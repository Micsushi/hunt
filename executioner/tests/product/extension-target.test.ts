import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {ExtensionBridge} from '../../src/product/extension-bridge.ts';

const posting='https://ats.rippling.com/fluidai-medical-careers/jobs/68057679-c967-4707-9423-ea2db74de7c5?jobSite=Indeed';
const application='https://ats.rippling.com/fluidai-medical-careers/jobs/68057679-c967-4707-9423-ea2db74de7c5/apply?jobSite=Indeed&jobBoardSlug=fluidai-medical-careers&jobId=68057679-c967-4707-9423-ea2db74de7c5&step=application';

test('generic existing-tab resolution refuses missing, unloaded, cross-posting and unproven redirect identities',async()=>{
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:404});
  try {
  for(const [expected,current] of [
    [posting,application.replace('68057679-c967-4707-9423-ea2db74de7c5','11111111-1111-4111-8111-111111111111')],
    [posting,application.replace('ats.rippling.com','ats.us1.rippling.com')],
    [posting,'https://other.example/apply'],
    ['https://jobs.smartrecruiters.com/Fixture/744000123456789-analyst','https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/11111111-1111-4111-8111-111111111111'],
    [posting,'discarded'],[posting,'missing'],
  ]){
    const bridge=new ExtensionBridge(createServer(),'fixture','http://127.0.0.1:1');let attachments=0;
    bridge.call=async(method)=>{if(method==='pageTabs')return current==='missing'?[]:[{tabId:7,url:current==='discarded'?application:current,discarded:current==='discarded'}];attachments++;throw new Error('must not attach');};
    try{await assert.rejects(bridge.open(expected!,7,true),/posting|application/);assert.equal(attachments,0);}finally{bridge.close();}
  }
  } finally {globalThis.fetch=originalFetch;}
});

test('SmartRecruiters existing application requires exact first-party numeric-to-publication proof',async()=>{
  const posting='https://jobs.smartrecruiters.com/Fixture/744000123456789-analyst';
  const application='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/11111111-1111-4111-8111-111111111111?dcr_ci=Fixture';
  const originalFetch=globalThis.fetch;
  const bridge=new ExtensionBridge(createServer(),'fixture','http://127.0.0.1:1');let attached='';
  globalThis.fetch=async(url)=>{assert.equal(String(url),'https://api.smartrecruiters.com/v1/companies/Fixture/postings/744000123456789');return new Response(JSON.stringify({id:'744000123456789',company:{identifier:'Fixture'},active:true,uuid:'11111111-1111-4111-8111-111111111111'}));};
  bridge.call=async(method,params={})=>{if(method==='pageTabs')return[{tabId:7,url:application,discarded:false}];if(method==='attach'){attached=String(params.url);throw new Error('captured attach');}return{};};
  try {
    await assert.rejects(bridge.open(posting,7,true),/attachment_unknown/);assert.equal(attached,application);
    for (const current of [application, application.replace('11111111-1111','99999999-9999'), posting+'?source=other']) {
      const opens: Record<string,unknown>[] = [];
      bridge.call=async(method,params={})=>{
        if(method==='pageTabs')return[{tabId:23,url:current,discarded:false}];
        opens.push(params);
        if (opens.length===1) return {redirectedTabId:23};
        throw new Error('captured verified attachment');
      };
      await assert.rejects(bridge.open(posting+'?oga=true'));
      assert.equal(opens[0]?.url,posting+'?oga=true');
      assert.equal(opens[0]?.reportRedirect,true);
      assert.deepEqual(opens.slice(1),current===application ? [{url:application,tabId:23,existingOnly:true,generic:true}] : []);
    }
  }
  finally {bridge.close();globalThis.fetch=originalFetch;}
});
