"""Fernet encrypt/decrypt for secrets stored in DB (linkedin passwords)."""

from __future__ import annotations

import os
from functools import lru_cache


@lru_cache(maxsize=1)
def _get_fernet():
    key = (os.environ.get("HUNT_CREDENTIAL_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "HUNT_CREDENTIAL_KEY is not set. "
            "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    from cryptography.fernet import Fernet

    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(plaintext: str) -> str:
    """Encrypt a string and return a base64 Fernet token."""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    """Decrypt a Fernet token and return the original string."""
    return _get_fernet().decrypt(token.encode()).decode()


def credential_key_is_set() -> bool:
    return bool((os.environ.get("HUNT_CREDENTIAL_KEY") or "").strip())
