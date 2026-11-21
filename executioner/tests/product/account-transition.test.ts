import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journeyId } from "../../src/contracts/index.ts";
import { PlaywrightWorkdayApplicationPage } from "../../src/ats/workday/application/playwright-page.ts";
import { observeWorkdayPage } from "../../src/ats/workday/page-observation.ts";
import { chromium } from "playwright";
import { ApplicationPause, fillApplication } from "../../src/product/engine.ts";
import { fixtureApplicantProfile, accountFixture, applicationFixture } from "./fixture.ts";

test("missing answers reload only a bound required empty busy catalog and only once", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    for (const scenario of ["recovers", "persistent", "ordinary-missing", "wrong-owner", "has-options"]) {
      const page = await browser.newPage();
      let loads = 0;
      await page.route("**/*", route => {
        loads++;
        return route.fulfill({ contentType: "text/html", body: applicationFixture });
      });
      const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
      await page.goto(url);
      // Inject the already-confirmed profile failure at the handler boundary;
      // the recovery decision still reads actual browser ownership/loading DOM.
      const install = async () => page.evaluate(({ scenario }) => {
        document.querySelector('[data-automation-id="applyFlowPage"]')!.insertAdjacentHTML('beforeend',
          '<input aria-required="true" data-uxi-multiselect-id="source-widget">');
        if (scenario !== "ordinary-missing") document.body.insertAdjacentHTML('beforeend',
          `<div data-automation-id="responsiveMonikerPrompt" aria-busy="true" data-associated-widget="${scenario === "wrong-owner" ? "different-widget" : "source-widget"}"><div>Loading</div>${scenario === "has-options" ? '<div role="option">Available</div>' : ''}</div>`);
      }, { scenario });
      await install();
      const reload = page.reload.bind(page);
      page.reload = async options => { const result = await reload(options); if (scenario === "persistent") await install(); return result; };
      const stages: string[] = [];
      const fill = fillApplication(page, { url,
        profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
        resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
      }, AbortSignal.timeout(25_000), stage => {
        stages.push(stage);
        if (stage === "Filling profile" && (loads === 1 || scenario === "persistent")) throw new ApplicationPause("Application paused: profile_answer_missing.");
      });
      if (scenario === "recovers") assert.match((await fill).reviewDigest, /^[a-f0-9]{64}$/);
      else await assert.rejects(fill, scenario === "persistent" ? /still loading required choices/ : /profile_answer_missing/);
      const recoveryExpected = scenario === "recovers" || scenario === "persistent";
      assert.equal(loads, recoveryExpected ? 2 : 1);
      assert.equal(stages.filter(stage => stage === "Recovering employer page").length, recoveryExpected ? 1 : 0);
      assert.equal(await page.evaluate("submits"), 0);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("saved Review or Experience continues without rewinding and requires owner review", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    for (const scenario of ["review", "experience", "missing-back", "bad-summary"]) {
      const canGoBack = scenario !== "missing-back";
      const page = await browser.newPage();
      const learningRoot = mkdtempSync(join(tmpdir(), "hunt-product-learning-"));
      const fixture = applicationFixture.replace("profile();", `${scenario === "experience" ? "resume" : "review"}();
        ${canGoBack ? `const back=document.createElement('button');back.dataset.automationId='pageFooterBackButton';back.textContent='Back';back.onclick=()=>{window.rewinds=(window.rewinds||0)+1;profile();};root.append(back);` : ""}`)
        .replace("[...saved,resumeName,answer]", scenario === "bad-summary" ? "[]" : "[...saved,resumeName,answer]");
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture }));
      const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
      await page.goto(url);
      const stages: string[] = [];
      const fill = fillApplication(page, { url, learningRoot,
        profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
        resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
      }, AbortSignal.timeout(25_000), stage => stages.push(stage));
      const result = await fill;
      assert.equal(result.needsOwnerReview, true);
      assert.ok(stages.includes("Continuing saved application"));
      assert.equal(await page.evaluate("window.rewinds"), undefined);
      const verification=JSON.parse(readFileSync(join(learningRoot,"review-verification.json"),"utf8"));
      assert.equal(verification.status,"owner_review_required");
      assert.equal(verification.earlierPagesNotReverified,true);
      if(scenario==="experience")assert.ok(result.completedPages>0);
      else {
        assert.equal(result.completedPages,0);
        assert.equal(verification.reason,"current_run_expectations_absent");
      }
      assert.equal(await page.evaluate("submits"), 0);
      await page.close();
      rmSync(learningRoot, { recursive: true, force: true });
    }
  } finally { await browser.close(); }
});

test("account entry uses existing sign-in only and never creates or accepts terms", { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    for (const scenario of ["created", "rejected", "existing-inline", "terms-unchecked"]) {
      const reject = scenario === "rejected";
      const page = await browser.newPage();
      let fixture = accountFixture
        .replace("sessionStorage.setItem('created','yes');root.innerHTML='<section data-automation-id=\"emailVerificationPage\">An email has been sent to you. Please verify your account.</section>';", "sessionStorage.setItem('created','yes');signIn();")
        .replace("()=>document.querySelector('#error').innerHTML='<p data-automation-id=\"accountNotFoundError\">Account not found</p>'",
          `()=>{window.signInAttempts=(window.signInAttempts||0)+1;${reject
            ? `document.querySelector('#error').innerHTML='<p data-automation-id="accountNotFoundError">Account not found</p>';`
            : "profile();"}}`)
        .replace("else signIn();", "else createAccount();");
      if (scenario === "terms-unchecked") fixture=fixture.replace('type="checkbox" checked','type="checkbox"');
      if (scenario === "existing-inline") {
        fixture = fixture.replace('data-automation-id="createAccountPage"', 'data-automation-id="signInFormo"')
          .replace("root.querySelector('button').onclick=()=>{sessionStorage.setItem('created','yes');signIn();};",
            "const link=document.createElement('button');link.dataset.automationId='signInLink';link.textContent='Sign In';link.onclick=signIn;root.append(link);root.querySelector('button').onclick=()=>{window.unwantedCreation=true;};");
      }
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture }));
      const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
      await page.goto(url);
      const stages: string[] = [];
      const fill = fillApplication(page, { url,
        profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
        resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
        credentials: { email: "fixture@example.invalid", password: "Synthetic-only-123!" },
        recordAccountAction: () => {},
      }, AbortSignal.timeout(25_000), stage => stages.push(stage));
      if (scenario !== "existing-inline") {
        await assert.rejects(fill,/showing account creation/);
        assert.equal(await page.locator('[data-automation-id="createAccountCheckbox"]').isChecked(),scenario !== "terms-unchecked");
        assert.equal(await page.evaluate("sessionStorage.getItem('created')"),null);
        await page.close();continue;
      }
      if (reject) await assert.rejects(fill, /site rejected account access/);
      else assert.match((await fill).reviewDigest, /^[a-f0-9]{64}$/);
      assert.ok(stages.includes(scenario === "existing-inline" ? "Opening existing account sign-in" : "Signing in after account creation"));
      if (scenario === "existing-inline") assert.equal(await page.evaluate("window.unwantedCreation"), undefined);
      assert.equal(await page.evaluate("window.signInAttempts"), 1);
      assert.equal(await page.evaluate("submits"), 0);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("employer error recovery waits for delayed readiness and stops at its reload limit", { timeout: 240_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    for (const scenario of ["coded", "entry", "mid-fill", "delayed", "second-reload", "reopen", "persistent", "aborted", "moved"]) {
      const persistent = scenario === "persistent";
      const page = await browser.newPage();
      let loads = 0;
      await page.route("**/*", route => {
        loads++;
        const errorPage = "<h1>Something went wrong</h1><p>Please refresh the page and then try again.</p>";
        let body = persistent || scenario === "reopen" && loads < 5 || loads === 1 && ["entry", "delayed", "second-reload", "aborted", "moved"].includes(scenario) || scenario === "second-reload" && loads === 2 ? errorPage : applicationFixture;
        if (scenario === "delayed" && loads === 2) {
          body = errorPage + `<script>setTimeout(()=>{document.open();document.write(${JSON.stringify(applicationFixture).replaceAll("</script", "<\\/script")});document.close()},2500)</script>`;
        }
        return route.fulfill({ contentType: "text/html", body });
      });
      const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
      await page.goto(url);
      if (scenario === "coded") {
        const form = '<main data-automation-id="applyFlowMyInfoPage"><input required value="saved"><button type="button" id="next">Next</button><button type="button" id="submit">Submit</button></main>';
        const code = "Error Page Error - Error Code: VPS|SYNTHETIC-CODE";
        for (const [markup, blocked] of [
          ['<div data-automation-id="errorMessage">'+code+'</div>', true],
          ['<div data-automation-id="inputAlert">'+code+'</div>', true],
          ['<aside role="alert">'+code+'</aside>', true],
          ['<div class="error-summary">'+code+'</div>', true],
          ['<div role="alert">'+code+'<span hidden>ignored</span></div>', true],
          ['<div data-automation-id="inputAlert">This field is required.</div>', false],
          ['<p>'+code+'</p>', false],
          ['<div role="alert" hidden>'+code+'</div>', false],
          ['<div role="alert"><span hidden>'+code+'</span></div>', false],
          ['<div style="opacity:0"><aside role="alert">'+code+'</aside></div>', false],
          ['<div role="alert"><span contenteditable>'+code+'</span></div>', false],
          ['<div role="alert"><textarea>'+code+'</textarea></div>', false],
          ['<div role="alert"><div role="option">'+code+'</div></div>', false],
          ['<div role="alert">Previous example: '+code+'</div>', false],
          ['<div role="alert">Error Page Error - Error Code:</div>', false],
        ] as const) {
          await page.setContent(form+markup);
          const observed = await observeWorkdayPage(page);
          assert.equal(observed.kind, blocked ? "employer_coded_error" : "application", markup);
          assert.equal(observed.signals.includes("coded_page_error"), blocked);
          assert.doesNotMatch(JSON.stringify(observed), /SYNTHETIC-CODE|VPS\|/);
        }
        await page.setContent(form+'<aside role="alert">'+code+'</aside>');
        await page.evaluate(() => {
          document.body.dataset.effects = "0";
          for (const name of ["click", "input", "change", "submit"]) {
            document.addEventListener(name, () => { document.body.dataset.effects = "changed"; }, true);
          }
        });
        const initial = await observeWorkdayPage(page);
        await assert.rejects(fillApplication(page, {url,profile:{},resume:Buffer.from("fixture")}, AbortSignal.timeout(5000),()=>{}), /coded page error/);
        assert.equal(await page.locator("body").getAttribute("data-effects"), "0");
        assert.equal((await observeWorkdayPage(page)).documentKey, initial.documentKey);
        assert.equal(loads, 1);
        for (const phase of ["focus", "after-click", "loading-after-click"] as const) {
          await page.setContent(form);
          await page.evaluate(({phase, code}) => {
            const next = document.querySelector<HTMLButtonElement>("#next")!;
            document.body.dataset.next = "0";
            document.body.dataset.submit = "0";
            document.querySelector<HTMLButtonElement>("#submit")!.onclick = () => { document.body.dataset.submit = "1"; };
            const showNotice = () => document.body.insertAdjacentHTML("beforeend", '<aside role="alert">'+code+'</aside>');
            if (phase === "focus") next.onfocus = showNotice;
            next.onclick = () => {
              document.body.dataset.next = "1";
              showNotice();
              if (phase === "loading-after-click") {
                document.querySelector("main")!.remove();
                document.body.insertAdjacentHTML("beforeend", '<div data-automation-id="applyFlowPage"><div data-automation-id="applyFlowLoadingPage">Loading</div></div>');
              }
            };
          }, {phase, code});
          const adapter = new PlaywrightWorkdayApplicationPage(page, {timeoutMs: 100, navigationSettleTimeoutMs: 120});
          const start = await adapter.observe(AbortSignal.timeout(5000));
          assert.ok(start.ok && start.value.page === "profile");
          const result = await adapter.next({
            journeyId: journeyId("journey_coded_error_probe_01"), from: start.value.page,
            fromPageId: start.value.pageId, allowed: ["profile", "questionnaire"],
          }, AbortSignal.timeout(5000));
          assert.ok(!result.ok);
          assert.equal(result.error.code, "page_incomplete", phase);
          assert.equal(await page.locator("body").getAttribute("data-next"), phase === "focus" ? "0" : "1");
          assert.equal(await page.locator("body").getAttribute("data-submit"), "0");
          assert.equal(loads, 1);
        }
        await page.close();
        continue;
      }
      const stages: string[] = [];
      let interruptProfile = false;
      const evaluate = page.evaluate.bind(page);
      page.evaluate = (async (...args: Parameters<typeof page.evaluate>) => {
        if (interruptProfile) {
          interruptProfile = false;
          await evaluate(() => { document.body.innerHTML = "<h1>Something went wrong</h1><p>Please refresh the page and then try again.</p>"; });
          throw new Error("Employer document replaced during profile operation");
        }
        return evaluate(...args);
      }) as typeof page.evaluate;
      const controller = new AbortController();
      const fill = fillApplication(page, { url,
        profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
        resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
      }, AbortSignal.any([controller.signal, AbortSignal.timeout(100_000)]), stage => {
        stages.push(stage);
        if (scenario === "aborted" && stage === "Recovering employer page") controller.abort(new Error("fixture cancelled"));
        if (scenario === "moved" && stage === "Recovering employer page") page.url = () => "https://fixture.wd1.myworkdayjobs.com/External/job/City/Other_R2";
        if (scenario === "mid-fill" && loads === 1 && stage === "Filling profile") interruptProfile = true;
      });
      if (persistent) await assert.rejects(fill, /still showing a site error after refreshing/);
      else if (scenario === "aborted") await assert.rejects(fill, /fixture cancelled/);
      else if (scenario === "moved") await assert.rejects(fill, /different job/);
      else {
        assert.match((await fill).reviewDigest, /^[a-f0-9]{64}$/);
        assert.equal(await page.evaluate("submits"), 0);
      }
      assert.equal(loads, persistent || scenario === "reopen" ? 5 : scenario === "second-reload" ? 3 : ["aborted", "moved"].includes(scenario) ? 1 : 2);
      assert.equal(stages.filter(stage => stage === "Recovering employer page").length, persistent || scenario === "reopen" ? 3 : scenario === "second-reload" ? 2 : 1);
      await page.close();
    }
  } finally { await browser.close(); }
});


test("administrator reset pauses without requesting an email or changing the password", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
    let reset = false, requests = 0, links = 0;
    await page.exposeFunction("resetDone", () => { reset = true; });
    await page.exposeFunction("resetRequested", () => { requests++; });
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body:
      route.request().url().includes("resetPassword?token=")
        ? `<input data-automation-id="password" type="password"><input data-automation-id="verifyPassword" type="password"><button data-automation-id="resetPasswordSubmitButton" onclick="resetDone().then(()=>document.body.innerHTML='Password reset')">Reset</button>`
        : reset ? applicationFixture
        : `<div role="alert"><p>You need to reset your password due to an administrator request. Click Forgot Password to continue.</p></div><button data-automation-id="forgotPasswordLink" onclick="document.body.innerHTML='<input data-automation-id=email><button data-automation-id=resetPasswordButton onclick=resetRequested()>Reset Password</button>'">Forgot password</button>` }));
    await page.goto(url);
    const result = fillApplication(page, { url,
      profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
      resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
      credentials: { email: "fixture@example.invalid", password: "Synthetic-only-123!" },
      recordAccountAction:()=>{},
      verifyEmail: async target => { links++; await target.goto("https://fixture.wd1.myworkdayjobs.com/resetPassword?token=synthetic"); },
    }, AbortSignal.timeout(45_000), () => {});
    await assert.rejects(result,/requires a password reset/);
    assert.equal(requests, 0); assert.equal(links, 0); assert.equal(reset, false);
  } finally { await browser.close(); }
});


test("saved-draft continuation ignores stalled Back and never reopens the posting", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage(); let loads = 0;
    const stalled = applicationFixture.replace("profile();", "resume();const back=document.createElement('button');back.dataset.automationId='pageFooterBackButton';back.textContent='Back';root.append(back);");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: ++loads === 1 ? stalled : applicationFixture }));
    const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
    await page.goto(url);
    const result = await fillApplication(page, { url,
      profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
      resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
    }, AbortSignal.timeout(45_000), () => {});
    assert.equal(loads, 1); assert.ok(result.completedPages > 0); assert.equal(result.needsOwnerReview,true);
    assert.equal(await page.evaluate("submits"), 0);
  } finally { await browser.close(); }
});

test("a missing posting is identified before account actions or the readiness deadline", { timeout: 15_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<h1>The page you are looking for doesn't exist.</h1>" }));
    const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
    await page.goto(url);
    await assert.rejects(fillApplication(page, { url, profile: {}, resume: Buffer.from("synthetic") },
      AbortSignal.timeout(5_000), () => {}), /posting is no longer available/);
  } finally { await browser.close(); }
});

for (const late of [true, false]) test(`application entry ${late ? "accepts a verified late destination" : "preserves unrelated activation errors"}`, { timeout: 60_000 }, async () => {
  const { PlaywrightPostingNavigationAdapter } = await import("../../src/browser/playwright-live/private/playwright-posting-navigation.ts");
  const activate = PlaywrightPostingNavigationAdapter.prototype.activate;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); let activations = 0;
    const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body:
      route.request().url().includes("opened=1") ? applicationFixture : '<button>Apply Manually</button>' }));
    PlaywrightPostingNavigationAdapter.prototype.activate = async function(current, action) {
      if (action !== "apply_manually") return activate.call(this, current, action);
      activations++;
      await page.goto(url + "?opened=1");
      if (late) throw new TypeError("account or application destination did not settle");
      throw new Error("unrelated activation failure");
    };
    await page.goto(url); const stages: string[] = [];
    const fill = fillApplication(page, { url,
      profile: fixtureApplicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid", previously_worked_for_organization: "false" }),
      resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
    }, AbortSignal.timeout(45_000), stage => stages.push(stage));
    if (late) {
      assert.match((await fill).reviewDigest, /^[a-f0-9]{64}$/);
      assert.ok(stages.includes("Continuing opened application"));
      assert.equal(await page.evaluate("submits"), 0);
    } else await assert.rejects(fill, /unrelated activation failure/);
    assert.equal(activations, 1);
  } finally {
    PlaywrightPostingNavigationAdapter.prototype.activate = activate;
    await browser.close();
  }
});

for (const required of [false, true]) test(`assessment stage ${required ? "reports a real gate" : "continues to verified Review"}`, {timeout:60000}, async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    const fixture=applicationFixture.replace('review();', 'assessment();').replace('function review()', `function assessment(){root.innerHTML='<section data-automation-id="takeAssessmentPage"><h2>Take Assessment</h2><button data-automation-id="inlineAssessmentButton">Take Assessment</button><button data-automation-id="pageFooterNextButton">Save and Continue</button></section>';root.querySelector('[data-automation-id="pageFooterNextButton"]').onclick=()=>{${required ? `root.insertAdjacentHTML('beforeend','<div role="alert">You must complete the assessment test to continue with your job application.</div>');` : 'review();'}};} function review()`);
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture}));
    const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';await page.goto(url);
    const run=fillApplication(page,{url,profile:fixtureApplicantProfile({given_name:'Synthetic',family_name:'Applicant',email_address:'fixture@example.invalid',previously_worked_for_organization:'false'}),resume:Buffer.from('%PDF-1.4 synthetic fixture')},AbortSignal.timeout(45000),()=>{});
    if(required)await assert.rejects(run,/requires an assessment before Review/);else assert.match((await run).reviewDigest,/^[a-f0-9]{64}$/);
    assert.equal(await page.evaluate('submits'),0);
  }finally{await browser.close();}
});


test("rejected sign-in never falls back to account creation or reset", {timeout:60000}, async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();let reset=false,requests=0,links=0,creates=0;
    await page.exposeFunction('resetDone',()=>{reset=true;});
    await page.exposeFunction('resetRequested',()=>{requests++;});
    await page.exposeFunction('createAttempted',()=>{creates++;});
    const account=`<body><script>
      function signIn(){document.body.innerHTML='<section data-automation-id="signInPage"><input data-automation-id="email"><input type="password" data-automation-id="password"><div data-automation-id="noCaptchaWrapper"><button data-automation-id="click_filter" role="button"><span data-automation-id="signInSubmitButton">Sign In</span></button></div><button data-automation-id="createAccountLink">Create Account</button><button data-automation-id="forgotPasswordLink">Forgot Password</button><div id="error"></div></section>';
      document.querySelector('[data-automation-id="click_filter"]').onclick=()=>document.querySelector('#error').textContent='You may have entered the wrong email address or password or your account might be locked.';
      document.querySelector('[data-automation-id="createAccountLink"]').onclick=create;
      document.querySelector('[data-automation-id="forgotPasswordLink"]').onclick=()=>{document.body.innerHTML='<input data-automation-id="email"><button data-automation-id="resetPasswordButton">Reset Password</button>';document.querySelector('button').onclick=resetRequested;};}
      function create(){document.body.innerHTML='<section data-automation-id="createAccountPage"><input data-automation-id="email"><input type="password" data-automation-id="password"><input type="password" data-automation-id="verifyPassword"><div data-automation-id="noCaptchaWrapper"><button data-automation-id="click_filter" role="button"><span data-automation-id="createAccountSubmitButton">Create Account</span></button></div><div id="error"></div></section>';document.querySelector('button').onclick=()=>{createAttempted();document.querySelector('#error').innerHTML='<p data-automation-id="accountAlreadyExistsError">Account exists</p><button data-automation-id="signInLink">Sign In</button>';document.querySelector('[data-automation-id="signInLink"]').onclick=signIn;};}
      signIn();</script></body>`;
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('/resetPassword') ? '<input data-automation-id="password" type="password"><input data-automation-id="verifyPassword" type="password"><button data-automation-id="resetPasswordSubmitButton" onclick="resetDone().then(()=>document.body.innerHTML=\'Password reset\')">Reset</button>' : reset?applicationFixture:account}));
    const url='https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';await page.goto(url);
    const result=fillApplication(page,{url,recordAccountAction:()=>{},profile:fixtureApplicantProfile({given_name:'Synthetic',family_name:'Applicant',email_address:'fixture@example.invalid',previously_worked_for_organization:'false'}),resume:Buffer.from('%PDF-1.4 synthetic fixture'),credentials:{email:'fixture@example.invalid',password:'Synthetic-only-123!'},verifyEmail:async target=>{links++;await target.goto('https://fixture.wd1.myworkdayjobs.com/resetPassword?token=synthetic');}},AbortSignal.timeout(50000),()=>{});
    await assert.rejects(result,/site rejected account access/);assert.equal(creates,0);assert.equal(requests,0);assert.equal(links,0);assert.equal(reset,false);
  }finally{await browser.close();}
});
