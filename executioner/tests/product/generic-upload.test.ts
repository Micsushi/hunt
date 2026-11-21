import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium, type Page} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';

const selected=Buffer.from('%PDF-selected-private-fixture');
const facts=[{factId:'given_name',value:'Fixture'},{factId:'email_address',value:'fixture@example.invalid'},
  {factId:'earliest_start_date',value:'2027-01-05'},{factId:'salary_expectations',value:'CAD 80,000 per year'},
  {factId:'portfolio_url',value:'https://portfolio.example.invalid/'},{factId:'city',value:'Saved city'}];
const contact='<label>First name<input required name="first"></label><label>Email<input required name="email" type="email"></label>';
const actions='<button type="button" onclick="window.advances++">Next</button><button type="button" onclick="window.submits++">Submit</button>';
async function fixture(page:Page,body:string){
  await page.setContent(`<form>${contact}${body}${actions}</form><script>window.advances=0;window.submits=0;</script>`);
}
async function fill(page:Page){return page.evaluate(fillVisibleFields,{facts,resume:{name:'Resume.pdf',base64:selected.toString('base64')},replaceExistingResume:true});}
async function bytes(page:Page,selector:string){return page.locator(selector).evaluate(async(e:HTMLInputElement)=>e.files?.[0]?Array.from(new Uint8Array(await e.files[0].arrayBuffer())):[]);}

test('Rippling-shaped hidden inputs resolve the visible associated Resume reference and preserve exact File undo',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await fixture(page,`<div><span id="field-8-label">Résumé*</span><label id="resume-widget" aria-labelledby="file-input-10 field-8-label">Drop or select your files
      <input id="file-input-10" type="file" aria-label="Drop or select your files" style="display:none"></label></div>
      <div><span id="field-55-label">Cover letter</span><label aria-labelledby="file-input-11 field-55-label">Drop or select your files
      <input id="file-input-11" type="file" aria-label="Drop or select your files" style="display:none"></label></div>`);
    await page.evaluate(()=>{
      for(const [id,key,text] of [['file-input-10','priorResume','%PDF-prior-resume'],['file-input-11','priorCover','%PDF-prior-cover']]){
        const file=new File([text!],`${key}.pdf`,{type:'application/pdf'});(window as any)[key!]=file;
        const transfer=new DataTransfer();transfer.items.add(file);(document.getElementById(id!) as HTMLInputElement).files=transfer.files;
      }
    });
    const result=await fill(page);assert.equal(result.resume,'verified');assert.deepEqual(await bytes(page,'#file-input-10'),[...selected]);
    assert.equal(await page.evaluate(()=>(document.getElementById('file-input-11') as HTMLInputElement).files![0]===(window as any).priorCover),true);
    await page.evaluate(()=>{(window as any).selectedResume=(document.getElementById('file-input-10') as HTMLInputElement).files![0];});
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.evaluate(()=>(document.getElementById('file-input-10') as HTMLInputElement).files![0]===(window as any).priorResume),true);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});
    assert.equal(await page.evaluate(()=>(document.getElementById('file-input-10') as HTMLInputElement).files![0]===(window as any).selectedResume),true);
    assert.deepEqual(await bytes(page,'#file-input-10'),[...selected]);
    await page.locator('#field-8-label').evaluate(e=>e.textContent='Cover letter');
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.deepEqual(await bytes(page,'#file-input-10'),[...selected]);
    await page.locator('#field-8-label').evaluate(e=>e.textContent='Résumé*');
    await page.locator('#resume-widget').evaluate((e:HTMLElement)=>e.style.display='none');
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.equal(await page.evaluate('advances+submits'),0);
  }finally{await browser.close();}
});

test('hidden unbound, ambiguous and explicitly different upload controls never receive the resume',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const body of [
      '<div><input required type="file" aria-label="Resume" style="display:none"></div>',
      '<div><input required type="file" aria-label="Resume" style="opacity:0"></div>',
      '<div><div>Resume</div><div><span>Choose File</span><input required type="file" style="display:none"></div></div>',
      '<div><div>Resume*</div><div>Choose File<input required type="file" aria-label="file-input"><input required type="file" aria-label="file-input"></div></div>',
      '<label>Resume<input required type="file"></label><label>Resume<input required type="file"></label>',
      '<div><div>Resume</div><input required type="file" aria-label="Photo"></div>',
      '<label>Cover letter<input required type="file"></label>',
      '<input id="other" type="hidden"><label for="other">Résumé<input required id="hidden" type="file" hidden></label>',
      '<input id="other" type="hidden"><div><div>Resume</div><label for="other">Choose File<input required id="hidden" type="file" hidden></label></div>',
      '<fieldset disabled><label>Resume<input required type="file"></label></fieldset>',
      '<div><span id="resume-label">Resume</span><span id="resume-label">Cover letter</span><label aria-labelledby="resume-label">Choose File<input required type="file" style="display:none"></label></div>',
      '<div><div>Resume</div><div>Cover letter</div><div>Choose File<input required type="file" aria-label="file-input"></div></div>',
    ]) {
      const page=await browser.newPage();await fixture(page,body);
      const result=await fill(page);assert.notEqual(result.resume,'verified',body);
      assert.equal(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.some(e=>(e as HTMLInputElement).files!.length>0)),false,body);
      await page.close();
    }
    const page=await browser.newPage();await page.setContent('<label>Resume<input required type="file"></label>');
    assert.equal((await fill(page)).resume,'missing','a lone upload is not an identified application');
  }finally{await browser.close();}
});

test('an upload moved to another form during the site response is never verified or undone through the new form',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,'<label id="upload">Resume<input required id="file" type="file"></label>');
    await page.evaluate(()=>{
      const other=document.createElement('form');other.id='other';document.body.append(other);
      document.getElementById('file')!.addEventListener('change',()=>other.append(document.getElementById('upload')!));
    });
    const result=await fill(page);assert.equal(result.resume,'unverified');assert.equal(result.filled.includes('Resume'),false);
    const before=await bytes(page,'#file');await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.deepEqual(await bytes(page,'#file'),before,'history does not mutate a file moved to another form');
  }finally{await browser.close();}
});


test('externalized Rippling upload waits for parsing, preserves its receipt and reports saved-profile conflicts',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await fixture(page,`<label>LinkedIn Link<input required id="linkedin"></label><span id="resume-title">Résumé*</span>
      <label id="widget" aria-labelledby="resume-title">Choose File<input id="file" type="file" hidden></label>`);
    await page.evaluate(()=>{
      (window as any).uploads=0;(window as any).firstAtUpload=null;(window as any).parsed=false;
      document.getElementById('file')!.addEventListener('change',()=>{
        (window as any).uploads++;(window as any).firstAtUpload=(document.querySelector('[name=first]') as HTMLInputElement).value;
        (document.getElementById('file') as HTMLInputElement).value='';
        const status=document.createElement('span');status.setAttribute('role','status');
        status.textContent='File Resume.pdf uploaded successfully';document.getElementById('widget')!.append(status);
        setTimeout(()=>{
          (document.querySelector('[name=first]') as HTMLInputElement).value='Parsed different name';
          const toast=document.createElement('div');toast.setAttribute('role','status');toast.textContent='Résumé parsing was successful.';
          document.body.append(toast);(window as any).parsed=true;
        },200);
      });
    });
    const allFacts=[...facts,{factId:'linkedin_url',value:'https://linkedin.example.invalid/owner'}];
    const result=await page.evaluate(fillVisibleFields,{facts:allFacts,resume:{name:'Resume.pdf',base64:selected.toString('base64')},replaceExistingResume:true});
    assert.equal(result.resume,'unverified');assert.ok(result.skipped.some(f=>f.reason==='uploaded_attachment_requires_review'));
    assert.ok(result.skipped.some(f=>f.label==='First name'&&f.reason==='resume_parser_value_conflict'));
    assert.equal(result.filled.includes('First name'),false);assert.equal(result.filled.includes('Resume'),false);
    assert.equal(await page.evaluate('firstAtUpload'),'');assert.equal(await page.evaluate('parsed'),true);
    assert.equal(await page.locator('#linkedin').inputValue(),'https://linkedin.example.invalid/owner');
    assert.equal(await page.locator('[name=email]').inputValue(),'fixture@example.invalid');
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('[name=email]').inputValue(),'');
    assert.equal(await page.locator('[role=status]').first().textContent(),'File Resume.pdf uploaded successfully');
    await page.evaluate(fillVisibleFields,{action:'redo' as const});
    const retry=await page.evaluate(fillVisibleFields,{facts:allFacts,resume:{name:'Resume.pdf',base64:selected.toString('base64')},replaceExistingResume:true});
    assert.equal(retry.resume,'unverified');assert.ok(retry.skipped.some(f=>f.reason==='resume_upload_already_attempted_review_attachment'));
    const different=await page.evaluate(fillVisibleFields,{facts:allFacts,resume:{name:'Resume.pdf',base64:Buffer.from('%PDF-different-selected').toString('base64')},replaceExistingResume:true});
    assert.equal(different.resume,'unverified');assert.ok(different.skipped.some(f=>f.reason==='different_resume_requires_manual_review'));
    assert.equal(await page.evaluate('uploads'),1);assert.equal(await page.evaluate('advances+submits'),0);
  }finally{await browser.close();}
});

test('SmartRecruiters shadow dropzone binds only the exact Resume section, never Easy Apply',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,`<div data-test="easy-apply-container"><h3>Easy Apply</h3><div><oc-apply-with-resume><spl-form-field><spl-dropzone id="easy" data-test="apply-with-resume-container"></spl-dropzone></spl-form-field></oc-apply-with-resume></div></div>
      <div data-test="resume-upload-container"><spl-typography-title data-test="section-title">Resume <span>*</span></spl-typography-title><spl-form-field><spl-dropzone id="resume" data-test="resume-upload"></spl-dropzone></spl-form-field></div>`);
    await page.evaluate(()=>{
      for(const [id,number] of [['easy','2'],['resume','1']]){
        document.getElementById(id!)!.attachShadow({mode:'open'}).innerHTML=`<div><label for="spl-dropzone-file-input-${number}">Choose a file or drop it here</label><input id="spl-dropzone-file-input-${number}" type="file" hidden><div>10 MB size limit</div></div>`;
      }
    });
    const result=await fill(page);assert.equal(result.resume,'verified');
    assert.deepEqual(await bytes(page,'#resume input[type=file]'),[...selected]);assert.deepEqual(await bytes(page,'#easy input[type=file]'),[]);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.deepEqual(await bytes(page,'#resume input[type=file]'),[]);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.deepEqual(await bytes(page,'#resume input[type=file]'),[...selected]);
  }finally{await browser.close();}
});

test('native rejection explicitly reports retained side effects and never verifies an invalid attachment on retry',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,'<label>Resume<input required id="file" type="file"></label>');
    await page.locator('#file').evaluate((e:HTMLInputElement)=>e.setCustomValidity('Rejected by fixture'));
    const result=await fill(page);assert.equal(result.resume,'unverified');
    assert.ok(result.skipped.some(f=>f.reason==='attachment_not_verified_native_file_retained'));
    assert.deepEqual(await bytes(page,'#file'),[...selected]);
    assert.equal((await fill(page)).resume,'unverified');
  }finally{await browser.close();}
});

test('Canada without sponsorship requires both explicit country facts and never borrows general authorization',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,'<label>Are you legally eligible to work in Canada without sponsorship?*<select required id="eligibility"><option value="" disabled selected>Choose</option><option>Yes</option><option>No</option></select></label><label>Resume<input required type="file"></label>');
    await page.evaluate(fillVisibleFields,{facts:[...facts,{factId:'work_authorization',value:true},{factId:'sponsorship_required',value:false}]});
    assert.equal(await page.locator('#eligibility').inputValue(),'');
    await page.evaluate(fillVisibleFields,{facts:[...facts,{factId:'work_authorization_canada',value:true}]});assert.equal(await page.locator('#eligibility').inputValue(),'');
    await page.evaluate(fillVisibleFields,{facts:[...facts,{factId:'work_authorization_canada',value:true},{factId:'sponsorship_required_canada',value:false}]});
    assert.equal(await page.locator('#eligibility').inputValue(),'Yes');
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.equal(await page.locator('#eligibility').inputValue(),'');
  }finally{await browser.close();}
});

test('Recruitee CV or resume uses its visible native label and leaves photo and cover letter untouched',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,`<section><label for="input-candidate.cv-radix-:R1nl9r6l:">CV or resume<span>*</span></label><div><div><div>
      <input id="input-candidate.cv-radix-:R1nl9r6l:" name="candidate.cv" type="file" required accept=".pdf" style="opacity:0;width:518px;height:150px"></div></div></div></section>
      <section><label for="photo">Photo</label><input id="photo" name="candidate.photo" type="file" style="opacity:0"></section>
      <section><label for="cover">Cover letter</label><input id="cover" name="candidate.coverLetterFile" type="file" style="opacity:0"></section>`);
    assert.equal((await fill(page)).resume,'verified');
    assert.deepEqual(await bytes(page,'[name="candidate.cv"]'),[...selected]);
    assert.deepEqual(await bytes(page,'#photo'),[]);assert.deepEqual(await bytes(page,'#cover'),[]);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.deepEqual(await bytes(page,'[name="candidate.cv"]'),[]);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.deepEqual(await bytes(page,'[name="candidate.cv"]'),[...selected]);
    assert.equal(await page.evaluate('advances+submits'),0);
  }finally{await browser.close();}
});

test('native retained-file retries keep profile blank while parsing remains busy',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,'<label>Resume<input required id="file" type="file"></label><div>Resume parsing in progress</div><div>Résumé parsing was successful.</div>');
    await page.evaluate(()=>{(window as any).uploads=0;document.getElementById('file')!.addEventListener('change',()=>{(window as any).uploads++;});});
    for(let attempt=0;attempt<2;attempt++) {
      const result=await fill(page);assert.ok(result.skipped.some(item=>item.reason==='resume_parsing_pending_profile_not_filled'));
      assert.equal(await page.locator('[name=first]').inputValue(),'');assert.equal(await page.locator('[name=email]').inputValue(),'');
    }
    assert.equal(await page.evaluate('uploads'),1);assert.deepEqual(await bytes(page,'#file'),[...selected]);
  }finally{await browser.close();}
});
