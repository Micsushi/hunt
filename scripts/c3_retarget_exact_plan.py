#!/usr/bin/env python3
"""Retarget an existing C3 plan without replacing its exact posting URLs."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path


def retarget_plan(
    source: dict,
    *,
    batch_id: str,
    ports: list[int],
    artifact_root: Path,
    source_plan: Path,
    deadline_seconds: int = 600,
) -> dict:
    lanes = list(source.get("lanes") or [])
    if len(lanes) != len(ports):
        raise ValueError(f"Expected {len(lanes)} ports, received {len(ports)}")
    if len(set(ports)) != len(ports):
        raise ValueError("Ports must be unique")

    result = copy.deepcopy(source)
    result["batch_id"] = batch_id
    result["allow_foreground"] = False
    result["allow_submit"] = False
    result["exact_retest"] = True
    result["retargeted_from"] = str(source_plan.resolve())
    result["availability"] = []
    result["lanes"] = []

    for ordinal, (source_lane, port) in enumerate(zip(lanes, ports, strict=True), start=1):
        lane = copy.deepcopy(source_lane)
        identity = f"{batch_id}_{port}"
        lane.update(
            {
                "index": ordinal,
                "batch_id": batch_id,
                "port": port,
                "profile": f"ChromeC3PlaywrightParallel_{identity}",
                "agent_id": f"agent_{identity}",
                "lane_id": f"lane_{identity}",
                "session_id": f"session_{identity}",
                "browser_target_id": f"session_{identity}",
                "artifact_dir": str((artifact_root / f"lane_{port}").resolve()),
                "allow_foreground": False,
                "allow_submit": False,
                "deadline_seconds": deadline_seconds,
            }
        )
        result["lanes"].append(lane)
        result["availability"].append(
            {
                "row_number": lane["job"].get("row_number"),
                "job_id": lane["job"].get("job_id"),
                "status": "exact_retest_required",
                "reason": "preserve_exact_posting_no_replacement",
            }
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Retarget a C3 plan while preserving every exact job URL."
    )
    parser.add_argument("--source-plan", required=True, type=Path)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--ports", required=True)
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--deadline-seconds", type=int, default=600)
    args = parser.parse_args()

    ports = [int(value.strip()) for value in args.ports.split(",") if value.strip()]
    source = json.loads(args.source_plan.read_text(encoding="utf-8"))
    result = retarget_plan(
        source,
        batch_id=args.batch_id,
        ports=ports,
        artifact_root=args.artifact_root,
        source_plan=args.source_plan,
        deadline_seconds=args.deadline_seconds,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(args.output.resolve())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
