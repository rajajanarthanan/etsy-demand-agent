#!/usr/bin/env python3
"""Smoke: rebrowser-playwright + DataImpulse against Etsy (US then CA)."""
from __future__ import annotations

import logging
import shutil
import time
import uuid

from rebrowser_playwright.sync_api import sync_playwright

from .config import build_search_url, dataimpulse_proxy_parts, load_config, probe_egress_ip
from .extractors import is_blocked_html, is_hard_ban_html

log = logging.getLogger("etsy_smoke_rebrowser")


def _probe(country: str) -> dict:
    parts = dataimpulse_proxy_parts(country, sticky=False)
    ip = probe_egress_ip(parts)
    proxy = {
        "server": parts["server"],
        "username": parts["username"],
        "password": parts["password"],
    }
    locale = "en-CA" if country == "ca" else "en-US"
    search_url = build_search_url("teak", 1, ship_to=country)

    result = {
        "country": country,
        "egress_ip": ip,
        "home_bytes": 0,
        "home_hard_ban": None,
        "home_blocked": None,
        "search_bytes": 0,
        "search_hard_ban": None,
        "search_blocked": None,
        "search_title": "",
        "error": "",
    }

    with sync_playwright() as pw:
        launch_kwargs: dict = {
            "headless": False,
            "proxy": proxy,
            "args": [
                "--no-default-browser-check",
                "--disable-dev-shm-usage",
            ],
        }
        if shutil.which("google-chrome") or shutil.which("google-chrome-stable"):
            launch_kwargs["channel"] = "chrome"
            log.info("rebrowser using system Chrome channel")
        else:
            log.info("rebrowser using bundled chromium")

        browser = pw.chromium.launch(**launch_kwargs)
        try:
            ctx = browser.new_context(
                proxy=proxy,
                locale=locale,
                viewport={"width": 1365, "height": 900},
                extra_http_headers={
                    "Accept-Language": (
                        "en-CA,en;q=0.9" if country == "ca" else "en-US,en;q=0.9"
                    ),
                },
            )
            page = ctx.new_page()
            page.set_default_timeout(60_000)

            page.goto("https://api.ipify.org?format=json", timeout=30_000)
            body = page.inner_text("body").strip()
            log.info("[%s] chrome egress %s (probe=%s)", country, body[:120], ip)

            page.goto("https://www.etsy.com/", wait_until="domcontentloaded", timeout=90_000)
            time.sleep(2.5)
            html = page.content()
            result["home_bytes"] = len(html)
            result["home_hard_ban"] = is_hard_ban_html(html)
            result["home_blocked"] = is_blocked_html(html)
            log.info(
                "[%s] home bytes=%s hard_ban=%s blocked=%s",
                country,
                result["home_bytes"],
                result["home_hard_ban"],
                result["home_blocked"],
            )
            if result["home_hard_ban"]:
                return result

            page.goto(search_url, wait_until="domcontentloaded", timeout=90_000)
            time.sleep(3.0)
            html = page.content()
            result["search_bytes"] = len(html)
            result["search_hard_ban"] = is_hard_ban_html(html)
            result["search_blocked"] = is_blocked_html(html)
            result["search_title"] = page.title()[:120]
            log.info(
                "[%s] search bytes=%s hard_ban=%s blocked=%s title=%r",
                country,
                result["search_bytes"],
                result["search_hard_ban"],
                result["search_blocked"],
                result["search_title"],
            )
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
            log.exception("[%s] smoke failed", country)
        finally:
            browser.close()
    return result


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    load_config()
    log.info("smoke id=%s rebrowser-playwright vs Etsy", uuid.uuid4().hex[:8])
    rows = []
    for cc in ("us", "ca"):
        rows.append(_probe(cc))
        time.sleep(2.0)
    print("\n=== rebrowser smoke summary ===")
    for r in rows:
        print(
            f"{r['country'].upper()}: egress={r['egress_ip'] or '?'} "
            f"home={r['home_bytes']}b ban={r['home_hard_ban']} "
            f"search={r['search_bytes']}b ban={r['search_hard_ban']} "
            f"title={r['search_title']!r} err={r['error']!r}"
        )


if __name__ == "__main__":
    main()
