import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,type Page} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';

const url='https://fixture.bamboohr.com/careers/123';
const facts=[{factId:'given_name',value:'Fixture'},{factId:'email_address',value:'fixture@example.invalid'},
  {factId:'country',value:'Canada'},{factId:'region',value:'Alberta'}];
async function fixture(page:Page,extra=''){
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<form id="job-application-form">
    <label>First name<input name="first"></label><label>Email<input type="email" name="email"></label>
    <button id="country" type="button" class="fab-SelectToggle" aria-label="Country Canada" onclick="window.countryTouches++">Canada</button>
    <div class="fab-SelectToggle__container" id="container"><button id="province" type="button" class="fab-SelectToggle" aria-label="Province –Select–" data-menu-id="fab-menu101" aria-expanded="false"><span class="fab-SelectToggle__content">–Select–</span></button></div>
    <button type="button" onclick="window.submits++">Submit application</button></form>
    <div id="fab-menu101" class="fab-MenuList" role="menu" hidden><div role="menuitem">Alberta</div><div role="menuitem">Ontario</div>${extra}</div>
    <script>window.countryTouches=0;window.submits=0;window.clears=0;window.selections=0;
      const button=document.getElementById('province'),menu=document.getElementById('fab-menu101'),container=document.getElementById('container');
      const close=()=>{menu.hidden=true;button.setAttribute('aria-expanded','false');};
      window.setProvince=value=>{button.setAttribute('aria-label','Province '+value);button.querySelector('.fab-SelectToggle__content').textContent=value;
        container.querySelector('.fab-SelectToggle__clearButton')?.remove();
        if(value!=='–Select–'){const clear=document.createElement('button');clear.type='button';clear.className='fab-SelectToggle__clearButton';clear.setAttribute('aria-label','Clear Selection');clear.textContent='×';clear.onclick=()=>{window.clears++;window.setProvince('–Select–');};container.append(clear);}
        close();};
      button.onclick=event=>{if(event.detail===0&&!event.isPrimary)return;const open=button.getAttribute('aria-expanded')!=='true';menu.hidden=!open;button.setAttribute('aria-expanded',String(open));};
      button.onkeydown=e=>{if(e.key==='Escape')close();};
      menu.onclick=e=>{const option=e.target.closest('[role=menuitem]');if(option){window.selections++;window.setProvince(option.textContent);}};
    </script>`}));
  await page.goto(url);
}

test('Bamboo data-menu-id portal selects saved province and Clear Selection restores blank on Undo',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page);
    await page.locator('#province').evaluate((e:HTMLButtonElement)=>e.click());
    assert.equal(await page.locator('#province').getAttribute('aria-expanded'),'false','Fabric ignores a zero-detail programmatic click');
    const result=await page.evaluate(fillVisibleFields,{facts});assert.ok(result.filled.includes('Province'));
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Alberta');
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province –Select–');assert.equal(await page.evaluate('clears'),1);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Alberta');
    assert.equal(await page.evaluate('countryTouches+submits'),0);assert.equal(await page.locator('#country').getAttribute('aria-label'),'Country Canada');
    await page.evaluate(()=>{(window as any).setProvince('Ontario');});
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Ontario');
  }finally{await browser.close();}
});

test('existing province, ambiguous option and conflicting menu binding stay untouched',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const kind of ['existing','duplicate','wrong-binding'] as const){
      const page=await browser.newPage();await fixture(page,kind==='duplicate'?'<div role="menuitem">Alberta</div>':'');
      if(kind==='existing')await page.evaluate(()=>{(window as any).setProvince('Ontario');});
      if(kind==='wrong-binding')await page.locator('#province').evaluate(e=>e.setAttribute('aria-controls','wrong-menu'));
      const result=await page.evaluate(fillVisibleFields,{facts});assert.equal(result.filled.includes('Province'),false);
      assert.equal(await page.locator('#province').getAttribute('aria-label'),kind==='existing'?'Province Ontario':'Province –Select–');
      assert.equal(await page.evaluate('clears+selections+countryTouches+submits'),0);await page.close();
    }
  }finally{await browser.close();}
});

test('Bamboo waits for the owned menu to become visible before selecting',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page);
    await page.locator('#province').evaluate(e=>e.addEventListener('click',()=>{
      const menu=document.getElementById('fab-menu101')!;menu.hidden=true;
      setTimeout(()=>{menu.hidden=false;},600);
    },{once:true}));
    const result=await page.evaluate(fillVisibleFields,{facts});
    assert.ok(result.filled.includes('Province'));
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Alberta');
    assert.equal(await page.evaluate('selections'),1);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province –Select–');
    assert.equal(await page.evaluate('submits+countryTouches'),0);
  }finally{await browser.close();}
});

test('province edits during menu opening or selection are preserved',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const phase of ['open','selection'] as const){
      const page=await browser.newPage();await fixture(page);
      await page.evaluate(phase=>{document.getElementById(phase==='open'?'province':'fab-menu101')!.addEventListener('click',()=>{
        setTimeout(()=>{(window as any).setProvince('Ontario');},20);
      },{once:true});},phase);
      const result=await page.evaluate(fillVisibleFields,{facts});assert.equal(result.filled.includes('Province'),false);
      assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Ontario');assert.equal(await page.evaluate('clears'),0);
      assert.equal(await page.evaluate('submits+countryTouches'),0);await page.close();
    }
  }finally{await browser.close();}
});

test('a country change while the province menu opens is not overwritten',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page);
    await page.locator('#province').evaluate(e=>e.addEventListener('click',()=>setTimeout(()=>document.getElementById('country')!.setAttribute('aria-label','Country United States'),20),{once:true}));
    const result=await page.evaluate(fillVisibleFields,{facts});assert.equal(result.filled.includes('Province'),false);
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province –Select–');
    assert.equal(await page.locator('#country').getAttribute('aria-label'),'Country United States');assert.equal(await page.evaluate('selections+clears+submits'),0);
  }finally{await browser.close();}
});
