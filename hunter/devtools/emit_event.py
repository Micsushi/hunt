import argparse
import json

from hunter.c1_logging import C1Logger  # type: ignore


def main() -> int:
    p = argparse.ArgumentParser(
        description="Emit a Hunter (C1) runtime_state event (webapp-visible) without PowerShell quoting pain."
    )
    p.add_argument("--key", required=True)
    p.add_argument("--level", default="info", choices=("debug", "info", "warn", "error"))
    p.add_argument("--message", required=True)
    p.add_argument("--code", required=True)
    p.add_argument(
        "--details-json",
        default="{}",
        help='JSON string for details (example: {"account_index":0,"blocked_days":1})',
    )
    p.add_argument("--discord", action="store_true", help="Also try to send Discord webhook.")
    args = p.parse_args()

    try:
        details = json.loads(args.details_json or "{}")
    except json.JSONDecodeError as e:
        raise SystemExit(f"Invalid --details-json: {e}") from e

    C1Logger(discord=bool(args.discord)).event(
        key=args.key,
        level=args.level,
        message=args.message,
        code=args.code,
        details=details,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
