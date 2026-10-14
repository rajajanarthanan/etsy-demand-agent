import { loadBusinessMemory } from "./business";
import { buildBriefing } from "./briefing";
import { loadSummary } from "./loadSummary";
import { retrieveMemory, type MemoryChunk } from "./memory";
import {
  queryLooksLikeSellerGeo,
  shopsInIndia,
} from "./sellers";
import { refreshRunDigest } from "./toonDigest";

export async function buildChatSystemPrompt(userQuery: string): Promise<{
  system: string;
  retrieved: MemoryChunk[];
}> {
  const { summary, source, path, runState, mtimeMs } = loadSummary();
  const business = loadBusinessMemory();
  const briefing = buildBriefing(summary);

  // Always refresh TOON from current summary so post-scrape intel is not stale
  const digest = refreshRunDigest(summary);

  const retrieved = await retrieveMemory(userQuery, 8);

  const si = summary.seller_intel;
  const sellerBlock = [
    `shops_with_location=${si?.shops_with_location ?? 0}`,
    `products_with_ships_from=${si?.products_with_ships_from ?? 0}`,
    "shop_location_top:",
    ...(si?.shop_location_top ?? []).slice(0, 25).map(
      (r) => `  - ${r.location}: ${r.shops} shops`,
    ),
  ].join("\n");

  let indiaBlock = "";
  if (queryLooksLikeSellerGeo(userQuery)) {
    const india = shopsInIndia(40);
    indiaBlock = [
      "",
      "## India-based shops (from shop_profiles location field; clear matches only)",
      `count=${india.length}`,
      ...india.map(
        (s) =>
          `- ${s.shop_name} | ${s.location} | sales=${s.sales_count} | ${s.shop_url}`,
      ),
      "Do not invent India sellers beyond this list. Travel-blurb locations are excluded.",
    ].join("\n");
  }

  const system = [
    "You are Demand Desk, a product-demand analyst for marketplace research (Etsy-focused wood housewares vertical by default).",
    "Ground every claim in the loaded dataset, business rules, run state, seller location intel, or retrieved memory. Cite shop names, locations, scores, prices, and listing/shop URLs when relevant.",
    "Never invent listings, unit sales, Canada insights when CA is empty, or compliance certificates.",
    "Prefer deterministic metrics; narrative second. Warn when other_wood is a catch-all.",
    "Seller location coverage comes from shop pages (sb-shop-location). If shops_with_location is high, you CAN answer geo questions from seller_intel and the India shop list when provided.",
    "",
    "## Business / plan context",
    JSON.stringify(business, null, 2),
    "",
    "## Dataset source",
    `source=${source} path=${path} summary_mtime_ms=${mtimeMs}`,
    "",
    "## Run state (scrape / job pointer)",
    runState ? JSON.stringify(runState, null, 2) : "(no run_state.json)",
    "",
    "## Executive briefing",
    briefing.executive,
    "",
    "## Operator briefing",
    briefing.operator,
    "",
    "## Caveats",
    briefing.caveats.map((c) => `- ${c}`).join("\n"),
    "",
    "## Live seller location intel",
    sellerBlock,
    indiaBlock,
    "",
    "## TOON run digest (compact market summary)",
    digest,
    "",
    "## Retrieved portable memory",
    retrieved.map((r) => `[${r.kind}/${r.id}] ${r.text}`).join("\n\n") ||
      "(none)",
    "",
    "If the user asks to remember something durable, acknowledge it and they can use the Remember control; do not pretend persistence without confirmation.",
  ].join("\n");

  return { system, retrieved };
}
