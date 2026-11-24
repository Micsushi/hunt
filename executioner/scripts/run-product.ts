import { startProductServer } from "../src/product/server.ts";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const receipt = args.find(arg => /^--preserve-paused-tabs=[a-f0-9]{64}$/.test(arg));
if (args.some(arg => arg !== '--open' && arg !== receipt)) throw new Error('Usage: npm run product -- [--open] [--preserve-paused-tabs=<queue SHA-256>]');
const product = await startProductServer({pausedQueueHash:receipt?.split('=')[1]});
console.log(`C3: ${product.origin}\nPairing key file: ${product.tokenPath}`);
if (args.includes('--open')) {
  const url = `${product.origin}/#token=${encodeURIComponent(readFileSync(product.tokenPath, 'utf8').trim())}`;
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
  const failed = () => console.error('Could not open the workspace. Open the C3 address above and enter the key from the pairing-key file.');
  browser.on('error', failed);
  browser.on('exit', code => { if (process.platform !== 'win32' && code !== 0 && code !== null) failed(); });
  browser.unref();
}
for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => { void product.close().then(() => process.exit(0)); });
