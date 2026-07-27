# C3 25-Lane Review Remediation

Original date: 2026-07-22
Status: superseded by strict browser-truth re-audit on 2026-07-25

The original conclusion that 22 lanes failed because of CAPTCHA was incorrect.
It treated Workday's internal `noCaptchaWrapper` name as proof of a visible
challenge. Independent screenshots and DOM checks found no actual CAPTCHA in
the 25 strict reruns.

Use
[C3_25_JOB_CONTROL_AND_BEHAVIOR_REAUDIT_2026-07-25.md](C3_25_JOB_CONTROL_AND_BEHAVIOR_REAUDIT_2026-07-25.md)
as the source of truth. It contains:

- all 25 exact job outcomes;
- direct browser state compared with each C3 report;
- report grades: 1 exact, 14 partial, and 10 wrong;
- confirmed code causes and recommended fixes;
- changes implemented during the audit;
- fixes that remain uncertain or require live proof;
- the only remaining user input: Workday credential/account-lock verification;
- links to every lane review, operation, artifact, and screenshot.

The current remediation priority is:

1. stop and correctly report explicit Workday credential rejection;
2. normalize successful Review result shapes in the batch classifier;
3. stabilize signup/signin/application state transitions;
4. make watchdog cancellation progress-aware;
5. detect unavailable postings before generic form repair;
6. prove Workday dropdown selection persistence;
7. reconcile every terminal report with final browser truth;
8. serialize concurrent ledger active-index updates;
9. refuse unsupported sensitive or material answers.

Do not implement the former CAPTCHA-clearance plan unless a future run captures
an actual visible challenge and independently proves that it is the blocking
state.
