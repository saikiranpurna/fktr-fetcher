"""Typed application errors mapped to HTTP status codes (mirrors the old TS contract)."""

from __future__ import annotations

# ErrorCode -> HTTP status. Kept identical to the frontend's expectations.
CODE_STATUS: dict[str, int] = {
    "AUTH_EXPIRED": 401,   # cookie invalid/expired
    "UPSTREAM_ERROR": 502,  # network/timeout/5xx/other 4xx
    "PARSE_ERROR": 502,     # response shape unexpected
    "CONFIG_ERROR": 400,    # missing account or endpoint
    "UNKNOWN": 500,
}


class AppError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def status(self) -> int:
        return CODE_STATUS.get(self.code, 500)


def auth_expired() -> AppError:
    return AppError("AUTH_EXPIRED", "Flipkart session expired or invalid. Update the cookie in the Accounts panel.")


def config_error(message: str) -> AppError:
    return AppError("CONFIG_ERROR", message)


def upstream(message: str) -> AppError:
    return AppError("UPSTREAM_ERROR", message)


def parse_error(message: str) -> AppError:
    return AppError("PARSE_ERROR", message)


def to_error_response(err: Exception) -> tuple[dict, int]:
    """(body, status) shaped as the frontend's ErrorResponse."""
    if isinstance(err, AppError):
        return {"ok": False, "error": {"code": err.code, "message": err.message}}, err.status
    return {"ok": False, "error": {"code": "UNKNOWN", "message": "Unexpected server error."}}, 500
