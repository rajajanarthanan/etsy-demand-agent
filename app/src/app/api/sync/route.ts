import { NextResponse } from "next/server";
import {
  cancelSync,
  readSyncStatus,
  startSync,
} from "@/lib/scrapeOrchestrator";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, sync: readSyncStatus() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: "start" | "cancel";
    countries?: string;
    pages?: number;
    skipHarvest?: boolean;
    skipDeep?: boolean;
  };

  if (body.action === "cancel") {
    return NextResponse.json({ ok: true, sync: cancelSync() });
  }

  const sync = await startSync({
    countries: body.countries,
    pages: body.pages,
    skipHarvest: body.skipHarvest,
    skipDeep: body.skipDeep,
  });
  return NextResponse.json({ ok: true, sync });
}
