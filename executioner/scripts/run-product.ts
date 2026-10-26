import { startProductServer } from "../src/product/server.ts";
const product = await startProductServer();
console.log(`C3: ${product.origin}\nPairing key file: ${product.tokenPath}`);
for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => { void product.close().then(() => process.exit(0)); });
