import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {preparePageViewport,viewportOwnership,viewportUnavailable,viewportCleanupPending} from '../../extension/page-viewport.js';

test('positive renderer viewport stays untouched and restoration is a no-op',async()=>{
  const calls:string[]=[];
  const restore=await preparePageViewport(async method=>{calls.push(method);return{cssLayoutViewport:{clientWidth:1707,clientHeight:735}};});
  await restore();await restore();assert.deepEqual(calls,['Page.getLayoutMetrics']);
});

test('only a zero viewport receives a temporary desktop viewport and restores once',async()=>{
  for(const dimensions of [[0,0],[0,800],[1280,0]]){
    const calls:{method:string;params?:Record<string,unknown>}[]=[];let reads=0;
    const restore=await preparePageViewport(async(method,params)=>{
      calls.push({method,params});
      return method==='Page.getLayoutMetrics'?{cssLayoutViewport:{clientWidth:reads++?1280:dimensions[0],clientHeight:reads>1?800:dimensions[1]}}:{};
    });
    assert.equal(calls.length,3);assert.deepEqual(calls[1],{method:'Emulation.setDeviceMetricsOverride',params:{width:1280,height:800,deviceScaleFactor:0,mobile:false}});
    await restore();await restore();assert.deepEqual(calls.map(c=>c.method),['Page.getLayoutMetrics','Emulation.setDeviceMetricsOverride','Page.getLayoutMetrics','Emulation.clearDeviceMetricsOverride']);
  }
});

test('unusable metrics pause without field operations and failed overrides clean up',async()=>{
  for(const mode of ['invalid','read-failed','set-failed','still-zero','recheck-failed']){
    const calls:string[]=[];let reads=0;
    await assert.rejects(preparePageViewport(async method=>{
      calls.push(method);
      if(mode==='read-failed' || mode==='set-failed'&&method==='Emulation.setDeviceMetricsOverride' || mode==='recheck-failed'&&method==='Page.getLayoutMetrics'&&reads>0)throw new Error('private browser detail');
      if(method==='Page.getLayoutMetrics'){reads++;return mode==='invalid'?{}:{cssLayoutViewport:{clientWidth:0,clientHeight:0}};}
      return{};
    }),error=>error instanceof Error&&error.message===viewportUnavailable);
    assert.equal(calls.includes('Emulation.clearDeviceMetricsOverride'),!['invalid','read-failed'].includes(mode));
    assert.ok(calls.every(method=>['Page.getLayoutMetrics','Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride'].includes(method)));
  }
});

test('temporary viewport uses real CDP and restores the isolated browser original dimensions',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({viewport:null});const page=await context.newPage();await page.setContent('<input aria-label="First name"><button type="button">Review</button>');
    const session=await context.newCDPSession(page);
    const before=(await session.send('Page.getLayoutMetrics')).cssLayoutViewport;
    let first=true;
    // The initial zero-size report is synthetic; the recovery and cleanup execute in Chromium.
    const restore=await preparePageViewport(async(method,params)=>{
      if(first&&method==='Page.getLayoutMetrics'){first=false;return{cssLayoutViewport:{clientWidth:0,clientHeight:0}};}
      return session.send(method as any,params);
    });
    const during=(await session.send('Page.getLayoutMetrics')).cssLayoutViewport;
    assert.equal(during.clientWidth,1280);assert.equal(during.clientHeight,800);
    await page.getByRole('textbox',{name:'First name'}).fill('Fixture');assert.equal(await page.getByRole('textbox').inputValue(),'Fixture');
    await restore();
    let after=(await session.send('Page.getLayoutMetrics')).cssLayoutViewport;
    for(let attempt=0;attempt<20 && (after.clientWidth!==before.clientWidth || after.clientHeight!==before.clientHeight);attempt++){
      await new Promise(resolve=>setTimeout(resolve,25));after=(await session.send('Page.getLayoutMetrics')).cssLayoutViewport;
    }
    assert.equal(after.clientWidth,before.clientWidth);assert.equal(after.clientHeight,before.clientHeight);
    await session.detach();
  }finally {await browser.close();}
});

test('failed cleanup retains exact-target ownership across workers until the next authorized prepare',async()=>{
  const values:Record<string,unknown>={unrelatedPreference:'retained'};
  const storage={get:async(key:string)=>({[key]:values[key]}),set:async(value:Record<string,unknown>)=>{Object.assign(values,value);},remove:async(key:string)=>{delete values[key];}};
  const owner=viewportOwnership('target-one',storage);let reads=0;
  const restore=await preparePageViewport(async method=>{
    if(method==='Runtime.evaluate')return{result:{value:'visible'}};
    if(method==='Page.getLayoutMetrics')return{cssLayoutViewport:{clientWidth:reads++?1280:0,clientHeight:reads>1?800:0}};
    if(method==='Emulation.clearDeviceMetricsOverride')throw new Error('private transport detail');
    if(method==='Emulation.setDeviceMetricsOverride')assert.equal(await owner.has(),true,'persist ownership before overriding');
    return{};
  },owner);
  await assert.rejects(restore,error=>error instanceof Error&&error.message===viewportCleanupPending);
  assert.equal(await owner.has(),true);
  const unrelated:string[]=[];
  await preparePageViewport(async method=>{unrelated.push(method);if(method==='Runtime.evaluate')return{result:{value:'visible'}};return{cssLayoutViewport:{clientWidth:800,clientHeight:600}};},viewportOwnership('target-two',storage));
  assert.deepEqual(unrelated,['Page.getLayoutMetrics','Runtime.evaluate']);assert.equal(await owner.has(),true);
  const recovered:string[]=[];
  const release=await preparePageViewport(async method=>{recovered.push(method);if(method==='Runtime.evaluate')return{result:{value:'visible'}};return{cssLayoutViewport:{clientWidth:800,clientHeight:600}};},viewportOwnership('target-one',storage));
  await release();assert.deepEqual(recovered,['Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride','Page.getLayoutMetrics','Runtime.evaluate']);
  assert.deepEqual(values,{unrelatedPreference:'retained'});
});

test('failed recovery and failed clearing preserve the marker and report pending cleanup',async()=>{
  let claimed=false;
  const ownership={has:async()=>claimed,claim:async()=>{claimed=true;},release:async()=>{claimed=false;}};
  const commands:string[]=[];
  await assert.rejects(preparePageViewport(async method=>{
    commands.push(method);
    if(method==='Emulation.clearDeviceMetricsOverride')throw new Error('transport failed');
    return{cssLayoutViewport:{clientWidth:0,clientHeight:0}};
  },ownership),error=>error instanceof Error&&error.message===viewportCleanupPending);
  assert.equal(claimed,true);
  assert.ok(commands.every(method=>['Page.getLayoutMetrics','Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride'].includes(method)));
  assert.equal(commands.at(-1),'Emulation.clearDeviceMetricsOverride');
});

test('pending override is reset across real CDP sessions before ownership is released',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({viewport:null});const page=await context.newPage();
    const previous=await context.newCDPSession(page);
    const original=(await previous.send('Page.getLayoutMetrics')).cssLayoutViewport;
    const targetId=(await previous.send('Target.getTargetInfo')).targetInfo.targetId;
    const values:Record<string,unknown>={};
    const storage={get:async(key:string)=>({[key]:values[key]}),set:async(value:Record<string,unknown>)=>{Object.assign(values,value);},remove:async(key:string)=>{delete values[key];}};
    let first=true;
    await preparePageViewport(async(method,params)=>{
      if(first&&method==='Page.getLayoutMetrics'){first=false;return{cssLayoutViewport:{clientWidth:0,clientHeight:0}};}
      return previous.send(method as any,params);
    },viewportOwnership(targetId,storage));
    await previous.detach();
    const next=await context.newCDPSession(page);
    assert.equal((await next.send('Target.getTargetInfo')).targetInfo.targetId,targetId);
    assert.equal((await next.send('Page.getLayoutMetrics')).cssLayoutViewport.clientWidth,1280);
    assert.equal(await viewportOwnership(targetId,storage).has(),true);
    const calls:string[]=[];
    await preparePageViewport(async(method,params)=>{
      calls.push(method);
      if(method==='Emulation.setDeviceMetricsOverride')assert.deepEqual(params,{width:0,height:0,deviceScaleFactor:0,mobile:false});
      if(method==='Emulation.clearDeviceMetricsOverride')assert.equal(await viewportOwnership(targetId,storage).has(),true);
      return next.send(method as any,params);
    },viewportOwnership(targetId,storage));
    let restored=(await next.send('Page.getLayoutMetrics')).cssLayoutViewport;
    for(let attempt=0;attempt<20 && (restored.clientWidth!==original.clientWidth || restored.clientHeight!==original.clientHeight);attempt++){
      await new Promise(resolve=>setTimeout(resolve,25));restored=(await next.send('Page.getLayoutMetrics')).cssLayoutViewport;
    }
    assert.equal(restored.clientWidth,original.clientWidth);assert.equal(restored.clientHeight,original.clientHeight);
    assert.equal(await viewportOwnership(targetId,storage).has(),false);
    assert.deepEqual(calls,['Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride','Page.getLayoutMetrics','Runtime.evaluate']);
    await next.detach();
  }finally {await browser.close();}
});

test('a rejected cross-session reset preserves pending ownership without claiming cleanup succeeded',async()=>{
  let pending=true;const calls:string[]=[];
  await assert.rejects(preparePageViewport(async method=>{calls.push(method);throw new Error('private reset failure');},
    {has:async()=>pending,claim:async()=>{pending=true;},release:async()=>{pending=false;}}),
  error=>error instanceof Error&&error.message===viewportCleanupPending);
  assert.equal(pending,true);assert.deepEqual(calls,['Emulation.setDeviceMetricsOverride']);
});
