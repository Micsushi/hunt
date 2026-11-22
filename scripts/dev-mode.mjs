import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const MODES = new Set(["ui", "c0", "c1", "c2", "full"]);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const frontendDir = path.join(repoRoot, "frontend");
const composeFile = path.join(repoRoot, "docker-compose.pipeline.yml");

export function parseMode(value = "ui") {
  if (value === "--help" || value === "-h") return "help";
  if (!MODES.has(value)) {
    throw new Error(`Unknown mode: ${value}. Use ui, c0, c1, c2, or full.`);
  }
  return value;
}

export function composeProfile(mode) {
  return mode === "full" ? "all" : mode;
}

export function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function npmInvocation(platform = process.platform, nodePath = process.execPath) {
  if (platform !== "win32") return { command: "npm", args: [] };
  return {
    command: nodePath,
    args: [
      path.win32.join(
        path.win32.dirname(nodePath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    ],
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main() {
  const mode = parseMode(process.argv[2]);
  if (mode === "help") {
    console.log("Usage: node scripts/dev-mode.mjs [ui|c0|c1|c2|full]");
    return;
  }

  const env = { ...process.env };
  if (mode === "ui") {
    env.VITE_MOCK_BACKEND = "true";
  } else {
    await run(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "--profile",
        composeProfile(mode),
        "up",
        "-d",
        "--build",
      ],
      {
        cwd: repoRoot,
      },
    );
    if (mode === "full") {
      console.log("C3 runs separately as a local service and browser extension.");
    }
    env.VITE_BACKEND_URL = "http://127.0.0.1:18080";
  }

  const npm = npmInvocation();
  await run(npm.command, [...npm.args, "run", "vite:raw"], {
    cwd: frontendDir,
    env,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`dev-mode: ${error.message}`);
    process.exitCode = 1;
  });
}
