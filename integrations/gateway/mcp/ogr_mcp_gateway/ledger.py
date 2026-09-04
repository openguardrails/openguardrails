"""Durable counters and small state for the gateway (sqlite, stdlib)."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path


class SqliteLedger:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS counts (workspace TEXT, limit_id TEXT, bucket TEXT, n INTEGER,
                                               PRIMARY KEY (workspace, limit_id, bucket));
            CREATE TABLE IF NOT EXISTS kv (workspace TEXT, key TEXT, value REAL, PRIMARY KEY (workspace, key));
            """)

    def _conn(self):
        return sqlite3.connect(self.path, isolation_level=None)

    def bump(self, workspace: str, limit_id: str, bucket: str) -> int:
        with self._lock, self._conn() as c:
            c.execute("INSERT INTO counts VALUES (?,?,?,1) ON CONFLICT(workspace, limit_id, bucket) DO UPDATE SET n = n + 1",
                      (workspace, limit_id, bucket))
            return int(c.execute("SELECT n FROM counts WHERE workspace=? AND limit_id=? AND bucket=?",
                                 (workspace, limit_id, bucket)).fetchone()[0])

    def get(self, workspace: str, key: str, default: float = 0.0) -> float:
        with self._lock, self._conn() as c:
            row = c.execute("SELECT value FROM kv WHERE workspace=? AND key=?", (workspace, key)).fetchone()
        return float(row[0]) if row else default

    def put(self, workspace: str, key: str, value: float) -> None:
        with self._lock, self._conn() as c:
            c.execute("INSERT INTO kv VALUES (?,?,?) ON CONFLICT(workspace, key) DO UPDATE SET value=excluded.value",
                      (workspace, key, value))


class MemoryLedger:
    """For tests and for `--stdio` runs that do not want a file."""
    def __init__(self):
        self.counts: dict[tuple, int] = {}
        self.kv: dict[tuple, float] = {}

    def bump(self, workspace, limit_id, bucket):
        k = (workspace, limit_id, bucket); self.counts[k] = self.counts.get(k, 0) + 1; return self.counts[k]

    def get(self, workspace, key, default=0.0):
        return self.kv.get((workspace, key), default)

    def put(self, workspace, key, value):
        self.kv[(workspace, key)] = value
