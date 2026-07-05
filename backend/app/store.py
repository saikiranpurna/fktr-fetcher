"""Account store: cookie normalization + CRUD over the shared .flipkart-session.json.

Format (compatible with the previous TS store so existing data carries over):
  { "accounts": [ { "id", "label", "items": [ {name, value, domain?, path?, ...} ], "updatedAt" } ], "updatedAt" }
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone

from .config import config
from .errors import config_error


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_cookie_input(text: str) -> list[dict]:
    """Accept a Cookie-Editor JSON array, an object map {name: value}, or a raw 'k=v; k2=v2' header."""
    s = (text or "").strip()
    if not s:
        raise config_error("Cookie is empty.")

    if s[0] == "[":
        try:
            arr = json.loads(s)
        except json.JSONDecodeError as e:
            raise config_error(f"Cookie JSON is invalid: {e}") from e
        if not isinstance(arr, list):
            raise config_error("Cookie JSON array is invalid.")
        items: list[dict] = []
        for raw in arr:
            if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or not isinstance(raw.get("value"), str):
                raise config_error("Each cookie needs string 'name' and 'value' fields.")
            items.append(raw)
        return items

    if s[0] == "{":
        try:
            obj = json.loads(s)
        except json.JSONDecodeError as e:
            raise config_error(f"Cookie JSON is invalid: {e}") from e
        if not isinstance(obj, dict):
            raise config_error("Cookie JSON object is invalid.")
        return [{"name": k, "value": str(v)} for k, v in obj.items() if k]

    # Raw "name=value; name2=value2" header.
    items = []
    for part in re.split(r";\s*", s):
        if not part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        if name:
            items.append({"name": name, "value": value.strip()})
    if not items:
        raise config_error("Cookie header is invalid.")
    return items


def to_cookie_dict(items: list[dict]) -> dict[str, str]:
    return {i["name"]: str(i.get("value", "")) for i in items if i.get("name")}


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-")
    return s or "account"


def _read() -> dict | None:
    path = config.session_store_path
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("accounts"), list):
            return data
    except (OSError, json.JSONDecodeError):
        return None
    return None


def _write(persisted: dict) -> None:
    path = config.session_store_path
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(persisted, f)
    os.replace(tmp, path)


def _meta(accounts: list[dict]) -> list[dict]:
    return [
        {"id": a["id"], "label": a["label"], "updatedAt": a.get("updatedAt"), "count": len(a.get("items", []))}
        for a in accounts
    ]


def add_account(label: str, cookie_input: str) -> list[dict]:
    items = normalize_cookie_input(cookie_input)
    label = (label or "").strip() or "account"
    account = {"id": _slug(label), "label": label, "items": items, "updatedAt": _now_iso()}
    data = _read() or {"accounts": [], "updatedAt": _now_iso()}
    data["accounts"] = [a for a in data["accounts"] if a.get("id") != account["id"]] + [account]
    data["updatedAt"] = _now_iso()
    _write(data)
    return _meta(data["accounts"])


def remove_account(account_id: str) -> list[dict]:
    data = _read()
    if not data:
        return []
    data["accounts"] = [a for a in data["accounts"] if a.get("id") != account_id]
    data["updatedAt"] = _now_iso()
    if data["accounts"]:
        _write(data)
    else:
        clear_all()
        return []
    return _meta(data["accounts"])


def clear_all() -> list[dict]:
    path = config.session_store_path
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass
    return []


def list_accounts() -> list[dict]:
    data = _read()
    return _meta(data["accounts"]) if data else []


def get_active_accounts() -> list[dict]:
    """Resolved accounts ready to fetch with: {id, label, cookies: {name: value}}."""
    data = _read()
    if not data:
        return []
    out = []
    for a in data["accounts"]:
        cookies = to_cookie_dict(a.get("items", []))
        if cookies:
            out.append({"id": a["id"], "label": a["label"], "cookies": cookies})
    return out
