"""Compare job-fit reviewers on a labeled batch without changing Hunt data."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from collections import Counter
from pathlib import Path

from scripts.review_job_matches import classify, classify_local


def evaluate(jobs, classified):
    truth = {job["id"]: job["expected"] for job in jobs}
    predicted = {}
    for row in classified:
        key, decision = row["id"], row["decision"]
        if key in predicted or key not in truth or decision not in ("yes", "no", "deferred"):
            raise ValueError(f"Invalid prediction for ID {key}.")
        predicted[key] = decision
    matrix = Counter((label, predicted.get(key, "missing")) for key, label in truth.items())
    return {
        "correct": sum(matrix[(k, k)] for k in ("yes", "no", "deferred")),
        "total": len(truth),
        "reviewed": len(predicted),
        "keeps_correct": matrix["yes", "yes"],
        "keeps_gold": sum(label == "yes" for label in truth.values()),
        "keeps_incorrect": matrix["no", "yes"] + matrix["deferred", "yes"],
        "false_rejections": matrix["yes", "no"],
        "missing": len(truth) - len(predicted),
        "confusion": {f"{gold} → {actual}": n for (gold, actual), n in sorted(matrix.items())},
        "decisions": [
            {"id": key, "expected": label, "actual": predicted.get(key, "missing")}
            for key, label in truth.items()
        ],
    }


def benchmark(jobs, runner, batch_size):
    started = time.monotonic()
    predictions, metrics = [], {}
    error = None
    fields = {"id", "company", "title", "location", "description", "referral"}
    for begin in range(0, len(jobs), batch_size):
        batch = [
            {key: value for key, value in job.items() if key in fields}
            for job in jobs[begin : begin + batch_size]
        ]
        try:
            rows = runner(batch, metrics)
            ids = {job["id"] for job in batch}
            if len(rows) != len(ids) or {row["id"] for row in rows} != ids:
                raise ValueError("Reviewer omitted or repeated an ID.")
            if any(row.get("decision") not in ("yes", "no", "deferred") for row in rows):
                raise ValueError("Reviewer returned an invalid decision.")
        except (ValueError, RuntimeError, OSError, KeyError, TypeError) as exc:
            error = f"{type(exc).__name__}: {exc}"[:300]
            break
        predictions.extend(rows)
    result = evaluate(jobs, predictions)
    return {
        **result,
        "seconds": round(time.monotonic() - started, 2),
        "usage": metrics,
        "error": error,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--codex-bin")
    parser.add_argument("--codex", action="append", default=[], metavar="MODEL:EFFORT")
    parser.add_argument("--ollama", action="append", default=[], metavar="MODEL")
    parser.add_argument("--ollama-origin", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-think", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 100 or not (args.codex or args.ollama):
        parser.error("Supply at least one model and a batch size from 1 to 100.")
    raw = args.fixture.read_bytes()
    jobs = json.loads(raw.decode("utf-8-sig"))["jobs"]
    report = {
        "fixture_sha256": hashlib.sha256(raw).hexdigest(),
        "batch_size": args.batch_size,
        "models": {},
    }

    def save(label, result):
        report["models"][label] = result
        args.output.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(label, json.dumps({k: v for k, v in result.items() if k != "decisions"}), flush=True)

    for configuration in args.codex:
        model, sep, effort = configuration.partition(":")
        if not (model and sep and effort in ("low", "medium", "high", "xhigh", "max")):
            parser.error("--codex must be MODEL:EFFORT")

        def hosted(batch, metrics):
            return classify(
                [dict(row, revision="fixture") for row in batch],
                model,
                effort,
                codex=args.codex_bin,
                usage=metrics,
            )

        save(configuration, benchmark(jobs, hosted, args.batch_size))

    for model in args.ollama:

        def local(batch, metrics):
            return classify_local(
                batch, model, args.ollama_origin, metrics, think=args.ollama_think
            )

        mode = " with thinking" if args.ollama_think else ""
        save(f"Ollama {model}{mode}", benchmark(jobs, local, args.batch_size))


if __name__ == "__main__":
    main()
