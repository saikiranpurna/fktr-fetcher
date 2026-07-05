"""Environment-driven configuration, read once at import."""

from __future__ import annotations

import os

try:
    # Load backend/.env on local runs; a no-op in Docker (env comes from docker-compose).
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

_DEFAULT_FKUA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop"
)
_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


class Config:
    timezone: str = os.environ.get("APP_TIMEZONE", "Asia/Kolkata")
    # Where dropped account cookies are persisted (gitignored; mount a volume in Docker).
    session_store_path: str = os.environ.get("SESSION_STORE_PATH", ".flipkart-session.json")
    # When set, /api/accounts mutations require the header x-admin-token.
    admin_token: str = os.environ.get("ADMIN_TOKEN", "")
    # Paginate My Orders (7/page, most recent first). Stops early when Flipkart reports no more
    # orders; this is a safety cap (100 pages ~= 700 orders). Raise it if you have more history.
    max_pages: int = max(1, _int("FLIPKART_MAX_PAGES", 100))
    # Fetch each order's detail page (address + live OTP) for at most this many recent orders.
    max_details: int = max(0, _int("FLIPKART_MAX_DETAILS", 40))
    # Per-request timeout, seconds (env is milliseconds to match the frontend convention).
    timeout: float = _int("FLIPKART_TIMEOUT_MS", 20000) / 1000.0
    # Flipkart requires its custom x-user-agent (FKUA) header on the internal APIs.
    fkua: str = os.environ.get("FLIPKART_FKUA", _DEFAULT_FKUA)
    user_agent: str = os.environ.get("FLIPKART_USER_AGENT", _DEFAULT_UA)
    orders_base: str = os.environ.get("FLIPKART_ORDERS_BASE", "https://www.flipkart.com/api/5/self-serve/orders/")
    detail_url: str = os.environ.get("FLIPKART_DETAIL_URL", "https://www.flipkart.com/api/4/page/fetch?")
    filter_type: str = os.environ.get("FLIPKART_FILTER_TYPE", "PREORDER_UNITS")
    # curl_cffi TLS-impersonation profile used by Scrapling's Fetcher.
    impersonate: str = os.environ.get("FLIPKART_IMPERSONATE", "chrome")


config = Config()
