import type { MarketDemandSummary, Wave1Row } from "./types";

function fmtPrice(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "n/a";
  return `$${n.toFixed(2)}`;
}

function topMakeable(wave1: Wave1Row[], limit = 5): Wave1Row[] {
  return wave1
    .filter((r) => r.category !== "other_wood")
    .slice(0, limit);
}

export function buildBriefing(summary: MarketDemandSummary): {
  executive: string;
  operator: string;
  caveats: string[];
} {
  const usCount = summary.us?.listing_count ?? 0;
  const caCount = summary.ca?.listing_count ?? 0;
  const wave1 = summary.wave1_makeable_shortlist ?? [];
  const clear = topMakeable(wave1, 5);
  const otherWood = wave1.find((r) => r.category === "other_wood");
  const topClear = clear[0];

  const executive = [
    `Dataset covers ${summary.source?.products ?? usCount} products across ${summary.source?.shops ?? "?"} shops (${summary.source?.harvest_rows ?? "?"} harvest rows).`,
    `US listings scored: ${usCount}. Canada listings scored: ${caCount}${caCount === 0 ? " (no CA signal in this file — do not invent one)." : "."}`,
    topClear
      ? `Clearest Wave‑1 makeable leader after filtering catch-alls: ${topClear.category} (combined noise ${topClear.combined_noise.toFixed(1)}, US median ${fmtPrice(topClear.us_median_price)}, 30d reviews ${topClear.us_reviews_30d ?? 0}).`
      : "Wave‑1 shortlist is empty or only catch-all categories.",
    otherWood
      ? `Note: other_wood leads raw noise (${otherWood.combined_noise.toFixed(1)}) but is a catch-all — treat as junk filter, not a SKU brief.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const operatorLines = [
    "Operator shortlist (makeable, excluding other_wood):",
    ...clear.map(
      (r, i) =>
        `${i + 1}. ${r.category} — noise ${r.combined_noise.toFixed(1)}, median ${fmtPrice(r.us_median_price)}, reviews_30d ${r.us_reviews_30d ?? 0}` +
        (r.example_us?.title
          ? ` · e.g. “${r.example_us.title.slice(0, 72)}${r.example_us.title.length > 72 ? "…" : ""}”`
          : ""),
    ),
    summary.scoring_notes
      ? `Scoring: ${summary.scoring_notes}`
      : "Scoring: proxy ranks/reviews — not verified unit sales.",
  ];

  const caveats: string[] = [];
  if (caCount === 0) caveats.push("Canada slice is empty in this run.");
  if (otherWood) {
    caveats.push(
      "other_wood dominates noise but mixes unrelated wood goods — prefer named Wave‑1 SKUs for production.",
    );
  }
  caveats.push(
    "Market scores are proxies (rank, badges, recent reviews). Exact Etsy unit sales are not public.",
  );
  caveats.push(
    "ships_from / shop location strings are often marketing blurbs — summarize cautiously.",
  );

  return {
    executive,
    operator: operatorLines.join("\n"),
    caveats,
  };
}

export function chartCategoryNoise(summary: MarketDemandSummary) {
  const types = summary.us?.product_types ?? [];
  return types
    .slice()
    .sort((a, b) => b.noise_points - a.noise_points)
    .slice(0, 12)
    .map((t) => ({
      category: t.category,
      noise: Math.round(t.noise_points * 10) / 10,
      listings: t.listing_count,
      makeable: t.makeable,
    }));
}

export function chartPriceBands(summary: MarketDemandSummary) {
  const types = summary.us?.product_types ?? [];
  return types
    .filter((t) => t.median_price != null)
    .slice()
    .sort((a, b) => (a.median_price ?? 0) - (b.median_price ?? 0))
    .map((t) => ({
      category: t.category,
      medianPrice: t.median_price as number,
      listings: t.listing_count,
    }));
}
