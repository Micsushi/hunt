# Ollama Gentle Optimization Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

Goal: Improve Hunt C2 local Ollama stability and latency in measured stages without copying llama.cpp-only MoE expert-offload assumptions.

Architecture: Hunt keeps Ollama as the default local LLM server for C2 chat and embeddings. Optimization happens through Docker environment settings, Fletcher request/logging options, and measured pipeline runs. Direct llama.cpp remains the separate path for Qwen3.6-35B-A3B MoE experiments that require `--n-cpu-moe`.

Tech Stack: Docker Compose, Ollama, Python, pytest, Fletcher C2 pipeline logs.

## Current State

Implemented:
- Stage 0 observability: `fletcher/ad_hoc_pipeline.py` logs an Ollama `/api/ps` snapshot during bullet rewrite parallel config and memory checks.
- Stage 1 stability: `docker-compose.pipeline.yml` sets `OLLAMA_CONTEXT_LENGTH=8192` for local Ollama.
- Stage 2 speed/memory tuning: local Ollama sets `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`.
- Parallel bullet rewrites are enabled for local C2 runs: `HUNT_BULLET_REWRITE_PARALLELISM` defaults to `5` and `OLLAMA_NUM_PARALLEL` defaults to `5`.
- Stage 3 warm model requests: chat and embedding calls send `keep_alive`, defaulting to `HUNT_OLLAMA_KEEP_ALIVE=-1`.
- C2 Ollama runtime snapshots include configured tuning values: parallelism, context length, flash attention, KV cache, and keep-alive.
- `python deploy.py` now has C2 resource profiles so weaker machines can use `safe` while 16GB+ VRAM machines can use `fast`.

Verified:

```powershell
python -m pytest tests/test_ad_hoc_pipeline.py -k "rewrite_parallelism or meminfo or cgroup or ollama_runtime" -q
docker compose --profile c2 -f docker-compose.pipeline.yml config
```

Expected current result:
- Focused tests pass.
- Rendered compose includes `OLLAMA_NUM_PARALLEL: "5"` and `OLLAMA_CONTEXT_LENGTH: "8192"` under `ollama`.
- Rendered compose includes `OLLAMA_FLASH_ATTENTION: "1"` and `OLLAMA_KV_CACHE_TYPE: q8_0` under `ollama`.
- C2 services include `HUNT_OLLAMA_KEEP_ALIVE: -1`.

## Stage 2: Flash Attention And Q8 KV Cache

Purpose: Reduce attention and KV-cache memory pressure before increasing concurrency or context.

Files:
- Modify `docker-compose.pipeline.yml:107-126`.
- Add tests only if deploy-readiness coverage expects exact Ollama environment keys.

Step 1: Update local Ollama environment.

Patch shape:

```yaml
  ollama:
    environment:
      OLLAMA_HOST: 0.0.0.0:11434
      OLLAMA_NUM_PARALLEL: ${OLLAMA_NUM_PARALLEL:-5}
      OLLAMA_CONTEXT_LENGTH: ${OLLAMA_CONTEXT_LENGTH:-8192}
      OLLAMA_FLASH_ATTENTION: ${OLLAMA_FLASH_ATTENTION:-1}
      OLLAMA_KV_CACHE_TYPE: ${OLLAMA_KV_CACHE_TYPE:-q8_0}
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
```

Step 2: Render compose.

```powershell
docker compose --profile c2 -f docker-compose.pipeline.yml config
```

Expected pass:
- Rendered `ollama.environment` includes `OLLAMA_FLASH_ATTENTION: "1"`.
- Rendered `ollama.environment` includes `OLLAMA_KV_CACHE_TYPE: q8_0`.

Step 3: Restart only Ollama for local validation.

```powershell
docker compose --profile c2 -f docker-compose.pipeline.yml up -d ollama ollama-init
```

Expected pass:
- `hunt-ollama-1` is healthy.
- `ollama-init` completes successfully.

Step 4: Run one C2 smoke or ad-hoc job.

```powershell
python ci.py c2
```

Expected pass:
- C2 tests pass.
- Pipeline logs still show Ollama snapshot fields.

Decision gate:
- Keep `q8_0` if output quality and JSON reliability remain stable.
- Revert only `OLLAMA_KV_CACHE_TYPE` if JSON failures or quality regressions increase.

## Stage 3: Keep Model Warm

Purpose: Remove repeated model-load latency between C2 LLM calls.

Status: Implemented for both chat and embedding requests.

Files:
- Modify `fletcher/llm/llm_enrich.py:495-524`.
- Modify or add tests in `tests/test_component2_ollama.py` or `tests/test_llm_enrich_logger.py`.
- Optionally modify `docker-compose.pipeline.yml:107-126` if choosing service-level keep-alive.

Preferred approach: request-level `keep_alive`.

Step 1: Add config variable.

File: `fletcher/config.py`.

Code shape:

```python
OLLAMA_KEEP_ALIVE = os.getenv("HUNT_OLLAMA_KEEP_ALIVE", "-1")
```

Step 2: Add `keep_alive` to `_ollama_chat` payload.

File: `fletcher/llm/llm_enrich.py`.

Code shape:

```python
payload = {
    "model": model,
    "format": "json",
    "stream": False,
    "keep_alive": config.OLLAMA_KEEP_ALIVE,
    "options": {"temperature": temperature},
    ...
}
```

Step 3: Add a unit test.

File: `tests/test_component2_ollama.py`.

Test shape:

```python
def test_ollama_chat_sends_keep_alive(monkeypatch):
    ...
    assert payload["keep_alive"] == "-1"
```

Step 4: Run focused tests.

```powershell
python -m pytest tests/test_component2_ollama.py tests/test_llm_enrich_logger.py -q
```

Expected pass:
- Tests pass.
- Captured payload includes `keep_alive`.

Decision gate:
- Use `-1` locally so repeated C2 generations do not unload the models between runs.
- Override with a duration such as `30m` on lower-RAM hosts that need idle memory reclaimed.

## Stage 4: Per-Request Context Control

Purpose: Keep C2 context moderate by default while allowing larger context for specific experiments.

Files:
- Modify `fletcher/config.py`.
- Modify `fletcher/llm/llm_enrich.py:495-524`.
- Add tests in `tests/test_component2_ollama.py`.

Step 1: Add config variable.

File: `fletcher/config.py`.

Code shape:

```python
OLLAMA_NUM_CTX = max(1024, int(os.getenv("HUNT_OLLAMA_NUM_CTX", "8192")))
```

Step 2: Add `num_ctx` to chat options.

File: `fletcher/llm/llm_enrich.py`.

Code shape:

```python
"options": {
    "temperature": temperature,
    "num_ctx": config.OLLAMA_NUM_CTX,
},
```

Step 3: Add a unit test.

File: `tests/test_component2_ollama.py`.

Test shape:

```python
def test_ollama_chat_sends_num_ctx(monkeypatch):
    ...
    assert payload["options"]["num_ctx"] == 8192
```

Step 4: Run focused tests.

```powershell
python -m pytest tests/test_component2_ollama.py -q
```

Expected pass:
- Tests pass.
- Chat payload includes `num_ctx`.

Decision gate:
- Keep default `8192`.
- Increase only for measured prompts that exceed context.
- Do not set 64K+ context for normal resume tailoring.

## Stage 5: Controlled Parallel Rewrite Trial

Purpose: Compare serial versus small parallel bullet rewrites after Ollama memory settings are stable.

Files:
- No code changes required for first trial.
- Optional future change: add a pipeline timing report to `fletcher/ad_hoc_pipeline.py` if manual log review is too slow.

Step 1: Run baseline serial.

```powershell
$env:HUNT_BULLET_REWRITE_PARALLELISM="1"
python -m pytest tests/test_ad_hoc_pipeline.py -q
```

Then run one representative C2 ad-hoc job and save the pipeline log.

Expected pass:
- Pipeline completes.
- Log includes `bullet_rewrite_parallel_config` with `active_workers=1`.

Step 2: Run parallel trial.

```powershell
$env:HUNT_BULLET_REWRITE_PARALLELISM="2"
python -m pytest tests/test_ad_hoc_pipeline.py -q
```

Then run the same representative C2 ad-hoc job and save the pipeline log.

Expected pass:
- Pipeline completes.
- Log includes `bullet_rewrite_parallel_config` with `active_workers=2`, unless memory guard falls back to serial.
- Ollama snapshot shows whether requests are loaded on GPU, CPU/GPU, or queued indirectly through timing.

Step 3: Compare logs.

Compare:
- Total wall time.
- LLM call duration distribution.
- JSON parse failure count.
- Rewrite success count.
- Memory guard fallback count.
- Ollama `processor` placement.

Decision gate:
- Keep `2` only if wall time improves without more failures.
- Try `3` only after `2` is clearly stable.
- Return default to `1` for shared/server environments unless server-specific measurements support more.

## Stage 6: Optional Q4 KV Cache Experiment

Purpose: Free more context memory only if `q8_0` is not enough.

Files:
- No code changes if using environment override.

Step 1: Override local environment for one test run.

```powershell
$env:OLLAMA_KV_CACHE_TYPE="q4_0"
docker compose --profile c2 -f docker-compose.pipeline.yml up -d ollama
```

Step 2: Run C2 verification.

```powershell
python ci.py c2
```

Expected pass:
- C2 passes.
- JSON reliability and output quality remain acceptable.

Decision gate:
- Prefer `q8_0` unless `q4_0` is required for context length.
- Do not combine `q4_0` with increased rewrite parallelism in the same test. Change one variable at a time.

## Stage 7: Direct llama.cpp Sidecar Research

Purpose: Reproduce the Qwen3.6-35B-A3B MoE offload technique outside Ollama.

Files:
- Create a separate future plan before implementation.
- Do not modify the existing Ollama service for this stage.

Required research questions:
- Which GGUF quant of Qwen3.6-35B-A3B fits local RAM and VRAM goals?
- Which llama.cpp build or fork is required for the target TurboQuant cache behavior?
- What exact `llama-server` command is stable on the target machine?
- How will Fletcher route requests to Ollama versus llama-server?

Initial command shape:

```powershell
llama-server `
  -m C:\models\qwen3.6-35b-a3b.gguf `
  --host 0.0.0.0 `
  --port 8088 `
  --ctx-size 32768 `
  --n-gpu-layers all `
  --n-cpu-moe 20 `
  --flash-attn on `
  --cache-type-k q8_0 `
  --cache-type-v q8_0 `
  --no-mmap `
  --mlock `
  --parallel 1
```

Decision gate:
- Keep this separate from Hunt production until a repeatable benchmark exists.
- Do not claim Ollama can reproduce `--n-cpu-moe` unless Ollama exposes equivalent controls.

## Final Verification Before Completion

Run after any stage implementation:

```powershell
python -m pytest tests/test_ad_hoc_pipeline.py -k "rewrite_parallelism or meminfo or cgroup or ollama_runtime" -q
python -m pytest tests/test_component2_ollama.py tests/test_llm_enrich_logger.py -q
docker compose --profile c2 -f docker-compose.pipeline.yml config
```

Run when changing compose or runtime behavior:

```powershell
python ci.py c2
```

Completion criteria:
- Tests pass.
- Compose renders.
- Pipeline logs show enough timing and Ollama placement information to compare before and after.
- Only one optimization variable changes per benchmark run.
