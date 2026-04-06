# Hunt : To Do

This document is the live cross-component fix list.

Use it to track the remaining work needed to move the system from "implemented" to "operationally complete."

Deployment note:
- Component 1, Component 2, Component 3, and Component 4 should continue to deploy through separate Ansible steps/stages.
- Do not treat this list as a signal to fold later components into the current Component 1 Stage 6 deployment.

## Component 1 : Discovery And Enrichment

Status:
- feature-complete
- not yet fully signed off operationally

What still needs to be fixed or validated:
- finish backlog drain on `server2`
  - LinkedIn backfill is still hitting `rate_limited` when the mixed-source batch is too aggressive
  - treat smaller LinkedIn-oriented runs as the expected operating mode until the safe batch size is proven
- tune the short operator command defaults
  - consider lowering `backfill-all` from `100` rows to a safer default such as `25`
  - keep the longer `backfill` command available for explicit larger runs
- validate a stable production drain sequence
  - retry failed/blocked rows
  - run smaller LinkedIn-safe batches first
  - run Indeed separately if LinkedIn pressure would otherwise stop the batch early
- confirm discovery quality stays acceptable after the new Indeed cleanup/filtering changes
  - watch for unrelated retail/store/associate rows returning again
  - tighten the Indeed-only relevance rules further if needed
- observe one real blocked/browser-fixable failure end to end with artifacts
  - screenshot saved
  - HTML/text snapshot saved
  - review app links work
- confirm unattended steady-state behavior
  - re-enable the 10-minute timer
  - watch at least one normal scheduled scrape + post-scrape enrichment cycle
  - confirm queue counts and review app stay healthy

Recommended finish sequence:
1. keep the current queue cleanup commands:
   - `./hunt.sh retry`
   - `./hunt.sh clean-indeed --apply`
2. drain with smaller batches first:
   - `DISPLAY=:98 ./hunt.sh backfill-all 25`
3. if LinkedIn remains sensitive, drain Indeed separately:
   - `DISPLAY=:98 ./hunt.sh backfill 100 --source indeed --ui-verify-blocked --yes`
4. once the backlog is under control, turn the timer back on:
   - `./hunt.sh auto-on`
   - `./hunt.sh auto-status`

Done means:
- backlog is at a normal steady-state level
- mixed discovery/enrichment runs behave predictably
- Ansible deploy is reproducible without manual container repair
- review app and metrics are stable

## Component 2 : Resume Tailoring

Status:
- initial local runtime exists
- not yet deployed

What still needs to be fixed or completed:
- finish production backend selection and wiring
  - Ollama-backed prompt execution is still the main intended production path
- curate stronger family-base resumes
  - software
  - pm
  - data
  - general
- expand review-surface support
  - latest result visibility
  - selected resume visibility
  - attempt browsing and artifact inspection
- validate the end-to-end C1 -> C2 handoff
  - C2 should consume enriched descriptions only after C1 is in a normal done state
- keep deployment separate from C1
  - C2 should become its own Ansible step/stage after C1 is stable

Done means:
- queue-driven resume generation is dependable
- one-page gating is stable
- selected resume state is easy for C3/C4 to consume

## Component 3 : Browser Autofill Extension

Status:
- initial local extension implementation exists
- not yet deployed as a production component

What still needs to be fixed or completed:
- strengthen answer grounding from selected resume facts
- add richer auth/account helpers
  - signed-in detection
  - account/login helper flows where reasonable
- broaden ATS support beyond the current first-family coverage
- improve packaging and operator polish
- keep deployment separate from C1 and C2
  - C3 should be its own Ansible step/stage
- validate the explicit C2/C4 handoff
  - selected resume
  - resolved apply URL
  - per-job apply context

Done means:
- Workday-first flows are dependable
- selected resume handoff is explicit and stable
- manual and orchestrated use both work

## Component 4 : Orchestration And Submit Control

Status:
- initial local contract implementation exists
- still early compared with C1/C2/C3

What still needs to be fixed or completed:
- finish the ready-to-apply predicate and persistence model
- build the shared apply-prep flow out fully
- add bounded C3 invocation with evidence capture
- add manual-review routing rules
- separate submit approval from fill success
- add unattended orchestration guardrails
  - concurrency limits
  - retry budgets
  - cooldown after auth or anti-bot trouble
- keep deployment separate from other components
  - likely its own OpenClaw-focused Ansible step/stage

Done means:
- C4 coordinates the other components without redefining their contracts
- submit control is explicit and auditable
- unattended runs are bounded and reviewable

## Cross-Component Fixes

Still important across the whole system:
- keep the deployment split by component in Ansible
- keep apply-context resolution centralized instead of rebuilding it ad hoc in prompts
- keep review surfaces clear about which lifecycle they are showing:
  - enrichment
  - resume generation
  - autofill/application
  - orchestration
- continue to avoid anti-bot / CAPTCHA bypass behavior
