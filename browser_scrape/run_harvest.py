"""Enqueue US/CA bestseller search jobs and run the headed worker."""
from __future__ import annotations

import argparse
import logging
import sys

from .config import (
    DEFAULT_COUNTRIES,
    DEFAULT_PAGES,
    KEYWORDS,
    build_search_url,
    load_config,
    normalize_country,
    write_run_state,
)
from .queue import JobQueue

log = logging.getLogger("etsy_harvest")


def enqueue_searches(
    countries: list[str],
    pages: int,
    keywords: list[str],
) -> int:
    q = JobQueue()
    n = 0
    for country in countries:
        country = normalize_country(country)
        for kw in keywords:
            for page in range(1, pages + 1):
                url = build_search_url(kw, page, ship_to=country)
                dedupe = f"search:{country}:{kw}:p{page}"
                jid = q.enqueue(
                    "search",
                    {
                        "keyword": kw,
                        "country": country,
                        "page": page,
                        "url": url,
                    },
                    country=country,
                    dedupe_key=dedupe,
                )
                if jid is not None:
                    n += 1
                    log.info("enqueued search id=%s %s", jid, dedupe)
                else:
                    log.info("skip duplicate %s", dedupe)
    return n


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    ap = argparse.ArgumentParser(description="Enqueue + run Etsy bestseller harvest")
    ap.add_argument("--countries", default="us,ca")
    ap.add_argument("--pages", type=int, default=DEFAULT_PAGES)
    ap.add_argument("--keywords", default=",".join(KEYWORDS))
    ap.add_argument("--enqueue-only", action="store_true")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--max-jobs", type=int, default=0)
    ap.add_argument("--launch-mode", choices=("cdp_chrome", "playwright"), default="cdp_chrome")
    ap.add_argument("--cdp-port", type=int, default=9222)
    ap.add_argument("--sticky", action="store_true", help="Sticky sessid (default: rotating IPs)")
    ap.add_argument("--rotate-each-session", action="store_true", help="Deprecated; rotating is default")
    args = ap.parse_args(argv)

    load_config()  # validate early
    countries = [
        normalize_country(c) for c in args.countries.split(",") if c.strip()
    ]
    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    if not countries:
        countries = list(DEFAULT_COUNTRIES)

    n = enqueue_searches(countries, args.pages, keywords)
    write_run_state({
        "harvest_enqueued": n,
        "countries": countries,
        "pages": args.pages,
        "keywords": keywords,
    })
    log.info("Enqueued %s new search jobs. queue=%s", n, JobQueue().counts())

    if args.enqueue_only:
        return

    from .worker import BrowserWorker

    BrowserWorker(
        headed=not args.headless,
        kinds=["search"],
        countries=countries,
        max_jobs=args.max_jobs,
        launch_mode=args.launch_mode,
        cdp_port=args.cdp_port,
        sticky=bool(args.sticky),
    ).run()


if __name__ == "__main__":
    main()
