# Deploy Resource Profiles Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

Goal: Let Hunt deploys choose C2 Ollama/Fletcher resource settings from detected GPU capacity.

Architecture: `deploy.py` keeps forwarding to `scripts/run_deploy_stack.py`. The deploy runner selects a resource profile for targets that include C2, injects profile env vars into Docker Compose, and prints the selected profile for operator visibility. Runtime C2 logs continue to show applied Ollama settings through `ollama.configured`.

Tech Stack: Python stdlib, Docker Compose env interpolation, pytest.

## Task 1: Resource Profile Module

Files: Create `scripts/resource_profiles.py`.
- [x] Step 1: Add profile definitions for `fast`, `balanced`, `safe`, and `cpu`.
- [x] Step 2: Add `nvidia-smi` VRAM detection.
- [x] Step 3: Add `auto` selection thresholds.
- [x] Step 4: Verify with unit tests.

## Task 2: Deploy Runner Integration

Files: Modify `scripts/run_deploy_stack.py`.
- [x] Step 1: Add `--resource-profile auto|fast|balanced|safe|cpu`.
- [x] Step 2: Apply profiles only when the selected services include C2/Fletcher/Ollama.
- [x] Step 3: Pass selected env vars to `subprocess.run(..., env=...)`.
- [x] Step 4: Print selected profile, detected VRAM, reason, and key env values.

## Task 3: Documentation And Tests

Files: Modify `tests/test_deploy_readiness.py`, `docs/DEPLOY.md`, and Hunt vault notes.
- [x] Step 1: Test profile thresholds.
- [x] Step 2: Test C2 fast profile env injection.
- [x] Step 3: Test deploy dry-run profile visibility.
- [x] Step 4: Document profile usage.

## Task 4: Keep-Alive Prewarm

Files: Modify `scripts/run_deploy_stack.py`, `tests/test_deploy_resource_profiles.py`, and `docs/DEPLOY.md`.
- [x] Step 1: Add `--no-prewarm`.
- [x] Step 2: After successful local C2 `up` or `restart`, prewarm Ollama chat and embedding models when `HUNT_OLLAMA_KEEP_ALIVE=-1`.
- [x] Step 3: Use host API `http://127.0.0.1:11435` by default, with `HUNT_OLLAMA_PREWARM_HOST` override.
- [x] Step 4: Add tests for prewarm, no-prewarm, and safe-profile skip.
