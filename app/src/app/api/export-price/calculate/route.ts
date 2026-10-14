import { NextResponse } from "next/server";
import { calculateExportPrice } from "@/lib/exportPrice";
import { calculateRequestSchema } from "@/lib/exportPrice/schema";
import type { ExportPriceInput } from "@/lib/exportPrice/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = calculateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data as ExportPriceInput;
    const result = calculateExportPrice(input);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
