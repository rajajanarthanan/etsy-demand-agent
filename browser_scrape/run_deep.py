"""Enqueue product (then shop) deep-scrape jobs from harvest CSV; run worker."""
from __future__ import annotations

import argparse
import csv
import logging
from pathlib import Path

from .config import OUT_DIR, load_config, write_run_state
from .queue import JobQueue

HARVEST_CSV = OUT_DIR / "harvest_listings.csv"

log = logging.getLogger("etsy_deep")


def _load_harvest(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"Missing harvest CSV: {path}. Run run_harvest first.")
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def enqueue_products(
    rows: list[dict],
    *,
    limit: int = 0,
    countries: list[str] | None = None,
) -> int:
    q = JobQueue()
    # Prefer unique listing_id keeping best (lowest) rank
    best: dict[str, dict] = {}
    for r in rows:
        lid = (r.get("listing_id") or "").strip()
        if not lid:
            continue
        country = (r.get("country") or "").lower()
        if countries and country not in countries:
            continue
        rank = int(r.get("rank") or 9999)
        prev = best.get(lid)
        if not prev or rank < int(prev.get("rank") or 9999):
            best[lid] = r

    # Makeable / kitchen SKUs first so seller+velocity intel lands early if interrupted
    _MAKEABLE_FIRST = {
        "cutting_board",
        "kitchen_utensils",
        "coasters_slices",
        "bowls_trays",
        "shelves_hooks",
        "frames",
    }

    def _prio(r: dict) -> tuple:
        cat = (r.get("category") or "").lower()
        makeable = 0 if cat in _MAKEABLE_FIRST else 1
        return (makeable, r.get("country") or "", int(r.get("rank") or 9999))

    ordered = sorted(best.values(), key=_prio)
    if limit and limit > 0:
        ordered = ordered[:limit]

    n = 0
    for r in ordered:
        lid = r["listing_id"]
        country = (r.get("country") or "us").lower()
        url = (r.get("url") or "").split("?")[0]
        if not url:
            continue
        jid = q.enqueue(
            "product",
            {
                "url": url,
                "listing_id": lid,
                "keyword": r.get("keyword", ""),
                "rank": int(r.get("rank") or 0),
                "signals": r.get("signals", ""),
                "country": country,
                "title": r.get("title", ""),
            },
            country=country,
            dedupe_key=f"product:{lid}:{country}",
        )
        if jid is not None:
            n += 1
    return n


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    ap = argparse.ArgumentParser(description="Deep scrape products + shops from harvest")
    ap.add_argument("--harvest", type=Path, default=HARVEST_CSV)
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max unique products to enqueue (0 = all)",
    )
    ap.add_argument("--countries", default="us,ca")
    ap.add_argument("--enqueue-only", action="store_true")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--max-jobs", type=int, default=0)
    ap.add_argument("--launch-mode", choices=("cdp_chrome", "playwright"), default="cdp_chrome")
    ap.add_argument("--cdp-port", type=int, default=9222)
    ap.add_argument("--sticky", action="store_true", help="Sticky sessid (default: rotating IPs)")
    ap.add_argument("--rotate-each-session", action="store_true", help="Deprecated; rotating is default")
    ap.add_argument(
        "--kinds",
        default="product,shop",
        help="Worker kinds (default product,shop)",
    )
    args = ap.parse_args(argv)

    load_config()
    countries = [c.strip().lower() for c in args.countries.split(",") if c.strip()]
    rows = _load_harvest(args.harvest)
    n = enqueue_products(rows, limit=args.limit, countries=countries)
    write_run_state({
        "deep_enqueued_products": n,
        "harvest_rows": len(rows),
        "limit": args.limit,
        "deep_countries": countries,
    })
    log.info("Enqueued %s product jobs. queue=%s", n, JobQueue().counts())

    if args.enqueue_only:
        return

    from .worker import BrowserWorker

    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    BrowserWorker(
        headed=not args.headless,
        kinds=kinds,
        countries=countries,
        max_jobs=args.max_jobs,
        launch_mode=args.launch_mode,
        cdp_port=args.cdp_port,
        sticky=bool(args.sticky),
    ).run()


if __name__ == "__main__":
    main()
