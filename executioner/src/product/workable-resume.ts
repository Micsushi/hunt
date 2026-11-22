import { createHash, randomUUID } from 'node:crypto';
import type { ElementHandle, Page, Locator } from 'playwright';
import { ApplicationPause, AttachmentPreviewUnavailable, type ResumeUploadReceipt, type WorkableReviewAttempt } from './application-contract.ts';
import { recordComponentFailure } from './component-diagnostics.ts';
import { applicationTarget } from './target.ts';

type PreviewRead = { digest: string } | { failure: `http_${number}` | 'unsupported_path' | 'unsupported_type' |
  'missing_body' | 'empty_body' | 'html' | 'transport_rejected' | 'size_mismatch' };

// Installed on the browser's attachment witness, so every phase checks the same dropzone.
function watchUploadProgress(group: Element) {
  const indicators = '[aria-busy=true],[role=progressbar],progress';
  const owned = (node: Element) => node.closest('[data-role=dropzone]')===group;
  const active = () => group.matches('[aria-busy=true]') || [...group.querySelectorAll(indicators)].some(node =>
    owned(node) && node.getClientRects().length && getComputedStyle(node).visibility==='visible' && !node.closest('[hidden],[aria-hidden=true]'));
  active.previewVisible = (link: Element) => link.getClientRects().length>0 && getComputedStyle(link).visibility==='visible' &&
    !link.closest('[hidden],[inert],[aria-hidden=true]');
  // An upload can start and finish before the next Review read. Inspect the old
  // attribute values as well as the final DOM, including hidden progress controls.
  let revision = 0, observer: MutationObserver | undefined;
  const record = (records: MutationRecord[]) => {
    if (records.some(row => {
      const node = row.target as Element;
      if (!owned(node)) return false;
      if (row.type==='childList') return [...row.addedNodes,...row.removedNodes].some(item=>item instanceof Element &&
        (item.matches(indicators) || item.querySelector(indicators)));
      const name=row.attributeName!;
      const value=node.getAttribute(name);
      if (value===row.oldValue) return false;
      if (name==='aria-busy') return row.oldValue==='true' || value==='true';
      if (name==='role') return row.oldValue==='progressbar' || value==='progressbar';
      return node.matches(indicators) || [...node.querySelectorAll(indicators)].some(owned);
    })) revision++;
  };
  active.revision = () => {
    if (!observer) {
      observer=new MutationObserver(record);
      observer.observe(group,{subtree:true,childList:true,attributes:true,attributeOldValue:true,
        attributeFilter:['aria-busy','aria-hidden','class','hidden','role','style']});
    }
    record(observer.takeRecords());
    return revision;
  };
  active.disconnect = () => observer?.disconnect();
  return active;
}

/** Workable replaces the file input after upload. Its owned preview is the receipt. */
export async function uploadWorkableResume(page:Page, input:Locator, file:{name:string;mimeType:string;buffer:Buffer}):Promise<ResumeUploadReceipt> {
  const group=await input.locator('xpath=ancestor::div[@data-role="dropzone"][1]').elementHandle();
  if(!group)throw new ApplicationPause('The resume upload owner could not be identified.');
  const selectedInput=await input.elementHandle();
  if(!selectedInput){await group.dispose();throw new ApplicationPause('The resume input changed. Inspect it before retrying.');}
  const receipt={token:randomUUID(),selectedSha256:createHash('sha256').update(file.buffer).digest('hex'),filename:file.name,applicationKey:applicationTarget(page.url()).key};
  let operation = 'inspect_existing_attachment';
  const busy = await group.evaluateHandle(watchUploadProgress);
  try {
    const attachment=await group.evaluate((element,{receipt,selectedInput,busy})=>{
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
      host.__huntWorkableResumeAttempt={...receipt,group:element,href:null,busy};
      // Workable can retain the selected file while its preview is still mounting.
      // Wait for that preview without replacing the applicant's pending upload.
      return preview ? 'existing' : file.files?.length || busy() ? 'pending' : 'fresh';
    },{receipt,selectedInput,busy});
    // A saved draft may already contain exactly the selected document. Verify
    // its bytes without replacing it or relying on its displayed filename.
    if (attachment === 'fresh') {
      operation = 'select_resume_file';
      await selectedInput.setInputFiles(file);
    }
    operation = `observe_${attachment}_preview`;
    const preview=await page.waitForFunction(({group,token})=>{
      const attempt=(window as any).__huntWorkableResumeAttempt;
      if(!group.isConnected || attempt?.group!==group || attempt.token!==token || attempt.busy())return null;
      const links=group.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
      if (links.length !== 1 || !attempt.busy.previewVisible(links[0]) || !links[0]!.href) return null;
      attempt.link = links[0];
      return links[0]!.href;
    },{group,token:receipt.token},{timeout:20000}).catch(()=>null);
    const href=preview?await preview.jsonValue():null;
    await preview?.dispose();
    if(typeof href!=='string' || !/^https:\/\//.test(href))throw new ApplicationPause('The employer has not confirmed the selected resume upload. Check its resume preview before retrying.');
    await verifyAndBindPreview(page,group,receipt,href,file.buffer.length,attachment);
    return receipt;
  } catch (error) {
    recordComponentFailure(error, 'uploads', operation);
    throw error;
  } finally {await busy.dispose();await selectedInput.dispose();await group.dispose();}
}

async function verifyAndBindPreview(page: Page, group: ElementHandle<HTMLElement | SVGElement>, receipt: ResumeUploadReceipt,
  href: string, byteLength: number, attachment: string) {
  let operation: string = 'verify_preview_bytes';
  let sealed=false;
  try {
    const revision=await group.evaluate((element,token)=>{
      const proof=(window as any).__huntWorkableResumeAttempt;
      if (!element.isConnected || proof?.group!==element || proof.token!==token || proof.busy()) return -1;
      return proof.busy.revision() as number;
    },receipt.token);
    if (revision<0) throw new ApplicationPause('The resume changed during verification.');
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
              links.length !== 1 || links[0] !== attempt.link || !attempt.busy.previewVisible(links[0]) || links[0]!.href !== href ||
              new URL(href).origin !== location.origin) throw new Error('The resume changed during verification.');
          try {
            const response = await fetch(href, {mode:'same-origin', credentials:'same-origin', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000)});
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
        }, {href, token:receipt.token, size:byteLength});
      }
    } else {
      // Existing signed external previews are anonymous. No browser session or credential retry.
      try {
        const response = await fetch(href, {signal:AbortSignal.timeout(15000), credentials:'omit', redirect:'error', cache:'no-store'});
        if (response.ok && response.body && !/text\/html/i.test(response.headers.get('content-type') ?? '')) {
          const reader = response.body.getReader();
          const hash = createHash('sha256');
          let size = 0;
          for (;;) {
            const {done, value} = await reader.read();
            if (done) {
              read = size === byteLength ? {digest:hash.digest('hex')} : {failure:size ? 'size_mismatch' : 'empty_body'};
              break;
            }
            size += value.byteLength;
            if (size > byteLength) {
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
    if (applicationTarget(page.url()).key !== receipt.applicationKey) throw new ApplicationPause('The application changed during attachment verification.');
    const binding = await group.evaluate(async (element,{receipt,href,byteLength,revision})=>{
      const attempt=(window as any).__huntWorkableResumeAttempt;
      const input = element.querySelector<HTMLInputElement>('input[type=file]');
      const file = input?.files?.[0];
      if (element.querySelectorAll('input[type=file]').length>1 || (input?.files?.length ?? 0)>1) return 'native_ambiguous';
      if (file) {
        if (file.size!==byteLength) return 'native_mismatch';
        const hash = await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
        if ([...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')!==receipt.selectedSha256) return 'native_mismatch';
      }
      const links = element.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
      if(!element.isConnected || (window as any).__huntWorkableResumeAttempt!==attempt || attempt?.token!==receipt.token || attempt.group!==element ||
          links.length!==1 || links[0]!==attempt.link || !attempt.busy.previewVisible(links[0]) || links[0]!.href!==href || attempt.fileChanged ||
          element.querySelectorAll('input[type=file]').length!==(input?1:0) || element.querySelector('input[type=file]')!==input || file!==input?.files?.[0]) return 'attachment_changed';
      const progress=attempt.busy;
      if (progress() || progress.revision()!==revision) return 'upload_changed_or_pending';
      attempt.dispose?.();
      attempt.href=href;
      attempt.recheckPending=false;
      attempt.byteLength=byteLength;
      attempt.nativeFile=file;
      let valid=true;
      const observer=new MutationObserver(()=>{valid=false;});
      observer.observe(element,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
      const invalidate=(event:Event)=>{valid=false;if ((event.target as HTMLInputElement)?.type==='file') attempt.fileChanged=true;};
      element.addEventListener('change',invalidate,true);
      attempt.check=()=>{if(observer.takeRecords().length)valid=false;return valid && element.isConnected && progress.revision()===revision;};
      attempt.dispose=()=>{observer.disconnect();progress.disconnect();element.removeEventListener('change',invalidate,true);};
      return 'bound';
    },{receipt,href,byteLength,revision});
    if (binding!=='bound') {
      operation=`verify_${attachment}_${binding}`;
      if (binding==='native_mismatch') throw new ApplicationPause('The current file does not match the selected PDF. Inspect the draft before retrying.');
      throw new ApplicationPause('The resume changed during verification.');
    }
    sealed=true;
  } catch (error) {
    recordComponentFailure(error,'uploads',operation);
    throw error;
  } finally {
    if (!sealed) await group.evaluate((_,token)=>{
      const proof=(window as any).__huntWorkableResumeAttempt;
      if(proof?.token===token)proof.busy?.disconnect?.();
    },receipt.token).catch(()=>{});
  }
}

export async function verifiedWorkableResume(page:Page,receipt:ResumeUploadReceipt|undefined,expectedSha256?:string,fieldKey?:string) {
  if(!receipt || receipt.selectedSha256!==expectedSha256 || applicationTarget(page.url()).ats!=='workable' || receipt.applicationKey!==applicationTarget(page.url()).key)return false;
  return page.evaluate(({receipt,fieldKey})=>{
    const proof=(window as any).__huntWorkableResumeAttempt;
    if(proof?.token!==receipt.token || proof.selectedSha256!==receipt.selectedSha256 || proof.applicationKey!==receipt.applicationKey ||
        !proof.href || proof.recheckPending || typeof proof.busy?.revision!=='function' || proof.busy() || !proof.check?.())return false;
    const inputs=proof.group.querySelectorAll('input[type=file]');
    if (inputs.length>1 || inputs[0]?.files?.length>1 || inputs[0]?.files?.[0]!==proof.nativeFile)return false;
    const links=proof.group.querySelectorAll('a[data-action=view]');
    if(links.length!==1 || links[0]!==proof.link || links[0].href!==proof.href || !proof.busy.previewVisible?.(links[0]))return false;
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

/** Re-read the previously verified attachment, without opening its picker or writing the file input. */
export async function recheckWorkablePreview(page: Page, receipt: ResumeUploadReceipt | undefined, expectedSha256?: string, review?: WorkableReviewAttempt) {
  const fail = (reason: string): never => {
    const error = new ApplicationPause('The employer resume preview has not been verified. Inspect the uploaded file before reviewing.');
    recordComponentFailure(error,'uploads',`review_workable_${reason}`);
    throw error;
  };
  const key = applicationTarget(page.url()).key;
  if (receipt && receipt.applicationKey !== key) return fail('application_changed');
  if (receipt && receipt.selectedSha256 !== expectedSha256) return fail('selection_changed');
  const inputs = page.locator('div[data-role=dropzone] input[type=file][data-ui=resume]');
  const group = await inputs.count() === 1 ? await inputs.locator('xpath=ancestor::div[@data-role="dropzone"][1]').elementHandle() : null;
  const busy = group ? await group.evaluateHandle(watchUploadProgress) : null;
  try {
    const state = await page.evaluate(({group,receipt,selectedSize,busy})=>{
      const host=window as any, proof=host.__huntWorkableResumeAttempt;
      if (!proof) return {reason:host.__huntClientResumeProof ? 'client_witness_only' : 'missing_preview_witness'};
      if (!receipt) return {reason:'missing_saved_receipt'};
      if (proof.token!==receipt.token || proof.selectedSha256!==receipt.selectedSha256 || proof.applicationKey!==receipt.applicationKey) return {reason:'witness_changed'};
      if (!proof.href || typeof proof.check!=='function') return {reason:'preview_never_verified'};
      if (!group || !group.isConnected || proof.group!==group || !busy) return {reason:'dropzone_changed'};
      const links=group.querySelectorAll<HTMLAnchorElement>('a[data-action=view]');
      if (links.length!==1 || links[0]!==proof.link) return {reason:'preview_link_changed'};
      if (!busy.previewVisible(links[0]!)) return {reason:'preview_hidden'};
      const prior=new URL(proof.href), latest=new URL(links[0]!.href);
      if (latest.protocol!=='https:' || latest.username || latest.password || latest.origin!==prior.origin || latest.pathname!==prior.pathname) return {reason:'preview_address_changed'};
      const inputs=group.querySelectorAll<HTMLInputElement>('input[type=file]');
      if (proof.fileChanged || inputs.length!==1 || inputs[0]!.files?.length && inputs[0]!.files[0]!==proof.nativeFile ||
          busy()) return {reason:'upload_changed_or_pending'};
      const size=selectedSize ?? proof.byteLength;
      if (!Number.isSafeInteger(size) || size<=0 || (selectedSize!==undefined && proof.byteLength!==undefined && proof.byteLength!==selectedSize)) return {reason:'missing_verified_size'};
      const reason = latest.href!==prior.href ? 'href_rotated' : typeof proof.busy?.revision==='function' ? 'watcher_invalidated' : 'legacy_witness';
      proof.recheckPending=true;
      proof.busy=busy;
      return {reason, href:latest.href, size:size as number};
    },{group,receipt,selectedSize:review?.selectedSize,busy});
    if (!group || !receipt || !state.href || !state.size) return fail(state.reason);
    if (review?.rechecked) return fail(`already_rechecked_${state.reason}`);
    if (review) review.rechecked=true;
    await verifyAndBindPreview(page,group,receipt,state.href,state.size,`review_${state.reason}`);
  } finally { await busy?.dispose(); await group?.dispose(); }
}
