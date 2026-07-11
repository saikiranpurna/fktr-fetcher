"""Cookie parsing + bulk-import behavior (the single-vs-multi-account detection is load-bearing)."""

from __future__ import annotations

import pytest

from app import store
from app.errors import AppError


# ── parse_import: single-account shapes stay one account ─────────────────────


def test_cookie_editor_array_is_one_account():
    # An array whose elements carry name/value (NOT a "cookie" key) is a single export.
    assert len(store.parse_import('[{"name":"SN","value":"x"},{"name":"T","value":"y"}]', "acct")) == 1


def test_name_value_map_is_one_account():
    # All-string values => single-account {name: value} map.
    assert len(store.parse_import('{"SN":"1","T":"2"}', "acct")) == 1


def test_raw_header_is_one_account():
    entries = store.parse_import("SN=1; T=2", "acct")
    assert len(entries) == 1 and entries[0]["label"] == "acct"


def test_plain_text_file_is_one_account():
    # A .txt holding a raw cookie header is not JSON -> single account.
    assert len(store.parse_import("SN=abc; T=def", "from-file")) == 1


# ── parse_import: multi-account shapes expand ────────────────────────────────


def test_label_cookie_array_expands():
    entries = store.parse_import('[{"label":"mom","cookie":"SN=1"},{"label":"dad","cookie":"SN=2"}]', "file")
    assert [e["label"] for e in entries] == ["mom", "dad"]


def test_label_map_expands():
    # Non-string values => multi-account {label: cookieData} map.
    entries = store.parse_import('{"alice":[{"name":"SN","value":"a"}],"bob":{"SN":"b"}}', "file")
    assert sorted(e["label"] for e in entries) == ["alice", "bob"]


def test_accounts_wrapper_expands():
    entries = store.parse_import('{"accounts":[{"label":"w1","cookie":"SN=1"},{"label":"w2","cookie":"SN=2"}]}', "f")
    assert [e["label"] for e in entries] == ["w1", "w2"]


def test_unlabeled_multi_entries_get_indexed_labels():
    entries = store.parse_import('[{"cookie":"SN=1"},{"cookie":"SN=2"}]', "batch")
    assert [e["label"] for e in entries] == ["batch-1", "batch-2"]


def test_empty_content_raises():
    with pytest.raises(AppError):
        store.parse_import("   ", "acct")


def test_multi_entry_without_cookie_raises():
    with pytest.raises(AppError):
        store.parse_import('{"accounts":[{"label":"x"}]}', "f")


# ── import_accounts: end-to-end over the file backend ────────────────────────


def test_import_single(file_store):
    n, meta = store.import_accounts("acct", '[{"name":"SN","value":"x"}]')
    assert n == 1
    assert meta[0]["label"] == "acct" and meta[0]["count"] == 1


def test_import_multi_creates_distinct_accounts(file_store):
    n, meta = store.import_accounts("file", '[{"label":"mom","cookie":"SN=1"},{"label":"dad","cookie":"SN=2"}]')
    assert n == 2 and sorted(m["id"] for m in meta) == ["dad", "mom"]


def test_duplicate_labels_within_one_blob_are_suffixed(file_store):
    n, meta = store.import_accounts("file", '[{"label":"dup","cookie":"SN=1"},{"label":"dup","cookie":"SN=2"}]')
    assert n == 2 and sorted(m["id"] for m in meta) == ["dup", "dup-2"]


def test_reimport_same_label_upserts_not_duplicates(file_store):
    store.import_accounts("acct", "SN=1")
    store.import_accounts("acct", "SN=2")
    accounts = store.list_accounts()
    assert len(accounts) == 1
    assert store.get_active_accounts()[0]["cookies"] == {"SN": "2"}


def test_get_active_accounts_resolves_cookies(file_store):
    store.import_accounts("acct", "SN=abc; T=def")
    active = store.get_active_accounts()
    assert active[0]["cookies"] == {"SN": "abc", "T": "def"}


def test_remove_and_clear(file_store):
    store.import_accounts("a", "SN=1")
    store.import_accounts("b", "SN=2")
    assert len(store.list_accounts()) == 2
    store.remove_account("a")
    assert [m["id"] for m in store.list_accounts()] == ["b"]
    store.clear_all()
    assert store.list_accounts() == []


def test_has_accounts(file_store):
    assert store.has_accounts() is False
    store.import_accounts("acct", "SN=1")
    assert store.has_accounts() is True
