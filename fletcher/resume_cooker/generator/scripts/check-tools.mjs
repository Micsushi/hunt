import { parseArgs, probeCommand, probeDockerDaemon } from "./build-lib.mjs";

const args = parseArgs(process.argv.slice(2));

const tools = ["latexmk", "pdflatex", "xelatex", "pdftotext", "pdfinfo", "docker", "node", "npm"];
const rows = [];

for (const tool of tools) {
  const capability =
    tool === "docker"
      ? await probeDockerDaemon()
      : await probeCommand(tool, {
          args: ["pdftotext", "pdfinfo"].includes(tool) ? ["-v"] : ["--version"]
        });
  rows.push({ tool, ...capability });
}

console.table(rows);

if (!rows.some((row) => ["latexmk", "pdflatex", "docker"].includes(row.tool) && row.usable)) {
  console.error("No usable PDF build engine found. Install latexmk/pdflatex or start Docker.");
  if (args["require-pdf-engine"] === "true") {
    process.exitCode = 1;
  }
}
