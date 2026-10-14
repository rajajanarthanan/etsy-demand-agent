#!/usr/bin/env python3
"""Smoke: 1 CA search using signed Chrome profile + DataImpulse __cr.ca."""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

from .config import build_search_url, load_config, write_run_state
from .queue import JobQueue
from .worker import BrowserWorker

log = logging.getLogger("etsy_smoke_signed")

DEFAULT_USER_DATA = Path.home() / ".config" / "google-chrome"


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--chrome-user-data-dir",
        default=str(DEFAULT_USER_DATA),
    )
    ap.add_argument(
        "--chrome-profile-directory",
        default="Profile 9",
        help="Your signed-in profile (Local State last_used was Profile 9)",
    )
    ap.add_argument("--cdp-port", type=int, default=9334)
    ap.add_argument("--keyword", default="teak")
    args = ap.parse_args()

    import sqlite3

    load_config()
    q = JobQueue()

    # Fresh one-off CA search job (dedupe key unique per smoke)
    url = build_search_url(args.keyword, 1, ship_to="ca")
    dedupe = f"smoke_signed_ca:{args.keyword}:{int(time.time())}"
    jid = q.enqueue(
        "search",
        {
            "keyword": args.keyword,
            "country": "ca",
            "page": 1,
            "url": url,
        },
        country="ca",
        dedupe_key=dedupe,
    )
    log.info("enqueued smoke CA search id=%s", jid)

    # Pause every other search job. Use attempts>=max so claim_next won't pick them
    # (blocked+attempts<max are still claimable).
    conn = sqlite3.connect(q.db_path)
    conn.execute(
        "UPDATE jobs SET status='blocked', error='paused_for_signed_smoke', "
        "attempts=max_attempts WHERE kind='search' AND id != ?",
        (jid,),
    )
    conn.execute(
        "UPDATE jobs SET status='pending', attempts=0, error='' WHERE id=?",
        (jid,),
    )
    conn.commit()
    conn.close()
    write_run_state({
        "smoke_signed_ca": True,
        "profile": args.chrome_profile_directory,
        "user_data_dir": args.chrome_user_data_dir,
    })

    try:
        BrowserWorker(
            headed=True,
            kinds=["search"],
            max_jobs=1,
            launch_mode="cdp_chrome",
            cdp_port=args.cdp_port,
            sticky=False,
            chrome_user_data_dir=args.chrome_user_data_dir,
            chrome_profile_directory=args.chrome_profile_directory,
        ).run()
    finally:
        # Restore paused CA harvest jobs
        conn = sqlite3.connect(q.db_path)
        n = conn.execute(
            "UPDATE jobs SET status='pending', error='', attempts=0 "
            "WHERE error='paused_for_signed_smoke'"
        ).rowcount
        conn.commit()
        conn.close()
        log.info("restored %s paused search jobs", n)


if __name__ == "__main__":
    main()
