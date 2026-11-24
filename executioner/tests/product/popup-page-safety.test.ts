import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {cpSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type BrowserContext} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {startProductServer} from '../../src/product/server.ts';
import {fixtureApplicantProfile} from './fixture.ts';
import {bambooAddressForm} from './bamboo-address-fixture.ts';

test('actual popup transport rejects synthetic profiles and keeps queued and current-page resumes independent', {timeout:150000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-popup-safety-'));
  const service=await startProductServer({root:join(root,'service'),port:0});
  const token=readFileSync(service.tokenPath,'utf8').trim();
  const extension=join(root,'extension');cpSync(resolve('extension'),extension,{recursive:true});
  for(const name of ['manifest.json','background.js','popup.js','website-handoff.js']){
    const file=join(extension,name);writeFileSync(file,readFileSync(file,'utf8').replaceAll('47831',new URL(service.origin).port));
  }
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    await worker.evaluate(async token=>{await (globalThis as any).chrome.storage.local.set({token});},token);
    const popup=await context.newPage();await popup.goto(worker.url().replace(/background\.js$/,'popup.html'));
    await popup.evaluate(()=>(globalThis as any).chrome.runtime.sendMessage({action:'connect'}));
    for(let i=0;i<100&&!service.queue.snapshot().connected;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(service.queue.snapshot().connected,true);
    const url='https://job-boards.greenhouse.io/fixture/jobs/123';
    await context.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><form><label>First name<input required autocomplete="given-name"></label><label>Email<input required type="email"></label><label>Resume<input required type="file" accept=".pdf"></label><button type="submit">Submit application</button></form>'}));
    const page=await context.newPage();await page.goto(url);
    const tabId=await worker.evaluate(async url=>(await (globalThis as any).chrome.tabs.query({})).find((t:any)=>t.url===url).id,url);
    const openPopup=async()=>{
      await worker.evaluate(tabId=>(globalThis as any).chrome.tabs.update(tabId,{active:true}),tabId);
      return (await Promise.all([context!.waitForEvent('page'),worker.evaluate(url=>(globalThis as any).chrome.tabs.create({url,active:false}),popup.url())]))[0];
    };
    const runPopupAction=async(view:typeof popup,action:string)=>{
      if(await view.locator('#back-to-fill').isVisible())await view.locator('#back-to-fill').click();
      if(['undo','redo','fill'].includes(action) && await view.locator('#other-actions').isHidden())await view.locator('#more-actions').click();
      await view.locator('#'+action).click();
      await view.locator('#batch:not(:disabled)').waitFor();
    };
    const issueMessages=async(view:typeof popup)=>{
      await view.locator('#issue-view').waitFor();
      const previous=view.locator('#previous-message'),next=view.locator('#next-message');
      while(await previous.isVisible() && await previous.isEnabled())await previous.click();
      const rows=[await view.locator('#issue-description').innerText()];
      while(await next.isVisible() && await next.isEnabled()){
        await next.click();rows.push(await view.locator('#issue-description').innerText());
      }
      return rows;
    };
    const findIssue=async(view:typeof popup,message:RegExp)=>{
      const body=view.locator('#issue-description');
      await body.waitFor();
      const previous=view.locator('#previous-message'),next=view.locator('#next-message');
      while(!message.test(await body.innerText()) && await previous.isVisible() && await previous.isEnabled())await previous.click();
      while(!message.test(await body.innerText()) && await next.isVisible() && await next.isEnabled())await next.click();
      assert.match(await body.innerText(),message);
    };
    const send=(operation:string,documentId?:string,expectedUrl=url)=>popup.evaluate(args=>(globalThis as any).chrome.runtime.sendMessage({action:'pageAction',...args,expiresAt:Date.now()+12000}),{operation,documentId,tabId,expectedUrl});
    const inspect=await send('inspect');assert.equal(inspect.ok,true);
    assert.equal(inspect.result.resume,'missing','the required native résumé input is visibly empty');
    const resume=Buffer.from('%PDF-1.4\nDefault fixture').toString('base64');
    const personal=fixtureApplicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
    const syntheticProfile=structuredClone(personal) as any;
    syntheticProfile.profilePlan.mode='synthetic_test_non_submittable';
    syntheticProfile.executionPolicy.answerFallbackPolicy='deterministic_site_valid_editable';
    service.queue.configure(syntheticProfile,resume);
    const synthetic=await send('fill',inspect.result.documentId);assert.equal(synthetic.ok,false);assert.match(synthetic.error,/saved personal profile/);
    assert.equal(await page.locator('input').first().inputValue(),'');assert.equal(await page.locator('input[type=file]').evaluate((el:any)=>el.files.length),0);
    service.queue.configure(personal,resume);
    const selected=Buffer.from('%PDF-1.4\nSelected version fixture').toString('base64');
    const queued=service.queue.add([{url,tabId,resumeBase64:selected,resumeName:'Selected.pdf',resumeVersion:'v8',sourceJobId:123}],{paused:true})[0]!;
    const longName='Engineer-'+ 'Analytics-'.repeat(18)+'Resume.pdf';
    const other=service.queue.add([{url:url.replace('/123','/987'),resumeName:longName,resumeVersion:'v12',
      resumeBase64:Buffer.from('%PDF-1.4\nLong name fixture').toString('base64'),sourceJobId:987}],{paused:true})[0]!;
    const nativeFile=page.locator('input[type=file]');
    await nativeFile.setInputFiles({name:'Resume.pdf',mimeType:'application/pdf',buffer:Buffer.from(selected,'base64')});
    assert.equal((await send('inspect')).result.resume,'unverified','page inspection has no selected queue PDF to compare');
    assert.equal(await nativeFile.evaluate((e:HTMLInputElement)=>e.files!.length),1);
    const before=readFileSync(join(root,'service',queued.id+'.input.json'),'utf8');
    const item=await fetch(service.origin+'/browser/page-resume',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({tabId,expectedUrl:url})});
    const choice=await item.json();
    assert.equal(choice.supportsQueue,true);
    assert.equal(choice.queued.name,'Selected.pdf');
    assert.equal(choice.currentPage.source,'default');
    assert.notEqual(choice.queued.sha256,choice.currentPage.sha256);
    const chooser=await openPopup();
    const resumeSelect=chooser.locator('#resume-select');
    await resumeSelect.waitFor();
    await context.addInitScript(() => {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = value => {
        const url = createObjectURL(value);
        if (value instanceof Blob && value.type === 'application/pdf') {
          (window as any).pdfForTest = {url, blob:value};
        }
        return url;
      };
    });
    async function previewBytes(view:typeof chooser) {
      const pdf=view.locator('#pdf[src^="blob:"]');
      await pdf.waitFor();
      return pdf.evaluate(async(frame:HTMLIFrameElement)=>{
        const shown=(window as any).pdfForTest;
        return frame.src===shown.url ? btoa(await shown.blob.text()) : null;
      });
    }
    await resumeSelect.click();
    const list=chooser.locator('#resume-list'), search=chooser.getByRole('searchbox',{name:'Search saved resumes'});
    const sort=chooser.getByRole('combobox',{name:'Sort saved resumes'});
    assert.equal(await search.evaluate(e=>e===document.activeElement),true);
    await sort.selectOption('version');
    assert.deepEqual(await list.getByRole('button').allTextContents(),[longName+' · v12','Selected.pdf · v8',choice.currentPage.name]);
    await sort.selectOption('version-asc');
    assert.deepEqual(await list.getByRole('button').allTextContents(),[choice.currentPage.name,'Selected.pdf · v8',longName+' · v12']);
    await chooser.setViewportSize({width:280,height:230});
    assert.equal(await chooser.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth && el.clientWidth<=280),true);
    assert.equal(await list.evaluate(el=>el.scrollWidth===el.clientWidth),true);
    await search.fill('missing fixture');
    assert.equal(await chooser.getByText('No matching resumes.').isVisible(),true);
    await search.fill('AnAlyTiCs');
    assert.deepEqual(await list.getByRole('button').allTextContents(),[longName+' · v12']);
    await search.fill('');
    const [viewer]=await Promise.all([context.waitForEvent('page'),list.getByRole('link',{name:/Open PDF: Default resume/}).click()]);
    assert.equal(await previewBytes(viewer),resume);
    await viewer.locator('summary').click();
    await viewer.getByRole('link',{name:/Selected\.pdf/}).click();
    assert.equal(await previewBytes(viewer),selected);
    await viewer.close();
    await search.fill('v8');
    assert.deepEqual(await list.getByRole('button').allTextContents(),['Selected.pdf · v8']);
    const [picked]=await Promise.all([context.waitForEvent('page'),list.getByRole('link',{name:/Open PDF: Selected/}).click()]);
    assert.equal(await previewBytes(picked),selected);
    await picked.close();
    assert.equal(await resumeSelect.getAttribute('value'),choice.currentPage.sha256,'previewing another row left the fill selection alone');
    await search.press('Escape');
    assert.equal(await resumeSelect.evaluate(e=>e===document.activeElement),true);
    await resumeSelect.press('Enter');
    await search.fill('v8');
    await search.press('ArrowDown');
    await chooser.keyboard.press('Enter');
    await chooser.locator('#resume-select[value="'+choice.queued.sha256+'"]').waitFor();
    assert.match(await resumeSelect.innerText(),/Selected\.pdf/);
    const workspace=await context.newPage();
    await workspace.goto(service.origin+'/#token='+token);
    await workspace.locator('.section-nav a[href="#preferences"]').click();
    const [library]=await Promise.all([context.waitForEvent('page'),workspace.getByRole('link',{name:'Browse saved resumes'}).click()]);
    await library.getByRole('link',{name:/Selected\.pdf/}).click();
    assert.equal(await previewBytes(library),selected);
    await library.close();
    await workspace.close();
    await resumeSelect.click();
    await list.getByRole('button',{name:/Default resume/}).click();
    await chooser.locator('#resume-select[value="'+choice.currentPage.sha256+'"]').waitFor();
    await chooser.locator('#resume-select:not(:disabled)').waitFor();
    await chooser.close();
    await service.queue.action(other.id,'remove');
    const fills=await send('fill',inspect.result.documentId);
    assert.equal(fills.ok,true,JSON.stringify(fills));
    assert.equal(await nativeFile.evaluate(async(e:HTMLInputElement)=>btoa(await e.files![0]!.text())),selected,'an existing employer attachment is preserved');
    assert.equal((await send('undo',inspect.result.documentId)).ok,true);
    await nativeFile.setInputFiles([]);
    assert.equal(await page.locator('input').first().inputValue(),'');
    assert.equal(await nativeFile.evaluate((e:HTMLInputElement)=>e.files!.length),0);
    assert.equal(await worker.evaluate(async()=> (await (globalThis as any).chrome.storage.local.get('token')).token),token);
    await page.screenshot({path:join(root,'unchanged-queued-draft.png')});
    // The queued filler evaluates in the employer document. Its journal is outside the extension's isolated world.
    const mainWorldFill=await page.evaluate(fillVisibleFields,{facts:[{factId:'given_name',value:'Queued fixture'}]});
    assert.equal(mainWorldFill.canUndo,true);
    assert.equal(await page.locator('input').first().inputValue(),'Queued fixture');
    const isolated=await send('inspect');
    assert.equal(isolated.result.canUndo,false);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('input').first().inputValue(),'');
    const submit=page.locator('button[type=submit]');
    const reportsDisabled=(reply: typeof inspect)=>reply.result.skipped.some((row:{reason:string})=>row.reason==='employer_submission_disabled');
    await submit.evaluate(button=>button.toggleAttribute('disabled',true));
    assert.equal(reportsDisabled(await send('inspect')),true);
    const inputFile=join(root,'service',queued.id+'.input.json');
    writeFileSync(inputFile,'{invalid fixture');
    const damaged=await openPopup();
    await damaged.locator('#support').filter({hasText:'Check the saved resume in Applications'}).waitFor();
    assert.equal(await damaged.locator('#fill').isDisabled(),true);
    assert.equal(await damaged.locator('#partial').isEnabled(),true);
    assert.match(await damaged.locator('#resume-select').innerText(),/Default resume/);
    await damaged.locator('#resume-select').click();
    assert.equal(await damaged.locator('#resume-list a').count(),1,'a single PDF remains available to open');
    await damaged.getByRole('searchbox',{name:'Search saved resumes'}).press('Escape');
    await damaged.locator('#partial').click();
    await damaged.locator('#issue-view').waitFor();
    assert.equal(await damaged.locator('#fill-log').count(),0);
    assert.equal(await nativeFile.evaluate(async(e:HTMLInputElement)=>btoa(await e.files![0]!.text())),resume);
    await runPopupAction(damaged,'undo');
    await damaged.close();
    writeFileSync(inputFile,before);
    const allowed=await send('fill',inspect.result.documentId);assert.equal(allowed.ok,true,JSON.stringify(allowed));
    assert.equal(reportsDisabled(allowed),true);
    assert.equal(allowed.result.resume,'verified');
    assert.equal(await page.locator('input').first().inputValue(),'Fixture');
    assert.equal(await nativeFile.evaluate(async(e:HTMLInputElement)=>btoa(await e.files![0]!.text())),resume,'current-page fill attached the generic PDF');
    assert.equal(readFileSync(join(root,'service',queued.id+'.input.json'),'utf8'),before);assert.equal(queued.status,'paused');
    await service.queue.action(queued.id,'remove');
    assert.equal(allowed.result.canUndo,true);
    const history=await send('inspect');
    assert.equal(reportsDisabled(history),true);
    assert.equal(history.result.canUndo,true,'the popup and public page actions share standalone page history');
    const undone=await send('undo',history.result.documentId);
    assert.equal(undone.ok,true,JSON.stringify(undone));
    assert.equal(reportsDisabled(undone),true);
    assert.equal(undone.result.incomplete,false,'the successful replay is separate from submission readiness');
    assert.equal(undone.result.requiredIssues.some((issue:{label:string})=>/first name/i.test(issue.label)),true,'Undo leaves the required name empty');
    assert.equal(reportsDisabled(await send('inspect')),true);
    assert.equal(undone.result.canRedo,true);
    assert.equal(await page.locator('input').first().inputValue(),'');
    const redone=await send('redo',history.result.documentId);
    assert.equal(redone.ok,true,JSON.stringify(redone));
    assert.equal(reportsDisabled(redone),true);
    assert.equal(await page.locator('input').first().inputValue(),'Fixture');
    const view=await openPopup();
    const warning='The employer still has submission disabled.';
    await findIssue(view,/The employer still has submission disabled/);
    for(const action of ['undo','redo']){
      await runPopupAction(view,action);
      assert.ok((await issueMessages(view)).some(row=>row.includes(warning)));
    }
    await view.close();
    await submit.evaluate((button:HTMLButtonElement)=>{button.disabled=false;});
    for(const action of ['undo','redo']) {
      const replayed=await send(action,history.result.documentId);
      assert.equal(replayed.ok,true);
      assert.equal(reportsDisabled(replayed),false);
    }
    for(const mode of ['enabled','hidden','aria-hidden','other-form','absent']) {
      await submit.evaluate((button:HTMLButtonElement,mode)=>{
        button.disabled=mode!=='enabled';
        button.hidden=mode==='hidden';
        button.setAttribute('aria-hidden',String(mode==='aria-hidden'));
        if(mode==='other-form')button.setAttribute('form','unrelated');
        else button.removeAttribute('form');
        if(mode==='absent')button.type='button';
      },mode);
      assert.equal(reportsDisabled(await send('inspect')),false,mode);
    }
    await page.locator('form button').evaluate((button:HTMLButtonElement)=>{button.type='submit';button.disabled=false;});
    // Some sites clear the picker after accepting a file. Its C3 receipt belongs to this application URL.
    await nativeFile.evaluate((e:HTMLInputElement)=>{e.value='';});
    assert.equal((await send('inspect')).result.resume,'unverified');
    const otherPosting=new URL('/fixture/jobs/124',url).href;
    await page.evaluate(next=>window.history.pushState({},'',next),otherPosting);
    await page.waitForURL(otherPosting);
    assert.equal((await send('inspect',undefined,otherPosting)).result.resume,'missing');
    const attachmentsUrl=new URL('/fixture/jobs/125',url).href;
    await context.route(attachmentsUrl,route=>route.fulfill({contentType:'text/html',body:`
      <form><label>First name<input></label><label>Email<input type=email></label>
      <label>Resume<input type=file required></label><label>Transcript<input type=file required></label>
      <button>Submit application</button></form>`}));
    await page.goto(attachmentsUrl);
    const attachments=await openPopup();
    const resumeInput=page.locator('input[type=file]').first();
    const transcript=page.getByLabel('Transcript',{exact:true});
    const resumeSelect2=attachments.locator('#resume-select');
    const defaultDigest=createHash('sha256').update(Buffer.from(resume,'base64')).digest('hex');
    await resumeSelect2.waitFor();
    assert.match(await resumeSelect2.innerText(),/Default resume/);
    assert.equal(await resumeSelect2.getAttribute('value'),defaultDigest);
    assert.equal(await attachments.locator('#issue-view').isVisible(),false,'fresh popup shows no pre-fill issues');
    for(const [action,message] of [
      ['partial','Transcript'],
      ['undo','Resume'],
      ['redo','The local resume picker contains a file.']
    ]){
      await runPopupAction(attachments,action!);
      const issues=(await issueMessages(attachments)).join(' ');
      assert.match(issues,/Transcript/i);
      assert.ok(issues.includes(message!),issues);
      assert.equal(await transcript.evaluate((e:HTMLInputElement)=>e.files!.length),0);
      assert.equal(await resumeInput.evaluate((e:HTMLInputElement)=>e.files!.length),action==='undo'?0:1);
    }
    service.queue.configure(personal,selected);
    const selectedDigest=createHash('sha256').update(Buffer.from(selected,'base64')).digest('hex');
    await attachments.waitForFunction(digest=>document.querySelector<HTMLButtonElement>('#resume-select')?.value===digest,selectedDigest);
    await runPopupAction(attachments,'partial');
    const conflictIssues=(await issueMessages(attachments)).join(' ');
    assert.match(conflictIssues,/Your selected PDF differs from the earlier resume selection/);
    assert.match(conflictIssues,/Transcript/i);
    assert.doesNotMatch(conflictIssues,/picker matches the selected PDF/);
    assert.equal(await resumeInput.evaluate((e:HTMLInputElement)=>e.files![0]!.text()),Buffer.from(resume,'base64').toString());
    await findIssue(attachments,/Transcript/i);
    await attachments.getByRole('button',{name:'Show field'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('input[type=file]')[1]?.getAnimations().length);
    await transcript.setInputFiles({name:'Transcript.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-manual-review')});
    await attachments.close();
    const resumedReview=await openPopup();
    await resumedReview.locator('#issue-view').waitFor();
    assert.doesNotMatch((await issueMessages(resumedReview)).join(' '),/transcript/i,'fixed field disappears after reopening');
    await resumedReview.close();
    await page.goto(attachmentsUrl);
    await resumeInput.setInputFiles({name:'Previous.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-previous')});
    const occupied=await openPopup();
    assert.equal(await occupied.locator('#issue-view').isVisible(),false);
    await runPopupAction(occupied,'partial');
    const occupiedIssues=(await issueMessages(occupied)).join(' ');
    assert.match(occupiedIssues,/A resume is already present/);
    assert.doesNotMatch(occupiedIssues,/picker matches the selected PDF/);
    assert.equal(await resumeInput.evaluate((e:HTMLInputElement)=>e.files![0]!.text()),'%PDF-previous');
    await occupied.close();
    await page.goto(attachmentsUrl);
    await resumeInput.evaluate(input=>{
      const label=input.closest('label')!;
      label.firstChild!.textContent='Resume/CV*';
      label.append(Object.assign(document.createElement('span'),{textContent:'CV.pdf'}));
      input.addEventListener('change',()=>{input.dataset.changed='yes';});
    });
    const retained=await openPopup();
    await runPopupAction(retained,'partial');
    const retainedIssues=(await issueMessages(retained)).join(' ');
    assert.match(retainedIssues,/The employer shows a different resume filename/);
    assert.match(retainedIssues,/Transcript/i);
    assert.doesNotMatch(retainedIssues,/picker matches the selected PDF|CV\.pdf/);
    await resumeInput.evaluate(input=>{input.nextElementSibling!.textContent='Resume.pdf';});
    await runPopupAction(retained,'partial');
    await findIssue(retained,/The employer shows the matching resume filename. PDF contents unverified/);
    assert.equal(await resumeInput.getAttribute('data-changed'),null);
    assert.equal(await resumeInput.evaluate((e:HTMLInputElement)=>e.files!.length),0);
    await retained.close();
    const oneClick='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/11111111-1111-4111-8111-111111111111';
    const childUrl=new URL('/unrelated-contact',oneClick).href;
    const contact='<label>First name<input required autocomplete="given-name"></label><label>Email<input required type="email"></label>';
    const owner='<oc-oneclick-form>'+contact+'<oc-resume-upload><spl-dropzone data-test="resume-upload"><label>Resume<input type="file"></label></spl-dropzone></oc-resume-upload></oc-oneclick-form>';
    let owners=1;
    await context.route(childUrl,route=>route.fulfill({contentType:'text/html',body:'<form>'+contact+'<button>Subscribe</button></form>'}));
    await context.route(oneClick,route=>route.fulfill({contentType:'text/html',body:'<main>'+owner.repeat(owners)+'</main><iframe src="'+childUrl+'"></iframe>'}));
    for (owners of [1,0,2]) {
      await page.goto(oneClick);
      const initial=await send('inspect',undefined,oneClick);
      assert.equal(initial.ok,true);
      const filled=await send('fill',initial.result.documentId,oneClick);
      assert.equal(filled.ok,true,JSON.stringify(filled));
      const child=page.frameLocator('iframe');
      assert.equal(await child.locator('input').first().inputValue(),'','unrelated frame must remain blank');
      assert.equal(await child.locator('input').last().inputValue(),'');
      assert.equal(initial.result.frames.length,1);
      assert.equal(filled.result.frames.length,1);
      if (owners>0) assert.equal(await page.locator('main input').first().inputValue(),owners===1?'Fixture':'');
    }
    const bambooUrl='https://fixture.bamboohr.com/careers/72/';
    await context.route(bambooUrl,route=>route.fulfill({contentType:'text/html',body:bambooAddressForm}));
    service.queue.configure(fixtureApplicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
      country:'Canada',region:'Alberta',postal_code:'T2P 1J9'}),resume);
    await page.goto(bambooUrl);
    const address=()=>page.locator('form').evaluate(form=>{
      const values=(name:string)=>form.querySelector<HTMLInputElement|HTMLSelectElement>('[name="'+name+'.value"]')!.value;
      return {country:values('countryId'),region:values('state'),postal:values('zip'),street:values('streetAddress'),city:values('city'),
        labels:Array.from(form.querySelectorAll('.fab-SelectToggle'),button=>button.getAttribute('aria-label')),submissions:form.dataset.submissions};
    });
    const original=await address();
    const bambooPopup=await openPopup();
    const fix=bambooPopup.getByRole('button',{name:'Use Canada from my profile'});
    const mismatch='Country is set to United States. Your profile uses Canada.';
    assert.equal(await bambooPopup.locator('#issue-view').isVisible(),false);
    await runPopupAction(bambooPopup,'partial');
    await findIssue(bambooPopup,/Country is set to United States/);
    assert.match(await bambooPopup.locator('#issue-message').innerText(),new RegExp(mismatch));
    assert.deepEqual(await address(),original);
    assert.doesNotMatch(await bambooPopup.locator('#issue-view').innerText(),/Alabama|State, ZIP/);
    assert.equal(await page.getByLabel('First name').inputValue(),'Fixture');
    await bambooPopup.locator('body').screenshot({path:join(root,'bamboo-conflict.png')});
    await fix.click();
    const canada={...original,country:'2',region:'20',postal:'T2P 1J9',labels:['Country Canada','Province Alberta']};
    await bambooPopup.locator('#use-profile-country').waitFor({state:'hidden'});
    assert.deepEqual(await address(),canada);
    await bambooPopup.locator('body').screenshot({path:join(root,'bamboo-corrected.png')});
    await runPopupAction(bambooPopup,'undo');
    await findIssue(bambooPopup,/Country is set to United States/);
    assert.deepEqual(await address(),original);
    assert.equal(await page.getByLabel('First name').inputValue(),'Fixture','Undo address preserves the preceding fill');
    assert.equal(await fix.isEnabled(),true);
    await runPopupAction(bambooPopup,'redo');
    await fix.waitFor({state:'hidden'});
    assert.deepEqual(await address(),canada);
    await page.locator('[name="zip.value"]').fill('Owner edit');
    await runPopupAction(bambooPopup,'undo');
    await findIssue(bambooPopup,/could not verify the restored address/);
    assert.deepEqual(await address(),{...canada,postal:'Owner edit'});
  }finally{await context?.close();await service.close();}
});
