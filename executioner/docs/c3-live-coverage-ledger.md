# C3 live coverage ledger

This ledger records sanitized, value-free live coverage. It never stores applicant
answers, credentials, Gmail content, raw DOM, selectors, or final Submit authority.
Each live attempt is immutable; a later attempt gets a new row.

## Accepted application-entry baseline

| Catalog row | Public employer / posting | Run | Furthest independently accepted state | Page type | Mutation coverage | Evidence result |
| --- | --- | --- | --- | --- | --- | --- |
| 43 | Bank of America / 26016513 | `fd6c0e056c5106e0` | account verified; real My Information visible | account entry, My Information | none claimed | accepted application entry; Gmail candidate count 1; body retained false |
| 76 | Manulife / JR26071419 | `318ac8b18caad3cc` | account access; real My Information visible | account entry, My Information | none claimed | accepted application entry |
| 82 | Lowe's / JR-02566071 | `ccd7f6a25254fb35` | account access; real My Information visible | account entry, My Information | none claimed | accepted application entry |

All three retained exact job, screenshot, request, decision, and acknowledgement
bindings; cleanup and completion audits passed; final Submit was not activated.
Earlier row 43 attempts remain immutable excluded evidence.

## Supported deterministic taxonomy before the next live run

| Page type | Stable identity source | Control / question types | Authorized answer source | Verification | Regression |
| --- | --- | --- | --- | --- | --- |
| Resume | bounded semantic page and fixed field ID | file upload, existing-file replacement | protected single-use resume artifact | independent upload item/success readback; one owned row | resume handler and production-binding tests |
| My Information | stable field and repeatable-row identities | text, phone, date, visible option, repeatable rows | protected owner profile or resume-verified fact | exact field/row readback; duplicate rows zero | profile handler and Playwright runtime tests |
| Application Questions | stable question and option identities | boolean, option, numeric, date, text, configured narrative | exact owner fact or configured template only | mutation receipt plus independent readback | questionnaire handler and Playwright runtime tests |
| Review | stable expected field and row identities | read-only summary; structural final Submit detection | hashes derived from the authorized sources above | every expected field reconciled; validation errors zero; Submit present and not activated | Review stopper and Playwright runtime tests |

## Current blockers and next evidence

- No protected current `application-profile.json` or `application-resume.pdf` is
  available in the Hunt storage roots. No applicant field may be filled until the
  owner supplies those exact sources through the protected preparation command.
- The next row 43 attempt must add ordinal pre-mutation, post-readback, transition,
  and Review monitor records before any live field coverage is marked supported.
- Any missing fact, ambiguous control, CAPTCHA, MFA, access-control reset, or
  uncertain browser effect remains an explicit blocked result, never an inferred
  answer.
- Rows 76 and 82 are considered only after row 43 reaches independently verified
  Review. Later jobs are selected for new UI/question/answer coverage, not volume.

