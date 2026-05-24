async (page) => {
  const fs = require("fs");
  const rowsPath = "C:/Users/sushi/Documents/Github/hunt/logs/wd_job5_6_rows_for_browser_verify.json";
  const outPath = "C:/Users/sushi/Documents/Github/hunt/logs/wd_job5_6_browser_verify_2026-05-24.json";
  const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
  const badPattern = /(?:job (?:is )?(?:no longer )?available|posting (?:is )?(?:no longer )?available|no longer accepting applications|page not found|maintenance|temporarily unavailable|sorry, this job posting)/i;
  const applyPattern = /apply/i;
  const applyPagePattern = /(?:apply manually|sign in|create account|email address|my information|application|already have an account)/i;
  const results = [];

  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);

  async function visibleText() {
    return await page.evaluate(() => document.body ? document.body.innerText : "");
  }

  async function clickFirstApply() {
    const controls = await page.locator("button, a").filter({ hasText: applyPattern }).all();
    for (const control of controls) {
      try {
        if (await control.isVisible() && await control.isEnabled()) {
          await Promise.race([
            page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {}),
            control.click({ timeout: 8000 }),
          ]);
          return true;
        }
      } catch {
      }
    }
    return false;
  }

  for (const row of rows) {
    const result = {
      file: row.file,
      row: row.row,
      company: row.company,
      job: row.job,
      url: row.url,
      finalUrl: "",
      title: "",
      status: "ok",
      reason: "",
      visibleHasJobTitle: false,
      clickedApply: false,
      clickedApplyManually: false,
      reachedApplyFlow: false,
    };

    try {
      await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);

      result.title = await page.title();
      let text = await visibleText();
      result.visibleHasJobTitle = text.toLowerCase().includes(String(row.job).toLowerCase().slice(0, 24));

      if (badPattern.test(text)) {
        result.status = "bad";
        result.reason = "visible unavailable or maintenance text before apply";
      } else {
        result.clickedApply = await clickFirstApply();
        await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(1200);

        text = await visibleText();
        if (badPattern.test(text)) {
          result.status = "bad";
          result.reason = "visible unavailable or maintenance text after Apply";
        } else {
          const manual = page.locator("button, a").filter({ hasText: /apply manually/i }).first();
          if (await manual.isVisible().catch(() => false)) {
            await manual.click({ timeout: 8000 }).catch(() => {});
            result.clickedApplyManually = true;
            await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(1200);
            text = await visibleText();
          }

          result.finalUrl = page.url();
          result.reachedApplyFlow = /\/apply\//i.test(result.finalUrl) || applyPagePattern.test(text);
          if (!result.clickedApply) {
            result.status = "bad";
            result.reason = "no visible enabled Apply control";
          } else if (badPattern.test(text)) {
            result.status = "bad";
            result.reason = "visible unavailable or maintenance text after Apply Manually";
          } else if (!result.reachedApplyFlow) {
            result.status = "warn";
            result.reason = "clicked Apply but did not recognize apply/auth flow";
          }
        }
      }
    } catch (error) {
      result.status = "bad";
      result.reason = String(error && error.message ? error.message : error).slice(0, 500);
      result.finalUrl = page.url();
    }

    results.push(result);
  }

  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  return {
    checked: results.length,
    bad: results.filter((item) => item.status === "bad").length,
    warn: results.filter((item) => item.status === "warn").length,
    outPath,
    badRows: results.filter((item) => item.status !== "ok").map((item) => ({
      file: item.file,
      row: item.row,
      company: item.company,
      status: item.status,
      reason: item.reason,
    })),
  };
}
