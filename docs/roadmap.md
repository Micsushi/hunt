# Hunt : System Roadmap

## Goal

Build a continuously running Linux-hosted system that can:
- discover new job postings
- enrich them with high-quality descriptions and external application URLs
- tailor a LaTeX resume to each job
- automate external job applications where the flow is stable and eligible

The system is split into three major components:
- Component 1 : posting discovery and enrichment
- Component 2 : resume tailoring
- Component 3 : application automation

Current implementation priority:
1. finish Component 1 Stage 3 hardening and deployment
2. implement Component 1 Stage 3.2 multi-source enrichment, starting with Indeed
3. validate the end-to-end handoff from Component 1 to Component 2
4. build Component 3 only on top of stable external-apply flows

## System Principles

- LinkedIn is the highest-priority source
- LinkedIn Easy Apply jobs should be classified and excluded early
- `priority = 1` jobs remain manual-only
- downstream automation should prefer external ATS URLs over job board URLs
- do not mix enrichment lifecycle with application lifecycle
- every stage should be testable in isolation before integrating it into the runner

## Component Summary

### Component 1 : posting discovery and enrichment

Purpose:
- discover jobs continuously
- store `job_url` as the listing URL
- resolve `apply_url` as the best-known external application URL
- save a usable description
- classify Easy Apply jobs so they are never sent forward

Primary source priority:
- LinkedIn first
- other sources remain useful for breadth and cross-checking

Current status:
- discovery exists
- DB migration for enrichment exists
- LinkedIn browser enrichment exists
- the repo now supports post-scrape enrichment inside the main scrape flow
- the repo now includes Stage 3 runtime code:
  - retry/backoff policy
  - stale-processing recovery
  - retry scheduling backfill for older retryable failures
  - newest-first post-scrape enrichment queue priority
  - queue-health CLI visibility
  - a minimal review/control-plane web app
  - read-only operator tools that avoid queue-maintenance side effects
- current focus is Stage 3 deployment rollout on `server2`
- next planned step after Stage 3 is Stage 3.2:
  - reuse the Stage 3 runtime for non-LinkedIn sources
  - start with Indeed enrichment
  - keep one queue/runtime/review-app model instead of building a second enrichment system
- deployment notes for `server2` live in `docs/components/component1/stage3_server2_plan.md`

Doc:
- `docs/components/component1/README.md`

### Component 2 : resume tailoring

Purpose:
- read the enriched description
- extract required and preferred keywords
- rewrite the resume to match the job while staying truthful
- compile LaTeX to PDF and enforce a one-page target
- save a per-job output resume without overwriting the source resume

Current status:
- requirements and desired prompting flow are defined
- implementation has not started in this repo

Doc:
- `docs/components/component2/README.md`

### Component 3 : application automation

Purpose:
- open the external application URL
- sign in or create accounts where appropriate
- fill application fields using stored candidate data
- generate paragraph responses when needed
- verify field mappings before submission

Current status:
- idea stage only
- should only begin after Component 1 consistently resolves external apply URLs

Important limitation:
- anti-bot and CAPTCHA bypassing are not a supported goal
- protected flows should be marked for manual review or failure handling instead

Doc:
- `docs/components/component3/README.md`

## Cross-Component Data Contract

Component 1 should hand off:
- job identity and metadata
- enriched description
- apply classification
- external application URL
- ATS classification

Component 2 should hand off:
- job-specific tailored resume source
- compiled PDF
- structured metadata about what was changed
- validation result such as page count and compile status

Component 3 should hand off:
- account/auth status for the target site
- field mapping results
- generated responses used in the form
- final submission status or failure reason

## What To Watch Closely

- LinkedIn markup volatility
- ATS URL normalization
- retries and idempotency
- handoff quality between enriched descriptions and resume tailoring
- safe handling of login state and secrets on the Linux server
