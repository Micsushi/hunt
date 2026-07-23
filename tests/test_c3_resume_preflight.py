import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIGURE_SCRIPT = REPO_ROOT / "scripts" / "configure_c3_debug_sink.js"
SETUP_SCRIPT = REPO_ROOT / "scripts" / "setup_c3_parallel_lanes.ps1"


def powershell_executable() -> str:
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if not executable:
        pytest.skip("PowerShell is not installed")
    return executable


def run_node(source: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "-e", source, *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def helper_script(body: str) -> str:
    return f"""
        const helpers = require({json.dumps(str(CONFIGURE_SCRIPT))});
        {body}
    """


def test_last20_resume_helper_accepts_pdf_and_emits_strict_identity(tmp_path):
    resume = tmp_path / "candidate-resume.pdf"
    payload = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n"
    resume.write_bytes(payload)

    result = run_node(
        helper_script(
            """
            const seed = helpers.readResumeSeed(process.argv[1]);
            helpers.isDefaultResumeReadyInBrowser(seed).then((browserReady) => {
              console.log(JSON.stringify({
                ready: helpers.isDefaultResumeReady(seed),
                browserReady,
                fileName: seed.pdfFileName,
                byteCount: seed.pdfByteCount,
                sha256: seed.pdfSha256,
              }));
            });
            """
        ),
        str(resume),
    )

    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["ready"] is True
    assert output["browserReady"] is True
    assert output["fileName"] == resume.name
    assert output["byteCount"] == len(payload)
    assert len(output["sha256"]) == 64


def test_last20_resume_helper_rejects_missing_zero_oversize_and_invalid_pdf(tmp_path):
    zero = tmp_path / "zero.pdf"
    zero.write_bytes(b"")
    oversize = tmp_path / "oversize.pdf"
    oversize.write_bytes(b"")
    with oversize.open("r+b") as handle:
        handle.truncate(10 * 1024 * 1024 + 1)
    wrong_extension = tmp_path / "resume.txt"
    wrong_extension.write_bytes(b"%PDF-1.4\n%%EOF\n")
    wrong_header = tmp_path / "resume.pdf"
    wrong_header.write_bytes(b"not a pdf")
    missing = tmp_path / "missing.pdf"

    result = run_node(
        helper_script(
            """
            const results = process.argv.slice(1).map((file) => {
              try {
                helpers.readResumeSeed(file);
                return "accepted";
              } catch (error) {
                return String(error.message || error).split(":")[0];
              }
            });
            console.log(JSON.stringify(results));
            """
        ),
        str(missing),
        str(zero),
        str(oversize),
        str(wrong_extension),
        str(wrong_header),
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["resume_preflight_missing"] * 5


def test_last20_resume_readiness_rejects_corrupt_cache_and_unsafe_identity(tmp_path):
    resume = tmp_path / "resume.pdf"
    resume.write_bytes(b"%PDF-1.4\nstrict identity\n%%EOF\n")

    result = run_node(
        helper_script(
            """
            const seed = helpers.readResumeSeed(process.argv[1]);
            const variants = [
              { ...seed, pdfDataUrl: "data:application/pdf;base64," },
              { ...seed, pdfDataUrl: "data:application/pdf;base64,%%%%" },
              { ...seed, pdfDataUrl: seed.pdfDataUrl.slice(0, -4) + "AAAA" },
              { ...seed, pdfByteCount: seed.pdfByteCount + 1 },
              { ...seed, pdfSha256: "0".repeat(64) },
              { ...seed, pdfFileName: "../resume.pdf" },
            ];
            Promise.all(variants.map((value) => helpers.isDefaultResumeReadyInBrowser(value)))
              .then((browserReady) => console.log(JSON.stringify({
                nodeReady: variants.map((value) => helpers.isDefaultResumeReady(value)),
                browserReady,
              })))
              .catch((error) => {
                console.error(error.stack || error.message || String(error));
                process.exitCode = 1;
              });
            """
        ),
        str(resume),
    )

    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["nodeReady"] == [False] * 6
    assert output["browserReady"] == [False] * 6


def test_last20_browser_resume_readiness_rejects_noncanonical_base64(tmp_path):
    resume = tmp_path / "resume.pdf"
    resume.write_bytes(b"%PDF-1.4\nnoncanonical padding bits\n%%EOF\n")

    result = run_node(
        helper_script(
            """
            const seed = helpers.readResumeSeed(process.argv[1]);
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            const canonical = seed.pdfDataUrl.split(",", 2)[1];
            const padding = canonical.endsWith("==") ? 2 : canonical.endsWith("=") ? 1 : 0;
            if (!padding) throw new Error("fixture_requires_base64_padding");
            const index = canonical.length - padding - 1;
            const replacement = alphabet[alphabet.indexOf(canonical[index]) ^ 1];
            const noncanonical = canonical.slice(0, index) + replacement + canonical.slice(index + 1);
            const cached = {
              ...seed,
              pdfDataUrl: "data:application/pdf;base64," + noncanonical,
            };
            helpers.isDefaultResumeReadyInBrowser(cached).then((browserReady) => {
              console.log(JSON.stringify({
                nodeReady: helpers.isDefaultResumeReady(cached),
                browserReady,
                decodedSame: Buffer.from(noncanonical, "base64").equals(
                  Buffer.from(canonical, "base64"),
                ),
              }));
            });
            """
        ),
        str(resume),
    )

    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["decodedSame"] is True
    assert output["nodeReady"] is False
    assert output["browserReady"] is False


def test_last20_seed_profile_requires_resume_before_cdp():
    result = subprocess.run(
        ["node", str(CONFIGURE_SCRIPT), "--port", "1", "--seed-workday-profile"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "resume_preflight_missing" in result.stderr
    assert "ECONNREFUSED" not in result.stderr


def test_last20_public_result_never_contains_pdf_data(tmp_path):
    resume = tmp_path / "resume.pdf"
    secret_pdf = b"%PDF-1.4\nPRIVATE-RESUME-CONTENT\n%%EOF\n"
    resume.write_bytes(secret_pdf)

    result = run_node(
        helper_script(
            """
            const seed = helpers.readResumeSeed(process.argv[1]);
            const output = helpers.makePublicResult({
              ok: true,
              defaultResumeReady: true,
              defaultResumeIdentity: helpers.defaultResumeIdentity(seed),
              pdfDataUrl: seed.pdfDataUrl,
              defaultResume: seed,
              testResult: {},
            }, "found");
            console.log(JSON.stringify(output));
            """
        ),
        str(resume),
    )

    assert result.returncode == 0, result.stderr
    assert "PRIVATE-RESUME-CONTENT" not in result.stdout
    assert "pdfDataUrl" not in result.stdout
    assert '"defaultResume":' not in result.stdout
    output = json.loads(result.stdout)
    assert output["defaultResumeReady"] is True
    assert output["defaultResumeIdentity"]["pdfByteCount"] == len(secret_pdf)


def test_last20_lane_setup_fails_closed_and_compares_resume_identity(tmp_path):
    missing = tmp_path / "missing.pdf"
    logs = tmp_path / "logs"
    result = subprocess.run(
        [
            powershell_executable(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SETUP_SCRIPT),
            "-BatchId",
            "resume-preflight-test",
            "-Ports",
            "1",
            "-LogsRoot",
            str(logs),
            "-ResumePath",
            str(missing),
            "-AllowPrimaryMonitor",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "resume_preflight_missing" in result.stderr
    setup = SETUP_SCRIPT.read_text(encoding="utf-8")
    assert "Get-FileHash" in setup
    assert "ExpectedResumeIdentity" in setup
    assert "defaultResumeIdentity" in setup


def test_last20_powershell_resume_preflight_rejects_invalid_header_before_lane_setup(tmp_path):
    invalid_pdf = tmp_path / "invalid-header.pdf"
    invalid_pdf.write_bytes(b"NOT-PDF but nonempty")
    setup = SETUP_SCRIPT.read_text(encoding="utf-8")
    function_start = setup.index("function Test-ResumePreflight {")
    function_end = setup.index("function Test-LanePreflight {", function_start)
    preflight_function = setup[function_start:function_end]
    escaped_path = str(invalid_pdf).replace("'", "''")
    command = f"""
        $ErrorActionPreference = "Stop"
        {preflight_function}
        try {{
            Test-ResumePreflight -ResumePath '{escaped_path}' | Out-Null
            exit 0
        }} catch {{
            [Console]::Error.WriteLine($_.Exception.Message)
            exit 23
        }}
    """

    result = subprocess.run(
        [powershell_executable(), "-NoProfile", "-Command", command],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 23
    assert "resume_preflight_missing" in result.stderr
    assert "PDF header" in result.stderr
    assert setup.index("$expectedResumeIdentity = Test-ResumePreflight") < setup.index(
        "$layout = Get-LaneWindowLayout"
    )
