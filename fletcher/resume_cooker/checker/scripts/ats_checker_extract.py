"""Execute the vendored ATS-Checker parser and emit one JSON result."""

import importlib.util
import json
import os
import sys
import tempfile


def load_vendored_module(module_path):
    spec = importlib.util.spec_from_file_location("resume_cooker_vendored_ats_checker", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load vendored ATS-Checker module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv):
    if len(argv) < 3:
        json.dump(
            {"ok": False, "error": "usage: ats_checker_extract.py <ats.py> <pdf>"},
            sys.stdout,
        )
        return 2

    try:
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory(prefix="resume-cooker-ats-checker-") as temp_dir:
            os.chdir(temp_dir)
            try:
                module = load_vendored_module(argv[1])
                with open(argv[2], "rb") as pdf_stream:
                    text = module.parse_resume(pdf_stream)
                library = f"PyPDF2:{module.PyPDF2.__version__}"
            finally:
                os.chdir(original_cwd)
    except Exception as exc:  # noqa: BLE001 - emit only the exception class
        json.dump({"ok": False, "error": type(exc).__name__}, sys.stdout)
        return 4

    json.dump({"ok": True, "library": library, "text": text}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
