import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {accountJournal} from '../../src/product/account-journal.ts';
import {prepareWorkdayAccount} from '../../src/product/workday-sign-in.ts';
import {fillApplication} from '../../src/product/engine.ts';
import {applicantProfile} from '../../src/product/sources.ts';
import {accountFixture} from './fixture.ts';
import {PlaywrightAccountPageAdapter} from '../../src/browser/playwright-live/private/playwright-account-page.ts';

test('delayed transition from Create Account to Sign In opens the link once', async () => {
  const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';
  for (const existingResponse of [false,true]) {
    let creating=existingResponse, opened=0, readsAfterOpen=0, signedIn=false;
    const clicks:string[]=[];
    const events:string[]=[];
    await prepareWorkdayAccount(async (method, request={})=>{
      if (method==='agentStatus') return {capabilities:['workday-account-v1','workday-page-v1','workday-create-account-v1']};
      switch (request.operation) {
        case 'begin': return {tabId:1};
        case 'inspect': {
          const state=signedIn ? 'application' : opened && ++readsAfterOpen>1 ? 'sign_in' :
            existingResponse && !creating ? 'account_exists' : 'create_account';
          return {state, documentId:'same-document', url, ready:true, clickReady:true};
        }
        case 'fill': return {state:'filled',verified:true};
        case 'navigate': assert.equal(request.action,'show_sign_in'); opened++; return {state:'navigated'};
        case 'click':
          clicks.push(String(request.accountMode));
          if (request.accountMode==='create') creating=false; else signedIn=true;
          return {state:'clicked'};
        case 'end': return {};
        default: throw new Error('Unexpected account operation');
      }
    },{url,signal:AbortSignal.timeout(10000),preferCreate:existingResponse,credentials:{email:'fixture@example.invalid',password:'synthetic'},record:event=>events.push(event),onTab:()=>{}});
    assert.equal(opened,1);
    assert.deepEqual(clicks,existingResponse ? ['create','sign_in'] : ['sign_in']);
    assert.equal(events.filter(event=>event==='account_exists').length,Number(existingResponse));
    assert.ok(events.includes('application_opened'));
  }
});

test('account journal preserves attempted effects atomically and rejects values outside its catalog',()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-account-journal-'));
  const record=accountJournal(root,'job-fixture','run-fixture');
  record('sign_in_attempted');record('sign_in_attempted','submit_click_succeeded');record('sign_in_uncertain');
  const file=join(root,'account-actions','job-fixture','run-fixture.json');
  const before=readFileSync(file,'utf8');
  assert.deepEqual(JSON.parse(before).events.map((event:any)=>event.event),['sign_in_attempted','sign_in_attempted','sign_in_uncertain']);
  assert.throws(()=>record('sign_in_attempted','email=private@example.invalid'));
  assert.throws(()=>record('private@example.invalid' as any));
  assert.equal(readFileSync(file,'utf8'),before);
  const broken=accountJournal(root,'blocked-job','blocked-run');
  mkdirSync(join(root,'account-actions','blocked-job','blocked-run.json'),{recursive:true});
  assert.throws(()=>broken('sign_in_attempted'));
  assert.equal(readFileSync(file,'utf8'),before);
});

test('missing or failed durable history prevents even credential filling', {timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const recorder of [undefined,()=>{throw new Error('private storage detail');}]) {
      const page=await browser.newPage();
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:accountFixture}));
      const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';await page.goto(url);
      await assert.rejects(fillApplication(page,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),resume:Buffer.from('%PDF-fixture'),credentials:{email:'fixture@example.invalid',password:'Synthetic-only-123!'},recordAccountAction:recorder},AbortSignal.timeout(10000),()=>{}),/Account history could not be saved/);
      assert.equal(await page.locator('[data-automation-id="email"]').inputValue(),'');
      assert.equal(await page.locator('[data-automation-id="password"]').inputValue(),'');
      assert.equal(await page.evaluate("sessionStorage.getItem('created')"),null);
      await page.close();
    }
  }finally{await browser.close();}
});

test('verification and reset gates never invoke a configured mailbox callback', {timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const html of ['<section data-automation-id="emailVerificationPage">Verify your account</section>', '<input data-automation-id="email"><button data-automation-id="resetPasswordButton">Reset Password</button>']) {
      const page=await browser.newPage();let mailbox=0;const events:string[]=[];
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
      const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';await page.goto(url);
      await assert.rejects(fillApplication(page,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),resume:Buffer.from('%PDF-fixture'),credentials:{email:'fixture@example.invalid',password:'Synthetic-only-123!'},verifyEmail:async()=>{mailbox++;},recordAccountAction:event=>events.push(event)},AbortSignal.timeout(10000),()=>{}),/requires (email verification|a password reset)/);
      assert.equal(mailbox,0);assert.equal(events.length,1);assert.match(events[0]!,/blocked$/);
      await page.close();
    }
  }finally{await browser.close();}
});

test('journal failure immediately before or after sign-in never repeats an uncertain effect', {timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const failAt of ['sign_in_attempted','sign_in_diagnostic']) {
      const root=mkdtempSync(join(tmpdir(),'c3-account-effect-'));
      const persist=accountJournal(root,'fixture-job','fixture-run');
      const page=await browser.newPage();
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:accountFixture}));
      const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';await page.goto(url);
      await page.evaluate(()=>{(window as any).clicks=0;document.querySelector('[data-automation-id="click_filter"]')!.addEventListener('click',()=>{(window as any).clicks++;});});
      await assert.rejects(fillApplication(page,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),resume:Buffer.from('%PDF-fixture'),credentials:{email:'fixture@example.invalid',password:'Synthetic-only-123!'},recordAccountAction:(event,trace)=>{
        if(event===failAt)throw new Error('private storage failure');persist(event,trace);
      }},AbortSignal.timeout(12000),()=>{}),/Account history could not be saved/);
      assert.equal(await page.evaluate('clicks'),failAt==='sign_in_attempted'?0:1);
      const text=readFileSync(join(root,'account-actions','fixture-job','fixture-run.json'),'utf8');
      assert.equal(text.includes('fixture@example.invalid'),false);assert.equal(text.includes('Synthetic-only'),false);
      const events=JSON.parse(text).events.map((event:any)=>event.event);
      assert.deepEqual(events,failAt==='sign_in_attempted'?['sign_in_fields_started']:['sign_in_fields_started','sign_in_attempted']);
      await page.close();
    }
  }finally{await browser.close();}
});

test('a runtime error after a sign-in attempt cannot trigger outer reload and a second account action', {timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true});
  const activate=PlaywrightAccountPageAdapter.prototype.activate;
  try {
    const page=await browser.newPage();let loads=0,clicks=0;
    await page.exposeFunction('signedInClick',()=>{clicks++;});
    const html=accountFixture.replace("()=>document.querySelector('#error').innerHTML='<p data-automation-id=\"accountNotFoundError\">Account not found</p>'",'()=>{signedInClick();profile();}');
    await page.route('**/*',route=>{loads++;return route.fulfill({contentType:'text/html',body:html});});
    const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';await page.goto(url);
    PlaywrightAccountPageAdapter.prototype.activate=async function(target,action){
      await activate.call(this,target,action);
      if(action==='submit_sign_in')await page.setContent('<h1>Something went wrong</h1><p>Please refresh the page and then try again.</p>');
    };
    const events:string[]=[];
    await assert.rejects(fillApplication(page,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),resume:Buffer.from('%PDF-fixture'),credentials:{email:'fixture@example.invalid',password:'Synthetic-only-123!'},recordAccountAction:event=>events.push(event)},AbortSignal.timeout(20000),()=>{}),/Workday is showing a site error/);
    assert.equal(clicks,1);assert.equal(loads,1);assert.equal(events.filter(event=>event==='sign_in_attempted').length,1);
  }finally{PlaywrightAccountPageAdapter.prototype.activate=activate;await browser.close();}
});
