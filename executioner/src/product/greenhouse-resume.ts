import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page, Request } from 'playwright';
import { ApplicationPause, type ResumeUploadReceipt } from './application-contract.ts';
import { applicationTarget } from './target.ts';

const groupSelector='[role=group][aria-labelledby=upload-label-resume]';

export async function uploadGreenhouseResume(page: Page, file: {name:string;mimeType:string;buffer:Buffer}, selectedControl?: Locator): Promise<ResumeUploadReceipt> {
  const sha256=createHash('sha256').update(file.buffer).digest('hex'), md5=createHash('md5').update(file.buffer).digest('hex');
  const group=page.locator(groupSelector);
  const originalGroup=await group.elementHandle();
  if(!originalGroup)throw new ApplicationPause('The resume upload control is missing. Inspect the draft, then retry.');
  const input=await group.locator('input[type=file]').elementHandle();
  if(!input)throw new ApplicationPause('The resume upload control is missing. Inspect the draft, then retry.');
  const requests=new Map<Request,Promise<boolean>>();
  const observe=(request:Request)=>{
    if(request.method()!=='POST' || !/^grnhse-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(new URL(request.url()).hostname))return;
    try { if(request.frame()!==page.mainFrame())return; } catch { return; }
    requests.set(request,input.evaluate(async(raw,{name,sha256})=>{
      const files=(raw as HTMLInputElement).files;
      if(files?.length!==1 || files[0]!.name!==name)return false;
      const digest=await crypto.subtle.digest('SHA-256',await files[0]!.arrayBuffer());
      return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')===sha256;
    },{name:file.name,sha256}).catch(()=>false));
  };
  page.on('request',observe);
  try {
    if (selectedControl && !(await selectedControl.evaluate((element, selected) => element === selected, input))) {
      throw new ApplicationPause('The resume control differs from the upload group. Inspect the attachment before retrying.');
    }
    const response=page.waitForResponse(async r=>r.status()===201 && await requests.get(r.request())===true,{timeout:30000}).catch(()=>undefined);
    await input.setInputFiles(file);
    const accepted=await response;
    const etag=accepted && /<ETag>(.*?)<\/ETag>/.exec(await accepted.text())?.[1]?.replace(/&quot;|["\s]/g,'').toLowerCase();
    if(requests.size!==1 || etag!==md5)throw new ApplicationPause('The employer has not confirmed the selected resume upload. Inspect the resume before retrying.');
  await group.getByText(file.name,{exact:true}).waitFor({state:'visible',timeout:10000});
  await group.getByRole('button',{name:'Remove file',exact:true}).waitFor({state:'visible',timeout:10000});
  const receipt={token:randomUUID(),selectedSha256:sha256,filename:file.name,applicationKey:applicationTarget(page.url()).key};
  await originalGroup.evaluate((element,receipt)=>{
    if(!element.isConnected || element.ownerDocument!==document || document.querySelector('[role=group][aria-labelledby=upload-label-resume]')!==element)throw new Error('The resume upload page changed.');
    const host=window as unknown as {__huntResumeProof?:{token:string;group:Element;check:()=>boolean;dispose:()=>void}};
    host.__huntResumeProof?.dispose();
    let valid=true;
    const changed=(records:MutationRecord[])=>records.some(r=>element.contains(r.target) || [...r.removedNodes].some(n=>n===element || n.contains(element)));
    const observer=new MutationObserver(records=>{if(changed(records))valid=false;});
    observer.observe(document,{childList:true,subtree:true});
    observer.observe(element,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['value','aria-label']});
    const invalidate=()=>{valid=false;};
    element.addEventListener('click',invalidate,true);element.addEventListener('change',invalidate,true);
    host.__huntResumeProof={token:receipt.token,group:element,
      check:()=>{if(changed(observer.takeRecords()))valid=false;return valid&&element.isConnected;},
      dispose:()=>{observer.disconnect();element.removeEventListener('click',invalidate,true);element.removeEventListener('change',invalidate,true);}};
  },receipt);
  if(requests.size!==1)throw new ApplicationPause('The resume changed during upload verification. Inspect the draft, then retry.');
  return receipt;
  } finally { page.off('request',observe);await input.dispose();await originalGroup.dispose(); }
}

export async function verifiedGreenhouseResume(page: Page, receipt: ResumeUploadReceipt | undefined, expectedSha256?: string) {
  if(!receipt || receipt.selectedSha256!==expectedSha256 || receipt.applicationKey!==applicationTarget(page.url()).key || applicationTarget(page.url()).ats!=='greenhouse')return false;
  return page.evaluate(({receipt,selector})=>{
    const proof=(window as unknown as {__huntResumeProof?:{token:string;group:Element;check:()=>boolean}}).__huntResumeProof;
    const groups=document.querySelectorAll(selector),group=groups.length===1?groups[0]:null;
    if(!proof || proof.token!==receipt.token || proof.group!==group || !proof.check())return false;
    const visible=(e:Element)=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
    return !!group && visible(group) && group.textContent?.includes(receipt.filename)===true &&
      [...group.querySelectorAll('button[aria-label="Remove file"]')].some(visible) && !group.querySelector('input[type=file]');
  },{receipt,selector:groupSelector});
}
