import type { BaselineJob } from "../../src/testing/job-flow-campaign.ts";

// Deliberately synthetic, production-shaped DOM. Never fetch or copy applicant data.
export function jobFlowFixture(job: BaselineJob): string {
  const order = job.permittedJourney.filter((state) => ["profile", "resume", "questionnaire", "review"].includes(state));
  const region = job.syntheticRegion;
  return `<!doctype html><html lang="en"><title>Synthetic job journey</title><body>
  <h1>Synthetic ${job.company} fixture</h1><div id="surface"></div>
  <script>
    const order = ${JSON.stringify(order)};
    let state = JSON.parse(localStorage.getItem('fixture') || 'null') || { stage: 'posting', index: 0, values: {}, effects: 0 };
    const save = () => localStorage.setItem('fixture', JSON.stringify(state));
    const surface = document.getElementById('surface');
    function render() {
      if (state.stage === 'posting') {
        surface.innerHTML = '<button id="apply">Apply to synthetic fixture</button>';
        document.getElementById('apply').onclick = () => { state.stage = 'auth'; save(); render(); }; return;
      }
      if (state.stage === 'auth') {
        surface.innerHTML = '<label>Synthetic email<input id="email" type="email"></label><button id="signin">Mock sign in</button>';
        document.getElementById('signin').onclick = () => { state.stage = 'verify'; save(); render(); }; return;
      }
      if (state.stage === 'verify') {
        surface.innerHTML = '<p>Mock mailbox verification only</p><button id="verify">Verify fixture identity</button>';
        document.getElementById('verify').onclick = () => { state.stage = 'application'; save(); render(); }; return;
      }
      const page = order[state.index];
      const roots = { profile: 'applyFlowMyInfoPage', resume: 'applyFlowMyExperiencePage', questionnaire: 'applyFlowApplicationQuestionsPage', review: 'applyFlowReviewPage' };
      const controls = {
        profile: '<label>First name Required<input required data-hunt-field-id="name" data-key="name"></label><label>Region Required<select required data-hunt-field-id="region" data-key="region"><option value="">Choose</option><option value="${region}">${region}</option></select></label>',
        resume: '<label>Resume<input required type="file" data-hunt-field-id="resume-artifact" data-automation-id="file-upload-input-ref"></label>',
        questionnaire: '<label>Fixture answer Required<textarea required data-hunt-field-id="answer" data-key="answer"></textarea></label><label><input type="checkbox" data-key="reveal">Show follow-up</label><div id="followup"></div>',
        review: '<p>Review reached. Never submit.</p><button id="submit" disabled>Submit</button>'
      };
      surface.innerHTML = '<main data-automation-id="' + roots[page] + '">' + controls[page] + '</main>' + (page === 'review' ? '' : '<footer><button hidden>Next</button><button id="next">Save and Continue</button></footer>');
      if (page === 'resume') surface.querySelector('input[type=file]').onchange = (event) => {
        const item = document.createElement('div');
        item.setAttribute('data-automation-id', 'file-upload-item');
        item.setAttribute('data-upload-state', 'success');
        item.textContent = 'Synthetic upload complete';
        event.target.parentElement.append(item);
      };
      for (const input of surface.querySelectorAll('[data-key]')) {
        if (input.type !== 'checkbox') input.value = state.values[input.dataset.key] || '';
        input.onchange = () => {
          state.values[input.dataset.key] = input.value; save();
          if (input.type === 'checkbox') document.getElementById('followup').innerHTML = input.checked ? '<label>Follow-up Required<input required data-hunt-field-id="followup" data-key="followup"></label>' : '';
        };
      }
      if (page !== 'review') document.getElementById('next').onclick = () => {
        state.effects++; state.index++; save();
        surface.innerHTML = '<main data-automation-id="applyFlowLoadingPage"></main>';
        setTimeout(render, 100);
      };
    }
    render();
  </script></body></html>`;
}
