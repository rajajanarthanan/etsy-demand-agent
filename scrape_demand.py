#!/usr/bin/env python3
"""
Etsy current-demand scrape.
Default: direct HTTP (no proxy / no ScrapeOps credits).
Optional: SCRAPEOPS=1 to use ScrapeOps Proxy API with US/CA geotargeting.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import re
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "data"
OUT_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("etsy_demand")

KEYWORDS = ["teak", "acacia", "hardwood", "mahogany"]
# Direct mode: ship_to hints only (no true geo IP). ScrapeOps mode: real country codes.
LOCATIONS_DIRECT = ["us", "ca"]
LOCATIONS_PROXY = ["us", "ca"]
PAGES_PER_KW = 2
# ScrapeOps only — keep free tier alive: avoid generic_level_4 (≈85 credits/request)
MODES = ["residential", "bypass"]  # no bypass4 by default

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Linux"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

# Product signals we care about for "currently making noise"
NOISE_PATTERNS = [
    (r"bestseller", "bestseller"),
    (r"popular now", "popular_now"),
    (r"in\s+\d+\s+baskets|in\s+carts", "in_baskets"),
    (r"only\s+\d+\s+left", "low_stock"),
    (r"\d+\+?\s+views?\s+in\s+the\s+last\s+24", "views_24h"),
    (r"star seller", "star_seller"),
]


def load_api_key() -> str:
    key = os.environ.get("SCRAPEOPS_API_KEY", "").strip()
    if key:
        return key
    cfg = ROOT / "config.json"
    if cfg.exists():
        data = json.loads(cfg.read_text())
        key = (data.get("api_key") or data.get("SCRAPEOPS_API_KEY") or "").strip()
        if key and key not in ("YOUR_API_KEY", "REPLACE_ME"):
            return key
    raise SystemExit(
        "Missing ScrapeOps API key.\n"
        "1) Sign up free (no card): https://scrapeops.io/app/register/bigdata-proxy\n"
        "2) Verify email, copy API key from dashboard\n"
        "3) Either: export SCRAPEOPS_API_KEY=...  OR  put {\"api_key\": \"...\"} in "
        f"{cfg}"
    )


def scrapeops_get(
    api_key: str,
    target_url: str,
    country: str,
    mode: str = "residential",
    timeout: int = 90,
) -> requests.Response:
    """
    mode:
      - residential: country + residential=true (cheaper)
      - bypass: country + generic_level_3 (stronger, costlier)
      - bypass4: country + generic_level_4 (strongest / expensive)
    """
    params: dict[str, Any] = {
        "api_key": api_key,
        "url": target_url,
        "country": country,
    }
    if mode == "residential":
        params["residential"] = "true"
    elif mode == "bypass":
        params["bypass"] = "generic_level_3"
        params["residential"] = "true"
    elif mode == "bypass4":
        params["bypass"] = "generic_level_4"
    else:
        raise ValueError(mode)

    return requests.get(
        "https://proxy.scrapeops.io/v1/",
        params=params,
        timeout=timeout,
    )


def build_search_url(keyword: str, page: int, ship_to: str | None = None) -> str:
    # page is 1-indexed for Etsy
    q = quote(keyword)
    # bestseller = current sales noise
    url = (
        f"https://www.etsy.com/search?q={q}"
        f"&is_best_seller=true&explicit=1"
        f"&ref=pagination&page={page}"
    )
    if ship_to:
        url += f"&ship_to={ship_to.upper()}"
    return url


def direct_get(target_url: str, country: str, timeout: int = 60) -> requests.Response:
    """Hit Etsy directly — no proxy, no ScrapeOps credits."""
    session = getattr(direct_get, "_session", None)
    if session is None:
        session = requests.Session()
        session.headers.update(BROWSER_HEADERS)
        # Soft region/currency prefs (Etsy may still serve by IP)
        if country == "ca":
            session.cookies.set("ua", "CAD", domain=".etsy.com")
            session.headers["Accept-Language"] = "en-CA,en;q=0.9"
        else:
            session.cookies.set("ua", "USD", domain=".etsy.com")
            session.headers["Accept-Language"] = "en-US,en;q=0.9"
        direct_get._session = session  # type: ignore[attr-defined]
    return session.get(target_url, timeout=timeout, allow_redirects=True)


def detect_signals(text: str) -> list[str]:
    t = text.lower()
    found = []
    for pat, name in NOISE_PATTERNS:
        if re.search(pat, t):
            found.append(name)
    return found


def classify(title: str) -> str:
    s = title.lower()
    rules = [
        ("cutting_board", r"cutting board|chopping board|butcher|charcuterie|cheese board|serving board|steak cutting|cutting board set"),
        ("kitchen_utensils", r"utensil|spoon|spatula|salad server|ladle|cooking set"),
        ("coasters_slices", r"coaster|wood slice|teak slice|rounds"),
        ("slab_lumber", r"\bslab\b|live edge|lumber|timber|plank|sawn"),
        ("door_divider", r"\bdoor\b|room divider|screen|headboard"),
        ("table_furniture", r"\btable\b|console|stool|chair|bench"),
        ("shelves_hooks", r"shelf|shelves|coat rack|wall hook|key holder"),
        ("bowls_trays", r"\bbowl\b|tray|riser|shower tray"),
        ("frames", r"frame|picture frame|photo"),
        ("digital", r"digital download|svg|dxf|\bpdf\b"),
        ("non_wood", r"tea gift|kimono|scarf|velvet|rug|ceramic|copper kettle|kaftan|cacao|rubber stamp|mason jar|glass"),
    ]
    for name, pat in rules:
        if re.search(pat, s):
            return name
    return "other_wood"


@dataclass
class Listing:
    keyword: str
    country: str
    page: int
    listing_id: str
    title: str
    url: str
    price: str
    currency: str
    shop: str
    rating: str
    signals: str
    category: str
    noise_score: int


def looks_blocked(html: str) -> bool:
    """True only for real soft-blocks — not JS that mentions captcha."""
    if len(html) < 2000:
        return True
    low = html.lower()
    # Real interstitial copy (avoid matching disableAutoRefreshOnCaptchaPassed etc.)
    if "unusual traffic from your" in low:
        return True
    if re.search(r">\s*please verify you are a human", low):
        return True
    if "access denied" in low and "/listing/" not in low:
        return True
    return False


def parse_listings(html: str, keyword: str, country: str, page: int) -> list[Listing]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[Listing] = []
    seen: set[str] = set()
    card_by_id: dict[str, str] = {}

    # Prefer listing anchors with rich card text when present
    for a in soup.select('a[href*="/listing/"]'):
        href = a.get("href") or ""
        m = re.search(r"/listing/(\d+)/", href)
        if not m:
            continue
        lid = m.group(1)
        node = a
        card_text = ""
        for _ in range(6):
            if node is None:
                break
            t = " ".join(node.stripped_strings)
            if len(t) > 40 and ("$" in t or "USD" in t or "CAD" in t or "bestseller" in t.lower()):
                card_text = t
                break
            node = node.parent
        if not card_text:
            card_text = " ".join(a.stripped_strings) or a.get("title") or ""
        card_by_id[lid] = card_text

        slug = ""
        sm = re.search(r"/listing/\d+/([^/?#]+)", href)
        if sm:
            slug = sm.group(1).replace("-", " ")
        title = a.get("title") or ""
        h3 = a.find("h3") if hasattr(a, "find") else None
        if h3 and h3.get("title"):
            title = h3.get("title")
        if not title:
            title = slug or card_text[:120]
        if lid not in seen:
            seen.add(lid)
            _append_listing(out, keyword, country, page, lid, title, href, card_text, slug)

    # Fallback: Etsy often embeds listing URLs in JSON without crawlable <a> tags
    for lid, slug in re.findall(
        r"(?:https?://www\.etsy\.com)?/listing/(\d+)/([a-z0-9\-]+)", html, re.I
    ):
        if lid in seen:
            continue
        seen.add(lid)
        title = slug.replace("-", " ")
        href = f"https://www.etsy.com/listing/{lid}/{slug}"
        card_text = card_by_id.get(lid, "")
        _append_listing(out, keyword, country, page, lid, title, href, card_text, title)
        if len(out) >= 48:
            break

    return out[:48]


def _append_listing(
    out: list[Listing],
    keyword: str,
    country: str,
    page: int,
    lid: str,
    title: str,
    href: str,
    card_text: str,
    slug: str,
) -> None:
    shop_m = re.search(
        r"From shop\s+([^\n$]+?)(?:\s+Sale Price|\s+\$|\s+Ad\b|\s+Free|\s+Original|\s+Add to|$)",
        card_text,
        re.I,
    )
    shop = shop_m.group(1).strip() if shop_m else ""
    prices = re.findall(r"(?:USD|CAD|INR|₹|\$|C\$)\s*([\d,.]+)|([\d,.]+)\s*(?:USD|CAD|INR)", card_text)
    flat = [p[0] or p[1] for p in prices if p[0] or p[1]]
    if not flat:
        flat = re.findall(r"\$\s*([\d,.]+)|₹\s*([\d,.]+)", card_text)
        flat = [a or b for a, b in flat]
    price = flat[0] if flat else ""
    currency = "USD" if country == "us" else ("CAD" if country == "ca" else "INR")
    if "CAD" in card_text or "C$" in card_text:
        currency = "CAD"
    if "₹" in card_text or "INR" in card_text:
        currency = "INR"
    rating_m = re.search(r"([\d.]+)\s*out of\s*5", card_text, re.I)
    rating = rating_m.group(1) if rating_m else ""
    signals = detect_signals(card_text)
    signals += [s for s in detect_signals(title) if s not in signals]
    if "bestseller" not in signals:
        signals.append("bestseller_filter")
    cat = classify(f"{title} {slug}")
    noise = 0
    noise += 3 if "bestseller" in signals or "bestseller_filter" in signals else 0
    noise += 2 if "popular_now" in signals else 0
    noise += 2 if "views_24h" in signals else 0
    noise += 1 if "in_baskets" in signals else 0
    noise += 1 if "low_stock" in signals else 0
    if cat in ("digital", "non_wood"):
        noise = 0
    full_url = href if href.startswith("http") else f"https://www.etsy.com{href.split('?')[0]}"
    full_url = full_url.split("?")[0]
    out.append(
        Listing(
            keyword=keyword,
            country=country,
            page=page,
            listing_id=lid,
            title=title.strip()[:200],
            url=full_url,
            price=price,
            currency=currency,
            shop=shop[:80],
            rating=rating,
            signals=",".join(signals),
            category=cat,
            noise_score=noise,
        )
    )


def fetch_page_direct(keyword: str, country: str, page: int) -> tuple[list[Listing], str]:
    url = build_search_url(keyword, page, ship_to=country)
    log.info("GET %s ship_to=%s page=%s mode=direct", keyword, country, page)
    try:
        r = direct_get(url, country=country)
    except Exception as e:
        raise RuntimeError(f"request error: {e}") from e

    log.info("status=%s bytes=%s", r.status_code, len(r.content))
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")

    html = r.text
    (OUT_DIR / f"raw_{keyword}_{country}_p{page}_direct.html").write_text(
        html, encoding="utf-8"
    )

    if looks_blocked(html):
        raise RuntimeError("blocked soft-wall (Etsy challenged this IP)")

    listings = parse_listings(html, keyword, country, page)
    if not listings:
        raise RuntimeError("parsed 0 listings")
    return listings, "direct"


def fetch_page_proxy(
    api_key: str, keyword: str, country: str, page: int
) -> tuple[list[Listing], str]:
    url = build_search_url(keyword, page)
    last_err = ""
    for mode in MODES:
        log.info("GET %s country=%s page=%s mode=%s", keyword, country, page, mode)
        try:
            r = scrapeops_get(api_key, url, country=country, mode=mode)
        except Exception as e:
            last_err = str(e)
            log.warning("request error: %s", e)
            time.sleep(2)
            continue

        log.info("status=%s bytes=%s", r.status_code, len(r.content))
        if r.status_code != 200:
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            body = r.text.lower()
            if r.status_code in (401, 402, 403) and (
                "api credits" in body or "email confirmation" in body or "api_key" in body
            ):
                raise SystemExit(f"ScrapeOps auth/credit error: {r.text[:500]}")
            time.sleep(2)
            continue

        html = r.text
        (OUT_DIR / f"raw_{keyword}_{country}_p{page}_{mode}.html").write_text(
            html, encoding="utf-8"
        )

        if looks_blocked(html):
            last_err = "blocked soft-wall"
            log.warning("soft-block page (mode=%s), escalating", mode)
            time.sleep(2)
            continue

        listings = parse_listings(html, keyword, country, page)
        if not listings:
            last_err = "parsed 0 listings"
            log.warning("0 listings parsed (mode=%s), escalating", mode)
            time.sleep(2)
            continue

        return listings, mode

    raise RuntimeError(f"Failed {keyword}/{country}/p{page}: {last_err}")


def analyze(rows: list[Listing]) -> dict:
    wood = [r for r in rows if r.category not in ("digital", "non_wood")]
    by_cat = Counter(r.category for r in wood)
    # rank categories by noise
    cat_noise: dict[str, int] = defaultdict(int)
    cat_n: dict[str, int] = defaultdict(int)
    prices: dict[str, list[float]] = defaultdict(list)
    for r in wood:
        cat_noise[r.category] += r.noise_score
        cat_n[r.category] += 1
        try:
            prices[r.category].append(float(r.price.replace(",", "")))
        except Exception:
            pass

    ranked = sorted(cat_noise.items(), key=lambda x: -x[1])
    top_listings = sorted(wood, key=lambda r: (-r.noise_score, r.price or "999"))[:40]

    product_recs = []
    # Map categories to actionable products (current street demand)
    mapping = [
        ("cutting_board", "Personalized cutting / charcuterie board", "Acacia/Teak", "Wave 1"),
        ("kitchen_utensils", "Kitchen utensil set (5–10 pcs)", "Teak/Acacia", "Wave 1"),
        ("bowls_trays", "Serving tray / riser / bowl", "Teak/Acacia", "Wave 1"),
        ("coasters_slices", "Teak slices / coaster blanks", "Teak", "Wave 1"),
        ("slab_lumber", "Raw live-edge slab / lumber blank", "Teak/Acacia", "Wave 2"),
        ("shelves_hooks", "Floating shelf / wall organizer", "Acacia/Teak", "Wave 2"),
        ("table_furniture", "Console / stool / small table", "Teak", "Wave 2"),
        ("door_divider", "Door / room divider / headboard", "Teak", "Wave 2–3"),
        ("frames", "Solid wood photo frame", "Teak/Hardwood", "Wave 2"),
    ]
    for cat, name, species, wave in mapping:
        if cat_n.get(cat, 0) == 0:
            continue
        ps = sorted(prices.get(cat, []))
        med = ps[len(ps) // 2] if ps else None
        product_recs.append(
            {
                "product": name,
                "category": cat,
                "species": species,
                "wave": wave,
                "listings": cat_n[cat],
                "noise_points": cat_noise[cat],
                "median_price": med,
            }
        )
    product_recs.sort(key=lambda x: -x["noise_points"])

    return {
        "total": len(rows),
        "wood": len(wood),
        "by_category": dict(by_cat),
        "category_noise": dict(ranked),
        "product_recs": product_recs,
        "hot_listings": [asdict(r) for r in top_listings],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Etsy bestseller demand scrape")
    parser.add_argument(
        "--proxy",
        action="store_true",
        help="Use ScrapeOps proxy (costs credits). Default is direct, no proxy.",
    )
    args = parser.parse_args()
    use_proxy = args.proxy or os.environ.get("SCRAPEOPS", "").strip() in ("1", "true", "yes")

    locations = LOCATIONS_PROXY if use_proxy else LOCATIONS_DIRECT
    api_key = load_api_key() if use_proxy else ""
    all_rows: list[Listing] = []
    run_log = []
    log.info("mode=%s locations=%s", "scrapeops" if use_proxy else "direct", locations)

    for country in locations:
        # Reset session cookies when switching ship_to region in direct mode
        if not use_proxy and hasattr(direct_get, "_session"):
            delattr(direct_get, "_session")
        for keyword in KEYWORDS:
            for page in range(1, PAGES_PER_KW + 1):
                try:
                    if use_proxy:
                        listings, mode = fetch_page_proxy(
                            api_key, keyword, country, page
                        )
                    else:
                        listings, mode = fetch_page_direct(keyword, country, page)
                    all_rows.extend(listings)
                    run_log.append(
                        {
                            "keyword": keyword,
                            "country": country,
                            "page": page,
                            "mode": mode,
                            "n": len(listings),
                        }
                    )
                    log.info(
                        "OK %s/%s p%s → %s listings (mode=%s)",
                        keyword,
                        country,
                        page,
                        len(listings),
                        mode,
                    )
                except Exception as e:
                    log.error("FAIL %s/%s p%s: %s", keyword, country, page, e)
                    run_log.append(
                        {
                            "keyword": keyword,
                            "country": country,
                            "page": page,
                            "error": str(e),
                        }
                    )
                time.sleep(2.0 if not use_proxy else 1.2)

    # dedupe by listing_id keeping max noise / any country
    best: dict[str, Listing] = {}
    for r in all_rows:
        prev = best.get(r.listing_id)
        if not prev or r.noise_score > prev.noise_score:
            best[r.listing_id] = r
    deduped = list(best.values())

    csv_path = OUT_DIR / "demand_listings.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(asdict(deduped[0]).keys()) if deduped else [
            "keyword", "country", "page", "listing_id", "title", "url", "price",
            "currency", "shop", "rating", "signals", "category", "noise_score",
        ])
        w.writeheader()
        for r in sorted(deduped, key=lambda x: -x.noise_score):
            w.writerow(asdict(r))

    summary = analyze(deduped)
    summary["run_log"] = run_log
    summary["countries"] = locations
    summary["keywords"] = KEYWORDS
    summary["pages_per_keyword"] = PAGES_PER_KW
    summary["fetch_mode"] = "scrapeops" if use_proxy else "direct"
    (OUT_DIR / "demand_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    print("\n=== CURRENT DEMAND SUMMARY ===")
    print(f"Fetch mode: {'scrapeops' if use_proxy else 'direct (no proxy)'}")
    print(f"Unique listings: {summary['wood']} wood-ish / {summary['total']} total")
    print("\nCategory noise ranking:")
    cat_noise = summary.get("category_noise") or {}
    if isinstance(cat_noise, dict):
        ranked = sorted(cat_noise.items(), key=lambda x: -x[1])[:12]
    else:
        ranked = list(cat_noise)[:12]
    for cat, pts in ranked:
        print(f"  {cat:20} noise={pts} n={summary['by_category'].get(cat, 0)}")
    print("\nProduct recommendations (by current noise):")
    for i, p in enumerate(summary["product_recs"][:10], 1):
        print(
            f"  {i}. [{p['wave']}] {p['product']} | n={p['listings']} "
            f"noise={p['noise_points']} med=${p['median_price']}"
        )
    print(f"\nWrote {csv_path}")
    print(f"Wrote {OUT_DIR / 'demand_summary.json'}")


if __name__ == "__main__":
    main()
