# Hunt : To Do

This document is the live cross-component fix list.

Use it to track the remaining work needed to move the system from "implemented" to "operationally complete."

Deployment note:
- C1 (Hunter), C2 (Fletcher), C3 (Executioner), and C4 (Coordinator) should continue to deploy through separate Ansible steps/stages.
- Do not treat this list as a signal to fold later components into the current C1 (Hunter) Stage 6 deployment.

## C1 (Hunter) : Discovery And Enrichment

Status:
- **Stage 4 repo scope** : implemented (artifacts, metrics, queue health JSON, backfill defaults **25**, discovery **lane** title filter in `hunter/search_lanes.py` + discovery + `scripts/cleanup_lane_mismatch_rows.py`)
- **v1.0 release** : pending your operational sign-off on `server2` (sole user today is fine with v0.1 tag until then)

Repo-side defaults and discovery lane filtering:
- Backfill / drain default batch size **25** (`hunterctl`, `backfill_enrichment.py`).
- **All boards** : after fetch, title must match the **engineering / product / data** lane for the search that fetched it (`title_matches_search_lane` in `hunter/search_lanes.py`; aligned with **`SEARCH_TERMS`** in `hunter/config.py`).
- **Existing DB junk** : run `./hunter.sh clean-lane-mismatch` (preview) then `./hunter.sh clean-lane-mismatch --apply` to remove stored rows whose title does not match their stored category lane (legacy: `clean-indeed`; optional `--source linkedin` / `--source indeed`).

What still needs **your validation on `server2`** (environment-specific):
- finish backlog drain on `server2`
  - LinkedIn backfill can still hit `rate_limited` if you override defaults to very large batches or mix sources aggressively
- validate a stable production drain sequence
  - retry failed/blocked rows
  - run LinkedIn-safe batches first (defaults help)
  - run Indeed separately if LinkedIn pressure would otherwise stop the batch early
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
   - `./hunter.sh retry`
   - `./hunter.sh clean-lane-mismatch --apply`
2. drain with default batch size (25) or smaller if needed:
   - `DISPLAY=:98 ./hunter.sh backfill-all`
   - or explicitly: `DISPLAY=:98 ./hunter.sh backfill-all 25`
3. if LinkedIn remains sensitive, drain Indeed separately:
   - `DISPLAY=:98 ./hunter.sh backfill 100 --source indeed --ui-verify-blocked --yes`
4. once the backlog is under control, turn the timer back on:
   - `./hunter.sh auto-on`
   - `./hunter.sh auto-status`

Done means:
- backlog is at a normal steady-state level
- mixed discovery/enrichment runs behave predictably
- Ansible deploy is reproducible without manual container repair
- review app and metrics are stable

## C2 (Fletcher) : Resume Tailoring

### v1.0 — **current focus** (LLM generation + existing contract)

Goal: ship **one-shot** (per run) tailored resumes that satisfy **`docs/components/component2/README.md` locked decisions**, with the **LLM doing real prompt-driven generation** for tailoring—not only heuristic bullets with LLM on classify/keywords.

Status:
- **~v0.1 shipped** in repo: pipeline, Ollama optional for **classification/keywords only**, Ansible Stage 7, review diff/highlight panel on structured JSON
- **v1.0 not done** until the items below are true

**Recently completed (v0.1 → v1.0 progress):**
- **Keyword extraction rewrite** (`fletcher/keyword_extractor.py`): multi-word tech phrases matched first, noise-filtered stopword list, minimum-frequency filter, punctuation-safe tokenizer, 0–10 meaningful terms only.
- **Bullet injection removed** (`fletcher/generator.py` `_rewrite_bullet`): the `"; aligned with pricing."` forced append is gone. Keywords are surfaced by scoring and selection only.
- **Candidate profile template** (`fletcher/templates/candidate_profile.template.md`): full instructions, Entry ID matching guide, complete example entries. File is gitignored (`fletcher/candidate_profile.md`).
- **LLM I/O logging on by default**: `HUNT_RESUME_LOG_LLM_IO=1`; prompt captured before the network call so it is preserved even on timeouts.
- **Review webapp — per-attempt artifact links**: each attempt row now has PDF / TeX / Keywords / LLM I/O links. New endpoints: `/api/attempts/{id}/pdf|tex|keywords|llm`.
- **Review webapp — LLM I/O viewer**: `/api/attempts/{id}/llm` renders enrichment metadata, full Ollama prompt, and raw response.

v1.0 remaining work (in order of dependency):
- **Fill in candidate profile** (`fletcher/candidate_profile.md`) with real job history — C2 cannot surface better bullets without it
- **LLM tailoring path**
  - prompts + JSON (or validated structured output) for bullet/skill emphasis aligned with JD, grounded in candidate profile / bullet library / OG facts
  - wire **Ollama** (or chosen backend) for this step with clear **fallback** when the model fails (heuristic or safe minimal edit)
  - keep **`main.tex` immutable** and preserve locked section order / one-page gate / concern flags
- **Production hardening**
  - queue-driven **`generate-ready`** dependable on `server2` with real JDs
  - confirm C2 only consumes jobs after C1 **`done` / `done_verified`** (existing SQL intent)
  - weak/sparse JDs: fallback behavior + flags remain sensible
- **Curate family base resumes** (`fletcher/base_resumes/`) for software / pm / data / general where used
- **End-to-end C1 → C2 handoff** validated on `server2`
- **C3/C4 contract** unchanged: selected version, PDF/TeX paths, `selected_resume_ready_for_c3`, flags
- **Deploy** remains separate Ansible Stage 7 (already); document operator smoke for v1.0

**Explicitly out of scope for v1.0** (do not block release on these):
- user-driven keyword pick lists and "regen with my selections"
- per-bullet chat / iterative edit sessions
- PDF-side heatmaps or LaTeX `latexdiff` as a product feature
- parity with Jobright-style interactive polish

v1.0 **done** means:
- candidate profile is filled in with real history
- LLM-backed tailoring meets locked decisions in practice (truthful, one page, artifacts + DB)
- timer/CLI paths stable; handoff fields trusted by C3/C4

---

### v2.0 — deferred (interactive editing + diff / coverage UX)

**Do not implement until v1.0 is signed off.** Design is already sketched in **`docs/components/component2/README.md`**:
- **Human-in-the-loop : how to implement** (presentation-agnostic contract)
- **Stages 9–12**: JD coverage/gap report, user intent storage, constrained regeneration with lineage, scoped bullet AI edit

Implementation hints (when you start v2.0):
- keep **JSON** as the negotiation layer; PDF/LaTeX remain outputs
- optional references: open **ResumeAgent** (LaTeX heatmap via color injection + sandbox compile), **latexdiff** for engineer-facing TeX diffs, **Reactive Resume**-style structured editor patterns for UI-only ideas

Tracker: add v2.0 tasks here as you break down Stages 9–12; link back to component2 README so the stage list stays canonical.

## C3 (Executioner) : Browser Autofill Extension

Status:
- initial local extension implementation exists
- not yet deployed as a production component

What still needs to be fixed or completed:
- strengthen answer grounding from selected resume facts
- keep the apply-context contract explicit and stable
  - resolved apply URL
  - selected resume metadata
  - per-job context import
  - generated-answer review flags
- close the resume-upload gap for queue-driven orchestration
  - a plain filesystem path is not enough for extension-driven upload
  - C3/C4 flows need resume bytes or a C3-side cached file payload
- add richer auth/account helpers
  - signed-in detection
  - account/login helper flows where reasonable
- keep OTP, CAPTCHA, and protected verification flows as manual-review handoff rather than automation goals
- broaden ATS support beyond the current first-family coverage
- harden Workday-first behavior before widening ATS coverage
  - manual fill
  - auto-fill-on-load
  - generated-answer storage
  - attempt/evidence persistence
- improve packaging and operator polish
- keep deployment separate from C1 and C2
  - C3 should be its own Ansible step/stage
- validate the explicit C2/C4 handoff
  - selected resume
  - resolved apply URL
  - per-job apply context
- define the stable trigger surface C4/OpenClaw should call
  - import context
  - request fill
  - read result/evidence summary

Done means:
- Workday-first flows are dependable
- selected resume handoff is explicit and stable
- manual and orchestrated use both work

## C4 (Coordinator) : Orchestration And Submit Control

Status:
- partial local runtime now exists under `coordinator/`
- still not ready for production or server deployment

What still needs to be fixed or completed:
- rewrite and expand the C4 (Coordinator) test suite
  - replace the placeholder `tests/test_component4_cli.py`
  - add stage-based tests for:
    - readiness reason codes
    - apply-prep artifacts
    - fill result routing
    - manual-review resolution
    - submit approval and final submitted transitions
    - scheduler `pick-next` blocking behavior
- finish tightening the shared apply-prep seam
  - treat `python -m coordinator.cli apply-prep` as the canonical C4 seam
  - stop pointing shared-flow docs at older helper scripts as if they were the main boundary
  - expose the shared C4 commands more clearly through `scripts/hunterctl.py`
- complete the current runtime checkpoint into a dependable local flow
  - validate the ready-to-apply predicate against real Hunt DB rows
  - validate run creation and event logging
  - validate fill-request and fill-result transitions
  - validate submit approval and final-status artifact writing
- add the live C3 bridge that is still missing
  - open the browser lane intentionally
  - load the C3-ready payload into a live extension session
  - trigger fill without rebuilding context in prompt text
- keep bounded C3 invocation with evidence capture
- keep manual-review routing explicit and auditable
- keep submit approval separate from fill success
- add unattended orchestration guardrails
  - one active execution run at a time
  - retry budgets
  - cooldown after auth or anti-bot trouble
  - stop-the-world hold when auth/security issues imply a broken shared dependency
- finish the OpenClaw and `server2` integration layer
  - separate C4 runtime storage outside the repo checkout
  - separate deployment/runtime docs
  - separate Ansible step/stage from C1/C2/C3
- keep deployment separate from other components
  - likely its own OpenClaw-focused Ansible step/stage

Recommended next order:
1. finish the C4 tests first
2. make `hunterctl` and the docs consistently use the shared C4 CLI surface
3. wire the live C3 bridge
4. only then tighten OpenClaw/server2 runtime integration

Done means:
- C4 coordinates the other components without redefining their contracts
- submit control is explicit and auditable
- unattended runs are bounded and reviewable

## Cross-Component Fixes

Still important across the whole system:
- keep the deployment split by component in Ansible
- keep apply-context resolution centralized instead of rebuilding it ad hoc in prompts
- keep the shared apply-prep boundary anchored in C4 rather than letting older helper scripts drift into the main contract
- keep review surfaces clear about which lifecycle they are showing:
  - enrichment
  - resume generation
  - autofill/application
  - orchestration
- continue to avoid anti-bot / CAPTCHA bypass behavior
