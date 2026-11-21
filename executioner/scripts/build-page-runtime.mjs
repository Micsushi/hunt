// Find missing lexical dependencies after Chrome/Playwright strip module scope.
// Browser state and dynamic DOM shapes remain covered by the transport checks.
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript';
import { pageFillSource, observePageSource, checkPageSource } from '../extension/page-runtime/serialize.js';

const programs = [pageFillSource, observePageSource, checkPageSource];
for (const source of programs) new Script(source);

const input = resolve('standalone-browser-payload.js');
const options = {allowJs:true, checkJs:true, noEmit:true, skipLibCheck:true, target:ts.ScriptTarget.ES2022,
  types:[], lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']};
const host = ts.createCompilerHost(options);
const readFile = host.readFile.bind(host);
host.readFile = file => resolve(file) === input ? programs.map(source => `(${source});`).join('\n') : readFile(file);
const program = ts.createProgram([input], options, host);
const unbound = program.getSemanticDiagnostics(program.getSourceFile(input))
  .map(issue => ts.flattenDiagnosticMessageText(issue.messageText, ' '))
  .filter(message => /Cannot find name |No value exists in scope for the shorthand property /.test(message));
if (unbound.length) throw new Error('Unbound standalone browser dependencies: ' + [...new Set(unbound)].join(', '));
