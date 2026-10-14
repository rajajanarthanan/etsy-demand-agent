"""Phase D: score US vs CA product types from harvest + product + shop data."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from .config import OUT_DIR, write_run_state

log = logging.getLogger("etsy_summarize")

HARVEST_CSV = OUT_DIR / "harvest_listings.csv"
PRODUCT_JSONL = OUT_DIR / "product_details.jsonl"
SHOP_JSONL = OUT_DIR / "shop_profiles.jsonl"
SUMMARY_PATH = OUT_DIR / "market_demand_summary.json"

# Makeable for teak/acacia mill Wave 1
MAKEABLE = {
    "cutting_board",
    "kitchen_utensils",
    "coasters_slices",
    "bowls_trays",
    "shelves_hooks",
    "frames",
    "other_wood",
}
SKIP = {"digital", "non_wood", "slab_lumber", "door_divider", "table_furniture"}


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _fprice(p: Any) -> float | None:
    try:
        return float(str(p).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def listing_market_score(harvest: dict, product: dict | None, shop: dict | None) -> float:
    """
    Higher = more 'currently making noise' in market.
    Heavy weight on recent reviews; light on lifetime reviews.
    """
    score = 0.0
    rank = int(harvest.get("rank") or harvest.get("rank_on_page") or 48)
    # Better rank → higher score (rank 1 ≈ 20 pts, rank 48 ≈ 0)
    score += max(0.0, 20.0 - (rank - 1) * (20.0 / 47.0))

    signals = (harvest.get("signals") or "") + "," + ((product or {}).get("signals") or "")
    sigs = {s.strip() for s in signals.split(",") if s.strip()}
    if "bestseller" in sigs or "bestseller_filter" in sigs:
        score += 3
    if "popular_now" in sigs:
        score += 4
    if "views_24h" in sigs:
        score += 3
    if "in_baskets" in sigs:
        score += 2
    if "low_stock" in sigs:
        score += 1
    if "star_seller" in sigs:
        score += 1

    if product:
        r30 = int(product.get("reviews_last_30d") or 0)
        r90 = int(product.get("reviews_last_90d") or 0)
        # Heavy: recent review velocity
        score += min(25.0, r30 * 5.0)
        score += min(15.0, r90 * 1.5)
        # Light: lifetime reviews (log-ish)
        lifetime = int(product.get("review_count") or 0)
        if lifetime > 0:
            score += min(5.0, (lifetime ** 0.5) * 0.15)

    if shop:
        sales = int(shop.get("sales_count") or 0)
        if sales > 0:
            score += min(8.0, (sales ** 0.5) * 0.05)
        if shop.get("star_seller"):
            score += 2

    cat = (product or {}).get("category") or harvest.get("category") or "other_wood"
    if cat in SKIP:
        score *= 0.05
    return round(score, 2)


def summarize(
    harvest_path: Path = HARVEST_CSV,
    product_path: Path = PRODUCT_JSONL,
    shop_path: Path = SHOP_JSONL,
) -> dict[str, Any]:
    harvest = _read_csv(harvest_path)
    products = _read_jsonl(product_path)
    shops = _read_jsonl(shop_path)

    products_by_id: dict[str, dict] = {}
    for p in products:
        lid = str(p.get("listing_id") or "")
        if not lid:
            continue
        # Prefer record with more recent-review data
        prev = products_by_id.get(lid)
        if not prev or int(p.get("reviews_last_90d") or 0) >= int(prev.get("reviews_last_90d") or 0):
            products_by_id[lid] = p

    shops_by_url: dict[str, dict] = {}
    shops_by_name: dict[str, dict] = {}
    for s in shops:
        url = (s.get("shop_url") or "").rstrip("/").lower()
        name = (s.get("shop_name") or "").strip().lower()
        if url:
            shops_by_url[url] = s
        if name:
            shops_by_name[name] = s

    # Dedupe harvest by (country, listing_id) keeping best rank
    best_h: dict[tuple[str, str], dict] = {}
    for h in harvest:
        lid = (h.get("listing_id") or "").strip()
        country = (h.get("country") or "").lower()
        if not lid or not country:
            continue
        key = (country, lid)
        prev = best_h.get(key)
        if not prev or int(h.get("rank") or 9999) < int(prev.get("rank") or 9999):
            best_h[key] = h

    scored_rows: list[dict] = []
    for (country, lid), h in best_h.items():
        prod = products_by_id.get(lid)
        shop = None
        if prod:
            su = (prod.get("shop_url") or "").rstrip("/").lower()
            sn = (prod.get("shop_name") or h.get("shop") or "").strip().lower()
            shop = shops_by_url.get(su) or shops_by_name.get(sn)
        else:
            sn = (h.get("shop") or "").strip().lower()
            shop = shops_by_name.get(sn)

        cat = (prod or {}).get("category") or h.get("category") or "other_wood"
        score = listing_market_score(h, prod, shop)
        price = _fprice((prod or {}).get("price") or h.get("price"))
        scored_rows.append({
            "country": country,
            "listing_id": lid,
            "title": (prod or {}).get("title") or h.get("title"),
            "url": (prod or {}).get("url") or h.get("url"),
            "category": cat,
            "price": price,
            "currency": (prod or {}).get("currency") or h.get("currency"),
            "rank": int(h.get("rank") or 0),
            "signals": h.get("signals"),
            "reviews_last_30d": int((prod or {}).get("reviews_last_30d") or 0),
            "reviews_last_90d": int((prod or {}).get("reviews_last_90d") or 0),
            "review_count": int((prod or {}).get("review_count") or 0),
            "shop_sales": int((shop or {}).get("sales_count") or 0),
            "market_score": score,
            "makeable": cat in MAKEABLE,
        })

    def by_country(cc: str) -> dict[str, Any]:
        rows = [r for r in scored_rows if r["country"] == cc]
        cat_scores: dict[str, float] = defaultdict(float)
        cat_n: dict[str, int] = defaultdict(int)
        cat_prices: dict[str, list[float]] = defaultdict(list)
        cat_r30: dict[str, int] = defaultdict(int)
        examples: dict[str, list[dict]] = defaultdict(list)

        for r in rows:
            cat = r["category"]
            cat_scores[cat] += r["market_score"]
            cat_n[cat] += 1
            if r["price"] is not None:
                cat_prices[cat].append(r["price"])
            cat_r30[cat] += r["reviews_last_30d"]
            if len(examples[cat]) < 5:
                examples[cat].append({
                    "title": r["title"],
                    "url": r["url"],
                    "price": r["price"],
                    "rank": r["rank"],
                    "market_score": r["market_score"],
                    "reviews_last_30d": r["reviews_last_30d"],
                    "reviews_last_90d": r["reviews_last_90d"],
                })

        ranked_cats = sorted(cat_scores.items(), key=lambda x: -x[1])
        product_types = []
        for cat, pts in ranked_cats:
            prices = cat_prices.get(cat) or []
            product_types.append({
                "category": cat,
                "noise_points": round(pts, 2),
                "listing_count": cat_n[cat],
                "reviews_last_30d_sum": cat_r30[cat],
                "median_price": round(statistics.median(prices), 2) if prices else None,
                "makeable": cat in MAKEABLE,
                "examples": sorted(
                    examples[cat], key=lambda e: -e["market_score"]
                ),
            })

        top_listings = sorted(rows, key=lambda r: -r["market_score"])[:25]
        return {
            "listing_count": len(rows),
            "product_types": product_types,
            "top_listings": top_listings,
        }

    us = by_country("us")
    ca = by_country("ca")

    # Combined Wave 1 shortlist: makeable cats with strong US+CA noise
    combined_cat: dict[str, float] = defaultdict(float)
    for block in (us, ca):
        for pt in block["product_types"]:
            if pt["makeable"]:
                combined_cat[pt["category"]] += pt["noise_points"]

    wave1 = []
    for cat, pts in sorted(combined_cat.items(), key=lambda x: -x[1])[:10]:
        us_pt = next((p for p in us["product_types"] if p["category"] == cat), None)
        ca_pt = next((p for p in ca["product_types"] if p["category"] == cat), None)
        wave1.append({
            "category": cat,
            "combined_noise": round(pts, 2),
            "us_noise": (us_pt or {}).get("noise_points"),
            "ca_noise": (ca_pt or {}).get("noise_points"),
            "us_median_price": (us_pt or {}).get("median_price"),
            "ca_median_price": (ca_pt or {}).get("median_price"),
            "us_reviews_30d": (us_pt or {}).get("reviews_last_30d_sum"),
            "ca_reviews_30d": (ca_pt or {}).get("reviews_last_30d_sum"),
            "example_us": ((us_pt or {}).get("examples") or [None])[0],
            "example_ca": ((ca_pt or {}).get("examples") or [None])[0],
        })

    # Seller origin intel from deep-scrape ships_from + shop location
    ships_ctr: dict[str, int] = defaultdict(int)
    for p in products_by_id.values():
        sf = (p.get("ships_from") or "").strip()
        if sf:
            ships_ctr[sf] += 1
    # Prefer URL-keyed unique shops; fall back to name map if URLs missing
    unique_shops = list(shops_by_url.values()) or list(shops_by_name.values())
    loc_ctr: dict[str, int] = defaultdict(int)
    for s in unique_shops:
        loc = (s.get("location") or "").strip()
        if loc:
            loc_ctr[loc] += 1
    seller_intel = {
        "products_with_ships_from": sum(ships_ctr.values()),
        "shops_with_location": sum(loc_ctr.values()),
        "ships_from_top": sorted(
            [{"origin": k, "listings": v} for k, v in ships_ctr.items()],
            key=lambda x: -x["listings"],
        )[:30],
        "shop_location_top": sorted(
            [{"location": k, "shops": v} for k, v in loc_ctr.items()],
            key=lambda x: -x["shops"],
        )[:30],
    }

    summary = {
        "source": {
            "harvest_rows": len(harvest),
            "unique_harvest": len(best_h),
            "products": len(products_by_id),
            "shops": len(unique_shops),
        },
        "us": us,
        "ca": ca,
        "wave1_makeable_shortlist": wave1,
        "seller_intel": seller_intel,
        "scoring_notes": (
            "market_score weights: bestseller rank, badges, "
            "reviews_last_30d (heavy), reviews_last_90d, light lifetime reviews, "
            "shop sales. Exact unit sales are not public."
        ),
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    write_run_state({"summary_path": str(SUMMARY_PATH), "wave1": [w["category"] for w in wave1]})
    return summary


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Summarize US/CA Etsy market demand")
    ap.add_argument("--harvest", type=Path, default=HARVEST_CSV)
    ap.add_argument("--products", type=Path, default=PRODUCT_JSONL)
    ap.add_argument("--shops", type=Path, default=SHOP_JSONL)
    args = ap.parse_args(argv)

    summary = summarize(args.harvest, args.products, args.shops)
    log.info("Wrote %s", SUMMARY_PATH)
    print("\nWave 1 makeable shortlist:")
    for w in summary["wave1_makeable_shortlist"]:
        print(
            f"  {w['category']:20} combined={w['combined_noise']} "
            f"US30d={w['us_reviews_30d']} CA30d={w['ca_reviews_30d']} "
            f"medUS=${w['us_median_price']} medCA=${w['ca_median_price']}"
        )
    si = summary.get("seller_intel") or {}
    print(
        f"\nSeller intel: ships_from={si.get('products_with_ships_from', 0)} "
        f"shop_locations={si.get('shops_with_location', 0)}"
    )
    for row in (si.get("ships_from_top") or [])[:10]:
        print(f"  ships_from {row['origin']!r}: {row['listings']}")
    for row in (si.get("shop_location_top") or [])[:10]:
        print(f"  shop_loc {row['location']!r}: {row['shops']}")
    print(f"\nFull summary: {SUMMARY_PATH}")


if __name__ == "__main__":
    main()
