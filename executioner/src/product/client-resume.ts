import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { ApplicationPause, type ResumeUploadReceipt } from './engine.ts';
import { applicationTarget } from './target.ts';

/** A client-held attachment is ready for the draft, not proof of a server upload. */
export async function selectClientResume(page:Page, locator:Locator, file:{name:string;mimeType:string;buffer:Buffer}):Promise<ResumeUploadReceipt|undefined> {
  const input=await locator.elementHandle();
  if(!input)throw new ApplicationPause('The resume input changed. Inspect it before retrying.');
  const receipt={token:randomUUID(),selectedSha256:createHash('sha256').update(file.buffer).digest('hex'),filename:file.name,applicationKey:applicationTarget(page.url()).key};
  let retain=false;
  try {
    const state=await input.evaluate((raw,receipt)=>{
      const input=raw as HTMLInputElement,host=window as any;
      if(!input.isConnected || input.disabled || input.multiple)return 'changed';
      if(input.files?.length)return 'existing';
      const group=input.closest('[role=group][aria-labelledby],fieldset');
      if(!group || group.getAttribute('data-allow-s3')!=='false')return 'native';
      const controls=group.querySelectorAll('input:not([type=hidden]),select,textarea');
      if(controls.length!==1 || controls[0]!==input)return 'ambiguous';
      const visible=(e:Element)=>e.getClientRects().length>0 && !e.closest('[hidden],[aria-hidden=true],[inert]') && getComputedStyle(e).visibility!=='hidden';
      const heading=(owner:Element)=>owner.matches('fieldset')?owner.querySelector(':scope > legend')?.textContent??'':(owner.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>{
        const matches=[...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)];
        return matches.length===1 && owner.contains(matches[0]!)?matches[0]!.textContent??'':'';
      }).join(' ');
      const resumeOwners=()=>[...document.querySelectorAll('[role=group][aria-labelledby],fieldset')].filter(e=>visible(e) && /resume|\bcv\b/i.test(heading(e)));
      const owners=resumeOwners();
      if(owners.length!==1 || owners[0]!==group)return 'ambiguous';
      const originalHeading=heading(group),originalLabelledby=group.getAttribute('aria-labelledby');
      const removeButtons=(visibleOnly=true)=>[...group.querySelectorAll('button,[role=button]')].filter(e=>/^remove(?: file| attachment| resume)?$/i.test((e.getAttribute('aria-label')??e.textContent??'').trim()) && (!visibleOnly || visible(e)));
      if(!visible(group) || removeButtons(false).length || group.matches('[aria-busy=true],[aria-invalid=true]') || group.querySelector('[aria-busy=true],[aria-invalid=true],[role=progressbar]') || [...group.querySelectorAll('p,span')].some(e=>/\.pdf$/i.test((e.textContent??'').trim())))return 'existing_completion';
      host.__huntClientResumeProof?.dispose?.();
      let valid=true,sealed=false,captured:File|undefined;
      const url=location.href;
      const capture=(event:Event)=>{
        if(event.target!==input)return;
        const files=input.files;
        if(sealed || files?.length!==1 || captured && captured!==files[0]){valid=false;return;}
        captured=files[0];
      };
      window.addEventListener('input',capture,true);window.addEventListener('change',capture,true);
      const invalidate=()=>{if(sealed)valid=false;};
      group.addEventListener('click',invalidate,true);group.addEventListener('change',invalidate,true);
      const changed=(records:MutationRecord[])=>records.some(r=>[...r.removedNodes].some(n=>n===group || n.contains(group)) || sealed && group.contains(r.target));
      const observer=new MutationObserver(records=>{if(changed(records))valid=false;});
      observer.observe(document,{childList:true,subtree:true});
      observer.observe(group,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-busy','aria-invalid','aria-label','aria-labelledby','data-allow-s3','id','hidden','disabled','value']});
      const completion=()=>{
        if(changed(observer.takeRecords()))valid=false;
        if(!valid || location.href!==url || !group.isConnected || group.ownerDocument!==document || !visible(group) || group.getAttribute('data-allow-s3')!=='false' || group.querySelector('input[type=file]') || group.getAttribute('aria-labelledby')!==originalLabelledby || heading(group)!==originalHeading)return false;
        const owners=resumeOwners();if(owners.length!==1 || owners[0]!==group)return false;
        if(group.matches('[aria-busy=true],[aria-invalid=true]') || [...group.querySelectorAll('[aria-busy=true],[aria-invalid=true],[role=progressbar],[role=alert]')].some(e=>visible(e) && (e.getAttribute('role')!=='alert' || !!e.textContent?.trim())))return false;
        const names=[...group.querySelectorAll('p,span')].filter(e=>visible(e) && (e.textContent??'').trim()===receipt.filename && ![...e.children].some(child=>(child.textContent??'').trim()===receipt.filename));
        const buttons=removeButtons();
        return names.length===1 && buttons.length===1 && !buttons[0]!.matches(':disabled,[aria-disabled=true]');
      };
      host.__huntClientResumeProof={...receipt,group,
        capturedHash:async()=>captured && [...new Uint8Array(await crypto.subtle.digest('SHA-256',await captured.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join(''),
        complete:completion,
        seal:()=>{if(!completion())return false;sealed=true;return true;},
        check:()=>sealed && completion(),
        dispose:()=>{valid=false;observer.disconnect();window.removeEventListener('input',capture,true);window.removeEventListener('change',capture,true);group.removeEventListener('click',invalidate,true);group.removeEventListener('change',invalidate,true);},
      };
      return 'client';
    },receipt);
    if(['changed','ambiguous','existing_completion'].includes(state))throw new ApplicationPause('The resume attachment is already present or its owner changed. Inspect it before retrying.');
    if(state!=='existing')await input.setInputFiles(file);
    await page.waitForTimeout(800);
    const native=await input.evaluate(async(raw,receipt)=>{
      const e=raw as HTMLInputElement;
      if(!e.isConnected || e.files?.length!==1)return false;
      const digest=await crypto.subtle.digest('SHA-256',await e.files[0]!.arrayBuffer());
      return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')===receipt.selectedSha256;
    },receipt);
    if(native)return undefined;
    if(state!=='client')throw new ApplicationPause('The selected resume attachment could not be verified. Inspect the draft before retrying.');
    const selected=await page.evaluate(async receipt=>{
      const proof=(window as any).__huntClientResumeProof;
      return proof?.token===receipt.token && await proof.capturedHash()===receipt.selectedSha256;
    },receipt);
    if(!selected)throw new ApplicationPause('The page did not retain proof of the selected resume bytes. Inspect the draft before retrying.');
    await page.waitForFunction(token=>{
      const proof=(window as any).__huntClientResumeProof;
      return proof?.token===token && proof.complete();
    },receipt.token,{timeout:5000}).then(handle=>handle.dispose()).catch(()=>{});
    retain=await page.evaluate(token=>{
      const proof=(window as any).__huntClientResumeProof;
      return proof?.token===token && proof.seal();
    },receipt.token);
    if(!retain)throw new ApplicationPause('The page has not confirmed its client-held resume attachment. Inspect the draft before retrying.');
    return receipt;
  } finally {
    if(!retain)await page.evaluate(token=>{const proof=(window as any).__huntClientResumeProof;if(proof?.token===token)proof.dispose();},receipt.token).catch(()=>{});
    await input.dispose();
  }
}

export async function verifiedClientResume(page:Page,receipt:ResumeUploadReceipt|undefined,expectedSha256?:string):Promise<boolean> {
  if(!receipt || receipt.selectedSha256!==expectedSha256)return false;
  try {if(receipt.applicationKey!==applicationTarget(page.url()).key)return false;} catch {return false;}
  return page.evaluate(receipt=>{
    const proof=(window as any).__huntClientResumeProof;
    return proof?.token===receipt.token && proof.selectedSha256===receipt.selectedSha256 && proof.filename===receipt.filename && proof.check();
  },receipt);
}
