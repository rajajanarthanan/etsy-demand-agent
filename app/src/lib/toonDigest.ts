import fs from "fs";
import { encode } from "@toon-format/toon";
import { ensureMemoryDir } from "./loadSummary";
import { MEMORY_DIR } from "./paths";
import type { MarketDemandSummary } from "./types";

/** Compact projection of the summary for LLM context (TOON). */
export function buildDigestObject(summary: MarketDemandSummary) {
  return {
    source: summary.source,
    us: {
      listing_count: summary.us?.listing_count ?? 0,
      product_types: (summary.us?.product_types ?? []).map((t) => ({
        category: t.category,
        noise_points: t.noise_points,
        listing_count: t.listing_count,
        reviews_last_30d_sum: t.reviews_last_30d_sum,
        median_price: t.median_price,
        makeable: t.makeable,
        examples: (t.examples ?? []).slice(0, 3).map((e) => ({
          title: e.title,
          url: e.url,
          price: e.price,
          market_score: e.market_score,
          reviews_last_30d: e.reviews_last_30d,
        })),
      })),
      top_listings: (summary.us?.top_listings ?? []).slice(0, 8).map((e) => ({
        title: e.title,
        url: e.url,
        price: e.price,
        market_score: e.market_score,
        reviews_last_30d: e.reviews_last_30d,
      })),
    },
    ca: {
      listing_count: summary.ca?.listing_count ?? 0,
      product_types: (summary.ca?.product_types ?? []).slice(0, 8).map((t) => ({
        category: t.category,
        noise_points: t.noise_points,
        listing_count: t.listing_count,
        median_price: t.median_price,
      })),
    },
    wave1_makeable_shortlist: (summary.wave1_makeable_shortlist ?? []).map(
      (r) => ({
        category: r.category,
        combined_noise: r.combined_noise,
        us_noise: r.us_noise,
        ca_noise: r.ca_noise,
        us_median_price: r.us_median_price,
        us_reviews_30d: r.us_reviews_30d,
        example_us: r.example_us
          ? {
              title: r.example_us.title,
              url: r.example_us.url,
              price: r.example_us.price,
              market_score: r.example_us.market_score,
            }
          : null,
      }),
    ),
    seller_intel: {
      products_with_ships_from:
        summary.seller_intel?.products_with_ships_from ?? 0,
      shops_with_location: summary.seller_intel?.shops_with_location ?? 0,
      ships_from_top: (summary.seller_intel?.ships_from_top ?? []).slice(0, 12),
      shop_location_top: (summary.seller_intel?.shop_location_top ?? []).slice(
        0,
        30,
      ),
    },
    scoring_notes: summary.scoring_notes,
  };
}

export function writeRunDigest(summary: MarketDemandSummary): string {
  ensureMemoryDir();
  const digest = buildDigestObject(summary);
  const toon = encode(digest);
  const out = `${MEMORY_DIR}/run_digest.toon`;
  fs.writeFileSync(out, toon);
  return out;
}

export function readRunDigest(): string | null {
  const p = `${MEMORY_DIR}/run_digest.toon`;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

/** Always rebuild digest from the live summary (avoids stale pre-backfill memory). */
export function refreshRunDigest(summary: MarketDemandSummary): string {
  return writeRunDigest(summary);
}
