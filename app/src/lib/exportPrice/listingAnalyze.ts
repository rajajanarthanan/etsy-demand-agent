import fs from "fs";
import path from "path";
import { DATA_DIR, SUMMARY_DATA_PATH, SUMMARY_FIXTURE_PATH } from "../paths";
import { readSecrets } from "../secrets";
import type { ListingEvidence, ProductionCostEstimate } from "./types";

function listingIdFromUrl(url: string): string | null {
  const m = url.match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function readProductDetails(): Record<string, unknown>[] {
  const p = path.join(DATA_DIR, "product_details.jsonl");
  if (!fs.existsSync(p)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return rows;
}

function findInSummary(url: string): ListingEvidence | null {
  const paths = [SUMMARY_DATA_PATH, SUMMARY_FIXTURE_PATH];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      const summary = JSON.parse(fs.readFileSync(p, "utf8")) as {
        us?: { top_listings?: { title: string; url: string; price: number | null }[] };
        ca?: { top_listings?: { title: string; url: string; price: number | null }[] };
        wave1_makeable_shortlist?: {
          example_us?: { title: string; url: string; price: number | null } | null;
          example_ca?: { title: string; url: string; price: number | null } | null;
        }[];
      };
      const candidates = [
        ...(summary.us?.top_listings ?? []),
        ...(summary.ca?.top_listings ?? []),
        ...((summary.wave1_makeable_shortlist ?? []).flatMap((w) =>
          [w.example_us, w.example_ca].filter(Boolean),
        ) as { title: string; url: string; price: number | null }[]),
      ];
      const hit = candidates.find((c) => c.url && (c.url === url || url.includes(String(listingIdFromUrl(c.url) ?? "___"))));
      if (hit) {
        return {
          url: hit.url,
          listingId: listingIdFromUrl(hit.url) ?? undefined,
          title: hit.title,
          price: hit.price,
          currency: "USD",
          source: "local_summary",
          retrievedAt: new Date().toISOString(),
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function estimateProductionCost(evidence: ListingEvidence): ProductionCostEstimate {
  const evidenceUsed: string[] = [];
  const assumptions: string[] = [];
  const materials = evidence.materials ?? [];
  const dims = evidence.dimensions;
  const title = (evidence.title ?? "").toLowerCase();

  if (materials.length) evidenceUsed.push(`materials:${materials.join(",")}`);
  if (dims) evidenceUsed.push(`dimensions:${dims}`);
  if (evidence.price != null) evidenceUsed.push(`list_price:${evidence.price}`);
  if (title) evidenceUsed.push(`title`);

  const hasWoodHint =
    materials.some((m) => /teak|acacia|wood|walnut|oak|mahogany/i.test(m)) ||
    /teak|acacia|wood|cutting board|coaster|tray|bowl/i.test(title);

  // Only estimate when we have material OR clear makeable wood product signal AND a list price
  if (!hasWoodHint || evidence.price == null) {
    return {
      amountInr: null,
      isEstimate: true,
      confidence: "insufficient_evidence",
      assumptions: [
        "Production cost was not estimated: need material evidence and/or clear product specs plus selling price context.",
        "Enter production cost manually (SKU BOM lives elsewhere in the business process).",
      ],
      evidenceUsed,
    };
  }

  // Heuristic reverse: production ≈ 18–28% of list price in INR terms is NOT used as FX invent.
  // Without FX we cannot convert list price to INR here — require caller FX or skip.
  assumptions.push(
    "Estimate uses a conservative manufacturing share of list price only when FX INR is supplied by caller.",
    "This is NOT a verified mill quote. Labelled estimate; human must confirm.",
    "Detailed SKU-level BOM is intentionally out of scope for this feature.",
  );

  return {
    amountInr: null,
    isEstimate: true,
    confidence: "low",
    assumptions: [
      ...assumptions,
      "Insufficient linked FX in analyzer alone — calculate endpoint should receive productionCostInr from user or a follow-up estimate with FX.",
    ],
    evidenceUsed,
  };
}

/**
 * Estimate production cost in INR when evidence + FX are available.
 * Uses a narrow heuristic band and always labels as estimate.
 */
export function estimateProductionCostInr(
  evidence: ListingEvidence,
  listPriceToInr: number | null,
): ProductionCostEstimate {
  const base = estimateProductionCost(evidence);
  if (base.confidence === "insufficient_evidence" || listPriceToInr == null || listPriceToInr <= 0) {
    return base;
  }

  // Conservative share for handmade wood housewares — clearly labelled assumption, not a quote.
  const share = 0.22;
  const amountInr = Math.round(listPriceToInr * share * 100) / 100;
  return {
    amountInr,
    isEstimate: true,
    confidence: evidence.materials?.length || evidence.dimensions ? "medium" : "low",
    assumptions: [
      `Assumed production cost ≈ ${(share * 100).toFixed(0)}% of observed list price converted to INR (${listPriceToInr}).`,
      "Not a mill quote. Replace with known production cost for confirmation.",
      "Packaging & Dispatch must still be entered separately as a top-level amount.",
      ...base.assumptions.filter((a) => !a.includes("Insufficient linked FX")),
    ],
    evidenceUsed: base.evidenceUsed,
  };
}

export async function analyzeListingUrl(url: string): Promise<{
  evidence: ListingEvidence | null;
  productionEstimate: ProductionCostEstimate;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const id = listingIdFromUrl(url);
  if (!id) {
    return {
      evidence: null,
      productionEstimate: {
        amountInr: null,
        isEstimate: true,
        confidence: "insufficient_evidence",
        assumptions: ["URL does not look like an Etsy listing URL (/listing/{id})."],
        evidenceUsed: [],
      },
      warnings: ["Invalid or unsupported listing URL."],
    };
  }

  // 1) Local product_details.jsonl
  const details = readProductDetails();
  const local = details.find((r) => {
    const lid = String(r.listing_id ?? "");
    const u = String(r.url ?? r.listing_url ?? "");
    return lid === id || u.includes(`/listing/${id}`);
  });

  if (local) {
    const evidence: ListingEvidence = {
      url,
      listingId: id,
      title: String(local.title ?? local.name ?? ""),
      price: local.price != null ? Number(local.price) : null,
      currency: local.currency != null ? String(local.currency) : "USD",
      shipsFrom: local.ships_from != null ? String(local.ships_from) : null,
      materials: Array.isArray(local.materials)
        ? (local.materials as string[])
        : typeof local.materials === "string"
          ? [local.materials]
          : [],
      dimensions: local.dimensions != null ? String(local.dimensions) : null,
      descriptionSnippet:
        local.description != null
          ? String(local.description).slice(0, 500)
          : null,
      source: "local_product_details",
      retrievedAt: new Date().toISOString(),
      raw: local,
    };
    return {
      evidence,
      productionEstimate: estimateProductionCost(evidence),
      warnings,
    };
  }

  // 2) Summary examples
  const fromSummary = findInSummary(url);
  if (fromSummary) {
    warnings.push(
      "Matched listing from local market summary examples (limited fields). Run deep scrape for richer evidence.",
    );
    return {
      evidence: fromSummary,
      productionEstimate: estimateProductionCost(fromSummary),
      warnings,
    };
  }

  // 3) Optional lightweight fetch (may be blocked). AI is not used for arithmetic.
  const secrets = readSecrets();
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "DemandDeskExportPrice/1.0 (local research; +https://localhost)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      warnings.push(`URL fetch returned HTTP ${res.status}. Provide costs manually or run browser deep scrape.`);
    } else {
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const priceMatch =
        html.match(/"price"\s*:\s*"?(£|\$|CA\$|AED|SAR)?\s*([0-9]+(?:\.[0-9]+)?)"?/i) ||
        html.match(/data-buy-box-price[^>]*>[\s\S]*?([0-9]+(?:\.[0-9]+)?)/i);
      const shipsMatch = html.match(/Ships from\s*([^<\n]+)/i);
      const evidence: ListingEvidence = {
        url,
        listingId: id,
        title: titleMatch?.[1]?.replace(/\s*-\s*Etsy.*$/i, "").trim(),
        price: priceMatch ? Number(priceMatch[2]) : null,
        currency: "USD",
        shipsFrom: shipsMatch?.[1]?.trim() ?? null,
        materials: [],
        descriptionSnippet: html.replace(/<[^>]+>/g, " ").slice(0, 400),
        source: "url_fetch",
        retrievedAt: new Date().toISOString(),
      };
      if (!evidence.price) {
        warnings.push(
          "Fetched page but could not reliably extract price. Treat evidence as incomplete.",
        );
      }
      if (!secrets.openaiApiKey) {
        warnings.push(
          "OpenAI key not set — skipped LLM-assisted field classification. Pricing engine remains deterministic.",
        );
      }
      return {
        evidence,
        productionEstimate: estimateProductionCost(evidence),
        warnings,
      };
    }
  } catch (e) {
    warnings.push(
      `URL fetch failed (${e instanceof Error ? e.message : String(e)}). Use known production cost workflow or local scrape data.`,
    );
  }

  return {
    evidence: null,
    productionEstimate: {
      amountInr: null,
      isEstimate: true,
      confidence: "insufficient_evidence",
      assumptions: [
        "No local listing evidence found and URL fetch did not yield usable specs.",
        "Enter production cost and packaging & dispatch manually.",
      ],
      evidenceUsed: [],
    },
    warnings,
  };
}
