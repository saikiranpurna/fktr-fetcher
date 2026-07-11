"""Pluggable persistence for account cookie records.

An "account record" is a dict: ``{"id", "label", "items": [{name, value, ...}], "updatedAt"}``.

Backends:
  - ``FileBackend``  — one JSON doc ``{"accounts": [...], "updatedAt"}`` at
                       ``config.session_store_path`` (the legacy on-disk format, so existing
                       local data carries over). Default for local dev.
  - ``MinioBackend`` — one S3 object per account at ``"<prefix><id>.json"`` in a MinIO/S3
                       bucket. Cookies (secrets) live only in the bucket; credentials come
                       from the environment.

Selection (``config.storage_backend``): ``"minio" | "file" | "auto"`` (default ``auto``).
``auto`` resolves to ``minio`` when ``config.minio_endpoint`` is set, else ``file``.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Protocol

from .config import config
from .errors import config_error


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StorageBackend(Protocol):
    """Persistence for account records, keyed by ``record["id"]``."""

    def load_all(self) -> list[dict]: ...
    def save_many(self, accounts: list[dict]) -> None: ...
    def delete(self, account_id: str) -> None: ...
    def clear(self) -> None: ...
    def has_any(self) -> bool: ...


class FileBackend:
    """Single JSON doc at ``config.session_store_path`` (read lazily each op)."""

    @property
    def _path(self) -> str:
        return config.session_store_path

    def _read_doc(self) -> dict:
        path = self._path
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("accounts"), list):
                    return data
            except (OSError, json.JSONDecodeError):
                pass
        return {"accounts": [], "updatedAt": _now_iso()}

    def _write_doc(self, doc: dict) -> None:
        path = self._path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        os.replace(tmp, path)

    def load_all(self) -> list[dict]:
        return list(self._read_doc().get("accounts", []))

    def save_many(self, accounts: list[dict]) -> None:
        if not accounts:
            return
        doc = self._read_doc()
        by_id: dict[str, dict] = {a["id"]: a for a in doc.get("accounts", []) if a.get("id")}
        for acct in accounts:
            by_id[acct["id"]] = acct
        doc["accounts"] = list(by_id.values())
        doc["updatedAt"] = _now_iso()
        self._write_doc(doc)

    def delete(self, account_id: str) -> None:
        doc = self._read_doc()
        remaining = [a for a in doc.get("accounts", []) if a.get("id") != account_id]
        if not remaining:
            self.clear()
            return
        doc["accounts"] = remaining
        doc["updatedAt"] = _now_iso()
        self._write_doc(doc)

    def clear(self) -> None:
        try:
            if os.path.exists(self._path):
                os.remove(self._path)
        except OSError:
            pass

    def has_any(self) -> bool:
        return bool(self._read_doc().get("accounts"))


class MinioBackend:
    """One S3 object per account: ``"<prefix><id>.json"`` in ``config.minio_bucket``.

    ``client`` may be injected (tests); otherwise a boto3 S3 client is built from config
    and the bucket is created on first use if missing.
    """

    def __init__(self, client=None) -> None:
        self._bucket = config.minio_bucket
        self._prefix = config.minio_prefix
        if client is not None:
            self._s3 = client
        else:
            self._s3 = self._build_client()
            self._ensure_bucket()

    def _build_client(self):
        try:
            import boto3
            from botocore.config import Config as BotoConfig
        except ImportError as e:  # pragma: no cover - boto3 ships in requirements
            raise config_error("boto3 is required for the MinIO storage backend.") from e
        if not config.minio_endpoint:
            raise config_error("STORAGE_BACKEND=minio but MINIO_ENDPOINT is not set.")
        return boto3.client(
            "s3",
            endpoint_url=config.minio_endpoint,
            aws_access_key_id=config.minio_access_key or None,
            aws_secret_access_key=config.minio_secret_key or None,
            region_name=config.minio_region,
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def _ensure_bucket(self) -> None:
        from botocore.exceptions import ClientError

        try:
            self._s3.head_bucket(Bucket=self._bucket)
        except ClientError:
            try:
                self._s3.create_bucket(Bucket=self._bucket)
            except ClientError as e:  # pragma: no cover - surfaced as a config error
                raise config_error(f"Could not create MinIO bucket '{self._bucket}': {e}") from e

    def _key(self, account_id: str) -> str:
        return f"{self._prefix}{account_id}.json"

    def _iter_keys(self):
        token = None
        while True:
            kwargs = {"Bucket": self._bucket, "Prefix": self._prefix}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._s3.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []) or []:
                if obj["Key"].endswith(".json"):
                    yield obj["Key"]
            if resp.get("IsTruncated"):
                token = resp.get("NextContinuationToken")
            else:
                break

    def load_all(self) -> list[dict]:
        accounts: list[dict] = []
        for key in self._iter_keys():
            body = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
            try:
                data = json.loads(body)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(data, dict) and data.get("id"):
                accounts.append(data)
        return accounts

    def save_many(self, accounts: list[dict]) -> None:
        for acct in accounts:
            self._s3.put_object(
                Bucket=self._bucket,
                Key=self._key(acct["id"]),
                Body=json.dumps(acct).encode("utf-8"),
                ContentType="application/json",
            )

    def delete(self, account_id: str) -> None:
        self._s3.delete_object(Bucket=self._bucket, Key=self._key(account_id))

    def clear(self) -> None:
        keys = [{"Key": k} for k in self._iter_keys()]
        for i in range(0, len(keys), 1000):  # S3 delete_objects caps at 1000 keys per call
            self._s3.delete_objects(Bucket=self._bucket, Delete={"Objects": keys[i : i + 1000]})

    def has_any(self) -> bool:
        resp = self._s3.list_objects_v2(Bucket=self._bucket, Prefix=self._prefix, MaxKeys=1)
        return bool(resp.get("Contents"))


_backend: StorageBackend | None = None


def _make_backend() -> StorageBackend:
    choice = config.storage_backend or "auto"
    if choice == "auto":
        choice = "minio" if config.minio_endpoint else "file"
    if choice == "minio":
        return MinioBackend()
    if choice == "file":
        return FileBackend()
    raise config_error(f"Unknown STORAGE_BACKEND '{config.storage_backend}' (use minio | file | auto).")


def get_backend() -> StorageBackend:
    global _backend
    if _backend is None:
        _backend = _make_backend()
    return _backend


def reset_backend() -> None:
    """Drop the cached backend so later config changes take effect (used by tests)."""
    global _backend
    _backend = None
