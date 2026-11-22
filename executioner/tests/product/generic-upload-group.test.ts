import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,type Page} from 'playwright';
import {uploadLabelKind,readUploadOwnerLabels} from '../../extension/page-runtime/upload-label.js';
import {inspectHostedFields} from '../../src/product/hosted-field-observation.ts';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {fillMatchedPage} from '../../src/product/page-matching.ts';
import {applicantProfile} from '../../src/product/sources.ts';

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
    for (const label of ['Upload your résumé (PDF or DOCX, max 5 MB)','Téléverser votre CV','Veuillez joindre votre curriculum vitae (CV)','Curriculum vitæ (obligatoire)']) {
      assert.equal(uploadLabelKind(label),'resume',label);
    }
    for (const hint of ['Drag and drop a file here or click to browse','Choisir un fichier','Accepted file types: PDF, DOCX']) {
      assert.equal(uploadLabelKind(hint),'action',hint);
    }
    for (const other of ['Resume.pdf','CV or academic transcript (PDF)','Téléverser votre relevé de notes','Cover letter instead of CV']) {
      assert.equal(uploadLabelKind(other),'other',other);
    }
    await page.locator('#upload-label-resume').evaluate(e=>e.textContent='Cover Letter');
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.deepEqual(await bytes(page,'resume'),[...pdf]);assert.equal(await page.evaluate('submits'),0);
    // Both workflows recognize the owned heading when the picker itself names only an action.
    for (const refs of ['resume-title missing-hint','resume-title empty-hint','resume-title format-hint']) {
      await page.reload();
      await fixture(page,`<fieldset aria-labelledby="${refs}"><legend id="resume-title">Téléverser votre CV (PDF, DOCX)</legend>
        <span id="empty-hint"></span><span id="format-hint">Max 5 MB</span>
        <input id="resume" type="file" required aria-label="Choose a file"></fieldset>`);
      const [evidence]=await page.locator('#resume').evaluateAll(readUploadOwnerLabels);
      assert.equal(evidence?.ambiguous,false,refs);
      assert.ok(evidence.visibleHeadings.some(text=>uploadLabelKind(text)==='resume'));
      const hosted=(await inspectHostedFields(page)).find(field=>field.kind==='file');
      assert.equal(hosted?.resumeTarget,true,refs);
      assert.equal((await fill(page)).resume,'verified',refs);
      assert.deepEqual(await bytes(page,'resume'),[...pdf]);
    }
    await page.reload();
    await fixture(page,'<div class="application-field"><span class="application-label">Résumé / CV</span>'+
      '<input id="resume" type="file" required aria-label="Choose file"></div>');
    const hosted=(await inspectHostedFields(page)).find(field=>field.kind==='file');
    assert.equal(hosted?.label,'Résumé / CV');assert.equal(hosted.resumeTarget,true);
    assert.equal((await fill(page)).resume,'verified');
    await page.reload();
    await fixture(page,'<fieldset><legend>Your documents</legend><div class="field"><label>Notes<input></label><div class="field"><label>Resume<input type="file" required></label></div></div></fieldset>');
    assert.equal((await inspectHostedFields(page)).find(field=>field.kind==='file')?.resumeTarget,true);
    assert.equal((await fill(page)).resume,'verified');

    // Bamboo renders a required native picker behind a visible Choose File button.
    await page.route('https://fixture.bamboohr.com/careers/1',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));
    await page.goto('https://fixture.bamboohr.com/careers/1');
    await fixture(page, group('resume','Resume/CV*') + '<div id="cover"><p>Cover Letter*</p><div><button type="button">Choose File*</button><span>No file selected</span><input id="extra" aria-label="file-input" type="file" required style="display:none"><input type="hidden" name="coverLetterFileId"></div></div>');
    await page.evaluate(() => {
      const unrelated = document.createElement('form');
      unrelated.innerHTML = '<label>Portfolio<input required type="file"></label>';
      document.body.append(unrelated);
    });
    const unresolved = (report:{skipped:{label:string;reason:string}[]}) => report.skipped.filter(row=>row.reason.startsWith('required_attachment_')).map(row=>row.label);
    const status = () => page.evaluate(fillVisibleFields,{action:'status' as const,facts});
    assert.deepEqual(unresolved(await status()),['Cover Letter']);
    for (const [markup,reason] of [
      ['<a download href="/cover-letter-template.docx">Download cover letter template</a>','required_attachment_missing'],
      ['<button type="button">Remove</button>','required_attachment_missing'],
      ['<span role="progressbar">Uploading</span>','required_attachment_unconfirmed'],
    ] as const) {
      await page.locator('#cover').evaluate((owner,html)=>owner.insertAdjacentHTML('beforeend',html),markup);
      const report=await status();
      assert.equal(report.incomplete,true);
      assert.ok(report.skipped.some(row=>row.label==='Cover Letter' && row.reason===reason),markup);
      await page.locator('#cover > :last-child').evaluate(node=>node.remove());
    }
    const partial = await fillMatchedPage({
      profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),
      resume:pdf,url:page.url(),workflow:'C3.2',signal:AbortSignal.timeout(10000),
      call:async(action,matchingPlans,matchingRunId)=>({...await page.evaluate(fillVisibleFields,{
        action,matchingPlans,matchingRunId,scope:'page' as const,facts,resume:action==='fill'?{name:'Resume.pdf',base64:pdf.toString('base64')}:undefined,
      })}),
    });
    assert.equal(partial.incomplete,true);
    assert.deepEqual(unresolved(partial),['Cover Letter']);
    assert.deepEqual(await bytes(page,'extra'),[]);
    assert.deepEqual(await bytes(page,'resume'),[...pdf]);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.deepEqual(await bytes(page,'resume'),[]);
    const extra=page.locator('#extra');
    await extra.evaluate((e:HTMLInputElement)=>{e.required=false;});
    assert.deepEqual(unresolved(await status()),[]);
    await extra.evaluate((e:HTMLInputElement)=>{e.required=true;});
    await page.locator('#cover button').evaluate((e:HTMLButtonElement)=>{e.disabled=true;});
    assert.deepEqual(unresolved(await status()),[]);
    await page.locator('#cover button').evaluate((e:HTMLButtonElement)=>{e.disabled=false;});
    await page.locator('[name=coverLetterFileId]').evaluate((e:HTMLInputElement)=>{e.value='uploaded-file';});
    assert.deepEqual(unresolved(await status()),[]);
    await page.locator('#cover').evaluate(owner=>owner.insertAdjacentHTML('beforeend','<progress>Uploading</progress>'));
    assert.ok((await status()).skipped.some(row=>row.label==='Cover Letter' && row.reason==='required_attachment_unconfirmed'));
    await page.locator('#cover progress').evaluate(node=>node.remove());
    await page.locator('[name=coverLetterFileId]').evaluate((e:HTMLInputElement)=>{e.value='';});
    await extra.setInputFiles({name:'Letter.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-existing-letter')});
    assert.deepEqual(unresolved(await status()),[]);
    await extra.setInputFiles([]);
    await extra.evaluate(e=>e.insertAdjacentHTML('afterend','<input type="hidden" name="documentType" value="coverLetter">'));
    assert.deepEqual(unresolved(await status()),['Cover Letter'],'unrelated metadata cannot complete the upload');
    await page.evaluate(()=> {
      document.querySelector('#cover')!.innerHTML='<div><label>Cover Letter<input required type="file"></label></div><input type="hidden" name="coverLetterFileId" value="fixture-file">';
    });
    assert.deepEqual(unresolved(await status()),[],'the outer widget owns the completed attachment');
    await page.locator('#cover input[type=hidden]').evaluate(e=>e.outerHTML='<span data-upload-state="success">Uploaded</span>');
    assert.deepEqual(unresolved(await status()),[],'the outer widget shows a completed attachment');
    await page.locator('#cover [data-upload-state]').evaluate((e:HTMLElement)=>{e.hidden=true;});
    assert.deepEqual(unresolved(await status()),['Cover Letter'],'a hidden success template cannot complete the upload');
    await page.locator('#cover').evaluate(e=>e.outerHTML='<label for="direct-file">Cover Letter</label><input id="direct-file" required type="file">');
    assert.deepEqual(unresolved(await status()),['Cover Letter'],'the form can directly own a labelled picker');
    assert.equal(await page.evaluate('submits'),0);

  }finally{await browser.close();}
});

test('duplicate names, multiple inputs and foreign group labels cannot authorize upload',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const conflictingOwners = [
      '<fieldset><legend>Cover letter</legend><div class="field"><input type="text"><input required type="file" aria-label="Resume"></div></fieldset>',
      '<div role="group"><div><h3>Cover letter</h3></div><input type="text"><input required type="file" aria-label="Resume"></div>',
      '<div class="application-label">Cover letter</div><div class="application-field"><input type="text"><input required type="file" aria-label="Resume"></div>',
      '<div role="group" aria-labelledby="t"><h3 id="t">Resume</h3><input type="text" aria-label="Notes"><input required type="file"></div>',
      '<div role="group" aria-label="Cover Letter"><input type="text"><input required type="file" aria-label="Resume"></div>',
      '<fieldset><legend>Academic transcript</legend><input type="text"><input required type="file" aria-label="Resume"></fieldset>',
      '<div role="group" aria-labelledby="document"><h3 id="document">Cover Letter</h3><input type="text"><input required type="file" aria-label="Resume"></div>',
      '<fieldset aria-labelledby="missing-title"><input id="resume" type="file" required aria-label="Resume"></fieldset>',
      '<div class="application-field"><div class="application-label">Relevé de notes</div><input type="file" required aria-label="Resume"></div>',
      '<fieldset aria-labelledby="title hint"><legend id="title">Resume</legend><span hidden id="hint">Academic transcript</span><input type="file" required></fieldset>',
      '<fieldset aria-labelledby="title hint"><legend id="title">Resume</legend><span id="hint"></span><span id="hint">PDF</span><input type="file" required></fieldset>',
    ];
    for(const body of [
      ...conflictingOwners,
      group('cover_letter','Cover Letter').replace('type="file"','type="file" required aria-label="Resume"'),
      group('resume','Resume/CV*').replace('</div><label','</div><input type="file"><label'),
      group('resume','Resume/CV*')+'<div id="upload-label-resume">Resume/CV</div>',
      group('resume','Resume/CV*').replace('aria-labelledby="upload-label-resume"','aria-labelledby="upload-label-resume other-label"')+'<div id="other-label">Cover Letter</div>',
      '<div role="group"><div id="outside">Resume/CV*</div></div><div role="group" aria-labelledby="outside"><label for="resume">Attach</label><input id="resume" type="file" class="visually-hidden"></div>',
      group('resume','Resume/CV*').replace('for="resume"','for="different"'),
    ]) {
      const page=await browser.newPage();await fixture(page,body);
      if (conflictingOwners.includes(body)) {
        const observed=(await inspectHostedFields(page)).find(field=>field.kind==='file');
        assert.equal(observed?.resumeTarget,false,body);
      }
      assert.notEqual((await fill(page)).resume,'verified');
      assert.equal(await page.locator('input[type=file]').evaluateAll(es=>es.some(e=>(e as HTMLInputElement).files!.length>0)),false);
      await page.close();
    }
  }finally{await browser.close();}
});
