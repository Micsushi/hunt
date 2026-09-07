"""Bounded execution for local document tools, without a shell."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time


def run_tool(argv, *, cwd=None, timeout=120.0, max_output=1024 * 1024):
    output = bytearray()
    overflow = threading.Event()
    # CREATE_SUSPENDED closes the spawn-before-job-assignment race on Windows.
    options = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | 4 | subprocess.CREATE_NO_WINDOW}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        **options,
    )
    job = None
    if os.name == "nt":
        from .compiler_job import ToolJob

        try:
            job = ToolJob(process)
            job.resume(process.pid)
        except OSError:
            try:
                if job is not None:
                    job.close()
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                process.stdout.close()
            raise

    def read_output():
        try:
            while chunk := process.stdout.read(4096):
                remaining = max_output - len(output)
                output.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    overflow.set()
                    break
        finally:
            process.stdout.close()

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    reason = None
    try:
        while process.poll() is None or reader.is_alive():
            if overflow.is_set():
                reason = "output_limit"
                break
            if time.monotonic() >= deadline:
                reason = "timeout"
                break
            time.sleep(0.01)
    finally:
        try:
            if job is not None:
                job.close()
            elif os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            reader.join(timeout=5)
    if reader.is_alive():
        raise RuntimeError("Document tool output pipe did not close after process cleanup")
    if overflow.is_set():
        reason = "output_limit"
    return {
        "returncode": process.returncode,
        "failure": reason,
        "output": output.decode("utf-8", errors="replace"),
    }
