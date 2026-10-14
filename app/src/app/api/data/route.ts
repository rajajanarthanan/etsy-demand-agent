import { NextResponse } from "next/server";
import {
  buildBriefing,
  chartCategoryNoise,
  chartPriceBands,
} from "@/lib/briefing";
import { ensureMemoryDir, loadSummary } from "@/lib/loadSummary";
import { loadBusinessMemory } from "@/lib/business";
import { memoryStatus } from "@/lib/memory";
import { readSyncStatus } from "@/lib/scrapeOrchestrator";
import { readSecrets, secretsPublicView } from "@/lib/secrets";
import { writeRunDigest } from "@/lib/toonDigest";

export const runtime = "nodejs";

export async function GET() {
  try {
    ensureMemoryDir();
    loadBusinessMemory();
    const loaded = loadSummary();
    // Keep digest in sync with latest summary (location backfill, re-summarize, etc.)
    writeRunDigest(loaded.summary);
    const briefing = buildBriefing(loaded.summary);
    return NextResponse.json({
      ok: true,
      source: loaded.source,
      path: loaded.path,
      mtimeMs: loaded.mtimeMs,
      mtimeIso: new Date(loaded.mtimeMs).toISOString(),
      runState: loaded.runState,
      summary: loaded.summary,
      briefing,
      charts: {
        categoryNoise: chartCategoryNoise(loaded.summary),
        priceBands: chartPriceBands(loaded.summary),
      },
      wave1: loaded.summary.wave1_makeable_shortlist ?? [],
      memory: memoryStatus(),
      sync: readSyncStatus(),
      keys: secretsPublicView(readSecrets()),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
