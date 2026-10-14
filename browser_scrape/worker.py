"""Headed Playwright worker: claim jobs, navigate via DataImpulse, extract, checkpoint."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import random
import re
import shutil
import signal
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# rebrowser-playwright: drop-in Playwright with CDP patches that reduce
# Runtime.enable / automation leaks DataDome fingerprints on.
from rebrowser_playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

from .config import (
    OUT_DIR,
    dataimpulse_proxy_parts,
    load_config,
    normalize_country,
    probe_egress_ip,
    write_run_state,
)
from .local_forward_proxy import LocalForwardProxy
from .extractors import (
    LISTING_JS,
    SEARCH_CARD_JS,
    SHOP_JS,
    enrich_listing_extract,
    enrich_shop_extract,
    extract_listing_from_html,
    extract_search_cards_from_js,
    extract_search_from_html,
    extract_shop_from_html,
    is_blocked_html,
    is_hard_ban_html,
)
from .queue import Job, JobQueue

log = logging.getLogger("etsy_worker")

HARVEST_CSV = OUT_DIR / "harvest_listings.csv"
PRODUCT_JSONL = OUT_DIR / "product_details.jsonl"
SHOP_JSONL = OUT_DIR / "shop_profiles.jsonl"

HARVEST_FIELDS = [
    "keyword", "country", "page", "rank", "rank_on_page", "listing_id",
    "title", "url", "price", "currency", "shop", "badges", "signals",
    "category", "scraped_at",
]


def _append_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        if write_header:
            w.writeheader()
        for r in rows:
            w.writerow(r)


def _append_jsonl(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _delay(lo: float = 3.0, hi: float = 8.0) -> None:
    time.sleep(random.uniform(lo, hi))


class BrowserWorker:
    def __init__(
        self,
        *,
        headed: bool = True,
        kinds: list[str] | None = None,
        countries: list[str] | None = None,
        max_jobs: int = 0,
        launch_mode: str = "cdp_chrome",
        cdp_port: int = 9222,
        sticky: bool = False,
        chrome_user_data_dir: str | Path | None = None,
        chrome_profile_directory: str | None = None,
    ) -> None:
        self.cfg = load_config()
        self.queue = JobQueue()
        self.headed = headed
        self.kinds = kinds
        self.countries = (
            [normalize_country(c) for c in countries if c.strip()] if countries else None
        )
        self.max_jobs = max_jobs  # 0 = unlimited
        # cdp_chrome: system Chrome via local auth forwarder → DataImpulse (works vs DataDome)
        # playwright: PW-managed Chrome + native proxy auth (often 403 on Etsy)
        self.launch_mode = launch_mode
        self.cdp_port = cdp_port
        # Default rotating: sticky sessids on this pool often reuse one IP
        self.sticky = sticky
        # Optional: reuse a real signed-in Chrome profile (cookies / fingerprint)
        self.chrome_user_data_dir = (
            Path(chrome_user_data_dir).expanduser() if chrome_user_data_dir else None
        )
        self.chrome_profile_directory = chrome_profile_directory or None
        self._owns_temp_profile = False
        self._sess_counter = 0
        self._current_country = ""
        self._sessid = ""
        self._egress_ip = ""
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self._pw = None
        self._chrome_proc: subprocess.Popen | None = None
        self._profile_dir: Path | None = None
        self._fwd: LocalForwardProxy | None = None
        self._consecutive_hard_bans = 0

    def _assert_profile_unlocked(self, user_data_dir: Path) -> None:
        lock = user_data_dir / "SingletonLock"
        if lock.exists() or (user_data_dir / "SingletonSocket").exists():
            raise SystemExit(
                f"Chrome profile is locked (Chrome is still open):\n  {user_data_dir}\n"
                "Close that Chrome window completely, then re-run.\n"
                "We relaunch YOUR profile with DataImpulse proxy — Chrome cannot "
                "share a profile with two processes."
            )

    @staticmethod
    def _is_default_chrome_dir(user_data_dir: Path) -> bool:
        """Chrome refuses --remote-debugging-port on the default user-data-dir."""
        resolved = user_data_dir.expanduser().resolve()
        defaults = {
            (Path.home() / ".config" / "google-chrome").resolve(),
            (Path.home() / ".config" / "chromium").resolve(),
        }
        return resolved in defaults

    def _prepare_signed_user_data_dir(self) -> Path:
        """
        Clone signed profile into a NON-default path so CDP works, while keeping
        cookies/login from the real profile.
        """
        assert self.chrome_user_data_dir is not None
        src = self.chrome_user_data_dir.expanduser().resolve()
        self._assert_profile_unlocked(src)

        dest = Path.home() / ".config" / "google-chrome-etsy-di"
        dest.mkdir(parents=True, exist_ok=True)
        # Always refresh Local State + chosen profile so login cookies stay current
        profile_name = self.chrome_profile_directory or "Default"
        src_profile = src / profile_name
        if not src_profile.is_dir():
            raise SystemExit(
                f"Profile directory not found: {src_profile}\n"
                f"Available: {[p.name for p in src.iterdir() if p.is_dir() and (p.name == 'Default' or p.name.startswith('Profile'))][:20]}"
            )

        log.info("Cloning signed profile %s → %s (CDP requires non-default path)", profile_name, dest)
        # Remove stale singletons on dest
        for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            p = dest / name
            if p.exists() or p.is_symlink():
                p.unlink(missing_ok=True)

        # Copy Local State + First Run + profile folder (not entire multi-GB tree)
        for fname in ("Local State", "First Run", "Last Version"):
            s = src / fname
            if s.exists():
                shutil.copy2(s, dest / fname)

        dest_profile = dest / profile_name
        if dest_profile.exists():
            shutil.rmtree(dest_profile, ignore_errors=True)
        # Ignore bulky caches
        def _ignore(_dir: str, names: list[str]) -> set[str]:
            skip = {
                "Cache",
                "Code Cache",
                "GPUCache",
                "GrShaderCache",
                "ShaderCache",
                "Service Worker",
                "VideoDecodeStats",
                "BrowserMetrics",
                "Crashpad",
                "Crash Reports",
            }
            return {n for n in names if n in skip}

        shutil.copytree(src_profile, dest_profile, ignore=_ignore)
        return dest

    def _new_sessid(self, country: str) -> str:
        self._sess_counter += 1
        # Unique sessid → DataImpulse assigns a (usually) new sticky exit IP
        return f"etsy_{country}_{self._sess_counter}_{uuid.uuid4().hex[:10]}"

    def _proxy_dict(self, country: str) -> dict[str, str]:
        return dataimpulse_proxy_parts(
            country, self._sessid, self.cfg, sticky=self.sticky
        )

    def _log_egress(self, country: str) -> None:
        parts = self._proxy_dict(country)
        ip = probe_egress_ip(parts)
        self._egress_ip = ip
        log.info(
            "DataImpulse egress country=%s sticky=%s sessid=%s ip=%s user=%s",
            country,
            self.sticky,
            self._sessid or "(rotating)",
            ip or "?",
            parts["username"][:48],
        )
        write_run_state({
            "egress_ip": ip,
            "egress_country": country,
            "sessid": self._sessid,
            "sticky": self.sticky,
        })

    def _chrome_bin(self) -> str:
        for name in ("google-chrome", "google-chrome-stable", "chromium"):
            path = shutil.which(name)
            if path:
                return path
        raise SystemExit("No Chrome/Chromium binary found")

    def _wait_cdp(self, timeout: float = 90.0) -> None:
        import urllib.request

        deadline = time.time() + timeout
        url = f"http://127.0.0.1:{self.cdp_port}/json/version"
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                time.sleep(0.5)
            # Bail early if Chrome process already exited
            if self._chrome_proc is not None and self._chrome_proc.poll() is not None:
                raise RuntimeError(
                    f"Chrome exited early code={self._chrome_proc.returncode} "
                    f"(see data/chrome_cdp_stderr.log)"
                )
        raise RuntimeError(
            f"Chrome CDP not ready on port {self.cdp_port} "
            f"(see data/chrome_cdp_stderr.log)"
        )

    def _start_forwarder(self, country: str) -> LocalForwardProxy:
        parts = self._proxy_dict(country)
        if self._fwd:
            self._fwd.stop()
            self._fwd = None
        fwd = LocalForwardProxy(
            upstream_server=parts["server"],
            username=parts["username"],
            password=parts["password"],
            listen_port=0,
        )
        fwd.start()
        self._fwd = fwd
        return fwd

    def _launch_cdp_chrome(self, country: str) -> Page:
        """System Chrome → local auth forwarder → DataImpulse (proxy cannot be skipped)."""
        self._log_egress(country)
        fwd = self._start_forwarder(country)

        if self.chrome_user_data_dir:
            src = self.chrome_user_data_dir.expanduser()
            if not src.is_dir():
                raise SystemExit(f"Chrome user-data-dir not found: {src}")
            # Default path blocks remote debugging — clone to google-chrome-etsy-di
            if self._is_default_chrome_dir(src):
                self._profile_dir = self._prepare_signed_user_data_dir()
            else:
                self._assert_profile_unlocked(src)
                self._profile_dir = src
            self._owns_temp_profile = False  # never delete signed/clone root blindly
            log.info(
                "Using signed Chrome profile user_data_dir=%s profile_directory=%s",
                self._profile_dir,
                self.chrome_profile_directory or "(default)",
            )
        else:
            self._profile_dir = OUT_DIR / f"chrome_profile_{country}_{self._sessid or 'rot'}"
            self._owns_temp_profile = True
            if self._profile_dir.exists():
                shutil.rmtree(self._profile_dir, ignore_errors=True)
            self._profile_dir.mkdir(parents=True)

        chrome = self._chrome_bin()
        # Critical: --proxy-server forces ALL traffic through our forwarder (no auth UI)
        # Do NOT pass AutomationControlled flags — Chrome shows a yellow banner that
        # DataDome correlates with bots, and hard-bans (no captcha to solve).
        args = [
            chrome,
            f"--remote-debugging-port={self.cdp_port}",
            f"--user-data-dir={self._profile_dir}",
            f"--proxy-server={fwd.listen_host}:{fwd.listen_port}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
        ]
        if self.chrome_profile_directory:
            args.append(f"--profile-directory={self.chrome_profile_directory}")
        args.append("about:blank")
        if not self.headed:
            args.append("--headless=new")
        log.info(
            "Starting Chrome CDP port=%s via local forwarder %s (DataImpulse)",
            self.cdp_port,
            fwd.proxy_server_arg,
        )
        err_log = OUT_DIR / "chrome_cdp_stderr.log"
        err_fh = err_log.open("w", encoding="utf-8")
        self._chrome_proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=err_fh,
            start_new_session=True,
        )
        # Give real profiles longer to restore session / decrypt cookies
        self._wait_cdp(timeout=90.0 if not self._owns_temp_profile else 45.0)
        try:
            err_fh.close()
        except Exception:
            pass
        if self._pw is None:
            self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.connect_over_cdp(
            f"http://127.0.0.1:{self.cdp_port}"
        )
        self._context = (
            self._browser.contexts[0]
            if self._browser.contexts
            else self._browser.new_context()
        )
        self._page = (
            self._context.pages[0] if self._context.pages else self._context.new_page()
        )
        self._page.set_default_timeout(90_000)
        # Verify Chrome really egresses via proxy
        try:
            self._page.goto("https://api.ipify.org?format=json", timeout=30_000)
            body = self._page.inner_text("body")
            log.info("Chrome confirmed egress via proxy: %s", body.strip()[:120])
        except Exception as e:
            log.warning("Chrome egress check failed: %s", e)
        return self._page

    def _launch_playwright(self, country: str) -> Page:
        self._log_egress(country)
        proxy = {
            "server": self._proxy_dict(country)["server"],
            "username": self._proxy_dict(country)["username"],
            "password": self._proxy_dict(country)["password"],
        }
        if self._pw is None:
            self._pw = sync_playwright().start()
        launch_kwargs: dict[str, Any] = {
            "headless": not self.headed,
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--no-default-browser-check",
                "--disable-dev-shm-usage",
            ],
            # Bind proxy at launch too so nothing leaks to your home IP
            "proxy": proxy,
        }
        if shutil.which("google-chrome") or shutil.which("google-chrome-stable"):
            launch_kwargs["channel"] = "chrome"
            log.info("Using system Chrome channel (playwright mode)")
        self._browser = self._pw.chromium.launch(**launch_kwargs)
        locale = {"ca": "en-CA", "gb": "en-GB", "uk": "en-GB"}.get(country, "en-US")
        accept_lang = {
            "ca": "en-CA,en;q=0.9",
            "gb": "en-GB,en;q=0.9",
            "uk": "en-GB,en;q=0.9",
        }.get(country, "en-US,en;q=0.9")
        self._context = self._browser.new_context(
            proxy=proxy,
            locale=locale,
            viewport={"width": 1365, "height": 900},
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            extra_http_headers={"Accept-Language": accept_lang},
        )
        self._context.add_init_script(
            """
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = window.chrome || { runtime: {} };
            """
        )
        self._context.route(
            "**/*",
            lambda route: (
                route.abort()
                if route.request.resource_type in ("image", "media")
                else route.continue_()
            ),
        )
        self._page = self._context.new_page()
        self._page.set_default_timeout(60_000)
        try:
            self._page.goto("https://api.ipify.org?format=json", timeout=30_000)
            log.info(
                "Playwright confirmed egress via proxy: %s",
                self._page.inner_text("body").strip()[:120],
            )
        except Exception as e:
            log.warning("Playwright egress check failed: %s", e)
        return self._page

    def _ensure_browser(self, country: str) -> Page:
        country = normalize_country(country) or "us"
        need_new = (
            self._page is None
            or self._current_country != country
            or not self._sessid
        )
        if not need_new:
            assert self._page is not None
            return self._page

        self._close_context()
        self._current_country = country
        self._sessid = self._new_sessid(country)
        log.info(
            "Launch browser driver=rebrowser-playwright mode=%s country=%s "
            "sticky=%s sessid=%s headed=%s",
            self.launch_mode,
            country,
            self.sticky,
            self._sessid or "(none—rotating)",
            self.headed,
        )
        if self.launch_mode == "cdp_chrome":
            page = self._launch_cdp_chrome(country)
        else:
            page = self._launch_playwright(country)

        # Warm homepage once per context — if already hard-banned, abort before search
        try:
            page.goto(
                "https://www.etsy.com/",
                wait_until="domcontentloaded",
                timeout=90_000,
            )
            time.sleep(random.uniform(2.0, 4.0))
            for sel in (
                'button:has-text("Accept")',
                'button:has-text("Accept all")',
                '[data-gdpr-single-choice-accept]',
            ):
                try:
                    loc = page.locator(sel).first
                    if loc.count() and loc.is_visible(timeout=800):
                        loc.click(timeout=2000)
                        break
                except Exception:
                    pass
            html = page.content()
            hard = is_hard_ban_html(html)
            blocked = is_blocked_html(html)
            log.info(
                "Homepage warm-up bytes=%s blocked=%s hard_ban=%s",
                len(html),
                blocked,
                hard,
            )
            if hard or blocked:
                self._consecutive_hard_bans += 1
                raise BlockedError(
                    f"homepage blocked on warm-up hard_ban={hard} "
                    f"streak={self._consecutive_hard_bans}"
                )
            self._consecutive_hard_bans = 0
        except BlockedError:
            raise
        except Exception as e:
            log.warning("Homepage warm-up failed: %s", e)
        return page

    def _close_context(self) -> None:
        try:
            if self._context and self.launch_mode == "playwright":
                self._context.close()
        except Exception:
            pass
        self._context = None
        self._page = None
        try:
            if self._browser:
                self._browser.close()
        except Exception:
            pass
        self._browser = None
        if self._chrome_proc and self._chrome_proc.poll() is None:
            try:
                os.killpg(self._chrome_proc.pid, signal.SIGTERM)
            except Exception:
                try:
                    self._chrome_proc.terminate()
                except Exception:
                    pass
            try:
                self._chrome_proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(self._chrome_proc.pid, signal.SIGKILL)
                except Exception:
                    pass
        self._chrome_proc = None
        if self._fwd:
            try:
                self._fwd.stop()
            except Exception:
                pass
            self._fwd = None
        # Never delete a real signed-in Chrome profile
        if (
            self._owns_temp_profile
            and self._profile_dir
            and self._profile_dir.exists()
        ):
            shutil.rmtree(self._profile_dir, ignore_errors=True)
        self._profile_dir = None
        self._egress_ip = ""

    def _rotate_session(self, country: str) -> Page:
        """New sessid (+ new browser) → new DataImpulse exit IP.

        If sticky sessid still maps to the same exit IP (small pool), fall back
        to rotating mode (no sessid) for this session so Etsy sees a new IP.
        """
        old = self._sessid
        old_ip = self._egress_ip
        log.warning(
            "Rotating DataImpulse IP country=%s old_sessid=%s old_ip=%s",
            country,
            old,
            old_ip or "?",
        )
        self._sessid = ""  # forces _new_sessid on next ensure
        self._close_context()
        page = self._ensure_browser(country)
        if old_ip and self._egress_ip and self._egress_ip == old_ip and self.sticky:
            log.warning(
                "Sticky sessid reused IP %s — switching to rotating mode (no sessid)",
                old_ip,
            )
            self.sticky = False
            self._sessid = ""
            self._close_context()
            page = self._ensure_browser(country)
        log.info(
            "Rotated to sticky=%s sessid=%s ip=%s (was %s)",
            self.sticky,
            self._sessid or "(rotating)",
            self._egress_ip or "?",
            old_ip or "?",
        )
        return page

    def _shutdown(self) -> None:
        self._close_context()
        if self._pw:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None

    def _wait_human_unblock(self, page: Page, timeout: float = 120.0) -> bool:
        """Headed only: wait only if a solvable captcha is present (not a hard ban)."""
        if not self.headed:
            return False
        try:
            html0 = page.content()
        except Exception:
            return False
        if is_hard_ban_html(html0):
            log.warning(
                "Hard ban (Access temporarily restricted) — no captcha to solve; "
                "rotating IP instead of waiting"
            )
            return False
        log.warning(
            "Possible captcha — solve it in the open Chrome window "
            "(waiting up to %.0fs)…",
            timeout,
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(5)
            try:
                html = page.content()
            except Exception:
                continue
            if is_hard_ban_html(html):
                log.warning("Hard ban appeared — stopping wait")
                return False
            if not is_blocked_html(html) and len(html) > 50_000:
                log.info("Page looks unblocked (%s bytes) — continuing", len(html))
                return True
            log.info(
                "Still blocked (%s bytes) — %.0fs left",
                len(html),
                max(0, deadline - time.time()),
            )
        return False

    def _navigate(self, page: Page, url: str) -> str:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=90_000)
        # Settle a bit for client render
        try:
            page.wait_for_load_state("networkidle", timeout=20_000)
        except Exception:
            pass
        time.sleep(random.uniform(2.0, 5.0))
        html = page.content()
        status = resp.status if resp else 0
        log.info("nav status=%s bytes=%s url=%s", status, len(html), url[:100])
        if is_hard_ban_html(html):
            self._consecutive_hard_bans += 1
            raise BlockedError(
                f"hard ban (Access temporarily restricted) streak={self._consecutive_hard_bans}"
            )
        if is_blocked_html(html) and self._wait_human_unblock(page):
            # Re-fetch after captcha
            resp = page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            time.sleep(random.uniform(1.5, 3.0))
            html = page.content()
            status = resp.status if resp else 0
            log.info(
                "post-captcha nav status=%s bytes=%s", status, len(html)
            )
            if is_hard_ban_html(html) or is_blocked_html(html):
                self._consecutive_hard_bans += 1
                raise BlockedError("still blocked after captcha wait")
            self._consecutive_hard_bans = 0
        elif not is_blocked_html(html):
            self._consecutive_hard_bans = 0
        return html

    def _handle_search(self, job: Job) -> str:
        p = job.payload
        keyword = p["keyword"]
        country = normalize_country(p.get("country") or job.country or "us")
        page_num = int(p.get("page") or 1)
        url = p.get("url") or ""
        if not url:
            from .config import build_search_url
            url = build_search_url(keyword, page_num, ship_to=country)

        page = self._ensure_browser(country)
        html = self._navigate(page, url)
        if is_blocked_html(html):
            raise BlockedError("search page blocked / challenge")

        try:
            cards = page.evaluate(SEARCH_CARD_JS)
            rows = extract_search_cards_from_js(
                cards, keyword=keyword, country=country, page=page_num
            )
        except Exception as e:
            log.warning("JS search extract failed: %s — HTML fallback", e)
            rows = extract_search_from_html(
                html, keyword=keyword, country=country, page=page_num
            )

        if not rows:
            # Save debug HTML
            debug = OUT_DIR / f"debug_search_{keyword}_{country}_p{page_num}.html"
            debug.write_text(html, encoding="utf-8")
            raise RuntimeError(f"parsed 0 search cards ({debug.name})")

        _append_csv(HARVEST_CSV, rows, HARVEST_FIELDS)
        log.info("search %s/%s/p%s → %s listings", keyword, country, page_num, len(rows))
        return str(HARVEST_CSV)

    def _handle_product(self, job: Job) -> str:
        p = job.payload
        url = p["url"]
        country = (p.get("country") or job.country or "us").lower()
        search_ctx = {
            "keyword": p.get("keyword", ""),
            "rank": p.get("rank"),
            "country": country,
            "signals": p.get("signals", ""),
            "url": url,
        }
        page = self._ensure_browser(country)
        html = self._navigate(page, url)
        if is_blocked_html(html):
            raise BlockedError("product page blocked / challenge")

        # Try to expand reviews section for more dates
        try:
            for sel in (
                'a[href*="#reviews"]',
                'button:has-text("reviews")',
                '[data-reviews-tab]',
            ):
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible(timeout=1000):
                    loc.click(timeout=3000)
                    time.sleep(1.0)
                    break
            page.mouse.wheel(0, 2500)
            time.sleep(0.8)
        except Exception:
            pass

        try:
            raw = page.evaluate(LISTING_JS)
            detail = enrich_listing_extract(raw, country=country, search_ctx=search_ctx)
            detail["url"] = url.split("?")[0]
            if not detail.get("listing_id"):
                m = re.search(r"/listing/(\d+)/", url)
                if m:
                    detail["listing_id"] = m.group(1)
        except Exception as e:
            log.warning("JS listing extract failed: %s — HTML fallback", e)
            detail = extract_listing_from_html(
                html, url=url, country=country, search_ctx=search_ctx
            )

        _append_jsonl(PRODUCT_JSONL, detail)

        # Enqueue shop if present
        shop_url = detail.get("shop_url") or ""
        if shop_url and "/shop/" in shop_url:
            shop_key = urlparse(shop_url).path.rstrip("/").lower()
            self.queue.enqueue(
                "shop",
                {"url": shop_url, "shop_name": detail.get("shop_name", ""), "country": country},
                country=country,
                dedupe_key=shop_key,
            )

        log.info(
            "product %s reviews30=%s reviews90=%s shop=%s",
            detail.get("listing_id"),
            detail.get("reviews_last_30d"),
            detail.get("reviews_last_90d"),
            detail.get("shop_name"),
        )
        return str(PRODUCT_JSONL)

    def _handle_shop(self, job: Job) -> str:
        p = job.payload
        url = p["url"]
        country = (p.get("country") or job.country or "us").lower()
        page = self._ensure_browser(country)
        html = self._navigate(page, url)
        if is_blocked_html(html):
            raise BlockedError("shop page blocked / challenge")

        try:
            raw = page.evaluate(SHOP_JS)
            profile = enrich_shop_extract(raw, shop_url=url, country=country)
        except Exception as e:
            log.warning("JS shop extract failed: %s — HTML fallback", e)
            profile = extract_shop_from_html(html, shop_url=url, country=country)

        _append_jsonl(SHOP_JSONL, profile)
        log.info(
            "shop %s sales=%s star=%s",
            profile.get("shop_name"),
            profile.get("sales_count"),
            profile.get("star_seller"),
        )
        return str(SHOP_JSONL)

    def process_job(self, job: Job) -> None:
        handlers = {
            "search": self._handle_search,
            "product": self._handle_product,
            "shop": self._handle_shop,
        }
        handler = handlers.get(job.kind)
        if not handler:
            raise RuntimeError(f"unknown job kind: {job.kind}")
        result = handler(job)
        self.queue.mark_done(job.id, result_path=result)

    def run(self) -> None:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
        reset = self.queue.reset_running()
        if reset:
            log.info("Requeued %s interrupted running jobs", reset)

        done = 0
        try:
            while True:
                if self.max_jobs and done >= self.max_jobs:
                    log.info("Reached max_jobs=%s", self.max_jobs)
                    break
                job = self.queue.claim_next(self.kinds, self.countries)
                if not job:
                    log.info(
                        "Queue empty for kinds=%s countries=%s counts=%s",
                        self.kinds,
                        self.countries,
                        self.queue.counts(),
                    )
                    break

                write_run_state({
                    "last_job_id": job.id,
                    "last_kind": job.kind,
                    "last_country": job.country or job.payload.get("country"),
                    "counts": self.queue.counts(),
                    "sessid": self._sessid,
                })
                log.info(
                    "Claimed job id=%s kind=%s country=%s",
                    job.id,
                    job.kind,
                    job.country or job.payload.get("country"),
                )

                try:
                    self.process_job(job)
                    done += 1
                    # Longer pause after product→shop chain
                    if job.kind == "product":
                        _delay(4.0, 10.0)
                    elif job.kind == "shop":
                        _delay(5.0, 12.0)
                    else:
                        _delay(3.0, 8.0)
                except BlockedError as e:
                    log.warning("Blocked job %s: %s", job.id, e)
                    self.queue.mark_failed(job.id, str(e), blocked=True)
                    country = (job.country or job.payload.get("country") or "us").lower()
                    # Hard bans: longer cool-down + always rotate. No 120s captcha wait.
                    streak = self._consecutive_hard_bans
                    if streak >= 3:
                        sleep_s = random.uniform(90, 180)
                    elif "hard ban" in str(e).lower() or streak >= 1:
                        sleep_s = random.uniform(25, 55)
                    elif not self.sticky:
                        sleep_s = random.uniform(15, 40)
                    else:
                        sleep_s = random.uniform(60, 180)
                    log.info(
                        "Backoff %.0fs then rotate DataImpulse IP "
                        "(sticky=%s hard_ban_streak=%s)",
                        sleep_s,
                        self.sticky,
                        streak,
                    )
                    time.sleep(sleep_s)
                    try:
                        self._rotate_session(country)
                    except BlockedError as e2:
                        log.warning("Rotate also blocked: %s — longer pause", e2)
                        time.sleep(random.uniform(60, 120))
                        self._sessid = ""
                        self._close_context()
                except Exception as e:
                    log.exception("Job %s failed: %s", job.id, e)
                    self.queue.mark_failed(job.id, str(e), blocked=False)
                    _delay(5.0, 12.0)
        finally:
            write_run_state({"counts": self.queue.counts(), "worker_exit": time.time()})
            self._shutdown()
            log.info("Worker done. processed=%s counts=%s", done, self.queue.counts())


class BlockedError(RuntimeError):
    pass


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Etsy headed Playwright queue worker")
    ap.add_argument("--headless", action="store_true", help="Run headless (default headed)")
    ap.add_argument("--kinds", default="", help="Comma kinds: search,product,shop")
    ap.add_argument(
        "--countries",
        default="",
        help="Comma countries to claim (e.g. ca). Empty = any.",
    )
    ap.add_argument("--max-jobs", type=int, default=0, help="Stop after N jobs (0=all)")
    ap.add_argument(
        "--launch-mode",
        choices=("cdp_chrome", "playwright"),
        default="cdp_chrome",
        help="cdp_chrome=Chrome+local forwarder→DataImpulse (default); playwright=PW proxy",
    )
    ap.add_argument("--cdp-port", type=int, default=9222)
    ap.add_argument(
        "--sticky",
        action="store_true",
        help="Use sticky sessid (same IP ~30m). Default is rotating (new IP per session).",
    )
    ap.add_argument(
        "--rotate-each-session",
        action="store_true",
        help="Deprecated alias: rotating is already the default.",
    )
    ap.add_argument(
        "--chrome-user-data-dir",
        default="",
        help="Reuse a real Chrome user-data-dir (e.g. ~/.config/google-chrome). "
        "Close Chrome first. Routes via DataImpulse.",
    )
    ap.add_argument(
        "--chrome-profile-directory",
        default="",
        help="Profile folder inside user-data-dir (e.g. 'Profile 9' or Default)",
    )
    args = ap.parse_args(argv)
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()] or None
    countries = [c.strip().lower() for c in args.countries.split(",") if c.strip()] or None
    BrowserWorker(
        headed=not args.headless,
        kinds=kinds,
        countries=countries,
        max_jobs=args.max_jobs,
        launch_mode=args.launch_mode,
        cdp_port=args.cdp_port,
        sticky=bool(args.sticky),
        chrome_user_data_dir=args.chrome_user_data_dir or None,
        chrome_profile_directory=args.chrome_profile_directory or None,
    ).run()


if __name__ == "__main__":
    main()
