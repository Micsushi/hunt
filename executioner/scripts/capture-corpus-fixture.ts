import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { normalizeCapture } from "../src/corpus/capture/index.ts";

const input = process.argv[2];
const outputRoot = process.argv[3];
if (input === undefined || outputRoot === undefined) {
  throw new TypeError("usage: capture-corpus-fixture <structural-input.json> <approved-output-root>");
}
const fixture = normalizeCapture(JSON.parse(readFileSync(resolve(input), "utf8")));
mkdirSync(resolve(outputRoot), { recursive: true });
const output = resolve(outputRoot, `${fixture.fixtureId}.json`);
if (basename(output) !== `${fixture.fixtureId}.json`) throw new TypeError("fixture output escaped its approved root");
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${fixture.fixtureId} ${fixture.semanticHash}\n`);
