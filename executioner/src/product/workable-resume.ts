import { createHash, randomUUID } from 'node:crypto';
import type { Page, Locator } from 'playwright';
import { ApplicationPause, AttachmentPreviewUnavailable, type ResumeUploadReceipt } from './application-contract.ts';
import { recordComponentFailure } from './component-diagnostics.ts';
import { applicationTarget } from './target.ts';

type PreviewRead = { digest: string } | { failure: `http_${number}` | 'unsupported_path' | 'unsupported_type' |
  'missing_body' | 'empty_body' | 'html' | 'transport_rejected' | 'size_mismatch' };

/** Workable replaces the file input after upload. Its owned preview is the receipt. */
export async function uploadWorkableResume(page:Page, input:Locator, file:{name:string;mimeType:string;buffer:Buffer}):Promise<ResumeUploadReceipt> {
  const group=await input.locator('xpath=ancestor::div[@data-role="dropzone"][1]').elementHandle();
  if(!group)throw new ApplicationPause('The resume upload owner could not be identified.');
  const selectedInput=await input.elementHandle();
  if(!selectedInput){await group.dispose();throw new ApplicationPause('The resume input changed. Inspect it before retrying.');}
  const receipt={token:randomUUID(),selectedSha256:createHash('sha256').update(file.buffer).digest('hex'),filename:file.name,applicationKey:applicationTarget(page.url()).key};
  let operation = 'inspect_existing_attachment';
  try {
    const attachment=await group.evaluate((element,{receipt,selectedInput})=>{
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
      // Workable can retain the selected file while its preview is still mounting.
      // Wait for that preview without replacing the applicant's pending upload.
      return preview ? 'existing' : file.files?.length ? 'pending' : 'fresh';
    },{receipt,selectedInput});
    // A saved draft may already contain exactly the selected document. Verify
    // its bytes without replacing it or relying on its displayed filename.
    if (attachment === 'fresh') {
      operation = 'select_resume_file';
      await selectedInput.setInputFiles(file);
    }
    operation = `observe_${attachment}_preview`;
    const preview=await page.waitForFunction(({group,token})=>{
      const attempt=(window as any).__huntWorkableResumeAttempt;
      if(!group.isConnected || attempt?.group!==group || attempt.token!==token)return null;
      const links=group.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
      if (links.length !== 1 || !links[0]!.getClientRects().length || !links[0]!.href) return null;
      attempt.link = links[0];
      return links[0]!.href;
    },{group,token:receipt.token},{timeout:20000}).catch(()=>null);
    const href=preview?await preview.jsonValue():null;
    await preview?.dispose();
    if(typeof href!=='string' || !/^https:\/\//.test(href))throw new ApplicationPause('The employer has not confirmed the selected resume upload. Check its resume preview before retrying.');
    operation = `verify_${attachment}_preview_address`;
    const url = new URL(href);
    if (url.username || url.password) throw new ApplicationPause('The resume preview address is not supported.');
    const sameOrigin = url.origin === new URL(page.url()).origin;
    operation = `verify_${attachment}_${sameOrigin ? 'same_origin' : 'external'}_preview`;
    let read: PreviewRead = {failure:'unsupported_path'};
    if (sameOrigin) {
      // Read a direct PDF from the selected document. Never follow it to a login or another origin.
      if (/\.pdf$/i.test(url.pathname)) {
        read = await group.evaluate(async (element, {href, token, size}): Promise<PreviewRead> => {
          const attempt = (window as any).__huntWorkableResumeAttempt;
          const links = element.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
          if (!element.isConnected || attempt?.token !== token || attempt.group !== element ||
              links.length !== 1 || links[0] !== attempt.link || links[0]!.href !== href ||
              new URL(href).origin !== location.origin) throw new Error('The resume changed during verification.');
          try {
            const response = await fetch(href, {mode:'same-origin', credentials:'same-origin', redirect:'error', signal:AbortSignal.timeout(15000)});
            if (!response.ok) return {failure:`http_${response.status}`};
            if (!response.body) return {failure:'missing_body'};
            const type = response.headers.get('content-type') ?? '';
            if (!/^(application\/pdf|application\/octet-stream)(?:;|$)/i.test(type)) {
              return {failure:/text\/html/i.test(type) ? 'html' : 'unsupported_type'};
            }
            const reader = response.body.getReader();
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (;;) {
              const {value, done} = await reader.read();
              if (done) break;
              if (offset + value.length > size) { await reader.cancel().catch(()=>{}); return {failure:'size_mismatch'}; }
              bytes.set(value, offset);
              offset += value.length;
            }
            if (offset !== size) return {failure:offset ? 'size_mismatch' : 'empty_body'};
            return {digest:[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('')};
          } catch { return {failure:'transport_rejected'}; }
        }, {href, token:receipt.token, size:file.buffer.length});
      }
    } else {
      // Existing signed external previews are anonymous. No browser session or credential retry.
      try {
        const response = await fetch(href, {signal:AbortSignal.timeout(15000), credentials:'omit', redirect:'error'});
        if (response.ok && response.body && !/text\/html/i.test(response.headers.get('content-type') ?? '')) {
          const reader = response.body.getReader();
          const hash = createHash('sha256');
          let size = 0;
          for (;;) {
            const {done, value} = await reader.read();
            if (done) {
              read = size === file.buffer.length ? {digest:hash.digest('hex')} : {failure:size ? 'size_mismatch' : 'empty_body'};
              break;
            }
            size += value.byteLength;
            if (size > file.buffer.length) {
              read = {failure:'size_mismatch'};
              await reader.cancel().catch(()=>{});
              break;
            }
            hash.update(value);
          }
        } else {
          read = {failure:!response.ok ? `http_${response.status}` : !response.body ? 'missing_body' : 'html'};
          await response.body?.cancel().catch(()=>{});
        }
      } catch { read = {failure:'transport_rejected'}; }
    }
    if ('failure' in read || read.digest !== receipt.selectedSha256) {
      const reason = 'failure' in read ? read.failure : 'hash_mismatch';
      operation += `_${reason}`;
      if (['size_mismatch','hash_mismatch','empty_body'].includes(reason)) {
        throw new ApplicationPause('The resume preview does not confirm the PDF selected for this job.');
      }
      throw new AttachmentPreviewUnavailable('The resume preview could not be verified. Inspect the uploaded file before retrying.');
    }
    operation = 'bind_verified_preview';
    await group.evaluate((element,{receipt,href})=>{
      const attempt=(window as any).__huntWorkableResumeAttempt;
      const links = element.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
      if(!element.isConnected || attempt?.token!==receipt.token || attempt.group!==element || links.length!==1 || links[0]!==attempt.link || links[0]!.href!==href)throw new Error('The resume changed during verification.');
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

export function unverifiedWorkablePreview(page: Page, requiredKeys: string[], expected: boolean, selectedDigestKnown: boolean) {
  return page.evaluate(({requiredKeys, expected, selectedDigestKnown}) => {
    const attempt = (window as any).__huntWorkableResumeAttempt;
    if (attempt) return !attempt.check?.() || selectedDigestKnown;
    return [...document.querySelectorAll('div[data-role=dropzone] input[type=file][data-ui=resume]')].some(
      input => expected || requiredKeys.includes(input.getAttribute('data-c3-hosted') ?? '')
    );
  }, {requiredKeys, expected, selectedDigestKnown});
}
