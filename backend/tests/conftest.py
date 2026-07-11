"""Test fixtures: point the store at an isolated file backend under a tmp path."""

from __future__ import annotations

import os
import sys

import pytest

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from app import storage  # noqa: E402
from app.config import config  # noqa: E402


@pytest.fixture
def file_store(tmp_path, monkeypatch):
    """Force the file backend at a throwaway path and reset the cached backend around each test."""
    monkeypatch.setattr(config, "storage_backend", "file")
    monkeypatch.setattr(config, "session_store_path", str(tmp_path / "sess.json"))
    storage.reset_backend()
    yield
    storage.reset_backend()
