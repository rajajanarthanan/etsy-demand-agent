import { NextResponse } from "next/server";
import {
  analyzeListingUrl,
  estimateProductionCostInr,
} from "@/lib/exportPrice";
import { analyzeRequestSchema } from "@/lib/exportPrice/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = analyzeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { url, fxUsdInr } = parsed.data;
    const analyzed = await analyzeListingUrl(url);

    let productionEstimate = analyzed.productionEstimate;
    if (
      analyzed.evidence?.price != null &&
      fxUsdInr &&
      (analyzed.evidence.currency ?? "USD").toUpperCase() === "USD"
    ) {
      productionEstimate = estimateProductionCostInr(
        analyzed.evidence,
        analyzed.evidence.price * fxUsdInr,
      );
    }

    return NextResponse.json({
      ok: true,
      evidence: analyzed.evidence,
      productionEstimate,
      warnings: analyzed.warnings,
      notes: [
        "AI/fetch may extract evidence only. All selling-price arithmetic must go through /api/export-price/calculate.",
        "Production cost estimates are labelled estimates — replace with known mill cost when available.",
      ],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
