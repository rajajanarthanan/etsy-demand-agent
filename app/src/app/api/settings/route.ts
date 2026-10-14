import { NextResponse } from "next/server";
import { readSecrets, secretsPublicView, writeSecrets } from "@/lib/secrets";
import type { DeskSecrets } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    ...secretsPublicView(readSecrets()),
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    openaiApiKey?: string;
    scrapeOpsApiKey?: string;
    dataimpulseLogin?: string;
    dataimpulsePassword?: string;
    dataimpulseHost?: string;
    dataimpulsePort?: number;
    clearOpenAI?: boolean;
    clearScrapeOps?: boolean;
  };

  const patch: DeskSecrets = {};
  if (body.clearOpenAI) patch.openaiApiKey = "";
  else if (typeof body.openaiApiKey === "string" && body.openaiApiKey.trim()) {
    patch.openaiApiKey = body.openaiApiKey.trim();
  }
  if (body.clearScrapeOps) patch.scrapeOpsApiKey = "";
  else if (
    typeof body.scrapeOpsApiKey === "string" &&
    body.scrapeOpsApiKey.trim()
  ) {
    patch.scrapeOpsApiKey = body.scrapeOpsApiKey.trim();
  }

  patch.dataimpulse = {};
  if (typeof body.dataimpulseLogin === "string" && body.dataimpulseLogin.trim()) {
    patch.dataimpulse.login = body.dataimpulseLogin.trim();
  }
  if (typeof body.dataimpulsePassword === "string" && body.dataimpulsePassword) {
    patch.dataimpulse.password = body.dataimpulsePassword;
  }
  if (typeof body.dataimpulseHost === "string" && body.dataimpulseHost.trim()) {
    patch.dataimpulse.host = body.dataimpulseHost.trim();
  }
  if (typeof body.dataimpulsePort === "number" && body.dataimpulsePort > 0) {
    patch.dataimpulse.port = body.dataimpulsePort;
  }

  const saved = writeSecrets(patch);
  return NextResponse.json({
    ok: true,
    ...secretsPublicView(saved),
  });
}
