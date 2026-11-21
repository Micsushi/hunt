import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillApplication } from '../../src/product/engine.ts';
import { applicantProfile } from '../../src/product/sources.ts';
import type { ProfilePagePlan } from '../../src/ats/workday/application/profile/types.ts';

const cloud = 'Do you have any hands-on experience with Kubernetes, Docker, or cloud platforms (e.g., AWS, Azure, GCP)?';
const location = 'This role requires employees to be based in the United States or Canada. Are you currently located in the U.S. or Canada?';
const coop = 'Are you currently enrolled in a Co-op or Work-Integrated Learning (WIL) program through your school?';
const select = (id: string, label: string) => `<label>${label}<select id="${id}" required><option value="">Choose</option><option>YES</option><option>NO</option></select></label>`;

test('hosted campaign questions fill from saved profile authority and leave unsupported questions open', async () => {
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
      education_gpa:'3.7', education_gpa_scale:'4.0', official_coop_program:'true', salary_expectations:'CAD 80,000 per year'}) as {profilePlan:ProfilePagePlan};
    const withExperience = (value: string) => ({...profile, profilePlan:{...profile.profilePlan,repeatables:[
      {section:'experience',rows:[{rowKey:'fixture',fields:[{fieldId:'experience.description',questionType:'experience',
        answerType:'text',allowedOptions:[],answer:{kind:'answered',value,provenance:'resume_verified',lane:'live_owner_fact'}}]}]},
    ]}});
    for (const [description, expected] of [['Automated deployment pipelines using Kubernetes.', 'YES'],
      ['Automated deployment pipelines without Kubernetes.', ''],['Familiar with AWS terminology.', '']]) {
      await page.goto(url);
      await assert.rejects(fillApplication(page,{url,profile:withExperience(description!),resume:Buffer.from('%PDF-fixture')},
        AbortSignal.timeout(12000),()=>{}), /Required or invalid fields remain/);
      assert.equal(await page.locator('#cloud').inputValue(),expected);
      assert.equal(await page.locator('#location').inputValue(),'YES');
      assert.equal(await page.locator('#gpa').inputValue(),'3.7/4.0');
      assert.equal(await page.locator('#coop').inputValue(),'Yes');
      assert.equal(await page.locator('#address').inputValue(),'123 Fixture St, Edmonton, Alberta T5A 0A1, Canada');
      assert.equal(await page.locator('#compensation').inputValue(),'CAD 80,000 per year');
      assert.equal(await page.locator('#ai').inputValue(),'');
      assert.equal(await page.evaluate('window.submitted'),undefined);
    }
  } finally { await browser.close(); }
});
