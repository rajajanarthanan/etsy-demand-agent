import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths";

export type ShopProfile = {
  shop_name: string;
  shop_url: string;
  location: string;
  sales_count: number;
  rating: string;
  admirers?: number;
};

/** Latest shop profile per URL from shop_profiles.jsonl */
export function loadLatestShopProfiles(): ShopProfile[] {
  const p = path.join(DATA_DIR, "shop_profiles.jsonl");
  if (!fs.existsSync(p)) return [];
  const latest = new Map<string, ShopProfile>();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const url = String(o.shop_url || "").split("?")[0];
      if (!url) continue;
      latest.set(url, {
        shop_name: String(o.shop_name || ""),
        shop_url: url,
        location: String(o.location || "").trim(),
        sales_count: Number(o.sales_count || 0),
        rating: String(o.rating || ""),
        admirers: Number(o.admirers || 0),
      });
    } catch {
      /* skip */
    }
  }
  return [...latest.values()];
}

const INDIA_RE =
  /\b(india|jaipur|jodhpur|rajasthan|mumbai|delhi|bangalore|bengaluru|chennai|hyderabad|pune|kolkata|kerala|gujarat)\b/i;

/** Exclude travel-blurb false positives (e.g. CA shop mentioning India). */
function isClearIndiaLocation(loc: string): boolean {
  if (!INDIA_RE.test(loc)) return false;
  if (/northern california|traveling nepal|collected from/i.test(loc)) {
    return false;
  }
  return true;
}

export function shopsInIndia(limit = 40): ShopProfile[] {
  return loadLatestShopProfiles()
    .filter((s) => isClearIndiaLocation(s.location))
    .sort((a, b) => b.sales_count - a.sales_count)
    .slice(0, limit);
}

export function queryLooksLikeSellerGeo(q: string): boolean {
  return /\b(india|indian|jaipur|seller|sellers|shop location|based in|ships from|country|geo)\b/i.test(
    q,
  );
}
