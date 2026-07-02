from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend.ledger.verify import verify_jsonl_hash_chain  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a Hunt ledger JSONL hash chain.")
    parser.add_argument("log_path", help="Agent, session, lane, or global ledger JSONL path.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    result = verify_jsonl_hash_chain(args.log_path)
    payload = asdict(result)
    payload["path"] = str(result.path)

    if args.json:
        print(json.dumps(payload, sort_keys=True))
    elif result.ok:
        print(
            f"OK {result.path}: {result.checked_lines} lines verified, last_hash={result.last_hash}"
        )
    else:
        error = result.error
        print(
            f"FAILED {result.path}: line {error.line_number if error else 0}: "
            f"{error.reason if error else 'unknown error'}"
        )
        if error and (error.expected is not None or error.actual is not None):
            print(f"expected={error.expected}")
            print(f"actual={error.actual}")

    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
