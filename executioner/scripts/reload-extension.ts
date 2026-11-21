import { join } from 'node:path';
import { homedir } from 'node:os';
import { productMcpHandler } from '../src/product/mcp.ts';

const root = process.argv[2] ?? process.env.HUNT_C3_PRODUCT_ROOT ?? join(process.env.LOCALAPPDATA ?? homedir(), 'Hunt', 'c3-product');
const handle = productMcpHandler({ origin: process.env.HUNT_C3_SERVICE_ORIGIN ?? 'http://127.0.0.1:47831', tokenPath: join(root, 'service-token') });
const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hunt_extension_reload', arguments: {} } });
console.log(JSON.stringify(response));
if (response && 'result' in response && (response.result as {isError?:boolean}).isError) process.exitCode = 1;
