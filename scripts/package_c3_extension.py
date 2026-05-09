#!/usr/bin/env python3
"""Package the C3 Chrome extension as an unpacked folder and zip artifact."""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXECUTIONER_ROOT = ROOT / "executioner"
DIST_ROOT = ROOT / "dist" / "c3"

INCLUDE_PATHS = [
    "manifest.json",
    "README.md",
    "src",
]


def _load_manifest() -> dict[str, object]:
    manifest_path = EXECUTIONER_ROOT / "manifest.json"
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def _artifact_name(manifest: dict[str, object]) -> str:
    version = str(manifest.get("version") or "dev").strip() or "dev"
    return f"hunt-apply-extension-v{version}"


def _copy_package_files(unpacked_dir: Path) -> None:
    if unpacked_dir.exists():
        shutil.rmtree(unpacked_dir)
    unpacked_dir.mkdir(parents=True, exist_ok=True)

    for relative in INCLUDE_PATHS:
        source = EXECUTIONER_ROOT / relative
        target = unpacked_dir / relative
        if source.is_dir():
            shutil.copytree(
                source,
                target,
                ignore=shutil.ignore_patterns("__pycache__", "*.map"),
            )
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def _write_zip(unpacked_dir: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(unpacked_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(unpacked_dir).as_posix())


def package_extension(*, dry_run: bool = False) -> dict[str, str]:
    manifest = _load_manifest()
    artifact_name = _artifact_name(manifest)
    unpacked_dir = DIST_ROOT / artifact_name
    zip_path = DIST_ROOT / f"{artifact_name}.zip"

    if not dry_run:
        DIST_ROOT.mkdir(parents=True, exist_ok=True)
        _copy_package_files(unpacked_dir)
        _write_zip(unpacked_dir, zip_path)

    return {
        "name": str(manifest.get("name") or "Hunt Apply Extension"),
        "version": str(manifest.get("version") or ""),
        "unpacked_dir": str(unpacked_dir),
        "zip_path": str(zip_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    result = package_extension(dry_run=args.dry_run)
    print("[c3-package] name:", result["name"])
    print("[c3-package] version:", result["version"])
    print("[c3-package] unpacked:", result["unpacked_dir"])
    print("[c3-package] zip:", result["zip_path"])
    if args.dry_run:
        print("[c3-package] dry-run complete")
    else:
        print("[c3-package] package complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
