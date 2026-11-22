import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium,type Browser} from 'playwright';
import {pageFillSource,pageFillWorld} from '../../extension/page-runtime/serialize.js';
import {effectiveProfileFacts} from '../../src/product/sources.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProductServer} from '../../src/product/server.ts';
import {ExtensionBridge} from '../../src/product/extension-bridge.ts';
import {ApplicationQueue} from '../../src/product/queue.ts';
import {applicantProfile} from '../../src/product/sources.ts';

test('normal add binds only an existing paused generic job without changing its selected input or starting it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-generic-bind-'));let opens=0;
  const bridge={connected:false,open:async()=>{opens++;throw new Error('Unexpected browser operation')},release:async()=>{}};
  const queue=new ApplicationQueue(root,bridge);
  try {
    const url='https://fixture.bamboohr.com/careers/123';
    queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from('%PDF-default').toString('base64'));
    assert.throws(()=>queue.add([{url,tabId:7}]),/Import unfamiliar/);
    const job=queue.add([{url,sourceJobId:123,resumeVersion:'v18',resumeBase64:Buffer.from('%PDF-selected').toString('base64')}],{paused:true})[0]!;
    const path=join(root,job.id+'.input.json'),before=readFileSync(path,'utf8');const {tabId:originalTab,...metadata}=job;
    const journal=join(root,job.id+'.account-journal.json');writeFileSync(journal,'saved journal');bridge.connected=true;
    const bound=queue.add([{url,tabId:7}])[0]!;
    assert.equal(bound.id,job.id);assert.equal(bound.tabId,7);assert.equal(bound.status,'paused');
    const {tabId,...rest}=bound;assert.deepEqual(rest,metadata);
    assert.equal(readFileSync(path,'utf8'),before);assert.equal(readFileSync(journal,'utf8'),'saved journal');assert.equal(opens,0);
    for(const extra of [{resumeBase64:Buffer.from('%PDF-other').toString('base64')},{sourceJobId:999},{title:'changed'}])assert.throws(()=>queue.add([{url,tabId:8,...extra}]),/Import unfamiliar/);
    assert.throws(()=>queue.add([{url:url.replace('/123','/124'),tabId:7}]),/Import unfamiliar/);
    for(const status of ['running','queued','review'] as const){job.status=status;assert.throws(()=>queue.add([{url,tabId:8}]),/Import unfamiliar/);}job.status='paused';
    (queue as any).running.set(job.id,new AbortController());assert.throws(()=>queue.add([{url,tabId:8}]),/Import unfamiliar/);(queue as any).running.delete(job.id);
    assert.equal(readFileSync(path,'utf8'),before);assert.equal(opens,0);
  } finally {await queue.close();}
});

test('selected Jobvite Prepare binds only the inspected first step and preserves the default PDF',async()=>{
  const root = mkdtempSync(join(tmpdir(),'c3-jobvite-preparation-'));
  const app = await startProductServer({root,port:0});
  const url = 'https://jobs.jobvite.com/fixture/job/abc/apply', documentId='a'.repeat(64);
  const input={jobs:[{url,tabId:7}],documentId};
  const auth={Authorization:'Bearer '+readFileSync(app.tokenPath,'utf8'),'Content-Type':'application/json'};
  const prepare=(body:unknown)=>fetch(app.origin+'/jobs',{method:'POST',headers:auth,body:JSON.stringify(body)});
  const observed={url,documentId,mainDocumentId:'first-loader',tabId:7,jobviteFirstStep:true,operation:'inspect'};
  let seen={...observed};
  const bridge=(app.queue as unknown as {bridge:ExtensionBridge}).bridge;
  bridge.call=async method=>{assert.equal(method,'pageAction');return seen;};
  try{
    const pdf=Buffer.from('%PDF-selected-default').toString('base64');
    app.queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),pdf);
    for (const invalid of [
      {...input,jobs:[{url,tabId:7,sourceJobId:92}]},
      {...input,jobs:[{url:url.replace('/fixture/','/other/'),tabId:7}]},
      {...input,jobs:[{url,tabId:9}]}, {...input,documentId:'b'.repeat(64)},
    ])assert.equal((await prepare(invalid)).status,400);
    seen={...observed,jobviteFirstStep:false};
    assert.equal((await prepare(input)).status,400);assert.equal(app.queue.jobs.length,0);
    seen=observed;
    assert.equal((await prepare(input)).status,200);
    const job=app.queue.jobs[0]!;
    assert.equal(job.tabId,7);assert.equal(job.selectedDocument,'first-loader');assert.equal(job.status,'paused');
    assert.equal(job.submissionAllowed,false);assert.equal(job.sourceJobId,undefined);
    assert.equal(JSON.parse(readFileSync(join(root,job.id+'.input.json'),'utf8')).resume,pdf);
    assert.equal((await prepare(input)).status,200);assert.equal(app.queue.jobs.length,1);
    const other='https://jobs.jobvite.com/fixture/job/xyz/apply';
    app.queue.add([{url:other,sourceJobId:99,resumeVersion:'v1',resumeBase64:Buffer.from('%PDF-other').toString('base64')}],{paused:true});
    seen={...observed,url:other,tabId:9};
    assert.equal((await prepare({jobs:[{url:other,tabId:9}],documentId})).status,400);
    const calls:string[]=[];
    let current=url.replace('/apply','');
    bridge.call=async(method,args={})=>{
      calls.push(method);
      if(method==='pageTabs')return [{tabId:7,url:current}];
      if(method==='attach'){assert.equal(args.existingOnly,true);assert.equal(args.selectedDocument,'first-loader');return {tabId:7,targetId:'tab'};}
      assert.equal(method,'detach');return {};
    };
    await assert.rejects(bridge.open(url,7,true,'first-loader'),/address changed/);
    current=url;
    await assert.rejects(bridge.open(url,7,true,'first-loader'),/confirm the selected application document/);
    assert.deepEqual(calls,['pageTabs','pageTabs','attach','detach']);
  }finally{await app.close();}
});

test('selected SmartRecruiters Prepare proves the posting and preserves the bound default PDF on rebind',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-smartrecruiters-preparation-'));
  let app=await startProductServer({root,port:0});
  const company='Fixture', id='744000123456789', uuid='11111111-1111-4111-8111-111111111111';
  const postingUrl=`https://jobs.smartrecruiters.com/${company}/${id}-analyst`;
  const url=`https://jobs.smartrecruiters.com/oneclick-ui/company/${company}/publication/${uuid}?dcr_ci=${company}`;
  const documentId='a'.repeat(64);
  let tabId=7, inspectedUrl=url;
  let observedDocumentId=documentId, loader='first-loader', returnedUuid=uuid, inspections=0;
  const realFetch=globalThis.fetch;
  const realConnect=chromium.connectOverCDP;
  let browser:Browser|undefined;
  globalThis.fetch=async(input,options)=>{
    if(String(input).startsWith(app.origin+'/')) return realFetch(input,options);
    assert.ok([id,uuid].some(value=>String(input)===`https://api.smartrecruiters.com/v1/companies/${company}/postings/${value}`));
    assert.equal(options?.redirect,'error');
    assert.equal(options?.credentials,'omit');
    return Response.json({id,uuid:returnedUuid,company:{identifier:company},active:true,postingUrl});
  };
  const observe=()=>{
    const bridge=(app.queue as unknown as {bridge:ExtensionBridge}).bridge;
    bridge.call=async(method,args)=>{
      assert.equal(method,'pageAction');
      inspections++;
      assert.deepEqual(args,{operation:'inspect',tabId,expectedUrl:inspectedUrl});
      return {url:inspectedUrl,tabId,documentId:observedDocumentId,mainDocumentId:loader,
        smartRecruitersFirstStep:inspectedUrl===url,smartRecruitersScreening:inspectedUrl!==url};
    };
  };
  const post=(path:string, body:unknown)=>fetch(app.origin+path,{method:'POST',headers:{
    Authorization:'Bearer '+readFileSync(app.tokenPath,'utf8'),'Content-Type':'application/json',
  },body:JSON.stringify(body)});
  const prepare=(selectedUrl=url)=>post('/jobs',{jobs:[{url:selectedUrl,tabId}],documentId});
  const edit=(expectedUrl=url, operation='fill')=>post('/browser/page',{tabId:tabId+1,expectedUrl,documentId,operation});
  try {
    observe();
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',city:'Example',region:'Ontario',country:'Canada'});
    const selected=Buffer.from('%PDF-selected-default').toString('base64');
    app.queue.configure(profile,selected);
    const imported=app.queue.add([{url:postingUrl,sourceJobId:9,resumeVersion:'v1',
      resumeBase64:Buffer.from('%PDF-tailored').toString('base64')}],{paused:true})[0]!;
    assert.equal((await prepare()).status,400);
    assert.equal(app.queue.jobs.length,1);
    assert.equal(imported.sourceJobId,9);
    const c1Edit=await edit();
    assert.equal(c1Edit.status,400);
    assert.match((await c1Edit.json()).error,/preserve its selected resume/);
    await app.queue.action(imported.id,'remove');
    const beforeRejected=inspections;
    returnedUuid='22222222-2222-4222-8222-222222222222';
    assert.equal((await prepare()).status,400);
    assert.equal((await prepare('https://example.invalid/application')).status,400);
    for (const privateUrl of [url+'&token=fixture',url+'#fixture',url+'&dcr_ci='+company]) {
      const denied=await prepare(privateUrl);
      assert.equal(denied.status,400);
      assert.match((await denied.json() as {error:string}).error,/ordinary SmartRecruiters application link/);
    }
    assert.equal((await prepare(url.replace('?', '/screening?'))).status,400);
    assert.equal(inspections,beforeRejected);
    returnedUuid=uuid;
    observedDocumentId='b'.repeat(64);
    assert.equal((await prepare()).status,400);
    assert.equal(app.queue.jobs.length,1);
    observedDocumentId=documentId;
    assert.equal((await prepare()).status,200);
    const job=app.queue.jobs.find(entry=>entry.status!=='removed')!;
    assert.equal(job.sourceJobId,undefined);
    assert.equal(job.url,postingUrl);
    assert.equal(job.selectedApplicationUrl,url);
    assert.equal(job.selectedDocument,'first-loader');
    assert.equal(job.status,'paused');
    assert.equal(job.submissionAllowed,false);
    const stored=join(root,job.id+'.input.json');
    const original=readFileSync(stored,'utf8');
    assert.equal(JSON.parse(original).resume,selected);
    app.queue.configure(profile,Buffer.from('%PDF-changed-default').toString('base64'));
    await app.close();
    app=await startProductServer({root,port:0});
    observe();
    let restored=app.queue.jobs.find(entry=>entry.id===job.id)!;
    assert.equal(restored.tabId,undefined);
    assert.equal(restored.selectedApplicationUrl,url);
    for (const actual of [url, url.replace('?', '/screening?')]) {
      const response=await edit(actual,'redo');
      assert.equal(response.status,400);
      assert.match((await response.json()).error,/preserve its selected resume/);
    }
    tabId=8; loader='replacement-loader';
    assert.throws(()=>app.queue.add([{url:postingUrl,tabId}]),/use Prepare again/);
    assert.equal((await prepare()).status,200);
    assert.equal(restored.tabId,8);
    assert.equal(restored.selectedDocument,'replacement-loader');
    assert.equal(restored.status,'paused');
    assert.equal(app.queue.jobs.filter(entry=>entry.status!=='removed').length,1);
    assert.equal(readFileSync(stored,'utf8'),original);

    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();
    await page.route('https://jobs.smartrecruiters.com/**', route=>route.fulfill({contentType:'text/html',body:
      '<main><oc-oneclick-form><oc-personal-information><label>First name<input required></label><label>Email<input required type=email></label></oc-personal-information>' +
      '<oc-resume-upload><spl-dropzone data-test="resume-upload"></spl-dropzone></oc-resume-upload>' +
      '<oc-nav-first-page><footer data-test="footer"><oc-button data-test="footer-next"><spl-button>Next</spl-button></oc-button></footer></oc-nav-first-page></oc-oneclick-form></main>'}));
    await page.goto(url);
    await page.evaluate(()=>{
      const trace = document.body.dataset;
      const zone=document.querySelector('spl-dropzone')!.attachShadow({mode:'open'});
      zone.innerHTML='<label>Resume<input type=file required></label><ul class="c-spl-file-list"></ul>';
      zone.querySelector('input')!.onchange=async event=>{
        const file=(event.target as HTMLInputElement).files?.[0];
        if (!file) return;
        (event.target as HTMLInputElement).value='';
        (event.target as HTMLInputElement).required=false;
        (event.target as HTMLInputElement).setAttribute('aria-required','true');
        trace.uploaded=await file.text();
        trace.uploads=String(Number(trace.uploads??0)+1);
        zone.querySelector('ul')!.innerHTML='<li class="c-spl-file-list-item"><span class="c-spl-file-list-item-label-container"><span class="c-spl-file-list-item-name"></span></span><spl-button><button></button></spl-button></li>';
        zone.querySelector('li span span')!.textContent=file.name;
        zone.querySelector('li button')!.setAttribute('aria-label','Delete file '+file.name);
      };
      const next=document.querySelector('spl-button')!;
      next.attachShadow({mode:'open'}).innerHTML='<button type=button><slot></slot></button>';
      next.addEventListener('click',()=>{
        trace.next='clicked';
        history.pushState({},'',location.pathname+'/screening'+location.search);
        document.querySelector('main')!.innerHTML='<oc-screening-questions><h2>Review</h2>' +
          '<oc-screening-questions-form><label>First name<input required></label></oc-screening-questions-form>' +
          '<oc-nav-screening-questions><oc-button data-test="footer-submit"><spl-button>Submit</spl-button></oc-button></oc-nav-screening-questions></oc-screening-questions>';
        const submit=document.querySelector('spl-button')!.attachShadow({mode:'open'});
        submit.innerHTML='<button type=button><slot></slot></button>';
        submit.querySelector('button')!.onclick=()=>{trace.submitted='clicked';};
      });
    });
    const bridge=(app.queue as unknown as {bridge:ExtensionBridge}).bridge;
    const screeningUrl=url.replace('?', '/screening?');
    let current=screeningUrl, returnedLoader=loader, attachments=0, connections=0, transitions=0;
    const boundBrowser=browser;
    chromium.connectOverCDP=async()=>{
      connections++;
      return {contexts:()=>boundBrowser.contexts(),close:async()=>{}} as Browser;
    };
    const renderer=await page.context().newCDPSession(page);
    const {frame}= (await renderer.send('Page.getFrameTree')).frameTree;
    const fixtureCall:ExtensionBridge['call']=async(method,args)=>{
      if (method==='cdp') {
        if (args?.method==='Page.getFrameTree') return {frameTree:{frame:{...frame,loaderId:loader,url:current}}};
        return renderer.send(args?.method as 'Page.createIsolatedWorld',args?.params as {frameId:string; worldName:string});
      }
      if (method==='pageTabs') return [{tabId,url:current}];
      if (method==='attach') {
        attachments++;
        assert.deepEqual(args,{url:current,tabId,existingOnly:true,generic:true,selectedDocument:loader});
        return {tabId,targetId:'fixture',selectedDocument:returnedLoader,screeningBinding:'fixture-grant'};
      }
      if (method==='screeningTransition') {
        transitions++;
        assert.deepEqual(args,{tabId,binding:'fixture-grant',url});
        assert.equal(page.url(),url.replace('?', '/screening?'));
        return {screening:true};
      }
      assert.equal(method,'detach');
      return {};
    };
    const bindBrowser=(selectedBridge:ExtensionBridge)=>{
      Object.defineProperty(selectedBridge,'connected',{value:true});
      selectedBridge.call=fixtureCall;
    };
    bindBrowser(bridge);
    const run=async()=>{
      assert.equal((await post('/jobs/'+restored.id+'/action',{action:'retry'})).status,200);
      const deadline=Date.now()+15000;
      while(app.queue.snapshot().jobs.some(job=>job.id===restored.id && (job.actionPending || job.status==='queued')) &&
          Date.now()<deadline) await delay(30);
      assert.equal(restored.status,'paused');
    };
    await run();
    assert.equal(attachments,0);
    current=url.replace(uuid,'22222222-2222-4222-8222-222222222222');
    await run();
    assert.equal(attachments,0);
    current=url; returnedLoader='stale-loader';
    await run();
    assert.equal(attachments,1);
    assert.equal(connections,0);
    assert.equal(await page.locator('input[type=email]').inputValue(),'');
    returnedLoader=loader;
    const prior=await page.context().newCDPSession(page);
    const {executionContextId}=await prior.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:pageFillWorld});
    const popupFill=(input:Record<string,unknown>)=>prior.send('Runtime.callFunctionOn',{executionContextId,
      returnByValue:true,awaitPromise:true,functionDeclaration:`async function(input) { return (${pageFillSource})(input); }`,
      arguments:[{value:{expectedUrl:url,scope:'page',...input}}]});
    const facts=effectiveProfileFacts(profile);
    const first=await popupFill({facts:facts.filter(f=>f.factId!=='email_address'),matchingRunId:'popup-name',
      resume:{name:'Resume.pdf',base64:selected}});
    assert.equal(first.result.value.resume,'unverified');
    await popupFill({facts,matchingRunId:'popup-email'});
    assert.equal(await page.locator('input[type=email]').inputValue(),'fixture@example.invalid');
    const undone=await popupFill({action:'undo'});
    assert.equal(undone.result.value.canUndo,true);
    assert.equal(undone.result.value.canRedo,true);
    assert.equal(await page.locator('input[type=email]').inputValue(),'');
    const readHistory=async()=> (await renderer.send('Runtime.evaluate',{contextId:executionContextId,
      returnByValue:true,expression:`(() => {
        const {undo,redo,matchingRunId,choiceDrafts,queuedHistory} = globalThis.__huntC3PartialFill;
        const labels = stack => stack.map(batch=>batch.map(edit=>edit.label));
        return {undo:labels(undo),redo:labels(redo),matchingRunId,popupChoices:!!choiceDrafts,queued:labels(queuedHistory?.undo??[])};
      })()`})).result.value;
    const popupHistory=await readHistory();
    assert.equal(popupHistory.undo.length,1);
    assert.equal(popupHistory.redo.length,1);
    const digest=await prior.send('Runtime.evaluate',{contextId:executionContextId,returnByValue:true,
      expression:'globalThis.__huntC3PartialFill.resumeAttempt.fileSha256'});
    const setReceiptHash=(sha:string)=>prior.send('Runtime.evaluate',{contextId:executionContextId,
      expression:`globalThis.__huntC3PartialFill.resumeAttempt.fileSha256 = ${JSON.stringify(sha)}`});
    await setReceiptHash('0'.repeat(64));
    await page.locator('input[type=email]').fill('');
    await run();
    assert.match(restored.error??'',/attachment no longer matches/);
    assert.equal(await page.locator('input[type=email]').inputValue(),'');
    assert.equal(transitions,0);
    assert.deepEqual(await readHistory(),popupHistory);
    assert.equal(await page.evaluate(()=>document.body.dataset.uploads),'1');
    await setReceiptHash(digest.result.value);
    await page.locator('oc-personal-information').evaluate(personal=>{
      personal.insertAdjacentHTML('beforeend','<oc-location-autocomplete><spl-autocomplete label="City" data-test="location-autocomplete"></spl-autocomplete></oc-location-autocomplete>');
      const host=personal.querySelector('spl-autocomplete')!;
      const shadow=host.attachShadow({mode:'open'});
      shadow.innerHTML='<input aria-label="City*" required role=combobox aria-autocomplete=list aria-controls="locations" aria-expanded=false aria-invalid=true>' +
        '<spl-icon role=button aria-label="Clear City value" hidden>Clear</spl-icon><div id="locations" role=listbox hidden></div>';
      const input=shadow.querySelector('input')!, menu=shadow.querySelector<HTMLElement>('#locations')!, clear=shadow.querySelector<HTMLElement>('spl-icon')!;
      const close=()=>{input.setAttribute('aria-expanded','false');menu.hidden=true;};
      input.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
      input.addEventListener('input',()=>{
        menu.replaceChildren();
        if(!input.value){close();return;}
        input.setAttribute('aria-expanded','true');menu.hidden=false;
        const label='Example, Ontario, Canada', option=document.createElement('spl-select-option');
        option.innerHTML='<div class="c-spl-autocomplete-default-option"><div data-sr-id="example-content"><spl-truncate title="'+label+'">'+label+'</spl-truncate></div></div>';
        const item=document.createElement('spl-dropdown-item');
        option.attachShadow({mode:'open'}).append(item);
        item.innerHTML='<slot></slot>';
        const itemShadow=item.attachShadow({mode:'open'});
        itemShadow.innerHTML='<div role=option><slot></slot></div>';
        itemShadow.querySelector('[role=option]')!.addEventListener('click',()=>{
          input.value=label;host.setAttribute('value','[object Object]');clear.hidden=false;
          input.setAttribute('aria-invalid','false');document.body.dataset.city=label;close();
        });
        menu.append(option);
      });
    });
    await prior.detach();
    await run();
    assert.equal(connections,2);
    assert.equal(transitions,1,restored.error);
    assert.match(restored.error??'',/employer Review screen is open/);
    const afterQueue=await readHistory();
    assert.deepEqual({...afterQueue,queued:[]},popupHistory);
    assert.deepEqual(afterQueue.queued,[['Email','City*']]);
    assert.equal(await page.locator('input').inputValue(),'Fixture');
    assert.deepEqual(await page.evaluate(()=>({...document.body.dataset})),{uploaded:'%PDF-selected-default',uploads:'1',city:'Example, Ontario, Canada',next:'clicked'});
    assert.equal(restored.selectedApplicationUrl,screeningUrl);
    assert.equal(await page.locator('input').inputValue(),'Fixture');

    await app.close();
    app=await startProductServer({root,port:0});
    const restartedBridge=(app.queue as unknown as {bridge:ExtensionBridge}).bridge;
    restored=app.queue.jobs.find(entry=>entry.id===job.id)!;
    assert.equal(restored.tabId,undefined);
    assert.equal(restored.selectedApplicationUrl,screeningUrl);
    current=screeningUrl;
    bindBrowser(restartedBridge);
    await run();
    assert.equal(connections,2);
    observe();
    inspectedUrl=screeningUrl;
    assert.equal((await prepare(screeningUrl+'&other=1')).status,400);
    tabId=9; loader='screening-loader'; returnedLoader=loader;
    assert.equal((await prepare(screeningUrl)).status,200);
    assert.equal(restored.selectedDocument,loader);
    bindBrowser(restartedBridge);
    await page.locator('input').fill('');
    await run();
    assert.equal(connections,3);
    assert.equal(transitions,1);
    assert.equal(await page.locator('input').inputValue(),'Fixture');
    assert.equal(readFileSync(stored,'utf8'),original);
    assert.deepEqual(await page.evaluate(()=>({...document.body.dataset})),{uploaded:'%PDF-selected-default',uploads:'1',city:'Example, Ontario, Canada',next:'clicked'});
  } finally {
    globalThis.fetch=realFetch;
    chromium.connectOverCDP=realConnect;
    await app.close();
    await browser?.close();
  }
});
