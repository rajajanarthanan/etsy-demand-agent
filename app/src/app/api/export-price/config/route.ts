import { NextResponse } from "next/server";
import { getPublicConfigSnapshot } from "@/lib/exportPrice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getPublicConfigSnapshot();
    return NextResponse.json({ ok: true, config });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
