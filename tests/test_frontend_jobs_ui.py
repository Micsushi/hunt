import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_job_detail_resume_run_matches_only_active_saved_job():
    script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const source = fs.readFileSync('src/pages/Jobs/JobDetail.tsx', 'utf8');
const file = ts.createSourceFile('detail.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'activeResumeRun');
assert.ok(fn);
const compiled = ts.transpileModule(fn.getText(file) + '\nexport { activeResumeRun };', { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, { exports: moduleObj.exports });
const { activeResumeRun } = moduleObj.exports;
const run = (jobId, status) => ({ input: { job_id: jobId }, status });
const queued = run(42, 'queued');
const running = run(42, 'running');
const cancelling = run(42, 'cancel_requested');
const inactive = [run(42, 'succeeded'), run(42, 'failed'), run(42, 'cancelled'), run(77, 'running'), run(null, 'running')];
assert.equal(activeResumeRun(inactive, 42), undefined);
assert.equal(activeResumeRun([...inactive, queued], 42), queued);
assert.equal(activeResumeRun([queued, running], 42), running);
assert.equal(activeResumeRun([queued, cancelling], 42), cancelling);
const c3 = {};
const c3Source = ts.transpileModule(fs.readFileSync('src/api/c3.ts', 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
});
vm.runInNewContext(c3Source.outputText,{exports:c3,require:()=>({}),URL});
const numeric = 'https://jobs.smartrecruiters.com/GDMSI/123-test';
const publication = 'https://jobs.smartrecruiters.com/oneclick-ui/company/GDMSI/publication/f1bc5065-8ef4-443c-99c0-f2b132115e4a';
for(const url of [numeric,publication,publication+'/screening']) {
  assert.equal(c3.isGenericApplicationUrl(url+'/?dcr_ci=GDMSI'),true);
  for(const query of ['?dcr_ci=gdmsi','?dcr_ci=GDMSI&dcr_ci=Other','?DCR_CI=Other']) {
    assert.equal(c3.isGenericApplicationUrl(url+query),false);
    assert.equal(c3.isManualApplicationUrl(url+query),false);
  }
}
assert.equal(c3.isManualApplicationUrl('https://ordinary.example/careers/823'),true);
assert.equal(c3.isManualApplicationUrl('https://Ordinary.EXAMPLE/careers/823'),true);
assert.equal(c3.isGenericApplicationUrl('https://Solace.BambooHR.com/careers/823'),true);
assert.equal(c3.supportsQueuedApplication('lever','https://Jobs.LEVER.co/fixture/11111111-1111-4111-8111-111111111111'),true);
for(const url of ['https://solace.bamboohr.com.evil.example/careers/823','https://user@foo.example/apply',
  'https://company.example:444/apply','http://company.example/apply','https://jobs.jobvite.com/company/job/%2f']) {
  assert.equal(c3.isManualApplicationUrl(url),false);
  assert.equal(c3.isGenericApplicationUrl(url),false);
}
assert.match(c3.handoffMessage({status:'not_sent',reason:'Check the link.'}),/Not sent.*Check the link/);

"""
    subprocess.run(["node", "-e", script], cwd=ROOT / "frontend", check=True)


def test_fletcher_diff_groups_replacement_clusters():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Fletcher/review/diff.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  require,
  module: moduleObj,
  exports: moduleObj.exports,
});
const { buildDiffSegments, applySegmentRevert } = moduleObj.exports;
const original = 'Drove technical alignment by presenting completed features to stakeholders and leading design discussion meetings to gather feedback and refine system architecture.';
const current = 'Drove technical alignment by presenting completed features and leading design discussions for product progression projects, gathering stakeholder feedback and build new solutions.';
const segments = buildDiffSegments('block', original, current);
const changed = segments.filter((segment) => segment.kind !== 'same');
const groupedDeletion = changed.find((segment) => segment.kind === 'del' && segment.text.includes('discussion meetings to gather'));
const groupedAddition = changed.find((segment) => segment.kind === 'add' && segment.text.includes('discussions for product progression'));
const reverted = applySegmentRevert(original, current, groupedAddition);
console.log(JSON.stringify({
  changed,
  groupedPairAdjacent: changed.indexOf(groupedAddition) === changed.indexOf(groupedDeletion) + 1,
  reverted,
}));
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["groupedPairAdjacent"]
    assert "discussion meetings to gather feedback" in payload["reverted"]
    assert "build new solutions" in payload["reverted"]


def test_fletcher_workspace_handles_flexible_skill_categories():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Fletcher/review/documentBlocks.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  require,
  module: moduleObj,
  exports: moduleObj.exports,
  encodeURIComponent,
  decodeURIComponent,
});
const { buildReviewBlocks, setBlockText, skillRowsForDoc } = moduleObj.exports;
const doc = {
  source_path: 'test',
  preamble: '',
  header: { name: 'A', contact_line: 'a@example.com' },
  summary: '',
  education: { entry: { entry_id: 'edu', institution_and_degree: 'School', date_text: '2026' }, bullets: [] },
  experience: [],
  projects: [],
  skills: {
    languages: ['Python'],
    frameworks: ['FastAPI'],
    developer_tools: ['Git'],
    categories: {
      Languages: ['Python'],
      'Cloud & Data': ['AWS', 'PostgreSQL'],
      'Developer Tools': ['Git'],
    },
  },
};
const rows = skillRowsForDoc(doc);
const blocks = buildReviewBlocks(doc, doc, doc);
const cloudBlock = blocks.find((block) => block.label === 'Cloud & Data');
const updated = setBlockText(doc, cloudBlock.blockId, 'AWS, DynamoDB');
const updatedLanguage = setBlockText(doc, 'skills.categories.Languages', 'Python, TypeScript');
console.log(JSON.stringify({
  rowLabels: rows.map((row) => row.label),
  cloudCurrent: cloudBlock.current,
  updatedCloud: updated.skills.categories['Cloud & Data'],
  updatedLanguageCategory: updatedLanguage.skills.categories.Languages,
  updatedLanguageLegacy: updatedLanguage.skills.languages,
}));
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["rowLabels"] == ["Languages", "Cloud & Data", "Developer Tools"]
    assert payload["cloudCurrent"] == "AWS, PostgreSQL"
    assert payload["updatedCloud"] == ["AWS", "DynamoDB"]
    assert payload["updatedLanguageCategory"] == ["Python", "TypeScript"]
    assert payload["updatedLanguageLegacy"] == ["Python", "TypeScript"]
