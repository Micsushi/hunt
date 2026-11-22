import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser, Page } from 'playwright';
import { ApplicationQueue } from '../../src/product/queue.ts';
import { applicantProfile } from '../../src/product/sources.ts';
import { AttachmentFailure } from '../../src/product/extension-bridge.ts';
import { viewportCleanupPending } from '../../extension/page-viewport.js';

test('failed viewport cleanup remains visible on the paused draft',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hunt-cleanup-failure-'));
  const queue=new ApplicationQueue(root,{connected:true,
    open:async()=>({page:{} as Page,browser:{close:async()=>{}} as Browser,tabId:7}),
    release:async()=>{throw new Error(viewportCleanupPending);},
  },async()=>{throw new Error('fixture application failure');});
  try{
    queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from('%PDF-fixture').toString('base64'));
    const [job]=queue.add([{url:'https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1'}]);
    for(let i=0;i<40&&job!.error!==viewportCleanupPending;i++)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(job!.status,'paused');assert.equal(job!.error,viewportCleanupPending);
  }finally{await queue.close();await rm(root,{recursive:true,force:true});}
});

test('attachment failures retain only fixed categories before opening any application',async()=>{
  const protectedTab = 'Cannot access a chrome-extension:// URL of different extension';
  for(const [message,category,accountOpened] of [
    ['Another debugger is already attached to the tab with id: 123.','debugger_already_attached',false],
    ['This tab is already running.','c3_attachment_busy',false],['fixture secret unexpected value','attachment_unknown',false],
    [protectedTab,'debugger_protected_extension',true],[protectedTab,'debugger_protected_extension',false],
  ] as const){
    const root=await mkdtemp(join(tmpdir(),'hunt-attach-failure-'));
    const queue=new ApplicationQueue(root,{connected:true,...(accountOpened && {prepareAccount:async()=>{}}),open:async()=>{throw new AttachmentFailure(new Error(message));},release:async()=>{}},async()=>{assert.fail('No filling after attachment failure');});
    try{
      queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from('%PDF-fixture').toString('base64'));
      const [job]=queue.add([{url:'https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1'}]);
      for(let i=0;i<40&&job!.status!=='paused';i++)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(job!.status,'paused');
      const dir=join(root,'learning',job!.id),[run]=await readdir(dir);
      const receipt=await readFile(join(dir,run!,'run-failure.json'),'utf8'),report=JSON.parse(receipt);
      assert.deepEqual(report.componentFailure,{component:'browser_interaction',operation:'open_tab'});
      assert.deepEqual(job!.componentFailure,report.componentFailure);
      assert.equal(report.stage,accountOpened ? 'Connecting to the Workday application' : 'Opening application');assert.equal(report.operation,'browser.attach');assert.equal(report.category,category);
      if (message===protectedTab) {
        assert.equal(job!.error!.includes('Workday opened the application.'),accountOpened);
        assert.match(job!.error!,/Chrome is protecting another extension/);
        assert.match(job!.error!,/If an extension popup is open, dismiss it and retry/);
        assert.match(job!.error!,/continue in the employer tab/);
        assert.doesNotMatch(job!.error!,/sign.in manually/i);
      }
      assert.doesNotMatch(receipt,/fixture secret|tab with id|fixture@example/);
    }finally{await queue.close();await rm(root,{recursive:true,force:true});}
  }
});

test('unexpected browser failures record only a bounded operation and safe source locations',async()=>{
  const root = await mkdtemp(join(tmpdir(),'hunt-run-failure-'));
  let released = false;
  const queue = new ApplicationQueue(root,{
    connected:true,
    open:async()=>({page:{} as Page,browser:{close:async()=>{}} as Browser,tabId:1}),
    release:async()=>{released=true;},
  },async (_page,_input,_signal,progress)=>{
    progress('Signing in');
    const failure = new Error('locator.fill: strict mode violation: fixture secret input fragment');
    failure.stack += '\n    at fixture (C:/private/folder/playwright-account-page.ts:172:57)';
    throw failure;
  });
  try {
    queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),
      Buffer.from('%PDF-fixture').toString('base64'));
    const [job] = queue.add([{url:'https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1'}]);
    const dir=join(root,'learning',job!.id);
    await assert.doesNotReject(async()=>{
      for (let i=0; i<40 && (!released || job!.status!=='paused'); i++) {
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.equal(job!.status,'paused');
      assert.equal(released,true);
    });
    const [run] = await readdir(dir);
    const receipt = await readFile(join(dir,run!,'run-failure.json'),'utf8');
    const report = JSON.parse(receipt);
    assert.equal(report.stage,'Signing in');
    assert.equal(report.operation,'locator.fill');
    assert.equal(report.category,'ambiguous_control');
    assert.ok(report.sourceFrames.includes('playwright-account-page.ts:172:57'));
    assert.doesNotMatch(receipt,/fixture secret|private\/folder|fixture@example/);
    assert.doesNotMatch(job!.error ?? '',/fixture secret|strict mode/);
  } finally {
    await queue.close();
    await rm(root,{recursive:true,force:true});
  }
});
