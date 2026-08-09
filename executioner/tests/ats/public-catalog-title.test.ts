import assert from "node:assert/strict";
import { test } from "node:test";

import {
  matchesExactVisibleJobTitle,
  parsePublicCatalog,
  verifiedPublicCatalogPosting,
} from "../../scripts/public-catalog-title.ts";

test("public catalog title matching accepts only the same visible title", () => {
  assert.equal(
    matchesExactVisibleJobTitle(
      "Senior Hardware Test Engineer– System on Chip",
      "Senior Hardware Test Engineer - System on Chip",
    ),
    true,
  );
  assert.equal(
    matchesExactVisibleJobTitle("Électricien(ne)", "Électricien(ne)"),
    true,
  );
  assert.equal(
    matchesExactVisibleJobTitle(
      "Senior Developer Relations Manager - Government & Defense",
      "Senior Developer Relations Manager - Telecom",
    ),
    false,
  );
  assert.equal(
    matchesExactVisibleJobTitle(
      "Software Development Engineer",
      "Backend Platform Engineer - AI Operations Platform",
    ),
    false,
  );
  assert.equal(matchesExactVisibleJobTitle("C++ Developer", "C Developer"), false);
  assert.equal(matchesExactVisibleJobTitle("C# Developer", "C Developer"), false);
  assert.equal(matchesExactVisibleJobTitle("FP&A Manager", "FP and A Manager"), true);
  assert.equal(
    matchesExactVisibleJobTitle(
      "Software Engineer / Software Development Engineer (P3)",
      "Software Engineer/Software Development Engineer (P3)",
    ),
    true,
  );
});
test("public catalog parsing fails closed on malformed or incomplete input", () => {
  const header = "company name,job name,country,link\n";
  const row = (company: string, job: string, id: string) =>
    `${company},${job},US,https://${company.toLowerCase()}.wd5.myworkdayjobs.com/Careers/job/US/${job}_${id}\n`;
  const valid = header + row("One", "Engineer", "R1") + row("Two", "Analyst", "R2");

  assert.equal(parsePublicCatalog(valid, 2).length, 2);
  assert.throws(() => parsePublicCatalog(valid, 100), /row count/u);
  assert.throws(
    () => parsePublicCatalog(header + row("One", "Engineer", "R1") + row("One", "Analyst", "R2"), 2),
    /duplicate company/u,
  );
  assert.throws(
    () => parsePublicCatalog(header + row("One", "Engineer", "R1") + row("Two", "Engineer", "R1").replace("two.wd5", "one.wd5"), 2),
    /duplicate link/u,
  );
  assert.throws(() => parsePublicCatalog('company name,job name,link\n"One,Engineer,https://one.wd5.myworkdayjobs.com/Careers/job/US/Engineer_R1\n', 1), /CSV/u);
});

test("public catalog verification binds status, host, tenant, posting, and title", () => {
  const expected = "https://tenant.wd5.myworkdayjobs.com/en-US/Careers/job/US/Engineer_R1?source=LinkedIn";
  const final = "https://tenant.wd5.myworkdayjobs.com/Careers/job/US/Engineer_R1";

  assert.equal(verifiedPublicCatalogPosting(expected, final, 200, "Engineer", "Engineer"), true);
  assert.equal(verifiedPublicCatalogPosting(expected, final, 500, "Engineer", "Engineer"), false);
  assert.equal(verifiedPublicCatalogPosting(expected, final.replace("tenant.wd5", "other.wd5"), 200, "Engineer", "Engineer"), false);
  assert.equal(verifiedPublicCatalogPosting(expected, final.replace("/Careers/", "/Other/"), 200, "Engineer", "Engineer"), false);
  assert.equal(verifiedPublicCatalogPosting(expected, final.replace("Engineer_R1", "Engineer_R2"), 200, "Engineer", "Engineer"), false);
  assert.equal(verifiedPublicCatalogPosting(expected, final, 200, "Engineer", "Engineer II"), false);
});
