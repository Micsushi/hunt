import assert from 'node:assert/strict';
import test from 'node:test';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type BrowserContext} from 'playwright';
import {startProductServer} from '../../src/product/server.ts';
import {fixtureApplicantProfile} from './fixture.ts';
import {type ExtensionBridge, verifiedScreeningTransition} from '../../src/product/extension-bridge.ts';

test('real extension binds Rippling documents and only permits the verified SmartRecruiters screening transition', {timeout:90000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'c3-existing-target-'));
  const service=await startProductServer({root:join(root,'service'),port:0});
  const extension=join(root,'extension');cpSync(resolve('extension'),extension,{recursive:true});
  for(const name of ['manifest.json','background.js','popup.js','website-handoff.js']){
    const file=join(extension,name);writeFileSync(file,readFileSync(file,'utf8').replaceAll('47831',new URL(service.origin).port));
  }
  let context:BrowserContext|undefined;
  const protectedWidget=join(root,'password-widget');
  mkdirSync(protectedWidget);
  const widgetSites=['https://careers-example.icims.com/*','https://custom.example.invalid/*'];
  writeFileSync(join(protectedWidget,'manifest.json'),JSON.stringify({manifest_version:3,name:'Fixture password suggestion',version:'1.0',
    content_scripts:[{matches:widgetSites,js:['suggestion.js']}],web_accessible_resources:[{resources:['suggestion.html'],matches:widgetSites}]}));
  writeFileSync(join(protectedWidget,'suggestion.js'),`if(location.pathname.startsWith('/protected/')){
    const show=()=>{const frame=document.createElement('iframe');frame.title='Fixture password manager';frame.src=chrome.runtime.getURL('suggestion.html');document.body.append(frame);};
    if(location.pathname.endsWith('/login'))document.addEventListener('fixture-focus-email',show,{once:true});else show();
  }`);
  writeFileSync(join(protectedWidget,'suggestion.html'),'<label>Email<input type=email value="untouched@example.invalid"></label>');
  // Model a toolbar site grant for an arbitrary host, outside the static ATS list.
  const mp=join(extension,'manifest.json'),manifest=JSON.parse(readFileSync(mp,'utf8'));
  manifest.host_permissions.push(widgetSites[1]);writeFileSync(mp,JSON.stringify(manifest));
  const extensions=extension+','+protectedWidget;
  try{
    context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${extensions}`,`--load-extension=${extensions}`]});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    await worker.evaluate(async token=>{await (globalThis as any).chrome.storage.local.set({token});},readFileSync(service.tokenPath,'utf8').trim());
    const popup=await context.newPage();await popup.goto(worker.url().replace(/background\.js$/,'popup.html'));
    await popup.evaluate(()=>(globalThis as any).chrome.runtime.sendMessage({action:'connect'}));
    for(let i=0;i<100&&!service.queue.snapshot().connected;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(service.queue.snapshot().connected,true);
    const resume=Buffer.from('%PDF-1.4\nOne-click fixture');
    service.queue.configure(fixtureApplicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),resume.toString('base64'));
    const posting='https://ats.rippling.com/fixture/jobs/68057679-c967-4707-9423-ea2db74de7c5?jobSite=Indeed';
    const application=posting.replace('?','/apply?')+'&step=application';
    await context.route('https://ats.rippling.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture application</title><label>First name<input></label>'}));
    const offerUrl='https://job-boards.greenhouse.io/fixture/jobs/123';
    await context.route(offerUrl,route=>route.fulfill({contentType:'text/html',body:`<form onsubmit="window.submitted=true;return false">
      <label>First name<input required autocomplete=given-name></label><label>Email<input required type=email></label>
      <label>Resume<input required type=file accept=".pdf"></label><label>Transcript<input required type=file></label>
      <button>Submit application</button></form>`}));
    const page=await context.newPage();await page.goto(offerUrl);
    const invitation=page.getByRole('complementary',{name:'Hunt C3'});
    // The consent control is in the extension's closed shadow root. Exercise
    // its accessible button with a real browser click in this fixture.
    const clickOffer=async(name:string)=>{
      await invitation.waitFor();
      const session=await context!.newCDPSession(page);
      try {
        const {nodes}=await session.send('Accessibility.getFullAXTree');
        const node=nodes.find(node=>node.role?.value==='button' && node.name?.value===name);
        assert.ok(node?.backendDOMNodeId,name);
        const {model}=await session.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});
        const [left,top,,,right,bottom]=model.border;
        assert.ok(left!==undefined && top!==undefined && right!==undefined && bottom!==undefined);
        await page.mouse.click((left+right)/2,(top+bottom)/2);
      } finally {await session.detach();}
    };
    await invitation.waitFor();
    assert.equal(await page.getByLabel('First name').inputValue(),'','the invitation never fills by itself');
    const popupCount=()=>worker.evaluate(async ()=>(await (globalThis as any).chrome.runtime.getContexts({contextTypes:['POPUP']})).length);
    assert.equal(await popupCount(),0,'visiting the ATS must not open the toolbar');
    await worker.evaluate(()=>(globalThis as any).chrome.action.openPopup());
    await invitation.waitFor({state:'detached',timeout:5000});
    assert.equal(await page.getByLabel('First name').inputValue(),'','opening the toolbar never starts a fill');
    await popup.evaluate(()=>(globalThis as any).chrome.extension.getViews({type:'popup'})[0].close());
    await clickOffer('Fill current page');
    await invitation.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[autocomplete=given-name]')?.value==='Fixture');
    await page.locator('#hunt-c3-field-review').waitFor();
    assert.equal(await popupCount(),0,'one confirmed click fills without opening the toolbar');
    assert.equal(await page.getByLabel('Email').inputValue(),'fixture@example.invalid');
    assert.equal(await page.getByLabel('Resume').evaluate((e:HTMLInputElement)=>e.files?.[0]?.text()),resume.toString());
    assert.equal(await page.getByLabel('Transcript').evaluate((e:HTMLInputElement)=>e.files?.length),0);
    assert.equal(await page.evaluate(()=>Boolean((window as any).submitted)),false);
    const offerTabId=await worker.evaluate(async url=>(await (globalThis as any).chrome.tabs.query({})).find((tab:any)=>tab.url===url).id,offerUrl);
    const fillHistoryResponse=await fetch(service.origin+'/browser/page-fill-log',{method:'POST',headers:{
      Authorization:'Bearer '+readFileSync(service.tokenPath,'utf8').trim(),'Content-Type':'application/json'},
      body:JSON.stringify({tabId:offerTabId,expectedUrl:offerUrl})});
    assert.ok(fillHistoryResponse.ok);
    assert.equal((await fillHistoryResponse.json()).runs.length,1,'one invitation click records exactly one fill');
    const candidate='https://careers-example.icims.com/jobs/123/candidate';
    await context.route(candidate,route=>route.fulfill({contentType:'text/html',body:'<form aria-label="Newsletter"><label>Email<input type=email></label></form><iframe title="Application" src="/embed"></iframe>'}));
    await context.route('https://careers-example.icims.com/embed',route=>route.fulfill({contentType:'text/html',body:'<form><label>First name<input readonly></label><label>Country<select disabled><option>Select</option></select></label><label>Unrecognized question<input></label></form>'}));
    await page.goto(candidate);
    const embedded=page.frameLocator('iframe').getByLabel('First name');
    await embedded.waitFor();
    await page.waitForTimeout(350);
    assert.equal(await invitation.count(),0,'newsletter, read-only, disabled, and unsupported fields cannot trigger an offer');
    await embedded.evaluate(e=>e.removeAttribute('readonly'));
    await invitation.waitFor();
    await embedded.fill('Existing');
    await invitation.waitFor({state:'detached'});
    await embedded.fill('');
    await clickOffer('Dismiss invitation');
    await embedded.fill('Existing');
    await embedded.fill('');
    await page.waitForTimeout(350);
    assert.equal(await invitation.count(),0,'dismissal survives changes on the same application');
    await page.evaluate(()=>history.pushState({},'','/jobs/456/candidate'));
    await invitation.waitFor();
    await page.goto(application);
    const tabId=await worker.evaluate(async url=>(await (globalThis as any).chrome.tabs.query({})).find((t:any)=>t.url===url).id,application);
    const bridge=(service.queue as unknown as {bridge:ExtensionBridge}).bridge;
    for(const site of widgetSites){
      const login=site.includes('icims');
      const employer=site.replace('*','protected/'+(login?'login':'form'));
      const form=employer+'/embedded';
      const unrelated='https://unrelated.example.invalid/widget';
      await context.route(unrelated,route=>route.fulfill({contentType:'text/html',body:'<label>Email<input type=email></label>'}));
      await context.route(employer,route=>route.fulfill({contentType:'text/html',body:'<iframe title="Employer application" src="'+form+'"></iframe>'+
        (login?'':'<iframe title="Third party" src="'+unrelated+'"></iframe>')}));
      await context.route(form,route=>route.fulfill({contentType:'text/html',body:'<form><label>Email<input type=email required></label><button type=button>Next</button></form>'}));
      await page.goto(employer);
      const widget=page.frameLocator('iframe[title="Fixture password manager"]').getByLabel('Email');
      if(!login)await widget.waitFor();
      const email=page.frameLocator('iframe[title="Employer application"]').getByLabel('Email');
      const action=(operation:string,documentId?:string)=>popup.evaluate(args=>(globalThis as any).chrome.runtime.sendMessage({action:'pageAction',...args}),{tabId,expectedUrl:employer,operation,documentId});
      const inspected=await action('inspect');
      assert.equal(inspected.ok,true,inspected.error);
      const doc=inspected.result.documentId;
      assert.match(doc,/^employer-/);
      if(login){
        await page.evaluate(()=>document.dispatchEvent(new Event('fixture-focus-email')));
        await widget.waitFor();
      }else assert.ok(inspected.result.frames.some((frame:any)=>frame.status==='unavailable'));
      const target=inspected.result.requiredIssues.find((field:any)=>field.label==='Email');
      assert.ok(target);
      const reveal=await popup.evaluate(args=>(globalThis as any).chrome.runtime.sendMessage(args),
        {action:'revealIssue',tabId,expectedUrl:employer,documentId:doc,frameId:target.frameId,fieldId:target.fieldId});
      assert.equal(reveal.ok,true,reveal.error);
      for(const [operation,value] of [['fill','fixture@example.invalid'],['undo',''],['redo','fixture@example.invalid']] as const){
        const result=await action(operation,doc);
        assert.equal(result.ok,true,result.error);
        assert.equal(await email.inputValue(),value);
      }
      assert.equal(await widget.inputValue(),'untouched@example.invalid');
      if(!login){
        assert.equal(await page.frameLocator('iframe[title="Third party"]').getByLabel('Email').inputValue(),'');
        await page.locator('iframe[title="Third party"]').evaluate(frame=>frame.setAttribute('hidden',''));
        assert.equal((await action('inspect')).result.frames.some((frame:any)=>frame.status==='unavailable'),false);
      }
      await page.locator('iframe[title="Fixture password manager"]').evaluate(frame=>frame.remove());
      assert.equal((await action('inspect')).result.documentId,doc);
      await page.reload();
      assert.equal((await action('undo',doc)).ok,false);
    }
    const issuesUrl='https://fixture.example.invalid/issue-review', childUrl=issuesUrl+'/address';
    await context.route(childUrl,route=>route.fulfill({contentType:'text/html',body:`<form>
      <fieldset><legend>Address</legend><label>State/Province<select required><option value="-1">Please select a country</option></select></label></fieldset>
      <label>Transcript<input type=file required></label><div role=combobox aria-label="Office" aria-required=true></div>
      <label>Country<input required value="Canada"></label><label>Hidden<input required hidden></label>
      <label>Optional<input></label><button>Continue</button></form><style>[role=combobox]{height:30px}</style>`}));
    await context.route(issuesUrl,route=>route.fulfill({contentType:'text/html',body:`<form>
      <label>First name<input autocomplete=given-name></label><label>Email<input type=email></label>
      <label>Email/Login<input type=email required value="bad"></label><label>Password<input type=password required autocomplete=new-password></label>
      <label>Password (Re-enter)<input type=password required value="private-fixture"></label></form>
      <form><label>Newsletter email<input type=email required></label></form>
      <form><label>Cover letter<input type=file required></label></form>
      <iframe title="Address" src="${childUrl}"></iframe>`}));
    await page.goto(issuesUrl);
    const inspected=await bridge.call('pageAction',{operation:'inspect',tabId,expectedUrl:issuesUrl});
    assert.equal(await invitation.count(),0,'a non-ATS page with application fields only supports the manual toolbar');
    type Issue={fieldId:string;frameId:string;label:string;section?:string;reason:string};
    const issues:Issue[]=inspected.requiredIssues;
    assert.deepEqual(issues.map(i=>[i.label,i.reason]),[
      ['Email/Login','required_invalid'],['Password','required_empty'],['Cover letter','required_empty'],['State/Province','required_empty'],
      ['Transcript','required_empty'],['Office','required_unconfirmed']]);
    assert.doesNotMatch(JSON.stringify(issues),/private-fixture/);
    const child=page.frameLocator('iframe');
    const province=issues.find(i=>i.label==='State/Province')!;
    assert.equal(province.section,'Address');
    const locate=(issue:Issue)=>popup.evaluate(args=>(globalThis as any).chrome.runtime.sendMessage(args),
      {action:'revealIssue',tabId,expectedUrl:issuesUrl,documentId:inspected.documentId,frameId:issue.frameId,fieldId:issue.fieldId});
    assert.equal((await locate(province)).ok,true);
    assert.equal(await child.getByLabel('State/Province').evaluate(e=>e.getAnimations().length>0),true);
    assert.equal(await child.getByLabel('State/Province').inputValue(),'-1');
    await child.getByLabel('State/Province').evaluate((e:HTMLSelectElement)=>e.replaceChildren(new Option('Alberta','AB',true,true)));
    assert.equal((await locate(province)).ok,false,'a resolved control cannot be highlighted as missing');
    await page.reload();
    assert.equal((await locate(province)).ok,false,'a stale document cannot reveal controls');
    await page.goto(application);
    const session=await bridge.open(posting,tabId,true);
    assert.equal(session.page.url(),application);assert.equal((await bridge.call('info',{tabId})).url,application);
    await page.reload();
    await assert.rejects(bridge.call('info',{tabId}),/document changed/);
    assert.equal(await page.locator('input').inputValue(),'');
    await bridge.release(tabId);await session.browser.close();
    await bridge.focus(tabId,posting);

    const uuid='11111111-1111-4111-8111-111111111111';
    const source='https://jobs.smartrecruiters.com/Fixture/123456-title';
    const base='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/'+uuid;
    const query='?dcr_ci=Fixture', personal=base+query, screening=base+'/screening'+query;
    await context.route('https://jobs.smartrecruiters.com/**',route=>route.fulfill({contentType:'text/html',body:'<main>Fixture application</main>'}));
    t.mock.method(globalThis,'fetch',async (url:unknown)=>{
      assert.equal(String(url),'https://api.smartrecruiters.com/v1/companies/Fixture/postings/123456');
      return Response.json({id:'123456',company:{identifier:'Fixture'},uuid,active:true});
    });
    await page.goto(personal);
    const unverified=await bridge.open(personal,tabId,true);
    assert.throws(()=>verifiedScreeningTransition(unverified.page,personal),/verified SmartRecruiters posting/);
    await bridge.release(tabId);await unverified.browser.close();
    const previous=await bridge.open(source,tabId,true);
    const stale=verifiedScreeningTransition(previous.page,personal);
    await bridge.release(tabId);await previous.browser.close();
    const delayed=await bridge.open(source,tabId,true);
    await assert.rejects(stale(),/tab changed/);
    await verifiedScreeningTransition(delayed.page,personal)();
    assert.equal((await bridge.call('info',{tabId})).url,personal);
    await page.evaluate(path=>history.pushState({},'',path),screening);
    assert.equal((await bridge.call('info',{tabId})).url,screening);
    await bridge.release(tabId);await delayed.browser.close();
    for (const destination of [screening,screening.replace('/Fixture/','/Other/'),screening.replace(uuid,'2'+uuid.slice(1)),base+'/other'+query,screening+'&extra=yes','reload']) {
      await page.goto(personal);
      const bound=await bridge.open(source,tabId,true);
      try {
        const grant=verifiedScreeningTransition(bound.page,personal);
        if (destination==='reload') await page.goto(screening);
        else await page.evaluate(path=>history.pushState({},'',path),destination);
        if (destination===screening) {
          await assert.rejects(bridge.call('info',{tabId}),/document changed/);
          await worker.evaluate(({tabId,personal})=>{
            // The tab API briefly still reports the personal page after CDP observes the screening route.
            const tabs=(globalThis as any).chrome.tabs, original=tabs.get.bind(tabs);
            tabs.get=async (id:number)=>{
              const snapshot=await original(id);
              if (id!==tabId) return snapshot;
              tabs.get=original;
              return {...snapshot,url:personal};
            };
          },{tabId,personal});
          await grant();
          assert.equal((await bridge.call('info',{tabId})).url,screening);
          assert.equal(await bound.page.locator('main').textContent(),'Fixture application');
          await assert.rejects(grant(),/no longer available/);
          await assert.rejects(bridge.call('cdp',{tabId,method:'Page.reload'}),/must stay on the current page/);
          await page.evaluate(path=>history.pushState({},'',path),personal);
          await assert.rejects(bridge.call('info',{tabId}),/document changed/);
        } else {
          await assert.rejects(grant(),/left the verified application route|document changed/);
          await assert.rejects(bridge.call('info',{tabId}),/document changed/);
        }
      } finally {await bridge.release(tabId);await bound.browser.close();}
    }
  }finally{await context?.close();await service.close();}
});
