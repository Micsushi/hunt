import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ApplicationPause, fillApplication } from "../../src/product/engine.ts";
import { applicantProfile } from "../../src/product/sources.ts";
import { accountFixture, applicationFixture } from "./fixture.ts";

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
        profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
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

test("unverified saved Review or Experience rewinds and verifies the complete draft", { timeout: 60_000 }, async () => {
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
        profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
        resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
      }, AbortSignal.timeout(25_000), stage => stages.push(stage));
      if (scenario === "bad-summary") await assert.rejects(fill);
      else if (canGoBack) {
        const result = await fill;
        assert.ok(result.completedPages > 0);
        assert.ok(stages.includes("Filling profile"));
        assert.equal(await page.evaluate("window.rewinds"), 1);
      } else await assert.rejects(fill, /Open My Information/);
      if (canGoBack) {
        const attempt = readdirSync(learningRoot)[0]!;
        const journal = JSON.parse(readFileSync(join(learningRoot, attempt, "question-answer-learning.json"), "utf8"));
        const question = journal.questions[0];
        assert.equal(question.uiType, "select");
        assert.deepEqual(question.possibleAnswers, ["Select One", "Yes", "No"]);
        assert.equal(question.monitorBinding, null);
        assert.equal(question.verificationResult, "not_attempted");
        assert.equal(question.chosenAnswer, null);
      }
      assert.equal(await page.evaluate("submits"), 0);
      await page.close();
      rmSync(learningRoot, { recursive: true, force: true });
    }
  } finally { await browser.close(); }
});

test("account entry prefers existing sign-in and follows creation without retrying rejection", { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    for (const scenario of ["created", "rejected", "existing-inline"]) {
      const reject = scenario === "rejected";
      const page = await browser.newPage();
      let fixture = accountFixture
        .replace("sessionStorage.setItem('created','yes');root.innerHTML='<section data-automation-id=\"emailVerificationPage\">An email has been sent to you. Please verify your account.</section>';", "sessionStorage.setItem('created','yes');signIn();")
        .replace("()=>document.querySelector('#error').innerHTML='<p data-automation-id=\"accountNotFoundError\">Account not found</p>'",
          `()=>{window.signInAttempts=(window.signInAttempts||0)+1;${reject
            ? `document.querySelector('#error').innerHTML='<p data-automation-id="accountNotFoundError">Account not found</p>';`
            : "profile();"}}`)
        .replace("else signIn();", "else createAccount();");
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
        profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
        resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
        credentials: { email: "fixture@example.test", password: "Synthetic-only-123!" },
      }, AbortSignal.timeout(25_000), stage => stages.push(stage));
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
    for (const scenario of ["entry", "mid-fill", "delayed", "second-reload", "reopen", "persistent", "aborted", "moved"]) {
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
        profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
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


test("administrator reset follows email link and resumes the application", { timeout: 60_000 }, async () => {
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
    const result = await fillApplication(page, { url,
      profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
      resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
      credentials: { email: "fixture@example.test", password: "Synthetic-only-123!" },
      verifyEmail: async target => { links++; await target.goto("https://fixture.wd1.myworkdayjobs.com/resetPassword?token=synthetic"); },
    }, AbortSignal.timeout(45_000), () => {});
    assert.match(result.reviewDigest, /^[a-f0-9]{64}$/);
    assert.equal(requests, 1); assert.equal(links, 1); assert.equal(reset, true);
    assert.equal(await page.evaluate("submits"), 0);
  } finally { await browser.close(); }
});


test("stalled saved-draft Back reopens the posting once and verifies the complete application", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage(); let loads = 0;
    const stalled = applicationFixture.replace("profile();", "resume();const back=document.createElement('button');back.dataset.automationId='pageFooterBackButton';back.textContent='Back';root.append(back);");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: ++loads === 1 ? stalled : applicationFixture }));
    const url = "https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1";
    await page.goto(url);
    const result = await fillApplication(page, { url,
      profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
      resume: Buffer.from("%PDF-1.4\nsynthetic fixture"),
    }, AbortSignal.timeout(45_000), () => {});
    assert.equal(loads, 2); assert.ok(result.completedPages > 0);
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
      profile: applicantProfile({ given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }),
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
    const run=fillApplication(page,{url,profile:applicantProfile({given_name:'Synthetic',family_name:'Applicant',email_address:'fixture@example.test'}),resume:Buffer.from('%PDF-1.4 synthetic fixture')},AbortSignal.timeout(45000),()=>{});
    if(required)await assert.rejects(run,/requires an assessment before Review/);else assert.match((await run).reviewDigest,/^[a-f0-9]{64}$/);
    assert.equal(await page.evaluate('submits'),0);
  }finally{await browser.close();}
});


test("confirmed existing account recovers a rejected sign-in once", {timeout:60000}, async () => {
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
    const result=await fillApplication(page,{url,profile:applicantProfile({given_name:'Synthetic',family_name:'Applicant',email_address:'fixture@example.test'}),resume:Buffer.from('%PDF-1.4 synthetic fixture'),credentials:{email:'fixture@example.test',password:'Synthetic-only-123!'},verifyEmail:async target=>{links++;await target.goto('https://fixture.wd1.myworkdayjobs.com/resetPassword?token=synthetic');}},AbortSignal.timeout(50000),()=>{});
    assert.match(result.reviewDigest,/^[a-f0-9]{64}$/);assert.equal(creates,1);assert.equal(requests,1);assert.equal(links,1);assert.equal(await page.evaluate('submits'),0);
  }finally{await browser.close();}
});
