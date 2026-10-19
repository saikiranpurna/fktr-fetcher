"""Storage backends: FileBackend round-trips on disk; MinioBackend against an in-memory S3 fake."""

from __future__ import annotations

import io

import pytest

from app import storage
from app.config import config
from app.errors import AppError


def _rec(rid, label="L", items=None):
    return {"id": rid, "label": label, "items": items or [{"name": "SN", "value": "1"}], "updatedAt": "t"}


# ── FileBackend ──────────────────────────────────────────────────────────────


def test_file_backend_roundtrip_upsert_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "session_store_path", str(tmp_path / "s.json"))
    be = storage.FileBackend()
    be.save_many([_rec("a", "A"), _rec("b", "B")])
    assert sorted(x["id"] for x in be.load_all()) == ["a", "b"]

    be.save_many([_rec("a", "A2", items=[])])  # upsert existing id
    by_id = {x["id"]: x for x in be.load_all()}
    assert by_id["a"]["label"] == "A2" and len(by_id) == 2

    be.delete("a")
    assert [x["id"] for x in be.load_all()] == ["b"]

    be.delete("b")  # last one removed -> store cleared
    assert be.load_all() == []


def test_file_backend_delete_many_is_one_write(tmp_path, monkeypatch):
    path = tmp_path / "s.json"
    monkeypatch.setattr(config, "session_store_path", str(path))
    be = storage.FileBackend()
    be.save_many([_rec("a"), _rec("b"), _rec("c")])
    writes = []
    real_write = be._write_doc
    monkeypatch.setattr(be, "_write_doc", lambda doc: (writes.append(doc), real_write(doc)))

    be.delete_many(["a", "c", "missing"])
    assert [x["id"] for x in be.load_all()] == ["b"] and len(writes) == 1

    be.delete_many([])  # nothing asked -> nothing written
    assert len(writes) == 1

    be.delete_many(["b"])  # nothing remains -> the store is cleared, like delete()
    assert be.load_all() == [] and not path.exists()


# ── MinioBackend (fake S3) ────────────────────────────────────────────────────


class FakeS3:
    """Minimal in-memory S3 covering only the calls MinioBackend makes."""

    def __init__(self):
        self.objs: dict[tuple[str, str], bytes] = {}
        self.delete_batches: list[dict] = []  # each delete_objects "Delete" payload
        self.fail_keys: set[str] = set()      # keys whose delete reports a per-key error

    def head_bucket(self, Bucket):
        return {}

    def create_bucket(self, Bucket):
        return {}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.objs[(Bucket, Key)] = Body

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.objs[(Bucket, Key)])}

    def delete_object(self, Bucket, Key):
        self.objs.pop((Bucket, Key), None)

    def list_objects_v2(self, Bucket, Prefix="", ContinuationToken=None, MaxKeys=None):
        keys = [k for (b, k) in self.objs if b == Bucket and k.startswith(Prefix)]
        if MaxKeys is not None:
            keys = keys[:MaxKeys]
        return {"Contents": [{"Key": k} for k in keys], "IsTruncated": False}

    def delete_objects(self, Bucket, Delete):
        # Real S3 reports per-key failures in the response body; it does not raise.
        self.delete_batches.append(Delete)
        errors = []
        for o in Delete["Objects"]:
            if o["Key"] in self.fail_keys:
                errors.append({"Key": o["Key"], "Code": "AccessDenied", "Message": "Access Denied."})
            else:
                self.objs.pop((Bucket, o["Key"]), None)
        return {"Errors": errors} if errors else {}


def test_minio_backend_crud_and_upsert():
    be = storage.MinioBackend(client=FakeS3())
    be.save_many([_rec("mom", "mom"), _rec("dad", "dad")])
    assert sorted(a["id"] for a in be.load_all()) == ["dad", "mom"]

    be.save_many([_rec("dad", "dad2")])  # same key overwrites
    assert {a["id"]: a["label"] for a in be.load_all()}["dad"] == "dad2"

    be.delete("mom")
    assert [a["id"] for a in be.load_all()] == ["dad"]

    be.clear()
    assert be.load_all() == []


def test_minio_delete_many_is_quiet_and_chunked_at_1000():
    fake = FakeS3()
    be = storage.MinioBackend(client=fake)
    be.save_many([_rec(f"a{i}") for i in range(2001)] + [_rec("keep")])

    be.delete_many([f"a{i}" for i in range(2001)] + ["a0"])  # a repeated id is sent once
    assert [len(b["Objects"]) for b in fake.delete_batches] == [1000, 1000, 1]
    assert all(b["Quiet"] is True for b in fake.delete_batches)
    assert [a["id"] for a in be.load_all()] == ["keep"]


def test_minio_delete_many_raises_on_per_key_errors():
    fake = FakeS3()
    be = storage.MinioBackend(client=fake)
    be.save_many([_rec("a"), _rec("b")])
    fake.fail_keys = {f"{config.minio_prefix}b.json"}
    with pytest.raises(AppError, match="could not delete 1 account object"):
        be.delete_many(["a", "b"])
    assert [a["id"] for a in be.load_all()] == ["b"]  # what failed is still there, and was reported


def test_minio_backend_object_key_layout():
    fake = FakeS3()
    be = storage.MinioBackend(client=fake)
    be.save_many([_rec("acct-1")])
    assert (config.minio_bucket, f"{config.minio_prefix}acct-1.json") in fake.objs


def test_minio_has_any():
    be = storage.MinioBackend(client=FakeS3())
    assert be.has_any() is False
    be.save_many([_rec("a")])
    assert be.has_any() is True


def test_file_has_any(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "session_store_path", str(tmp_path / "s.json"))
    be = storage.FileBackend()
    assert be.has_any() is False
    be.save_many([_rec("a")])
    assert be.has_any() is True
