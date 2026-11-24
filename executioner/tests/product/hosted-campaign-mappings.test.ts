import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { fillApplication } from '../../src/product/engine.ts';
import { applicantProfile, effectiveProfileFacts, productSources } from '../../src/product/sources.ts';
import type { parseApplicationProfile } from '../../src/profile/application-profile.ts';
import { matchingContext } from '../../src/product/target.ts';
import { createPageAnswerPlanner } from '../../src/product/page-answer-planner.ts';
import { disposeResumeArtifact } from '../../src/contracts/resume-artifact.ts';
import type { ProfilePagePlan } from '../../src/ats/workday/application/profile/types.ts';

const cloud = 'Do you have any hands-on experience with Kubernetes, Docker, or cloud platforms (e.g., AWS, Azure, GCP)?';
const location = 'This role requires employees to be based in the United States or Canada. Are you currently located in the U.S. or Canada?';
const coop = 'Are you currently enrolled in a Co-op or Work-Integrated Learning (WIL) program through your school?';
const select = (id: string, label: string) => `<label>${label}<select id="${id}" required><option value="">Choose</option><option>YES</option><option>NO</option></select></label>`;

test('hosted campaign questions fill from saved profile authority and flag required fallbacks for Review', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply';
    await page.route('**/*', route => route.fulfill({contentType:'text/html',body:`
      <label>Name<input required></label><label>Email<input type="email" required></label>
      <label>What is your average GPA?<input id="gpa" required></label>
      <label>${coop}<input id="coop" required></label>
      ${select('cloud',cloud)}${select('location',location)}
      <label>What is your current address?<input id="address" required></label>
      <label>What is your target compensation range?<input id="compensation" required></label>
      ${select('ai','Have you worked on any projects involving artificial intelligence?')}
      <button onclick="window.submitted=true">Submit application</button>`}));
    const profile = applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
      address_line1:'123 Fixture St', city:'Edmonton', region:'Alberta', postal_code:'T5A 0A1', country:'Canada',
      education_gpa:'3.7', education_gpa_scale:'4.0', official_coop_program:'true', sponsorship_required_canada:'false', application_source:'Job board', salary_expectations:'CAD 80,000 per year',
      relocation_preference:'Anywhere in Canada',languages:'English: native; French: intermediate'}) as {profilePlan:ProfilePagePlan};
    const employer = 'Northwind Labs';
    const choices = ['Community event', 'LinkedIn Job Posting', 'Other'];
    const yesNo = ['Yes', 'No'];
    const cases = [
      ['Have you been previously employed by Northwind Labs or one of its subsidiaries?', yesNo, '', false, ['No', true, 'synthetic_test_default']],
      ['Are you currently employed by Northwind Labs, or have you previously been employed by Northwind Labs or Contoso?', yesNo, '', false, ['No', true, 'synthetic_test_default']],
      ['Do you reside in Manitoba or Nova Scotia?', yesNo, '', false, ['No', false, 'profile_fact']],
      ['Do you plan to relocate to Manitoba or Nova Scotia?', yesNo, '', false, ['Yes', true, 'synthetic_test_default']],
      ['Do you, now or in the future, require sponsorship to work in Canada?', yesNo, 'Yes', false, ['No', false, 'live_owner_fact']],
      ['Do you, now or in the future, require sponsorship to work in the United States?', yesNo, '', false, ['Yes', true, 'synthetic_test_default']],
      ['How did you hear about Northwind Labs?', choices, '', false, ['LinkedIn Job Posting', false, 'live_owner_fact']],
      ['How did you hear about Northwind Labs?', choices, 'LinkedIn Job Posting', false, ['LinkedIn Job Posting', false, 'live_owner_fact']],
      ['How did you hear about another employer?', choices, '', false, ['Community event', true, 'synthetic_test_default']],
      ['How did you hear about Northwind Labs?', choices, 'Community event', true, [null, false, undefined]],
    ] as const;
    const sources = productSources(profile, Buffer.from('%PDF-fixture'));
    try {
      const contact = await browser.newPage();
      const applyUrl = 'https://recruiting.ultipro.ca/fixture/JobBoard/test/OpportunityApply';
      await contact.route(applyUrl, route => route.fulfill({contentType:'text/html',body:`
        <form><label>First Name<input value="Fixture"></label>
        <label>Address 1<input id="street" required></label>
        <label>Zip / Postal Code<input id="postal" required></label></form>`}));
      await contact.goto(applyUrl);
      const currentPlan = createPageAnswerPlanner(sources, effectiveProfileFacts(profile), null, undefined, true);
      const fillAddress = async () => {
        const {matching = []} = await contact.evaluate(fillVisibleFields, {scope:'page',action:'status'} as const);
        for (const label of ['Address 1','Zip / Postal Code']) {
          assert.ok(matching.some(field => field.question === label && field.profileOnly));
        }
        const matchingPlans = await Promise.all(matching.map(field => currentPlan(field,matching,AbortSignal.timeout(3000))));
        return contact.evaluate(fillVisibleFields,{scope:'page' as const,matchingPlans});
      };
      await fillAddress();
      assert.equal(await contact.locator('#street').inputValue(),'123 Fixture St');
      assert.equal(await contact.locator('#postal').inputValue(),'T5A 0A1');
      await contact.evaluate(fillVisibleFields,{scope:'page',action:'undo'} as const);
      assert.equal(await contact.locator('#street').inputValue(),'');
      assert.equal(await contact.locator('#postal').inputValue(),'');
      await contact.locator('#street').fill('Manually entered');
      await fillAddress();
      assert.equal(await contact.locator('#street').inputValue(),'Manually entered');
      await contact.locator('form').evaluate(form => form.insertAdjacentHTML('beforeend', `
        <div data-automation="panel-list-item">
          <label>School Name<input class="tt-input" data-automation="school-textbox" data-bind="value: SchoolName, typeahead: {}" role="combobox" required value="Fixture School"></label>
          <label>Degree<input class="tt-input" data-automation="degree-textbox" data-bind="value: DegreeName, typeahead: {}" role="combobox" required value="Fixture Degree"></label>
        </div>
        <div data-automation="skills-panel"><div class="panel-body">
          <label>Skills<input class="tt-input" data-automation="item-typeahead" role="combobox" required></label>
          <button type="button" data-automation="item-add-button">Add</button>
          <div data-automation="skills-panel"><div data-automation="selected-item">
            <span data-automation="skill-label" data-bind="text: SkillName">Fixture skill</span>
          </div></div>
        </div></div>`));
      const issues = async () => (await contact.evaluate(fillVisibleFields, {scope:'page',action:'status'} as const))
        .requiredIssues?.map(({label,reason}) => [label,reason]);
      assert.deepEqual(await issues(),[]);
      await contact.getByLabel('School Name').evaluate(input => input.setAttribute('aria-expanded','true'));
      await contact.getByLabel('Degree').evaluate(input => input.setAttribute('aria-invalid','true'));
      await contact.locator('[data-automation="selected-item"]').evaluate(item => item.remove());
      assert.deepEqual(await issues(),[['School Name','required_unconfirmed'],['Degree','required_invalid'],['Skills','required_empty']]);
      await contact.getByLabel('Skills').fill('Unadded skill');
      assert.ok((await issues())?.some(([label,reason]) => label==='Skills' && reason==='required_unconfirmed'));
      await contact.getByLabel('School Name').evaluate(input => {
        input.setAttribute('aria-expanded','false');
        input.setAttribute('data-bind','value: SchoolId, typeahead: {}');
      });
      assert.ok((await issues())?.some(([label,reason]) => label==='School Name' && reason==='required_unconfirmed'));
      await contact.close();
      const plan = createPageAnswerPlanner(sources, effectiveProfileFacts(profile), employer);
      const relocate = {pageId:'page',formId:'application',frameId:'main',fieldId:'relocate',signature:'fixture',
        question:'If you are not currently based in Ottawa, are you willing to relocate? *',options:yesNo,
        selected:'',required:true,control:'radio',valid:false};
      const canada = {...relocate,fieldId:'eligibility',question:'Are you legally entitled to work in Canada? *'};
      const signal=AbortSignal.timeout(3000);
      const local=await plan(relocate,[canada],signal);
      assert.deepEqual([local.answer,local.provisional],['Yes',false]);
      for(const [wording,formId] of [[relocate.question,'other'],[relocate.question.replace('Ottawa','Paris'),'application']]){
        assert.equal((await plan({...relocate,question:wording!},[{...canada,formId:formId!}],signal)).provisional,true);
      }
      const french={...relocate,control:'text',options:[],question:'Please tell us a bit about your level of fluency in written and spoken French? *'};
      const level=await plan(french,[],signal);
      assert.deepEqual([level.answer,level.provisional],['French: intermediate',false]);
      assert.equal((await plan({...french,question:french.question.replace('French','German')},[],signal)).provisional,true);
      const results = [];
      for (const [question, options, selected, readOnly] of cases) {
        const row = {pageId:'page', fieldId:'choice', signature:'fixture', question, options, selected,
          required:true, control:'radio', valid:Boolean(selected), constraints:{readOnly}};
        const result = await plan(row, [row], AbortSignal.timeout(5000));
        results.push([question, result.answer, result.provisional, result.lane]);
      }
      assert.deepEqual(results, cases.map(([question, , , , expected]) => [question, ...expected]));
    } finally { disposeResumeArtifact(sources.resumeIntent.artifact); }
    const withExperience = (value: string) => ({...profile, profilePlan:{...profile.profilePlan,repeatables:[
      {section:'experience',rows:[{rowKey:'fixture',fields:[{fieldId:'experience.description',questionType:'experience',
        answerType:'text',allowedOptions:[],answer:{kind:'answered',value,provenance:'resume_verified',lane:'live_owner_fact'}}]}]},
    ]}});
    for (const [description, verified] of [['Automated deployment pipelines using Kubernetes.', true],
      ['Automated deployment pipelines without Kubernetes.', false],['Familiar with AWS terminology.', false]] as const) {
      await page.goto(url);
      const learningRoot = mkdtempSync(join(tmpdir(), 'hunt-hosted-answers-'));
      try {
        const result = await fillApplication(page,{url,profile:withExperience(description),learningRoot,resume:Buffer.from('%PDF-fixture')},
          AbortSignal.timeout(12000),()=>{});
        assert.ok(result.reviewDigest);
        assert.equal(result.needsOwnerReview,true);
        const journal = JSON.parse(readFileSync(join(learningRoot,'matching-backlog.json'),'utf8'));
        const entry = journal.entries.find((row: { question: string }) => row.question === cloud);
        assert.ok(entry);
        assert.equal(entry.attempts.some((attempt: { reason: string }) => attempt.reason === 'profile_answer'),verified);
        if (!verified) assert.equal(entry.provisional,true);
      } finally { rmSync(learningRoot,{recursive:true,force:true}); }
      assert.equal(await page.locator('#cloud').inputValue(),'YES');
      assert.equal(await page.locator('#location').inputValue(),'YES');
      assert.equal(await page.locator('#gpa').inputValue(),'3.7/4.0');
      assert.equal(await page.locator('#coop').inputValue(),'Yes');
      assert.equal(await page.locator('#address').inputValue(),'123 Fixture St, Edmonton, Alberta T5A 0A1, Canada');
      assert.equal(await page.locator('#compensation').inputValue(),'CAD 80,000 per year');
      assert.equal(await page.locator('#ai').inputValue(),'YES');
      assert.equal(await page.evaluate('window.submitted'),undefined);
    }
  } finally { await browser.close(); }
});

test('bilingual screening uses Canadian eligibility, separates background consent and preserves the prior-employer choice', async () => {
  const url = 'https://jobs.smartrecruiters.com/oneclick-ui/company/ReitmansCanadaLteLtd/publication/11111111-1111-4111-8111-111111111111/screening';
  const company = matchingContext(url).company;
  assert.equal(company, 'ReitmansCanadaLteLtd');
  const eligible = "Êtes vous présentement admissible à travailler au Canada? | Are you currently eligible to work in Canada?";
  const available = "Êtes-vous actuellement disponible pour travailler à l’emplacement du poste ? | Are you currently available work at the job location?";
  const background = "Si vous recevez une offre d'emploi de RCL, vous consentez à respecter le processus de vérification d'emploi et de références. | If advanced to an offer of employment with RCL, you consent to respecting the employment verification and background check process.";
  const prior = "Avez-vous déjà été employé.e par RCL - Reitmans (Canada) Ltée ou l’une de ses marques (Reitmans, PENN. Penningtons, RW&CO) ? | Have you ever been employed by RCL - Reitmans (Canada) Ltd or any of its brands (Reitmans, PENN. Penningtons, RW&CO)?";
  const privacy = "You declare that you have read and agree to the privacy notice of Reitmans (Canada) Ltée/Ltd.";
  const employers = ["Oui, je suis actuellement employé.e chez RCL | Yes, I am currently employed at RCL", "Oui, j’ai déjà été employé.e chez RCL | Yes, I was previously employed at RCL", "Non | No"];

  for (const [granted, willing] of [[true, false], [false, true], [true, undefined]] as const) {
    const base = applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
      work_authorization_canada:String(granted),ai_evaluation_consent:willing === undefined ? '' : String(!granted)}) as {profile:ReturnType<typeof parseApplicationProfile>;profilePlan:ProfilePagePlan};
    const profile = {...base,profile:{...base.profile,unsetFactIds:base.profile.unsetFactIds.filter(id => id !== 'terms_consent' && (willing === undefined || id !== 'background_check_willing')),facts:[...base.profile.facts,
      {factId:'terms_consent',value:granted,provenance:'owner_provided',lane:'live_owner_fact'},
      ...(willing === undefined ? [] : [{factId:'background_check_willing',value:willing,provenance:'owner_provided',lane:'live_owner_fact'}])]}};
    const sources = productSources(profile, Buffer.from('%PDF-fixture'));
    try {
      const plan = createPageAnswerPlanner(sources, effectiveProfileFacts(profile), company);
      const answer = async (question: string, control: 'radio'|'listbox'|'checkbox', options: string[], required = true, planner = plan) => {
        const row = {pageId:'screening',fieldId:'q',signature:'fixture',question,options,
          selected:control==='checkbox'?false:'',required,control,valid:false};
        return planner(row, [row], AbortSignal.timeout(3000));
      };
      for (const [q,expected,lane] of [
        [eligible,granted ? 'Yes' : 'No','live_owner_fact'],
        [available,'Yes','synthetic_test_default'],
        [background,willing === undefined ? null : willing ? 'Yes' : 'No',willing === undefined ? undefined : 'live_owner_fact'],
      ] as const) {
        const result = await answer(q, 'radio', ['Yes','No']);
        assert.deepEqual([result.answer,result.lane], [expected,lane]);
      }
      const screeningQuestion = 'I consent to automated screening of my application.';
      const existingDecline = {pageId:'screening',fieldId:'ai',signature:'fixture',question:screeningQuestion,options:['Yes','No'],
        selected:'No',required:true,control:'radio' as const,valid:true};
      assert.equal((await plan(existingDecline,[existingDecline],AbortSignal.timeout(3000))).answer,null);
      assert.equal((await answer(screeningQuestion,'radio',['Yes','No'],false)).answer,null);
      const ai = await answer(screeningQuestion,'radio',['Yes','No']);
      assert.equal(ai.answer,willing === undefined ? null : granted ? 'No' : 'Yes');
      assert.equal(ai.provisional,willing === undefined);
      const mixed='We use automated tools to screen applications. I accept the application terms.';
      assert.equal((await answer(mixed,'radio',['Yes','No'])).reason,'protected_answer_denied');
      assert.equal((await answer(mixed,'checkbox',[],false)).reason,'optional_field');
      for (const flags of [{state:'ambiguous' as const},{state:'hidden' as const},{constraints:{readOnly:true}}]) {
        const optional = {...existingDecline,...flags,required:false,selected:''};
        const result = await plan(optional,[optional],AbortSignal.timeout(3000));
        assert.deepEqual([result.answer,result.reason,result.provisional],[null,'optional_field',false]);
      }
      const mixedDecline={...existingDecline,question:mixed};
      assert.equal((await plan(mixedDecline,[mixedDecline],AbortSignal.timeout(3000))).reason,'readback_only');
      const expectedBackground = willing === undefined ? null : willing ? 'Yes' : 'No';
      assert.equal((await answer(background.replaceAll('RCL','ABC'),'radio',['Yes','No'])).answer,expectedBackground);
      assert.equal((await answer(background.replace('de RCL','de XYZ'),'radio',['Yes','No'])).answer,null);
      assert.equal((await answer(background+' You also authorize a credit report.','radio',['Yes','No'])).answer,null);
      const filled = {pageId:'screening',fieldId:'q',signature:'fixture',question:background,options:['Yes','No'],
        selected:'Yes',required:true,control:'radio' as const,valid:true};
      assert.equal((await plan(filled,[filled],AbortSignal.timeout(3000))).answer,willing === undefined ? null : willing ? 'Yes' : 'No');
      const history = await answer(prior,'listbox',employers);
      assert.deepEqual([history.answer,history.provisional],['Non | No',true]);
      const notice = await answer(privacy,'checkbox',[]);
      assert.deepEqual([notice.answer,notice.provisional],[granted,false]);
      for (const [q,required] of [[privacy,false],[privacy.replace('Reitmans','Another Employer'),true],
        [privacy + ' You also authorize a background check.',true]] as const) {
        assert.equal((await answer(q,'checkbox',[],required)).answer,null);
      }
      const spectrum = createPageAnswerPlanner(sources, effectiveProfileFacts(profile), 'SpectrumHealthCare');
      const spectrumNotice = 'You declare that you have read and understand the privacy notice of Spectrum Health Care.';
      assert.equal((await answer(spectrumNotice,'checkbox',[],true,spectrum)).answer,granted);
      assert.equal((await answer(spectrumNotice,'checkbox',[],false,spectrum)).answer,null);
      assert.equal((await answer(spectrumNotice,'checkbox',[])).answer,null);
      assert.equal((await answer(spectrumNotice+' You also authorize a background check.','checkbox',[],true,spectrum)).answer,null);
      const otherCountry = await answer(eligible.replace('Canada?', 'France?'),'radio',['Yes','No']);
      assert.ok(otherCountry.provisional);
    } finally { disposeResumeArtifact(sources.resumeIntent.artifact); }
  }
});

test('current-page education dates and searchable profile choices use the corresponding saved facts', async () => {
  const profile = applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
    country:'Canada',city:'Edmonton',region:'Alberta',application_source:'Job board',sponsorship_required_canada:'false',
    education_institution:'Fixture University',education_field_of_study:'Computer Science',education_degree:'Bachelor of Science',
    education_start_year:'2019',education_end_year:'2023',earliest_start_date:'2027-06-15'});
  const sources = productSources(profile,Buffer.from('%PDF-fixture'));
  try {
    const facts = effectiveProfileFacts(profile);
    const makePlan = (saved = facts) => createPageAnswerPlanner(sources,saved,'Example Company',undefined,true);
    const plan = makePlan();
    const row = {pageId:'application',fieldId:'question',signature:'fixture',required:true,selected:'',valid:false};
    for (const [question,options,expected] of [
      ['Location (City)', ['Edmonton, Kentucky, United States','Edmonton, Alberta, Canada'], 'Edmonton, Alberta, Canada'],
      ['School', ['Other','Fixture University'], 'Fixture University'],
      ['Discipline', ['Mathematics','Computer Science'], 'Computer Science'],
      ['Degree', ['Associate Degree',"Bachelor's Degree"], "Bachelor's Degree"],
      ['Country', ['United States +1','Canada +1'], 'Canada +1'],
      ['Which U.S. State or Canadian Province do you reside in?', ['Alabama','Alberta'], 'Alberta'],
      ['How did you first learn about Example Company as an employer?', ['Company blog','LinkedIn'], 'LinkedIn'],
      ['Do you now, or will you in the future, require immigration sponsorship to work for Example Company in Canada?', ['Yes','No'], 'No'],
      ['Have you previously been employed at Example Company for any length of time?',
        ['I have been employed at Example Company as an intern','I have not previously been employed at Example Company'],
        'I have not previously been employed at Example Company'],
    ] as const) {
      const choice = {...row,question,options,control:'listbox',queryable:true};
      const result = await plan(choice,[],AbortSignal.timeout(3000));
      assert.deepEqual([result.answer,result.provisional], [expected,false],question);
    }
    const school = {...row,question:'School',control:'listbox',required:false,queryable:true,options:[]};
    const schoolQuery = await plan(school,[],AbortSignal.timeout(3000));
    assert.deepEqual([schoolQuery.query,schoolQuery.reason],['Fixture University','saved_profile_field']);
    const schoolChoice = await plan({...school,options:['Fixture University']},[],AbortSignal.timeout(3000));
    assert.deepEqual([schoolChoice.answer,schoolChoice.reason],['Fixture University','saved_profile_field']);
    assert.equal((await plan({...school,searchQuery:'Fixture University',options:['Fixture College']},[],AbortSignal.timeout(3000))).answer,null);
    const pronouns = {...row,question:'Pronouns',control:'listbox',queryable:true,options:['He/him/his','She/her/hers','I prefer not to say']};
    const neutral = await plan(pronouns,[],AbortSignal.timeout(3000));
    assert.deepEqual([neutral.answer,neutral.provisional],['I prefer not to say',true]);
    assert.equal((await plan({...pronouns,options:['He/him/his','She/her/hers']},[],AbortSignal.timeout(3000))).answer,null);
    assert.equal((await plan({...pronouns,selected:'She/her/hers',valid:true},[],AbortSignal.timeout(3000))).answer,null);
    for (const [question,expected] of [['Education start date year','2019'],['Education end date year','2023'],['Start date year',null],['End date year',null]] as const) {
      const year = {...row,question,options:[],control:'text',constraints:{inputType:'number'}};
      assert.equal((await plan(year,[],AbortSignal.timeout(3000))).answer,expected);
      const missingYears = makePlan(facts.filter(fact => !['education_start_year','education_end_year'].includes(fact.factId)));
      assert.equal((await missingYears(year,[],AbortSignal.timeout(3000))).answer,null);
    }
  } finally { disposeResumeArtifact(sources.resumeIntent.artifact); }
});
