import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fillApplication } from '../../src/product/engine.ts';
import { applicantProfile, effectiveProfileFacts, productSources } from '../../src/product/sources.ts';
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
      education_gpa:'3.7', education_gpa_scale:'4.0', official_coop_program:'true', sponsorship_required_canada:'false', application_source:'Job board', salary_expectations:'CAD 80,000 per year'}) as {profilePlan:ProfilePagePlan};
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
      const plan = createPageAnswerPlanner(sources, effectiveProfileFacts(profile), employer);
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
