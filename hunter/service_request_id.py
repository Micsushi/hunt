"""Shared request ID context and logging for C1, C2, and C4 service APIs."""

from __future__ import annotations

import contextvars
import logging
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")

_LOGGER = logging.getLogger("hunt.request_id")
_SERVER_LOGGER = logging.getLogger("uvicorn.error")


class ServiceRequestIDMiddleware(BaseHTTPMiddleware):
    """Attach X-Request-ID to service requests and log one correlatable line."""

    def __init__(self, app, *, service_name: str):
        super().__init__(app)
        self.service_name = service_name

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)

        response.headers["X-Request-ID"] = request_id
        message = "%s request_id=%s method=%s path=%s status=%s"
        args = (
            self.service_name,
            request_id,
            request.method,
            request.url.path,
            response.status_code,
        )
        _LOGGER.info(message, *args)
        _SERVER_LOGGER.info(message, *args)
        return response


def get_request_id() -> str:
    return request_id_var.get("")
