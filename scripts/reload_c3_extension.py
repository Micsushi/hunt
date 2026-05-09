#!/usr/bin/env python3
"""Reload the unpacked C3 Chrome extension through Chrome DevTools."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import urllib.error
import urllib.request
from urllib.parse import urlparse

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9222
EXTENSION_TITLE = "Hunt Apply"


class ReloadError(RuntimeError):
    """Raised when the extension cannot be reloaded."""


def _read_json(url: str):
    with urllib.request.urlopen(url, timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def _devtools_json_url(host: str, port: int, path: str) -> str:
    return f"http://{host}:{port}{path}"


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ReloadError("Chrome DevTools WebSocket closed unexpectedly.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_ws_text(sock: socket.socket, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    mask = os.urandom(4)
    header = bytearray([0x81])
    if len(data) < 126:
        header.append(0x80 | len(data))
    elif len(data) < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", len(data)))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", len(data)))
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    sock.sendall(bytes(header) + mask + masked)


def _recv_ws_text(sock: socket.socket) -> dict:
    while True:
        first, second = _recv_exact(sock, 2)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", _recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
        mask = _recv_exact(sock, 4) if masked else b""
        payload = _recv_exact(sock, length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        if opcode == 0x8:
            raise ReloadError("Chrome DevTools WebSocket closed before reload completed.")
        if opcode == 0x9:
            continue
        if opcode == 0x1:
            return json.loads(payload.decode("utf-8"))


def _open_devtools_websocket(websocket_url: str) -> socket.socket:
    parsed = urlparse(websocket_url)
    if parsed.scheme != "ws":
        raise ReloadError(f"Unsupported DevTools WebSocket scheme: {parsed.scheme}")
    host = parsed.hostname or DEFAULT_HOST
    port = parsed.port or 80
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    sock = socket.create_connection((host, port), timeout=3)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
    header = response.decode("iso-8859-1", errors="replace")
    if " 101 " not in header.splitlines()[0]:
        sock.close()
        raise ReloadError("Chrome DevTools WebSocket upgrade failed.")
    expected_accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
    ).decode("ascii")
    if expected_accept not in header:
        sock.close()
        raise ReloadError("Chrome DevTools WebSocket accept header did not match.")
    return sock


def evaluate_runtime_expression(websocket_url: str, expression: str) -> None:
    sock = _open_devtools_websocket(websocket_url)
    try:
        _send_ws_text(
            sock,
            {
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {"expression": expression},
            },
        )
        while True:
            message = _recv_ws_text(sock)
            if message.get("id") != 1:
                continue
            if "exceptionDetails" in message:
                raise ReloadError("Chrome rejected the extension reload expression.")
            return
    except OSError:
        if expression == "chrome.runtime.reload()":
            return
        raise
    except ReloadError as error:
        if expression == "chrome.runtime.reload()" and "closed" in str(error).lower():
            return
        raise
    finally:
        sock.close()


def find_c3_target(targets):
    for target in targets:
        url = str(target.get("url") or "")
        title = str(target.get("title") or "")
        target_type = str(target.get("type") or "")
        if target_type == "background_page" and url.startswith("chrome-extension://"):
            if EXTENSION_TITLE in title or "/src/background/" in url:
                return target
        if url.startswith("chrome-extension://") and (
            EXTENSION_TITLE in title
            or "/src/options/options.html" in url
            or "/src/popup/popup.html" in url
        ):
            return target
    return None


def reload_c3_extension(*, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> str:
    list_url = _devtools_json_url(host, port, "/json/list")
    try:
        targets = _read_json(list_url)
    except urllib.error.URLError as error:
        raise ReloadError(
            "Chrome DevTools is not reachable. Start Chrome with "
            f"`--remote-debugging-port={port}` and keep the C3 extension loaded."
        ) from error

    target = find_c3_target(targets)
    if not target:
        raise ReloadError(
            "Could not find a Hunt Apply extension target in Chrome DevTools. "
            "Open the C3 Options page or popup, then try again."
        )

    websocket_url = target.get("webSocketDebuggerUrl")
    if not websocket_url:
        raise ReloadError("Chrome DevTools target did not include a WebSocket URL.")

    evaluate_runtime_expression(str(websocket_url), "chrome.runtime.reload()")
    return str(target.get("url") or target.get("title") or target.get("id") or "c3")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)

    try:
        target = reload_c3_extension(host=args.host, port=args.port)
    except ReloadError as error:
        print(f"[c3-reload] {error}")
        return 1

    print(f"[c3-reload] Reload requested for {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
