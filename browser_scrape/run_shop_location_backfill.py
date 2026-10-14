"""Re-queue shop jobs for profiles missing location (seller pages only).

Usage:
  .venv/bin/python -m browser_scrape.run_shop_location_backfill
  .venv/bin/python -m browser_scrape.run_shop_location_backfill --run --max-jobs 10
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from urllib.parse import urlparse

from .config import OUT_DIR, load_config, write_run_state
from .queue import JobQueue
from .worker import BrowserWorker

SHOP_JSONL = OUT_DIR / "shop_profiles.jsonl"

log = logging.getLogger("etsy_shop_loc")


def _latest_profiles(path: Path) -> dict[str, dict]:
    """shop_url -> latest profile row."""
    latest: dict[str, dict] = {}
    if not path.exists():
        return latest
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            url = (o.get("shop_url") or "").split("?")[0]
            if url:
                latest[url] = o
    return latest


def shops_missing_location() -> list[dict]:
    out = []
    for url, o in _latest_profiles(SHOP_JSONL).items():
        if (o.get("location") or "").strip():
            continue
        out.append(o)
    return out


def requeue_missing(*, limit: int = 0) -> int:
    missing = shops_missing_location()
    if limit and limit > 0:
        missing = missing[:limit]
    q = JobQueue()
    n = 0
    for o in missing:
        url = (o.get("shop_url") or "").split("?")[0]
        if not url or "/shop/" not in url:
            continue
        country = (o.get("country_context") or "us").lower()
        shop_key = urlparse(url).path.rstrip("/").lower()
        # New dedupe so previously completed shop jobs can run again
        dedupe = f"shop-locfix:{shop_key}"
        jid = q.enqueue(
            "shop",
            {
                "url": url,
                "shop_name": o.get("shop_name") or "",
                "country": country,
            },
            country=country,
            dedupe_key=dedupe,
        )
        if jid is not None:
            n += 1
    return n


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    ap = argparse.ArgumentParser(
        description="Backfill shop location from seller pages (sb-shop-location)"
    )
    ap.add_argument("--limit", type=int, default=0, help="Max shops to enqueue (0=all missing)")
    ap.add_argument("--enqueue-only", action="store_true")
    ap.add_argument("--run", action="store_true", help="Run headed worker after enqueue")
    ap.add_argument("--max-jobs", type=int, default=0)
    ap.add_argument("--launch-mode", choices=("cdp_chrome", "playwright"), default="cdp_chrome")
    ap.add_argument("--cdp-port", type=int, default=9222)
    args = ap.parse_args(argv)

    load_config()
    missing = shops_missing_location()
    log.info(
        "Seller pages: %s profiles missing location (of latest unique shops)",
        len(missing),
    )
    n = requeue_missing(limit=args.limit)
    write_run_state({
        "shop_location_backfill_enqueued": n,
        "shop_location_missing": len(missing),
    })
    log.info("Enqueued %s shop location jobs. queue=%s", n, JobQueue().counts())

    if args.enqueue_only or not args.run:
        log.info("Enqueue done. Pass --run to scrape now (shop jobs only).")
        return

    BrowserWorker(
        headed=True,
        kinds=["shop"],
        max_jobs=args.max_jobs or 0,
        launch_mode=args.launch_mode,
        cdp_port=args.cdp_port,
    ).run()


if __name__ == "__main__":
    main()
