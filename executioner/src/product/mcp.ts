import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const tools = [
  {name:'hunt_matching_backlog',description:'Read private C3.1 question observations, suggested categories, answer choices and fill outcomes for owner review. Does not approve mappings or change profile facts.',inputSchema:{type:'object',properties:{offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'hunt_extension_reload',description:'Reload only the paired Hunt extension from its existing installed folder and verify the same extension reconnects. Refuses while C3 applications or page actions are active. Preserves browser tabs, profile, pairing and drafts. Does not install files or grant permissions.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  {name:'hunt_status',description:'Read C3 connection, extension version and saved-profile/account availability. Never returns passwords, pairing keys or applicant answers.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'hunt_tabs',description:'List HTTPS tabs in the paired C3 browser. Choose the intended application tab explicitly; this does not open or focus tabs.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'hunt_account_check',description:'Recheck the saved Gmail mailbox connection with read-only inbox access and update its verification status and timestamp. Uses saved credentials without returning them. This does not verify employer passwords or sign in to an employer.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  {name:'hunt_page',description:'Inspect a selected HTTPS application page, then use its documentId to fill the saved profile and default resume or undo/redo supported field changes. Fill may upload the resume; Undo cannot remove a remote upload. Queued applications must continue through Applications to preserve their selected resume. Never navigates, signs in or submits. Independently review the employer page; partial filling does not mean completion.',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['inspect','fill','undo','redo']},tabId:{type:'integer',minimum:1},expectedUrl:{type:'string'},documentId:{type:'string',description:'Required for fill/undo/redo. Copy from inspect; changes when the page reloads.'}},required:['operation','tabId','expectedUrl'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
];

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);

export function productMcpHandler(options: {origin: string; tokenPath: string}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('C3 MCP connects only to its loopback service.');
  async function call(path: string, body?: unknown) {
    const token = readFileSync(options.tokenPath,'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The saved C3 pairing key is unavailable.');
    const response = await fetch(new URL(path,origin),{method:body === undefined ? 'GET' : 'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if (response.status === 401) throw new Error('C3 rejected the saved pairing key. Reconnect the local workspace.');
    if (response.status === 404) throw new Error('This C3 service does not support agent controls yet. Update the service and extension.');
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(object(result) && typeof result.error === 'string' ? result.error : 'C3 could not confirm the action. Inspect the page before retrying.');
    return result;
  }
  return async (request: unknown) => {
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number') return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}};
    if (request.id === undefined) return undefined;
    const reply = (result: unknown) => ({jsonrpc:'2.0',id:request.id,result});
    const error = (code: number, message: string) => ({jsonrpc:'2.0',id:request.id,error:{code,message}});
    if (request.method === 'initialize') {
      const version = object(request.params) ? request.params.protocolVersion : undefined;
      return reply({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(String(version)) ? version : '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hunt-c3',version:'1.0.0'},instructions:'Only operate the explicitly selected application. Never submit. Inspect before fill, and independently review the employer page afterward.'});
    }
    if (request.method === 'ping') return reply({});
    if (request.method === 'tools/list') return reply({tools});
    if (request.method !== 'tools/call') return error(-32601,'Method not found');
    if (!object(request.params) || typeof request.params.name !== 'string') return error(-32602,'Unknown tool');
    const toolName = request.params.name;
    if (!tools.some(tool=>tool.name === toolName)) return error(-32602,'Unknown tool');
    const args = request.params.arguments ?? {};
    if (!object(args)) return error(-32602,'Tool arguments must be an object');
    if (!['hunt_page','hunt_matching_backlog'].includes(toolName) && Object.keys(args).length) return error(-32602,'This tool does not accept arguments');
    if(toolName==='hunt_matching_backlog' && (Object.keys(args).some(key=>!['offset','limit'].includes(key)) || !Number.isSafeInteger(args.offset??0) || Number(args.offset??0)<0 || !Number.isSafeInteger(args.limit??50) || Number(args.limit??50)<1 || Number(args.limit??50)>100)) return error(-32602,'Invalid backlog page');
    try {
      let result = toolName === 'hunt_matching_backlog' ? await call(`/matching/backlog?offset=${args.offset??0}&limit=${args.limit??50}`) : toolName === 'hunt_extension_reload' ? await call('/browser/extension/reload',{}) : toolName === 'hunt_status' ? await call('/agent/status') : toolName === 'hunt_tabs' ? await call('/browser/tabs') : toolName === 'hunt_account_check' ? await call('/account/check',{}) : await call('/browser/page',args);
      if (toolName === 'hunt_account_check' && object(result)) { const {email:_email,...status} = result; result = status; }
      return reply({content:[{type:'text',text:JSON.stringify(result)}]});
    } catch (cause) {
      const message = cause instanceof Error && !/ENOENT|fetch failed|abort|timeout/i.test(cause.message) ? cause.message : 'C3 could not confirm the request. Check that the local service is running, then inspect the page before retrying.';
      return reply({isError:true,content:[{type:'text',text:message}]});
    }
  };
}

export async function serveProductMcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, options: {origin: string; tokenPath: string}) {
  const handle = productMcpHandler(options);
  const lines = createInterface({input,crlfDelay:Infinity});
  try {
    for await (const line of lines) {
      let response;
      try { if (line.length > 65536) throw new Error('Request too large'); response = await handle(JSON.parse(line)); }
      catch { response = {jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON request'}}; }
      if (response !== undefined && !output.write(JSON.stringify(response)+'\n')) await once(output,'drain');
    }
  } finally { lines.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.HUNT_C3_PRODUCT_ROOT ?? join(process.env.LOCALAPPDATA ?? homedir(),'Hunt','c3-product');
  await serveProductMcp(process.stdin,process.stdout,{origin:process.env.HUNT_C3_SERVICE_ORIGIN ?? 'http://127.0.0.1:47831',tokenPath:process.env.HUNT_C3_TOKEN_FILE ?? join(root,'service-token')});
}
