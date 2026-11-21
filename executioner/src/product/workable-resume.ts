import { createHash, randomUUID } from 'node:crypto';
import type { Page, Locator } from 'playwright';
import { ApplicationPause, type ResumeUploadReceipt } from './application-contract.ts';
import { recordComponentFailure } from './component-diagnostics.ts';
import { applicationTarget } from './target.ts';

/** Workable replaces the file input after upload. Its owned preview is the receipt. */
export async function uploadWorkableResume(page:Page, input:Locator, file:{name:string;mimeType:string;buffer:Buffer}):Promise<ResumeUploadReceipt> {
  const group=await input.locator('xpath=ancestor::div[@data-role="dropzone"][1]').elementHandle();
  if(!group)throw new ApplicationPause('The resume upload owner could not be identified.');
  const selectedInput=await input.elementHandle();
  if(!selectedInput){await group.dispose();throw new ApplicationPause('The resume input changed. Inspect it before retrying.');}
  const receipt={token:randomUUID(),selectedSha256:createHash('sha256').update(file.buffer).digest('hex'),filename:file.name,applicationKey:applicationTarget(page.url()).key};
  let operation = 'inspect_existing_attachment';
  try {
    const existing=await group.evaluate((element,{receipt,selectedInput})=>{
      const host=window as any;
      const preview=element.querySelector('a[data-action=view]');
      const previous=host.__huntWorkableResumeAttempt?.applicationKey===receipt.applicationKey ? host.__huntWorkableResumeAttempt : undefined;
      const file=selectedInput as HTMLInputElement;
      const currentInput=file.isConnected && file.ownerDocument===document && element.contains(file) &&
        element.querySelectorAll('input[type=file]').length===1 && file.type==='file' && !file.disabled && !file.multiple;
      const removedConfirmed=previous?.href && previous.applicationKey===receipt.applicationKey &&
        typeof previous.check==='function' && !previous.check() && file.files?.length===0;
      if(!element.isConnected || !currentInput || previous && !preview && !removedConfirmed)throw new Error('An upload is already pending review. Inspect the resume before retrying.');
      host.__huntWorkableResumeAttempt?.dispose?.();
      host.__huntWorkableResumeAttempt={...receipt,group:element,href:null};
      return !!preview;
    },{receipt,selectedInput});
    // A saved draft may already contain exactly the selected document. Verify
    // its bytes without replacing it or relying on its displayed filename.
    if (!existing) {
      operation = 'select_resume_file';
      await selectedInput.setInputFiles(file);
    }
    operation = 'observe_preview';
    const preview=await page.waitForFunction(({group,token})=>{
      const attempt=(window as any).__huntWorkableResumeAttempt;
      if(!group.isConnected || attempt?.group!==group || attempt.token!==token)return null;
      const links=group.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
      return links.length===1 && links[0]!.getClientRects().length && links[0]!.href || null;
    },{group,token:receipt.token},{timeout:20000}).catch(()=>null);
    const href=preview?await preview.jsonValue():null;
    await preview?.dispose();
    if(typeof href!=='string' || !/^https:\/\//.test(href))throw new ApplicationPause('The employer has not confirmed the selected resume upload. Check its resume preview before retrying.');
    // The owned preview URL is self-contained. A browser-bound request also
    // reads all browser cookies, which the selected-tab extension cannot do.
    operation = 'verify_preview_bytes';
    try {
      const response=await fetch(href,{signal:AbortSignal.timeout(15000),credentials:'omit'});
      if(!response.ok)throw new ApplicationPause('The resume preview is unavailable or expired. Refresh its preview before retrying.');
      if(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')!==receipt.selectedSha256)throw new ApplicationPause('The resume preview does not confirm the PDF selected for this job.');
    } catch(error) {
      if(error instanceof ApplicationPause)throw error;
      throw new ApplicationPause('The resume preview could not be read. Inspect the uploaded file before retrying.');
    }
    operation = 'bind_verified_preview';
    await group.evaluate((element,{receipt,href})=>{
      const attempt=(window as any).__huntWorkableResumeAttempt;
      if(!element.isConnected || attempt?.token!==receipt.token || attempt.group!==element || element.querySelector<HTMLAnchorElement>('a[data-action=view]')?.href!==href)throw new Error('The resume changed during verification.');
      attempt.href=href;
      let valid=true;
      const observer=new MutationObserver(()=>{valid=false;});
      observer.observe(element,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
      const invalidate=()=>{valid=false;};
      element.addEventListener('change',invalidate,true);
      attempt.check=()=>{if(observer.takeRecords().length)valid=false;return valid && element.isConnected;};
      attempt.dispose=()=>{observer.disconnect();element.removeEventListener('change',invalidate,true);};
    },{receipt,href});
    return receipt;
  } catch (error) {
    recordComponentFailure(error, 'uploads', operation);
    throw error;
  } finally {await selectedInput.dispose();await group.dispose();}
}

export async function verifiedWorkableResume(page:Page,receipt:ResumeUploadReceipt|undefined,expectedSha256?:string,fieldKey?:string) {
  if(!receipt || receipt.selectedSha256!==expectedSha256 || applicationTarget(page.url()).ats!=='workable' || receipt.applicationKey!==applicationTarget(page.url()).key)return false;
  return page.evaluate(({receipt,fieldKey})=>{
    const proof=(window as any).__huntWorkableResumeAttempt;
    if(proof?.token!==receipt.token || !proof.href || !proof.check?.())return false;
    const links=proof.group.querySelectorAll('a[data-action=view]');
    if(links.length!==1 || links[0].href!==proof.href || !links[0].getClientRects().length)return false;
    return fieldKey===undefined || [...proof.group.querySelectorAll('input[type=file]')].some((e:any)=>e.getAttribute('data-c3-hosted')===fieldKey);
  },{receipt,fieldKey});
}
