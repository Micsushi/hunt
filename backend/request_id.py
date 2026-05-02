"""Request ID: per-request UUID propagated via X-Request-ID header.

Set by RequestIDMiddleware on every inbound request. Gateway proxy calls
read it via the context var and forward it to downstream services.
"""

from shared.request_id import ServiceRequestIDMiddleware as RequestIDMiddleware
from shared.request_id import get_request_id, request_id_var

__all__ = ["RequestIDMiddleware", "get_request_id", "request_id_var"]
