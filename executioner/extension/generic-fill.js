import { pageFillSource, fillPageDocument } from './page-runtime/serialize.js';

// Playwright and native script injection discard closures. In Node, expose the
// actual standalone function. Chrome sends pageFillSource directly through CDP.
export const fillVisibleFields = globalThis.process?.release?.name === 'node'
  ? Function('return ' + pageFillSource)()
  : fillPageDocument;
