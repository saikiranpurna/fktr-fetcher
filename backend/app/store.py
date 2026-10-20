"""Account store: cookie normalization + CRUD, persisted via the pluggable storage backend.

Account record shape (unchanged, so existing file data carries over):
  { "id", "label", "items": [ {name, value, domain?, path?, ...} ], "updatedAt" }
Persistence is delegated to ``storage.get_backend()`` — a single JSON file for local dev,
MinIO (S3) in Docker. This module owns only cookie parsing, slugging, and the public CRUD API.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone

from . import storage
from .errors import config_error

# Serializes every read-modify-write mutation. API handlers run on a threadpool, so two requests
# (two files dropped together, or parallel bulk-remove chunks) could otherwise interleave: the
# file backend would lose one of the writes, and the cookie-dedup check-then-save could admit a
# duplicate. The backend is one process (a single uvicorn worker), so a process-level lock covers it.
_lock = threading.Lock()


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


def _cookie_sig(items: list[dict]) -> tuple:
    """Canonical identity of an account's cookies (its name=value set), so the same session added
    twice under different labels is recognized as one account and deduped."""
    return tuple(sorted(to_cookie_dict(items).items()))


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-")
    return s or "account"


def _meta(accounts: list[dict]) -> list[dict]:
    return [
        {
            "id": a["id"],
            "label": a["label"],
            "updatedAt": a.get("updatedAt"),
            "count": len(a.get("items", [])),
            "active": a.get("active", True),
        }
        for a in accounts
    ]


def _unique_id(base: str, taken: set[str]) -> str:
    candidate = base
    n = 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def _record(label: str, cookie_input: str) -> dict:
    items = normalize_cookie_input(cookie_input)
    label = (label or "").strip() or "account"
    return {"id": _slug(label), "label": label, "items": items, "updatedAt": _now_iso(), "active": True}


def add_account(label: str, cookie_input: str) -> list[dict]:
    """Add/replace a single account. Same label upserts (re-dropping refreshes it); the SAME
    cookies added under a DIFFERENT label are a duplicate — the original is kept and the add is a
    no-op, so a mistaken re-add can't create a second copy of one account."""
    backend = storage.get_backend()
    rec = _record(label, cookie_input)
    sig = _cookie_sig(rec["items"])
    with _lock:
        existing = backend.load_all()
        if any(a.get("id") != rec["id"] and _cookie_sig(a.get("items", [])) == sig for a in existing):
            return _meta(existing)
        backend.save_many([rec])
        return _meta(backend.load_all())


# ── Bulk import ──────────────────────────────────────────────────────────────


def _entry_cookie_str(cookie) -> str:
    return cookie if isinstance(cookie, str) else json.dumps(cookie)


def _entries_from_list(items: list, default_label: str) -> list[dict]:
    out: list[dict] = []
    for i, e in enumerate(items):
        if not isinstance(e, dict) or "cookie" not in e:
            raise config_error("Each account entry needs a 'cookie' field.")
        label = str(e.get("label") or "").strip()
        if not label:
            label = f"{default_label}-{i + 1}" if len(items) > 1 else default_label
        out.append({"label": label, "cookie": _entry_cookie_str(e["cookie"])})
    return out


def parse_import(content: str, default_label: str) -> list[dict]:
    """Split an uploaded .json/.txt blob into ``[{label, cookie}]`` entries.

    Multi-account documents (recognized deterministically):
      • ``{"accounts": [ {label, cookie}, ... ]}``
      • ``[ {label, cookie}, ... ]``  — array whose elements carry a ``cookie`` key
        (distinct from a Cookie-Editor export, whose elements carry name/value only).
      • ``{ "<label>": <cookieData>, ... }`` — object map whose values are all non-strings
        (distinct from a ``{name: value}`` single-account map, whose values are all strings).
    Anything else is treated as ONE account (Cookie-Editor array, {name:value} map, or a raw
    ``k=v; k2=v2`` header — the forms ``normalize_cookie_input`` already understands).
    """
    s = (content or "").strip()
    if not s:
        raise config_error("File is empty.")
    default_label = (default_label or "").strip() or "account"

    data = None
    if s[0] in "[{":
        try:
            data = json.loads(s)
        except json.JSONDecodeError:
            data = None

    if isinstance(data, dict) and isinstance(data.get("accounts"), list):
        return _entries_from_list(data["accounts"], default_label)

    if isinstance(data, list) and data and all(isinstance(e, dict) and "cookie" in e for e in data):
        return _entries_from_list(data, default_label)

    if isinstance(data, dict) and data and all(not isinstance(v, str) for v in data.values()):
        return [
            {"label": str(k).strip() or default_label, "cookie": _entry_cookie_str(v)}
            for k, v in data.items()
        ]

    return [{"label": default_label, "cookie": s}]


def import_accounts(default_label: str, content: str) -> tuple[int, list[dict]]:
    """Parse a blob into one or many accounts, persist them, and return (imported, metadata).

    Same-label entries across separate imports upsert (re-dropping a file updates it); genuine
    duplicate labels *within one blob* are suffixed (-2, -3, …) on both id and label so none is
    silently overwritten and each stays distinguishable by label. The suffix depends only on the
    blob, so re-dropping the same file updates "x-2" in place instead of minting "x-3".
    Accounts whose cookies are identical to one already stored under a different label, or to an
    earlier entry in the same blob, are duplicates and are skipped — only the first copy is kept.
    """
    entries = parse_import(content, default_label)
    # Normalize every cookie before taking the lock: a bad entry fails the whole import up front.
    candidates = [_record(entry["label"], entry["cookie"]) for entry in entries]
    backend = storage.get_backend()
    with _lock:
        existing = backend.load_all()
        sigs: dict[tuple, str] = {_cookie_sig(a.get("items", [])): a["id"] for a in existing}
        records: list[dict] = []
        batch_ids: set[str] = set()
        batch_sigs: set[tuple] = set()
        for rec in candidates:
            sig = _cookie_sig(rec["items"])
            if sig in batch_sigs:
                continue  # the same cookies appeared earlier in this blob — keep the first copy
            if rec["id"] in batch_ids:
                base = rec["id"]
                rec["id"] = _unique_id(base, batch_ids)
                # Same suffix on the label (X -> X-2): the account filter and the CSV "Account"
                # column key on the label, so two rows both labelled "X" would be indistinguishable.
                rec["label"] += rec["id"][len(base):]
            dup_id = sigs.get(sig)
            if dup_id is not None and dup_id != rec["id"]:
                continue  # same cookies already held under another account — skip the duplicate
            batch_ids.add(rec["id"])
            batch_sigs.add(sig)
            sigs[sig] = rec["id"]
            records.append(rec)
        backend.save_many(records)
        return len(records), _meta(backend.load_all())


def remove_account(account_id: str) -> list[dict]:
    backend = storage.get_backend()
    with _lock:
        backend.delete(account_id)
        return _meta(backend.load_all())


def remove_accounts(ids: list[str]) -> list[dict]:
    """Remove several accounts with one backend delete and one reload. Removing them one request
    at a time rescanned all of storage per id (a GET per object on MinIO), so a bulk remove was
    quadratic in the account count."""
    backend = storage.get_backend()
    with _lock:
        if ids:
            backend.delete_many(ids)
        return _meta(backend.load_all())


def set_active(account_ids: list[str], active: bool) -> list[dict]:
    """Activate/deactivate accounts by id. Inactive accounts keep their cookies but are excluded
    from get_active_accounts(), so the poller drops them from its roster until reactivated."""
    backend = storage.get_backend()
    ids = set(account_ids)
    with _lock:
        changed = []
        for a in backend.load_all():
            if a.get("id") in ids and a.get("active", True) != active:
                a["active"] = active
                changed.append(a)
        if changed:
            backend.save_many(changed)
        return _meta(backend.load_all())


def clear_all() -> list[dict]:
    with _lock:
        storage.get_backend().clear()
    return []


def list_accounts() -> list[dict]:
    return _meta(storage.get_backend().load_all())


def has_accounts() -> bool:
    """Cheap existence check (avoids loading every account) for the empty-state fallback."""
    return storage.get_backend().has_any()


def get_active_accounts() -> list[dict]:
    """Resolved accounts ready to fetch with: {id, label, cookies: {name: value}}."""
    out = []
    for a in storage.get_backend().load_all():
        cookies = to_cookie_dict(a.get("items", []))
        if cookies and a.get("active", True):
            out.append({"id": a["id"], "label": a["label"], "cookies": cookies})
    return out
