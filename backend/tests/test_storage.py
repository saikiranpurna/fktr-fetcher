"""Storage backends: FileBackend round-trips on disk; MinioBackend against an in-memory S3 fake."""

from __future__ import annotations

import io

from app import storage
from app.config import config


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


# ── MinioBackend (fake S3) ────────────────────────────────────────────────────


class FakeS3:
    """Minimal in-memory S3 covering only the calls MinioBackend makes."""

    def __init__(self):
        self.objs: dict[tuple[str, str], bytes] = {}

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
        for o in Delete["Objects"]:
            self.objs.pop((Bucket, o["Key"]), None)


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
