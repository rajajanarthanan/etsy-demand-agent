"""SQLite job queue with checkpoint/resume."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .config import OUT_DIR

DB_PATH = OUT_DIR / "jobs.sqlite"

STATUSES = ("pending", "running", "done", "failed", "blocked")


@dataclass
class Job:
    id: int
    kind: str  # search | product | shop
    payload: dict[str, Any]
    status: str
    attempts: int
    max_attempts: int
    error: str
    result_path: str
    created_at: float
    updated_at: float
    country: str
    dedupe_key: str


class JobQueue:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = Path(db_path or DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=60)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 3,
                    error TEXT NOT NULL DEFAULT '',
                    result_path TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    country TEXT NOT NULL DEFAULT '',
                    dedupe_key TEXT NOT NULL DEFAULT ''
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)"
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe "
                "ON jobs(kind, dedupe_key) WHERE dedupe_key != ''"
            )

    def enqueue(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        country: str = "",
        dedupe_key: str = "",
        max_attempts: int = 3,
    ) -> int | None:
        """Insert job. Returns id, or None if duplicate dedupe_key."""
        now = time.time()
        with self._conn() as conn:
            try:
                cur = conn.execute(
                    """
                    INSERT INTO jobs
                    (kind, payload, status, attempts, max_attempts, error,
                     result_path, created_at, updated_at, country, dedupe_key)
                    VALUES (?, ?, 'pending', 0, ?, '', '', ?, ?, ?, ?)
                    """,
                    (
                        kind,
                        json.dumps(payload),
                        max_attempts,
                        now,
                        now,
                        country,
                        dedupe_key,
                    ),
                )
                return int(cur.lastrowid)
            except sqlite3.IntegrityError:
                return None

    def claim_next(
        self,
        kinds: list[str] | None = None,
        countries: list[str] | None = None,
    ) -> Job | None:
        """Atomically claim one pending job (or retriable blocked/failed)."""
        with self._conn() as conn:
            filters = ""
            params: list[Any] = []
            if kinds:
                placeholders = ",".join("?" for _ in kinds)
                filters += f" AND kind IN ({placeholders})"
                params.extend(kinds)
            if countries:
                ccs = [c.lower().strip() for c in countries if c.strip()]
                placeholders = ",".join("?" for _ in ccs)
                filters += f" AND lower(country) IN ({placeholders})"
                params.extend(ccs)

            row = conn.execute(
                f"""
                SELECT * FROM jobs
                WHERE (
                    status = 'pending'
                    OR (status IN ('blocked', 'failed')
                        AND attempts < max_attempts)
                )
                {filters}
                ORDER BY
                    CASE kind WHEN 'search' THEN 0 WHEN 'product' THEN 1
                              WHEN 'shop' THEN 2 ELSE 3 END,
                    id ASC
                LIMIT 1
                """,
                params,
            ).fetchone()
            if not row:
                return None
            now = time.time()
            conn.execute(
                """
                UPDATE jobs SET status='running', attempts=attempts+1,
                updated_at=?, error='' WHERE id=?
                """,
                (now, row["id"]),
            )
            return self._row_to_job(conn.execute(
                "SELECT * FROM jobs WHERE id=?", (row["id"],)
            ).fetchone())

    def mark_done(self, job_id: int, result_path: str = "") -> None:
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE jobs SET status='done', result_path=?, updated_at=?, error=''
                WHERE id=?
                """,
                (result_path, time.time(), job_id),
            )

    def mark_failed(self, job_id: int, error: str, *, blocked: bool = False) -> None:
        status = "blocked" if blocked else "failed"
        with self._conn() as conn:
            conn.execute(
                """
                UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?
                """,
                (status, error[:2000], time.time(), job_id),
            )

    def reset_running(self) -> int:
        """On startup, requeue jobs left in running (crash recovery)."""
        with self._conn() as conn:
            cur = conn.execute(
                """
                UPDATE jobs SET status='pending', updated_at=?
                WHERE status='running'
                """,
                (time.time(),),
            )
            return cur.rowcount

    def counts(self) -> dict[str, int]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
            ).fetchall()
            return {r["status"]: r["n"] for r in rows}

    def pending_count(self, kinds: list[str] | None = None) -> int:
        with self._conn() as conn:
            if kinds:
                ph = ",".join("?" for _ in kinds)
                row = conn.execute(
                    f"""
                    SELECT COUNT(*) AS n FROM jobs
                    WHERE (status='pending'
                           OR (status IN ('blocked','failed')
                               AND attempts < max_attempts))
                      AND kind IN ({ph})
                    """,
                    kinds,
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS n FROM jobs
                    WHERE status='pending'
                       OR (status IN ('blocked','failed')
                           AND attempts < max_attempts)
                    """
                ).fetchone()
            return int(row["n"])

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> Job:
        return Job(
            id=row["id"],
            kind=row["kind"],
            payload=json.loads(row["payload"]),
            status=row["status"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            error=row["error"] or "",
            result_path=row["result_path"] or "",
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            country=row["country"] or "",
            dedupe_key=row["dedupe_key"] or "",
        )
