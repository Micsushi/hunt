"""Resource profile selection for local Ollama-backed C2 deploys."""

from __future__ import annotations

from dataclasses import dataclass
import subprocess


@dataclass(frozen=True)
class ResourceProfile:
    name: str
    env: dict[str, str]


@dataclass(frozen=True)
class ResourceProfileSelection:
    requested: str
    selected: str
    gpu_vram_mb: int | None
    reason: str
    env: dict[str, str]


PROFILES: dict[str, ResourceProfile] = {
    "fast": ResourceProfile(
        name="fast",
        env={
            "OLLAMA_NUM_PARALLEL": "5",
            "OLLAMA_CONTEXT_LENGTH": "8192",
            "OLLAMA_FLASH_ATTENTION": "1",
            "OLLAMA_KV_CACHE_TYPE": "q8_0",
            "HUNT_BULLET_REWRITE_PARALLELISM": "5",
            "HUNT_OLLAMA_KEEP_ALIVE": "-1",
        },
    ),
    "balanced": ResourceProfile(
        name="balanced",
        env={
            "OLLAMA_NUM_PARALLEL": "3",
            "OLLAMA_CONTEXT_LENGTH": "8192",
            "OLLAMA_FLASH_ATTENTION": "1",
            "OLLAMA_KV_CACHE_TYPE": "q8_0",
            "HUNT_BULLET_REWRITE_PARALLELISM": "3",
            "HUNT_OLLAMA_KEEP_ALIVE": "30m",
        },
    ),
    "safe": ResourceProfile(
        name="safe",
        env={
            "OLLAMA_NUM_PARALLEL": "1",
            "OLLAMA_CONTEXT_LENGTH": "4096",
            "OLLAMA_FLASH_ATTENTION": "1",
            "OLLAMA_KV_CACHE_TYPE": "q8_0",
            "HUNT_BULLET_REWRITE_PARALLELISM": "1",
            "HUNT_OLLAMA_KEEP_ALIVE": "30m",
        },
    ),
    "cpu": ResourceProfile(
        name="cpu",
        env={
            "OLLAMA_NUM_PARALLEL": "1",
            "OLLAMA_CONTEXT_LENGTH": "2048",
            "OLLAMA_FLASH_ATTENTION": "0",
            "OLLAMA_KV_CACHE_TYPE": "q8_0",
            "HUNT_BULLET_REWRITE_PARALLELISM": "1",
            "HUNT_OLLAMA_KEEP_ALIVE": "30m",
            "NVIDIA_VISIBLE_DEVICES": "none",
        },
    ),
}


def detect_gpu_vram_mb() -> int | None:
    """Return largest visible NVIDIA GPU VRAM in MB, or None when unavailable."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    values: list[int] = []
    for line in result.stdout.splitlines():
        try:
            values.append(int(line.strip()))
        except ValueError:
            continue
    return max(values) if values else None


def _auto_profile_name(gpu_vram_mb: int | None) -> tuple[str, str]:
    if gpu_vram_mb is None:
        return "safe", "gpu_vram_unknown"
    if gpu_vram_mb >= 15000:
        return "fast", "gpu_vram_at_least_15gb"
    if gpu_vram_mb >= 10000:
        return "balanced", "gpu_vram_at_least_10gb"
    if gpu_vram_mb >= 6000:
        return "safe", "gpu_vram_at_least_6gb"
    return "cpu", "gpu_vram_below_6gb"


def select_resource_profile(
    requested: str, *, gpu_vram_mb: int | None = None
) -> ResourceProfileSelection:
    normalized = (requested or "auto").strip().lower()
    if normalized == "auto":
        detected = detect_gpu_vram_mb() if gpu_vram_mb is None else gpu_vram_mb
        selected, reason = _auto_profile_name(detected)
        return ResourceProfileSelection(
            requested="auto",
            selected=selected,
            gpu_vram_mb=detected,
            reason=reason,
            env=dict(PROFILES[selected].env),
        )
    profile = PROFILES.get(normalized)
    if profile is None:
        valid = ", ".join(["auto", *sorted(PROFILES)])
        raise RuntimeError(f"Unknown resource profile `{requested}`. Valid profiles: {valid}")
    return ResourceProfileSelection(
        requested=normalized,
        selected=profile.name,
        gpu_vram_mb=gpu_vram_mb,
        reason="explicit",
        env=dict(profile.env),
    )
