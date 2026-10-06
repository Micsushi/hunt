# C2 resume checking

On the Fletcher page, select a PDF or TeX file and choose **Check resume**.
Job details are optional; supplying them adds keyword coverage findings. Checks
are read-only and local. The result is hidden when either input changes.
**Tailor resume** remains a separate action using the configured C2
provider. No score-driven rewrite, formatting optimization, quality gate, C3
selection change, or C4 dependency is introduced.

The API percentage is the fraction of local non-JD checks that passed, with equal
weight. It is not an employer ATS score, a writing-quality score, or a hiring
prediction. Findings and their evidence matter more than the percentage.
Keyword coverage is advisory and uses a limited technical vocabulary; it does
not establish qualifications or authorize adding unsupported claims.

PDF checks combine Resume Cooker's text/section checks with independent
pdfminer.six and pypdf extraction, word-occurrence agreement, Unicode replacement
characters, page count, and contact email detection. TeX checks inspect source
without compiling it; upload an exported PDF to verify actual PDF parsing.
Scanned PDFs fail the text-layer check. Uploads are limited to 10 MB and 20 PDF
pages; checking runs in a bounded subprocess and temporary files are removed.

## Runtime and entrypoints

Install `fletcher/requirements.txt` and Node.js 22 or newer. C0 and C2 container
recipes include Node. No npm install is needed for the default checker runtime.

```text
python -m fletcher.resume_checker path/to/resume.pdf
python -m fletcher.resume_checker path/to/resume.pdf --jd path/to/job.txt --out report.json
```

Authenticated upload APIs are `POST /api/fletcher/check` on C0 and `POST /check`
on C2, with multipart `resume` and optional `job_details`. Reports return to the
caller; the UI does not persist them. Missing dependencies return an error, not
a fabricated score. The checker never invokes the tailoring model.

## Imported runtime and provenance

`fletcher/resume_cooker/` retains the Resume Cooker CLI, generator/editor,
checker/compare/tester adapters, tests, synthetic fixtures, and supporting public
docs from `Micsushi/resume-cooker` main `dd4f5f93a44d46f6d009b94498096c58a994af11`.
The preview and CLI implementation/test files include the focused change from
`f631a7e`. The local xpdf exit-99 detection repair is retained in `build-lib.mjs`.
`hunt-check.mjs` is the C2-only local entrypoint. The Python subprocess boundary
is adapted from Hunt's `codex/resume-cooker-stage-four` plus its retained local
timeout/cancellation fixes, with the old C3 blocking/override policy removed.
The compiler timeout/process cleanup and revision-checked review save/compile fixes
from Hunt commits `69d9f87a` and `aeb7f68e` are also retained.
The source repositories and their dirty changes remain untouched.

The upstream MIT license is retained. Third-party tester applications, their
environments, personal files, and retired task records are not duplicated.
The imported CLI's optional tester adapters still accept `--tester-root` for
separately installed applications. They are not reported as executed by C2.
The imported standalone API suite remains explicitly opt-in; C2 exposes no
external-provider check option.

## Other tools assessed

- [Resume Matcher](https://github.com/srbhr/Resume-Matcher) offers local Ollama
  matching and resume editing. That duplicates C2's tailoring role and adds a
  second model workflow, so it is not a default dependency.
- [Affinda](https://resume-parser.affinda.com/docs/) offers structured resume
  parsing through an API. It needs separate credentials and a deliberate data
  sharing decision; C2 does not upload resumes to it.
- [Jobscan](https://www.jobscan.co/resume-scanner) offers hosted resume/job
  comparison. Its website is not treated as a supported programmatic API.

The added independent local PDF parser provides useful extraction evidence
without introducing a second model or a hosted resume service.
