"""Parse Etsy search / listing / shop HTML (and page-embedded JSON)."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

# Reuse classifiers from sibling module
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from scrape_demand import classify, detect_signals, looks_blocked  # noqa: E402


# ---------------------------------------------------------------------------
# Block / challenge detection
# ---------------------------------------------------------------------------

def is_blocked_html(html: str) -> bool:
    if looks_blocked(html):
        return True
    low = html.lower()
    if "access is temporarily restricted" in low:
        return True
    if "unusual activity from your device" in low:
        return True
    if "datadome" in low and ("captcha" in low or "geo.captcha" in low):
        if len(html) < 50_000 and "/listing/" not in low:
            return True
    if "cf-browser-verification" in low:
        return True
    if len(html) < 5000 and "/listing/" not in low and "etsy" in low:
        # Tiny interstitial / soft-wall page
        return True
    return False


def is_hard_ban_html(html: str) -> bool:
    """True for non-solvable restriction pages (no captcha to click)."""
    low = (html or "").lower()
    if "access is temporarily restricted" in low:
        return True
    if "unusual activity from your device" in low:
        return True
    # Tiny interstitial (~1.5KB): dead end even if DataDome JS mentions captcha CDN
    if len(html) < 5000 and "/listing/" not in low:
        return True
    return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _abs_url(href: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href.split("?")[0]
    return urljoin("https://www.etsy.com", href.split("?")[0])


def _parse_price_currency(text: str, country: str) -> tuple[str, str]:
    cc = (country or "us").lower()
    currency = {"us": "USD", "ca": "CAD", "gb": "GBP", "uk": "GBP"}.get(cc, "USD")
    if "CAD" in text or "C$" in text:
        currency = "CAD"
    if "₹" in text or "INR" in text:
        currency = "INR"
    prices = re.findall(
        r"(?:USD|CAD|INR|₹|\$|C\$)\s*([\d,.]+)|([\d,.]+)\s*(?:USD|CAD|INR)",
        text,
    )
    flat = [p[0] or p[1] for p in prices if p[0] or p[1]]
    if not flat:
        flat = [a or b for a, b in re.findall(r"\$\s*([\d,.]+)|₹\s*([\d,.]+)", text)]
    return (flat[0] if flat else ""), currency


def _extract_json_blobs(html: str) -> list[Any]:
    blobs: list[Any] = []
    # __NEXT_DATA__
    m = re.search(
        r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        html,
        re.I | re.S,
    )
    if m:
        try:
            blobs.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            pass
    # Etsy often embeds large JSON in script type=application/json or window data
    for m in re.finditer(
        r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
        html,
        re.I | re.S,
    ):
        try:
            blobs.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            pass
    return blobs


def _walk(obj: Any):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _parse_relative_or_absolute_date(s: str, now: datetime | None = None) -> datetime | None:
    """Parse Etsy review date strings into aware UTC datetimes."""
    now = now or datetime.now(timezone.utc)
    t = (s or "").strip()
    if not t:
        return None
    low = t.lower()

    # "about 2 weeks ago", "3 days ago", "a month ago"
    m = re.search(
        r"(?:about\s+)?(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago",
        low,
    )
    if m:
        n_raw, unit = m.group(1), m.group(2)
        n = 1 if n_raw in ("a", "an") else int(n_raw)
        delta = {
            "second": timedelta(seconds=n),
            "minute": timedelta(minutes=n),
            "hour": timedelta(hours=n),
            "day": timedelta(days=n),
            "week": timedelta(weeks=n),
            "month": timedelta(days=30 * n),
            "year": timedelta(days=365 * n),
        }[unit]
        return now - delta

    # Absolute formats
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            dt = datetime.strptime(t[:32], fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    # ISO
    try:
        dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def compute_review_windows(
    dates: list[datetime],
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    d30 = now - timedelta(days=30)
    d90 = now - timedelta(days=90)
    last_30 = sum(1 for d in dates if d >= d30)
    last_90 = sum(1 for d in dates if d >= d90)
    latest = max(dates).date().isoformat() if dates else ""
    return {
        "reviews_last_30d": last_30,
        "reviews_last_90d": last_90,
        "latest_review_date": latest,
        "review_dates_sampled": len(dates),
    }


# ---------------------------------------------------------------------------
# Search extraction
# ---------------------------------------------------------------------------

SEARCH_CARD_JS = r"""
() => {
  const results = [];
  const seen = new Set();
  const anchors = Array.from(document.querySelectorAll('a[href*="/listing/"]'));
  for (const a of anchors) {
    const m = (a.href || '').match(/\/listing\/(\d+)\//);
    if (!m) continue;
    const lid = m[1];
    if (seen.has(lid)) continue;
    seen.add(lid);
    let node = a;
    let cardText = '';
    for (let i = 0; i < 8 && node; i++) {
      const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 40) { cardText = t; break; }
      node = node.parentElement;
    }
    if (!cardText) cardText = (a.innerText || a.title || '').trim();
    let title = '';
    const h = a.querySelector('h2,h3,[data-listing-card-title]');
    if (h) title = (h.getAttribute('title') || h.innerText || '').trim();
    if (!title) title = (a.getAttribute('title') || '').trim();
    if (!title) {
      const sm = (a.href || '').match(/\/listing\/\d+\/([^/?#]+)/);
      title = sm ? sm[1].replace(/-/g, ' ') : cardText.slice(0, 120);
    }
    const badges = [];
    const low = cardText.toLowerCase();
    if (low.includes('bestseller')) badges.push('bestseller');
    if (low.includes('popular now')) badges.push('popular_now');
    if (/in\s+\d+\s+baskets|in\s+carts/.test(low)) badges.push('in_baskets');
    if (/only\s+\d+\s+left/.test(low)) badges.push('low_stock');
    if (/\d+\+?\s+views?\s+in\s+the\s+last\s+24/.test(low)) badges.push('views_24h');
    let shop = '';
    const shopM = cardText.match(/From shop\s+([^\n$]+?)(?:\s+Sale Price|\s+\$|\s+Ad\b|\s+Free|\s+Original|\s+Add to|$)/i);
    if (shopM) shop = shopM[1].trim();
    results.push({
      listing_id: lid,
      title: title.slice(0, 200),
      url: a.href.split('?')[0],
      card_text: cardText.slice(0, 800),
      badges,
      shop: shop.slice(0, 80),
    });
    if (results.length >= 48) break;
  }
  return results;
}
"""


def extract_search_cards_from_js(cards: list[dict], *, keyword: str, country: str, page: int) -> list[dict]:
    out: list[dict] = []
    for i, c in enumerate(cards):
        title = (c.get("title") or "").strip()
        card_text = c.get("card_text") or ""
        price, currency = _parse_price_currency(card_text, country)
        badges = list(c.get("badges") or [])
        signals = detect_signals(card_text) + detect_signals(title)
        for b in badges:
            if b not in signals:
                signals.append(b)
        if "bestseller" not in signals and "bestseller_filter" not in signals:
            signals.append("bestseller_filter")
        cat = classify(title)
        out.append({
            "keyword": keyword,
            "country": country,
            "page": page,
            "rank": (page - 1) * 48 + i + 1,
            "rank_on_page": i + 1,
            "listing_id": str(c.get("listing_id") or ""),
            "title": title[:200],
            "url": _abs_url(c.get("url") or ""),
            "price": price,
            "currency": currency,
            "shop": (c.get("shop") or "")[:80],
            "badges": ",".join(badges),
            "signals": ",".join(dict.fromkeys(signals)),
            "category": cat,
            "scraped_at": datetime.now(timezone.utc).isoformat(),
        })
    return out


def extract_search_from_html(html: str, *, keyword: str, country: str, page: int) -> list[dict]:
    """Fallback HTML parser mirroring scrape_demand.parse_listings + rank."""
    soup = BeautifulSoup(html, "html.parser")
    cards: list[dict] = []
    seen: set[str] = set()
    for a in soup.select('a[href*="/listing/"]'):
        href = a.get("href") or ""
        m = re.search(r"/listing/(\d+)/", href)
        if not m:
            continue
        lid = m.group(1)
        if lid in seen:
            continue
        seen.add(lid)
        node = a
        card_text = ""
        for _ in range(8):
            if node is None:
                break
            t = " ".join(node.stripped_strings)
            if len(t) > 40:
                card_text = t
                break
            node = node.parent
        if not card_text:
            card_text = " ".join(a.stripped_strings) or a.get("title") or ""
        title = a.get("title") or ""
        h3 = a.find(["h2", "h3"])
        if h3 and h3.get("title"):
            title = h3.get("title")
        if not title:
            sm = re.search(r"/listing/\d+/([^/?#]+)", href)
            title = (sm.group(1).replace("-", " ") if sm else card_text[:120])
        shop_m = re.search(
            r"From shop\s+([^\n$]+?)(?:\s+Sale Price|\s+\$|\s+Ad\b|\s+Free|\s+Original|\s+Add to|$)",
            card_text,
            re.I,
        )
        badges = detect_signals(card_text)
        cards.append({
            "listing_id": lid,
            "title": title,
            "url": href,
            "card_text": card_text,
            "badges": badges,
            "shop": shop_m.group(1).strip() if shop_m else "",
        })
        if len(cards) >= 48:
            break
    return extract_search_cards_from_js(cards, keyword=keyword, country=country, page=page)


# ---------------------------------------------------------------------------
# Listing (product) extraction
# ---------------------------------------------------------------------------

LISTING_JS = r"""
() => {
  const text = (document.body && document.body.innerText || '').slice(0, 80000);
  const h1 = document.querySelector('h1');
  const title = h1 ? (h1.innerText || '').trim() : (document.title || '');

  // price
  let priceText = '';
  const priceEl = document.querySelector('[data-buy-box-region] [data-buy-box-price], [data-buy-box-price], p.wt-text-title-03, .wt-text-title-larger');
  if (priceEl) priceText = (priceEl.innerText || '').trim();
  if (!priceText) {
    const m = text.match(/(?:USD|CAD|\$|C\$)\s*[\d,.]+/);
    if (m) priceText = m[0];
  }

  // rating + review count
  let rating = '';
  let reviewCount = '';
  const ratingM = text.match(/([\d.]+)\s*out of\s*5/i);
  if (ratingM) rating = ratingM[1];
  const rcM = text.match(/\(([\d,]+)\s*reviews?\)/i) || text.match(/([\d,]+)\s*reviews?/i);
  if (rcM) reviewCount = rcM[1].replace(/,/g, '');

  // shop
  let shopName = '';
  let shopUrl = '';
  const shopA = document.querySelector('a[href*="/shop/"]');
  if (shopA) {
    shopName = (shopA.innerText || '').trim().split('\n')[0].slice(0, 80);
    shopUrl = (shopA.href || '').split('?')[0];
  }
  const shopM = text.match(/From\s+([A-Za-z0-9_\-\. ]{2,60})\s+(?:Star Seller|Owned by|Contact)/i);
  if (!shopName && shopM) shopName = shopM[1].trim();

  // ships / processing
  let shipsFrom = '';
  const sf = text.match(/Ships from\s+([^\n]+)/i);
  if (sf) shipsFrom = sf[1].trim().slice(0, 120);
  let processing = '';
  const pr = text.match(/(?:Processing time|Ready to ship in)\s*[:\-]?\s*([^\n]+)/i);
  if (pr) processing = pr[1].trim().slice(0, 120);

  // breadcrumbs
  const crumbs = Array.from(document.querySelectorAll('nav[aria-label*="breadcrumb" i] a, [data-clg-id*="breadcrumb"] a'))
    .map(a => (a.innerText || '').trim()).filter(Boolean);

  // badges / social proof strings
  const signals = [];
  const low = text.toLowerCase();
  if (low.includes('bestseller')) signals.push('bestseller');
  if (low.includes('popular now')) signals.push('popular_now');
  if (/in\s+\d+\s+(people'?s?\s+)?carts|in\s+\d+\s+baskets/.test(low)) signals.push('in_baskets');
  if (/only\s+\d+\s+left/.test(low)) signals.push('low_stock');
  if (/\d+\+?\s+views?\s+in\s+the\s+last\s+24/.test(low)) signals.push('views_24h');
  if (low.includes('star seller')) signals.push('star_seller');

  // sales string
  let salesText = '';
  const salesM = text.match(/([\d,]+)\s+sales?/i);
  if (salesM) salesText = salesM[0];

  // Review dates — look for time elements and common review date patterns
  const dateCandidates = [];
  for (const el of document.querySelectorAll('time[datetime], [data-review-date], .shop2-review-attribution, [class*="review"] time')) {
    const dt = el.getAttribute('datetime') || el.innerText || '';
    if (dt.trim()) dateCandidates.push(dt.trim());
  }
  // fallback: scan nearby review section text for relative dates
  const reviewSection = document.querySelector('#reviews, [data-reviews], [id*="review"]') || document.body;
  const rtext = (reviewSection.innerText || '').slice(0, 30000);
  const relMatches = rtext.match(/(?:about\s+)?(?:\d+|a|an)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago/gi) || [];
  for (const r of relMatches) dateCandidates.push(r);
  const absMatches = rtext.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi) || [];
  for (const r of absMatches) dateCandidates.push(r);

  // Unique dates preserving order, cap 40
  const seen = new Set();
  const reviewDates = [];
  for (const d of dateCandidates) {
    const k = d.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    reviewDates.push(d);
    if (reviewDates.length >= 40) break;
  }

  // listing id from URL
  const lm = location.pathname.match(/\/listing\/(\d+)\//);
  const listingId = lm ? lm[1] : '';

  return {
    listing_id: listingId,
    title,
    price_text: priceText,
    rating,
    review_count: reviewCount,
    shop_name: shopName,
    shop_url: shopUrl,
    ships_from: shipsFrom,
    processing_time: processing,
    breadcrumbs: crumbs,
    signals,
    sales_text: salesText,
    review_date_strings: reviewDates,
    page_text_sample: text.slice(0, 2000),
  };
}
"""


def enrich_listing_extract(raw: dict, *, country: str = "us", search_ctx: dict | None = None) -> dict:
    price_text = raw.get("price_text") or ""
    price, currency = _parse_price_currency(price_text or raw.get("page_text_sample") or "", country)
    dates: list[datetime] = []
    for s in raw.get("review_date_strings") or []:
        dt = _parse_relative_or_absolute_date(s)
        if dt:
            dates.append(dt)
    windows = compute_review_windows(dates)
    title = (raw.get("title") or "").strip()[:300]
    signals = list(raw.get("signals") or [])
    for s in detect_signals(raw.get("page_text_sample") or ""):
        if s not in signals:
            signals.append(s)

    out = {
        "listing_id": str(raw.get("listing_id") or ""),
        "title": title,
        "url": "",
        "price": price,
        "currency": currency,
        "rating": raw.get("rating") or "",
        "review_count": int(re.sub(r"\D", "", str(raw.get("review_count") or "0")) or 0),
        "shop_name": (raw.get("shop_name") or "")[:80],
        "shop_url": _abs_url(raw.get("shop_url") or ""),
        "ships_from": raw.get("ships_from") or "",
        "processing_time": raw.get("processing_time") or "",
        "breadcrumbs": raw.get("breadcrumbs") or [],
        "signals": ",".join(dict.fromkeys(signals)),
        "sales_text": raw.get("sales_text") or "",
        "category": classify(title),
        "review_date_strings": raw.get("review_date_strings") or [],
        **windows,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "country": country,
    }
    if search_ctx:
        out["search_keyword"] = search_ctx.get("keyword", "")
        out["search_rank"] = search_ctx.get("rank")
        out["search_country"] = search_ctx.get("country", country)
        out["harvest_signals"] = search_ctx.get("signals", "")
        if not out["url"]:
            out["url"] = search_ctx.get("url", "")
    return out


def extract_listing_from_html(html: str, *, url: str = "", country: str = "us", search_ctx: dict | None = None) -> dict:
    """HTML fallback when JS evaluate unavailable."""
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)[:80000]
    h1 = soup.find("h1")
    title = h1.get_text(strip=True) if h1 else (soup.title.string if soup.title else "")
    rating_m = re.search(r"([\d.]+)\s*out of\s*5", text, re.I)
    rc_m = re.search(r"\(([\d,]+)\s*reviews?\)", text, re.I) or re.search(
        r"([\d,]+)\s*reviews?", text, re.I
    )
    shop_a = soup.select_one('a[href*="/shop/"]')
    shop_url = shop_a.get("href") if shop_a else ""
    shop_name = shop_a.get_text(" ", strip=True).split("\n")[0] if shop_a else ""
    lm = re.search(r"/listing/(\d+)/", url or "")
    date_strs = re.findall(
        r"(?:about\s+)?(?:\d+|a|an)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago",
        text,
        re.I,
    )
    date_strs += re.findall(
        r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b",
        text,
        re.I,
    )
    # Also try JSON-LD / embedded
    for blob in _extract_json_blobs(html):
        for node in _walk(blob):
            for key in ("datePublished", "dateCreated", "createDate", "created_timestamp"):
                if key in node and isinstance(node[key], (str, int, float)):
                    date_strs.append(str(node[key]))
            if "reviewRating" in node or node.get("@type") == "Review":
                for k in ("datePublished", "dateCreated"):
                    if node.get(k):
                        date_strs.append(str(node[k]))

    raw = {
        "listing_id": lm.group(1) if lm else "",
        "title": title,
        "price_text": "",
        "rating": rating_m.group(1) if rating_m else "",
        "review_count": rc_m.group(1).replace(",", "") if rc_m else "0",
        "shop_name": shop_name,
        "shop_url": shop_url,
        "ships_from": "",
        "processing_time": "",
        "breadcrumbs": [],
        "signals": detect_signals(text),
        "sales_text": "",
        "review_date_strings": list(dict.fromkeys(date_strs))[:40],
        "page_text_sample": text[:2000],
    }
    sf = re.search(r"Ships from\s+([^\n]+)", text, re.I)
    if sf:
        raw["ships_from"] = sf.group(1).strip()[:120]
    out = enrich_listing_extract(raw, country=country, search_ctx=search_ctx)
    out["url"] = _abs_url(url) if url else out.get("url", "")
    return out


# ---------------------------------------------------------------------------
# Shop extraction
# ---------------------------------------------------------------------------

SHOP_JS = r"""
() => {
  const text = (document.body && document.body.innerText || '').slice(0, 60000);
  const h1 = document.querySelector('h1.shop-name, h1');
  const name = h1 ? (h1.innerText || '').trim() : '';
  let sales = '';
  const sm = text.match(/([\d,]+)\s+Sales/i);
  if (sm) sales = sm[1].replace(/,/g, '');
  let admirers = '';
  const am = text.match(/([\d,]+)\s+Admirers/i);
  if (am) admirers = am[1].replace(/,/g, '');
  const starSeller = /star seller/i.test(text);
  // Prefer shop-home city line under H1 (e.g. "Portland, Oregon")
  let location = '';
  const locEl = document.querySelector(
    'p.sb-shop-location, .sb-shop-location, .shop-details .sb-shop-location'
  );
  if (locEl) location = (locEl.innerText || '').trim().slice(0, 120);
  if (!location) {
    const loc = text.match(/(?:Based in|Located in)\s+([^\n]+)/i);
    if (loc) location = loc[1].trim().slice(0, 120);
  }
  let joined = '';
  const jm = text.match(/(?:On Etsy since|Joined)\s+(\d{4})/i);
  if (jm) joined = jm[1];
  let rating = '';
  const rm = text.match(/([\d.]+)\s*out of\s*5/i);
  if (rm) rating = rm[1];
  let reviewCount = '';
  const rc = text.match(/\(([\d,]+)\s*reviews?\)/i);
  if (rc) reviewCount = rc[1].replace(/,/g, '');
  return {
    shop_name: name,
    sales_count: sales,
    admirers,
    star_seller: starSeller,
    location,
    join_year: joined,
    rating,
    review_count: reviewCount,
  };
}
"""


def enrich_shop_extract(raw: dict, *, shop_url: str = "", country: str = "") -> dict:
    return {
        "shop_name": (raw.get("shop_name") or "")[:120],
        "shop_url": _abs_url(shop_url),
        "sales_count": int(re.sub(r"\D", "", str(raw.get("sales_count") or "0")) or 0),
        "admirers": int(re.sub(r"\D", "", str(raw.get("admirers") or "0")) or 0),
        "star_seller": bool(raw.get("star_seller")),
        "location": raw.get("location") or "",
        "join_year": raw.get("join_year") or "",
        "rating": raw.get("rating") or "",
        "review_count": int(re.sub(r"\D", "", str(raw.get("review_count") or "0")) or 0),
        "country_context": country,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def extract_shop_from_html(html: str, *, shop_url: str = "", country: str = "") -> dict:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)[:60000]
    h1 = soup.select_one("h1.shop-name") or soup.find("h1")
    name = h1.get_text(strip=True) if h1 else ""
    if not name:
        path = urlparse(shop_url).path
        m = re.search(r"/shop/([^/?#]+)", path)
        name = m.group(1) if m else ""
    sm = re.search(r"([\d,]+)\s+Sales", text, re.I)
    am = re.search(r"([\d,]+)\s+Admirers", text, re.I)
    rm = re.search(r"([\d.]+)\s*out of\s*5", text, re.I)
    rc = re.search(r"\(([\d,]+)\s*reviews?\)", text, re.I)
    # Shop-home city under H1 (Etsy class sb-shop-location)
    loc_el = soup.select_one("p.sb-shop-location, .sb-shop-location")
    location = loc_el.get_text(" ", strip=True)[:120] if loc_el else ""
    if not location:
        loc = re.search(r"(?:Based in|Located in)\s+([^\n]+)", text, re.I)
        location = loc.group(1).strip()[:120] if loc else ""
    jm = re.search(r"(?:On Etsy since|Joined)\s+(\d{4})", text, re.I)
    raw = {
        "shop_name": name,
        "sales_count": sm.group(1) if sm else "0",
        "admirers": am.group(1) if am else "0",
        "star_seller": bool(re.search(r"star seller", text, re.I)),
        "location": location,
        "join_year": jm.group(1) if jm else "",
        "rating": rm.group(1) if rm else "",
        "review_count": rc.group(1) if rc else "0",
    }
    return enrich_shop_extract(raw, shop_url=shop_url, country=country)
