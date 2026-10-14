import fs from "fs";
import { ensureMemoryDir } from "./loadSummary";
import { MEMORY_DIR } from "./paths";
import type { BusinessMemory } from "./types";

export const DEFAULT_BUSINESS: BusinessMemory = {
  brand: "Sample vertical: makeable hardwood housewares (teak / acacia)",
  materials: ["teak", "acacia", "mahogany (secondary)"],
  wave1_categories: [
    "cutting_board",
    "kitchen_utensils",
    "coasters_slices",
    "bowls_trays",
    "shelves_hooks",
    "frames",
    "other_wood",
  ],
  prefer: [
    "cutting boards",
    "utensils",
    "risers/trays",
    "coasters",
    "frames",
    "hooks/shelves that are makeable overseas with long ship times",
  ],
  avoid: [
    "toys",
    "treating other_wood as an automatic production SKU",
    "slab/door/table noise without a clear makeable SKU",
  ],
  compliance_notes: [
    "Do not invent Lacey Act or food-contact certificates.",
    "Footnote compliance needs; never claim certifications you do not have.",
  ],
  scoring_caveats: [
    "Scores are demand proxies (rank, badges, recent reviews), not verified unit sales.",
    "US-heavy runs may have empty CA — say so explicitly.",
    "seller_intel location strings are often marketing blurbs.",
  ],
};

export function loadBusinessMemory(): BusinessMemory {
  ensureMemoryDir();
  const p = `${MEMORY_DIR}/business.json`;
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(DEFAULT_BUSINESS, null, 2));
    return DEFAULT_BUSINESS;
  }
  try {
    return { ...DEFAULT_BUSINESS, ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {
    return DEFAULT_BUSINESS;
  }
}
