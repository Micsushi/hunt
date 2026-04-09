"""
RAG index for keyword-to-bullet semantic matching.

Flow:
  1. build_index()   — embed all bullets/skills from resume + profile + library
                       into a ChromaDB collection on disk.
  2. is_stale()      — hash check: returns True if source files changed since
                       the last build.
  3. distribute_keywords_rag() — embed each JD keyword, query the collection,
                                  route to bullet_keywords or summary_keywords
                                  based on similarity threshold.

The index is rebuilt automatically in the pipeline when source files change.
Run `fletch index build` to force a manual rebuild.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.request
from pathlib import Path
from typing import Any

from .. import config
from ..resume.source_loader import load_bullet_library, load_candidate_profile
from ..resume.parser import parse_resume_file


# ---------------------------------------------------------------------------
# Ollama embedding
# ---------------------------------------------------------------------------

def _embed(text: str) -> list[float]:
    """Return embedding vector for text via Ollama mxbai-embed-large."""
    payload = json.dumps({
        "model": config.OLLAMA_EMBED_MODEL,
        "prompt": text.strip()[:2000],
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{config.OLLAMA_HOST}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.load(resp)
    return body["embedding"]


# ---------------------------------------------------------------------------
# Source hash (staleness check)
# ---------------------------------------------------------------------------

def _hash_sources(
    resume_path: Path,
    candidate_profile_path: Path,
    bullet_library_path: Path,
) -> str:
    h = hashlib.sha256()
    for p in (resume_path, candidate_profile_path, bullet_library_path):
        p = Path(p)
        if p.exists():
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


def _meta_path(index_dir: Path) -> Path:
    return index_dir / "index_meta.json"


def is_stale(
    resume_path: Path,
    candidate_profile_path: Path,
    bullet_library_path: Path,
    index_dir: Path | None = None,
) -> bool:
    """True if source files changed since last build, or index doesn't exist."""
    idx_dir = Path(index_dir or config.RAG_INDEX_DIR)
    meta = _meta_path(idx_dir)
    if not meta.exists():
        return True
    try:
        stored = json.loads(meta.read_text(encoding="utf-8"))
        current = _hash_sources(resume_path, candidate_profile_path, bullet_library_path)
        return stored.get("source_hash") != current
    except Exception:
        return True


# ---------------------------------------------------------------------------
# Index documents
# ---------------------------------------------------------------------------

def _collect_documents(
    resume_path: Path,
    candidate_profile_path: Path,
    bullet_library_path: Path,
) -> list[dict[str, str]]:
    """Return list of {id, text, source} dicts covering all indexable content."""
    docs: list[dict[str, str]] = []

    # --- main.tex bullets ---
    try:
        resume_doc = parse_resume_file(resume_path)
        for entry in resume_doc.experience:
            for i, bullet in enumerate(entry.bullets):
                docs.append({
                    "id": f"resume_exp_{entry.entry_id}_{i}",
                    "text": bullet,
                    "source": "resume_experience",
                    "entry_id": entry.entry_id,
                })
        for entry in resume_doc.projects:
            for i, bullet in enumerate(entry.bullets):
                docs.append({
                    "id": f"resume_proj_{entry.entry_id}_{i}",
                    "text": bullet,
                    "source": "resume_project",
                    "entry_id": entry.entry_id,
                })
        # Skills from resume
        for lang in resume_doc.skills.languages:
            docs.append({
                "id": f"resume_skill_lang_{_short_id(lang)}",
                "text": lang,
                "source": "resume_skill",
                "entry_id": "skills",
            })
        for fw in resume_doc.skills.frameworks:
            docs.append({
                "id": f"resume_skill_fw_{_short_id(fw)}",
                "text": fw,
                "source": "resume_skill",
                "entry_id": "skills",
            })
        for tool in resume_doc.skills.developer_tools:
            docs.append({
                "id": f"resume_skill_tool_{_short_id(tool)}",
                "text": tool,
                "source": "resume_skill",
                "entry_id": "skills",
            })
    except Exception:
        pass

    # --- candidate_profile.md bullet candidates + skills + extra context ---
    try:
        profile = load_candidate_profile(candidate_profile_path)
        for entry in profile.get("experience_entries", []):
            eid = entry.get("entry_id", "unknown")
            # Bullet candidates
            for bc in entry.get("bullet_candidates", []):
                text = (bc.get("text") or "").strip()
                if text:
                    docs.append({
                        "id": f"profile_exp_{eid}_{bc.get('bullet_id', _short_id(text))}",
                        "text": text,
                        "source": "profile_bullet",
                        "entry_id": eid,
                    })
            # Immutable facts — useful context
            for fact in entry.get("immutable_facts", []):
                text = (fact.get("text") or "").strip()
                if text:
                    docs.append({
                        "id": f"profile_fact_{eid}_{fact.get('fact_id', _short_id(text))}",
                        "text": text,
                        "source": "profile_fact",
                        "entry_id": eid,
                    })
            # Extra context fields
            ctx = entry.get("extra_context") or {}
            for field, value in ctx.items():
                if value:
                    docs.append({
                        "id": f"profile_ctx_{eid}_{field}",
                        "text": str(value),
                        "source": "profile_context",
                        "entry_id": eid,
                    })
        for entry in profile.get("project_entries", []):
            eid = entry.get("entry_id", "unknown")
            for bc in entry.get("bullet_candidates", []):
                text = (bc.get("text") or "").strip()
                if text:
                    docs.append({
                        "id": f"profile_proj_{eid}_{bc.get('bullet_id', _short_id(text))}",
                        "text": text,
                        "source": "profile_project_bullet",
                        "entry_id": eid,
                    })
        for bucket in ("languages", "frameworks", "developer_tools"):
            for skill in profile.get("skills", {}).get(bucket, []):
                name = (skill.get("name") or "").strip()
                where = (skill.get("where_used") or "").strip()
                if name:
                    text = f"{name}: {where}" if where else name
                    docs.append({
                        "id": f"profile_skill_{bucket}_{_short_id(name)}",
                        "text": text,
                        "source": "profile_skill",
                        "entry_id": "skills",
                    })
    except Exception:
        pass

    # --- bullet_library.md ---
    try:
        library = load_bullet_library(bullet_library_path)
        for entry in library.get("experience_entries", []):
            eid = entry.get("source_entry_id", "unknown")
            for bc in entry.get("bullet_candidates", []):
                text = (bc.get("text") or "").strip()
                if text:
                    docs.append({
                        "id": f"lib_exp_{eid}_{bc.get('bullet_id', _short_id(text))}",
                        "text": text,
                        "source": "library_bullet",
                        "entry_id": eid,
                    })
        for entry in library.get("project_entries", []):
            eid = entry.get("source_entry_id", "unknown")
            for bc in entry.get("bullet_candidates", []):
                text = (bc.get("text") or "").strip()
                if text:
                    docs.append({
                        "id": f"lib_proj_{eid}_{bc.get('bullet_id', _short_id(text))}",
                        "text": text,
                        "source": "library_project_bullet",
                        "entry_id": eid,
                    })
    except Exception:
        pass

    # Deduplicate by text
    seen: set[str] = set()
    deduped: list[dict[str, str]] = []
    for doc in docs:
        key = doc["text"].strip().lower()
        if key and key not in seen:
            seen.add(key)
            deduped.append(doc)
    return deduped


def _short_id(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:8]


# ---------------------------------------------------------------------------
# Build index
# ---------------------------------------------------------------------------

def build_index(
    resume_path: Path,
    candidate_profile_path: Path,
    bullet_library_path: Path,
    index_dir: Path | None = None,
    *,
    verbose: bool = False,
) -> dict[str, Any]:
    """Embed all source documents and persist to ChromaDB.

    Returns a status dict with counts and timing.
    """
    import chromadb  # deferred import — only needed when RAG is active

    idx_dir = Path(index_dir or config.RAG_INDEX_DIR)
    idx_dir.mkdir(parents=True, exist_ok=True)

    docs = _collect_documents(resume_path, candidate_profile_path, bullet_library_path)
    if verbose:
        print(f"[RAG] Collected {len(docs)} documents to index.")

    client = chromadb.PersistentClient(path=str(idx_dir))
    # Drop and recreate for a clean rebuild
    try:
        client.delete_collection("resume_bullets")
    except Exception:
        pass
    collection = client.create_collection(
        "resume_bullets",
        metadata={"hnsw:space": "cosine"},
    )

    batch_size = 50
    total = len(docs)
    embedded = 0
    errors = 0
    start = time.perf_counter()

    for i in range(0, total, batch_size):
        batch = docs[i: i + batch_size]
        ids, texts, embeddings, metadatas = [], [], [], []
        for doc in batch:
            try:
                vec = _embed(doc["text"])
                ids.append(doc["id"])
                texts.append(doc["text"])
                embeddings.append(vec)
                metadatas.append({
                    "source": doc["source"],
                    "entry_id": doc.get("entry_id", ""),
                })
                embedded += 1
            except Exception as exc:
                errors += 1
                if verbose:
                    print(f"  [RAG] embed error for '{doc['text'][:60]}': {exc}")
        if ids:
            collection.add(ids=ids, documents=texts, embeddings=embeddings, metadatas=metadatas)
        if verbose:
            print(f"  [RAG] {min(i + batch_size, total)}/{total} embedded...")

    duration_ms = int((time.perf_counter() - start) * 1000)
    source_hash = _hash_sources(resume_path, candidate_profile_path, bullet_library_path)
    meta = {
        "source_hash": source_hash,
        "total_docs": total,
        "embedded": embedded,
        "errors": errors,
        "duration_ms": duration_ms,
        "embed_model": config.OLLAMA_EMBED_MODEL,
        "resume_path": str(resume_path),
        "candidate_profile_path": str(candidate_profile_path),
        "bullet_library_path": str(bullet_library_path),
    }
    _meta_path(idx_dir).write_text(json.dumps(meta, indent=2), encoding="utf-8")

    if verbose:
        print(f"[RAG] Index built: {embedded} docs in {duration_ms}ms. Errors: {errors}.")
    return meta


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------

def _get_collection(index_dir: Path | None = None):
    import chromadb
    idx_dir = Path(index_dir or config.RAG_INDEX_DIR)
    client = chromadb.PersistentClient(path=str(idx_dir))
    return client.get_collection("resume_bullets")


def query_keyword(
    keyword: str,
    index_dir: Path | None = None,
    n_results: int = 3,
) -> list[dict[str, Any]]:
    """Return top-n matches for a keyword with text and similarity score."""
    collection = _get_collection(index_dir)
    vec = _embed(keyword)
    results = collection.query(query_embeddings=[vec], n_results=n_results)
    hits = []
    docs_list = (results.get("documents") or [[]])[0]
    dists = (results.get("distances") or [[]])[0]
    metas = (results.get("metadatas") or [[]])[0]
    for text, dist, meta in zip(docs_list, dists, metas):
        # ChromaDB cosine distance: 0 = identical, 2 = opposite.
        # Convert to similarity: 1 - (dist / 2)  gives 0..1 range.
        similarity = round(1.0 - dist / 2.0, 4)
        hits.append({"text": text, "similarity": similarity, "meta": meta})
    return hits


# ---------------------------------------------------------------------------
# Distribute keywords via RAG
# ---------------------------------------------------------------------------

def distribute_keywords_rag(
    keywords: list[str],
    index_dir: Path | None = None,
    *,
    threshold: float | None = None,
    max_total: int = 10,
    verbose: bool = False,
) -> dict:
    """Route each keyword to bullet_keywords or summary_keywords using RAG.

    - bullet_keywords: top match >= threshold - concept already in candidate
      background, LLM reformulates existing bullets to use JD vocabulary.
    - summary_keywords: top match < threshold - foreign concept, LLM injects
      naturally into summary paragraph only.

    Returns dict with keys:
      bullet_keywords, summary_keywords, scores (per-keyword detail list),
      threshold_used, rag_used=True.
    """
    if not keywords:
        return {"bullet_keywords": [], "summary_keywords": [], "scores": [], "threshold_used": None, "rag_used": True}

    sim_threshold = threshold if threshold is not None else config.RAG_SIMILARITY_THRESHOLD
    bullet_kws: list[str] = []
    summary_kws: list[str] = []
    scores: list[dict] = []

    for kw in keywords:
        try:
            hits = query_keyword(kw, index_dir, n_results=1)
            top_score = hits[0]["similarity"] if hits else 0.0
            top_text = hits[0]["text"] if hits else ""
            bucket = "bullet" if top_score >= sim_threshold else "summary"
            scores.append({
                "keyword": kw,
                "score": round(top_score, 4),
                "bucket": bucket,
                "nearest": top_text[:80],
            })
            if verbose:
                print(
                    f"  [RAG] '{kw}' -> score {top_score:.3f} "
                    f"({bucket}) "
                    f"| nearest: '{top_text[:60]}'"
                )
            if bucket == "bullet":
                bullet_kws.append(kw)
            else:
                summary_kws.append(kw)
        except Exception as exc:
            scores.append({"keyword": kw, "score": 0.0, "bucket": "summary", "nearest": "", "error": str(exc)})
            if verbose:
                print(f"  [RAG] query error for '{kw}': {exc}")
            summary_kws.append(kw)

    bullet_cap = max_total // 2 + max_total % 2
    summary_cap = max_total // 2
    return {
        "bullet_keywords": bullet_kws[:bullet_cap],
        "summary_keywords": summary_kws[:summary_cap],
        "scores": scores,
        "threshold_used": sim_threshold,
        "rag_used": True,
    }


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def index_status(index_dir: Path | None = None) -> dict[str, Any]:
    """Return current index metadata, or an empty dict if not built."""
    idx_dir = Path(index_dir or config.RAG_INDEX_DIR)
    meta = _meta_path(idx_dir)
    if not meta.exists():
        return {"built": False}
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
        data["built"] = True
        data["index_dir"] = str(idx_dir)
        return data
    except Exception:
        return {"built": False}


def clear_index(index_dir: Path | None = None) -> None:
    """Delete the ChromaDB collection and meta file."""
    import chromadb
    idx_dir = Path(index_dir or config.RAG_INDEX_DIR)
    try:
        client = chromadb.PersistentClient(path=str(idx_dir))
        client.delete_collection("resume_bullets")
    except Exception:
        pass
    meta = _meta_path(idx_dir)
    if meta.exists():
        meta.unlink()
