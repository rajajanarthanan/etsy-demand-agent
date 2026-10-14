import { NextResponse } from "next/server";
import { loadSummary } from "@/lib/loadSummary";
import {
  appendNote,
  memoryStatus,
  readNotes,
  reindexMemory,
} from "@/lib/memory";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    status: memoryStatus(),
    notes: readNotes(),
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action?: "reindex" | "remember";
    text?: string;
    category?: string;
    tags?: string[];
  };

  if (body.action === "remember") {
    if (!body.text?.trim()) {
      return NextResponse.json(
        { ok: false, error: "text required" },
        { status: 400 },
      );
    }
    const note = appendNote(body.text.trim(), {
      category: body.category,
      tags: body.tags,
    });
    // Best-effort reindex so the note is retrievable
    try {
      await reindexMemory(loadSummary().summary);
    } catch {
      /* note still saved */
    }
    return NextResponse.json({ ok: true, note, status: memoryStatus() });
  }

  const loaded = loadSummary();
  const result = await reindexMemory(loaded.summary);
  return NextResponse.json({
    ok: true,
    ...result,
    status: memoryStatus(),
  });
}
