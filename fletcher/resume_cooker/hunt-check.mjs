// C2 uses the imported checkers without running builds, APIs, or tester applications.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { analyzeExtractedText } from './checker/scripts/text-layer.mjs';
import { analyzeLatexText } from './checker/scripts/source-analysis.mjs';
import { analyzeJobDescriptionText } from './checker/scripts/jd-analysis.mjs';
import { createReport } from './checker/scripts/report-lib.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') continue;
  options[args[i]] = args[++i];
}
if (command !== 'check') throw new Error('Only advisory checks are supported.');
const text = await readFile(options['--text'], 'utf8');
const checks = analyzeExtractedText(text);
if (options['--source']) checks.push(...analyzeLatexText(await readFile(options['--source'], 'utf8')));
if (options['--jd']) checks.push(...analyzeJobDescriptionText(await readFile(options['--jd'], 'utf8'), text));
const report = { ...createReport({ stage: 'preflight', checks }), command, run_id: randomUUID() };
const body = JSON.stringify(report);
await writeFile(options['--out'] + '.tmp', body);
await rename(options['--out'] + '.tmp', options['--out']);
console.log(body);
process.exitCode = report.status === 'fail' ? 2 : 0;
