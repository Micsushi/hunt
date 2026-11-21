import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,type Page} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';

const pdf=Buffer.from('%PDF-native-group-fixture');
const facts=[{factId:'given_name',value:'Fixture'},{factId:'email_address',value:'fixture@example.invalid'}];
const group=(id:string,title:string)=>`<div role="group" aria-labelledby="upload-label-${id}"><div id="upload-label-${id}">${title}</div><label for="${id}">Attach</label><input id="${id}" type="file" class="visually-hidden" accept=".pdf,.doc,.docx,.txt,.rtf"></div>`;
async function fixture(page:Page,body:string){
  await page.setContent(`<style>.visually-hidden{position:absolute;width:1px;height:1px;opacity:0}</style><form><label>First name<input name="first"></label><label>Email<input name="email" type="email"></label>${body}<button type="button" onclick="window.submits++">Submit application</button></form><script>window.submits=0;</script>`);
}
const fill=(page:Page)=>page.evaluate(fillVisibleFields,{facts,resume:{name:'Resume.pdf',base64:pdf.toString('base64')},replaceExistingResume:true});
const bytes=(page:Page,id:string)=>page.locator(`#${id}`).evaluate(async(e:HTMLInputElement)=>e.files?.[0]?[...new Uint8Array(await e.files[0].arrayBuffer())]:[]);

test('native Attach label uses only its uniquely labelled Resume/CV upload group',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,group('resume','Resume/CV*')+group('cover_letter','Cover Letter'));
    const result=await fill(page);assert.equal(result.resume,'verified');
    assert.deepEqual(await bytes(page,'resume'),[...pdf]);assert.deepEqual(await bytes(page,'cover_letter'),[]);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.deepEqual(await bytes(page,'resume'),[]);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.deepEqual(await bytes(page,'resume'),[...pdf]);
    await page.locator('#upload-label-resume').evaluate(e=>e.textContent='Cover Letter');
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.deepEqual(await bytes(page,'resume'),[...pdf]);assert.equal(await page.evaluate('submits'),0);
  }finally{await browser.close();}
});

test('duplicate names, multiple inputs and foreign group labels cannot authorize upload',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const body of [
      group('resume','Resume/CV*').replace('</div><label','</div><input type="file"><label'),
      group('resume','Resume/CV*')+'<div id="upload-label-resume">Resume/CV</div>',
      group('resume','Resume/CV*').replace('aria-labelledby="upload-label-resume"','aria-labelledby="upload-label-resume other-label"')+'<div id="other-label">Cover Letter</div>',
      '<div role="group"><div id="outside">Resume/CV*</div></div><div role="group" aria-labelledby="outside"><label for="resume">Attach</label><input id="resume" type="file" class="visually-hidden"></div>',
      group('resume','Resume/CV*').replace('for="resume"','for="different"'),
    ]) {
      const page=await browser.newPage();await fixture(page,body);assert.notEqual((await fill(page)).resume,'verified');
      assert.equal(await page.locator('input[type=file]').evaluateAll(es=>es.some(e=>(e as HTMLInputElement).files!.length>0)),false);
      await page.close();
    }
  }finally{await browser.close();}
});

test('an explicit Cover Letter group cannot be relabelled by its native file input',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,group('cover_letter','Cover Letter').replace('type="file"','type="file" required aria-label="Resume"'));
    assert.notEqual((await fill(page)).resume,'verified');assert.deepEqual(await bytes(page,'cover_letter'),[]);
  }finally{await browser.close();}
});
