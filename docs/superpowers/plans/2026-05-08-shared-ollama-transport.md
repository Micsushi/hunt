# Shared Ollama Transport Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:executing-plans.
Goal: Extract reusable Ollama chat and embedding transport so C2, future C3 answer generation, and worker-side tooling can share one local LLM client.
Architecture: Add a dependency-light `shared.llm.ollama` module that owns HTTP payload construction, keep-alive normalization, JSON response loading, and content/embedding extraction. Keep Fletcher/C2 prompt services in `fletcher.llm`, and have the existing provider, legacy helper, and RAG embedding call into shared transport.
Tech Stack: Python standard library `urllib`, existing pytest/unittest tests.

## Task 1: Shared Transport
Files: Create `shared/llm/__init__.py`, create `shared/llm/ollama.py`, create `tests/test_shared_ollama.py`.
- [x] Step 1: Write tests for chat keep_alive payload, content extraction, and embedding extraction.
- [x] Step 2: Run `python -m pytest tests/test_shared_ollama.py -q` and see import failure.
- [x] Step 3: Implement shared transport helpers.
- [x] Step 4: Run `python -m pytest tests/test_shared_ollama.py -q` and pass.

## Task 2: Fletcher Integration
Files: Modify `fletcher/llm/llm_enrich.py`, `fletcher/llm/rag.py`, `fletcher/llm/providers/ollama.py`, `tests/test_component2_ollama.py`.
- [x] Step 1: Route `_ollama_chat`, `_embed`, and `OllamaProvider.generate_json` through `shared.llm.ollama`.
- [x] Step 2: Update tests to patch the shared urllib call site.
- [x] Step 3: Run `python -m pytest tests/test_shared_ollama.py tests/test_component2_ollama.py -q`.

## Task 3: Verification and Vault
Files: Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/local-llm-runtime-notes.md`.
- [x] Step 1: Run focused LLM/provider tests.
- [x] Step 2: Update the vault note with implemented file paths.
