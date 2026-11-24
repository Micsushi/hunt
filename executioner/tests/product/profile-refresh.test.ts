import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApplicationQueue} from '../../src/product/queue.ts';
import {applicantProfile} from '../../src/product/sources.ts';
import {startProductServer} from '../../src/product/server.ts';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
const profileDigest=(queue:ApplicationQueue)=>createHash('sha256').update(JSON.stringify(queue.getSettings()!.profile)).digest('hex');

test('successive refreshes undo in order and equal revisions cannot disguise a changed profile',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-profile-refresh-history-'));
  let opens=0;
  const queue=new ApplicationQueue(root,{connected:false,open:async()=>{opens++;throw new Error('unused')},release:async()=>{}});
  const values={given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',city:'A'};
  try {
    queue.configure(applicantProfile(values),Buffer.from('%PDF-original').toString('base64'));
    const originalSettings=structuredClone(queue.getSettings()!);
    const job=queue.add([{url:'https://jobs.lever.co/fixture/12345678-abcd-1234-abcd-123456789abc',resumeBase64:Buffer.from('%PDF-selected').toString('base64'),resumeVersion:'v17'}],{paused:true})[0]!;
    const path=join(root,job.id+'.input.json'),a=readFileSync(path,'utf8');
    const originalJob=JSON.stringify(job);
    const journal=join(root, job.id+'.account-journal.json');
    writeFileSync(journal,'fixture journal');
    assert.equal(queue.snapshot().jobs[0]!.profileUpdateAvailable,false);
    const current=()=>({expectedProfileRevision:(queue.getSettings()!.profile as any).profile.revision,expectedProfileDigest:profileDigest(queue)});
    const initialIdentity=current();
    queue.configureApplicant({...values,city:'B'});const bIdentity=current();
    assert.equal(queue.snapshot().jobs[0]!.profileUpdateAvailable,true);
    await assert.rejects(queue.action(job.id,'refresh_profile',undefined,undefined,initialIdentity),/Saved profile changed/);
    assert.equal(readFileSync(path,'utf8'),a);
    const b=await queue.action(job.id,'refresh_profile',undefined,undefined,bIdentity) as any;const bInput=readFileSync(path,'utf8');
    assert.ok(b.inputDigest);
    assert.deepEqual(JSON.parse(bInput).profile,queue.getSettings()!.profile);
    assert.equal(JSON.parse(bInput).resume,JSON.parse(a).resume);
    assert.equal(JSON.stringify(job),originalJob);
    assert.equal(queue.snapshot().jobs[0]!.profileUpdateAvailable,false);
    queue.configureApplicant({...values,city:'C'});
    let c=await queue.action(job.id,'refresh_profile',undefined,undefined,current()) as any;
    for(let cycle=0;cycle<25;cycle++) {
      await queue.action(job.id,'undo_profile_refresh',undefined,undefined,c);
      c=await queue.action(job.id,'refresh_profile',undefined,undefined,current()) as any;
    }
    const history=readFileSync(join(root,job.id+'.profile-refresh.json'),'utf8');
    assert.equal(JSON.parse(history).entries.length,2);assert.doesNotMatch(history,/%PDF|JVBERi/);
    await queue.action(job.id,'undo_profile_refresh',undefined,undefined,c);assert.equal(readFileSync(path,'utf8'),bInput);
    await queue.action(job.id,'undo_profile_refresh',undefined,undefined,b);assert.equal(readFileSync(path,'utf8'),a);
    queue.configure(originalSettings.profile,originalSettings.resume);queue.configureApplicant({...values,city:'Different B'});
    assert.equal(current().expectedProfileRevision,bIdentity.expectedProfileRevision);
    await assert.rejects(queue.action(job.id,'refresh_profile',undefined,undefined,bIdentity),/Saved profile changed/);
    assert.equal(readFileSync(path,'utf8'),a);
    const latest=await queue.action(job.id,'refresh_profile',undefined,undefined,current()) as any;
    const newer={...JSON.parse(readFileSync(path,'utf8')),newer:true};
    writeFileSync(path,JSON.stringify(newer));
    await assert.rejects(queue.action(job.id,'undo_profile_refresh',undefined,undefined,latest),/newer details were kept/);
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),newer);
    for(const status of ['running','queued','review','submitting','removed'] as const) {
      job.status=status;
      await assert.rejects(queue.action(job.id,'refresh_profile',undefined,undefined,current()),/Wait for this application to pause/);
    }
    job.status='paused';
    for(const active of [(queue as any).running,(queue as any).reviewActions]){
      if(active instanceof Map) active.set(job.id,{}); else active.add(job.id);
      try {
        await assert.rejects(queue.action(job.id,'refresh_profile',undefined,undefined,current()),/Wait for this application to pause/);
      } finally {active.delete(job.id);}
    }
    assert.equal(readFileSync(journal,'utf8'),'fixture journal');
    assert.equal(opens,0);
  } finally {await queue.close();}
});

test('Use saved profile updates a paused draft through the normal UI and supports Undo/Redo', {timeout:45000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-profile-refresh-ui-'));
  const service=await startProductServer({root,port:0});
  const browser=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try {
    const values={given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',city:'Before'};
    service.queue.configure(applicantProfile(values),Buffer.from('%PDF-default').toString('base64'));
    const job=service.queue.add([{url:'https://jobs.lever.co/fixture/12345678-abcd-1234-abcd-123456789abc',resumeBase64:Buffer.from('%PDF-selected').toString('base64')}],{paused:true})[0]!;
    const path=join(root,job.id+'.input.json'),before=readFileSync(path,'utf8');
    service.queue.configureApplicant({...values,city:'After'});
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto(service.origin+'/#token='+encodeURIComponent(readFileSync(service.tokenPath,'utf8').trim()));
    const firstName = page.getByRole('textbox',{name:'First name',exact:true});
    await firstName.fill('');
    await page.getByRole('link',{name:'Disclosures',exact:true}).click();
    await page.getByRole('button',{name:'Save profile',exact:true}).click();
    assert.equal(await firstName.evaluate(input => input === document.activeElement),true);
    await firstName.fill(values.given_name);
    await page.getByRole('link',{name:'Disclosures',exact:true}).click();
    const consent = page.getByLabel('Allow AI screening of my application when an employer requires an answer',{exact:true});
    await consent.waitFor();
    assert.equal(await consent.inputValue(),'');
    for(const choice of ['true','false','']) {
      await consent.selectOption(choice);
      await page.getByRole('button',{name:'Save profile',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#profile-status')?.textContent==='Saved on this device');
      const facts = (service.queue.getSettings()!.profile as any).profile.facts;
      assert.equal(facts.find((fact:any)=>fact.factId==='ai_evaluation_consent')?.value,choice===''?undefined:choice==='true');
      assert.equal(readFileSync(path,'utf8'),before);
    }
    await page.getByRole('button',{name:'Applications',exact:true}).click();
    await page.getByRole('button',{name:'Use saved profile',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#notice')?.textContent?.includes('Saved profile applied'));
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).profile,service.queue.getSettings()!.profile);
    assert.equal(service.queue.jobs[0]!.status,'paused');
    await page.locator('#undo').click();await page.waitForFunction(()=>document.querySelector('#notice')?.textContent==='Change undone');
    assert.equal(readFileSync(path,'utf8'),before);
    await page.locator('#redo').click();await page.waitForFunction(()=>document.querySelector('#notice')?.textContent==='Change restored');
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).profile,service.queue.getSettings()!.profile);
    assert.equal(JSON.parse(readFileSync(path,'utf8')).resume,JSON.parse(before).resume);
    assert.equal(service.queue.jobs[0]!.status,'paused');
    await page.getByRole('button',{name:'Remove',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#notice')?.textContent?.startsWith('Removed from the list.'));
    assert.equal(service.queue.jobs[0]!.status,'removed');
  } finally {await browser.close();await service.close();}
});
