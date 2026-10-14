import fs from "fs";
import {
  FIXTURE_MEMORY_DIR,
  MEMORY_DIR,
  RUN_STATE_PATH,
  SUMMARY_DATA_PATH,
  SUMMARY_FIXTURE_PATH,
} from "./paths";
import type { MarketDemandSummary } from "./types";

export type LoadedSummary = {
  summary: MarketDemandSummary;
  path: string;
  source: "data" | "fixture";
  mtimeMs: number;
  runState: Record<string, unknown> | null;
};

export function loadSummary(): LoadedSummary {
  const preferData = fs.existsSync(SUMMARY_DATA_PATH);
  const path = preferData ? SUMMARY_DATA_PATH : SUMMARY_FIXTURE_PATH;
  if (!fs.existsSync(path)) {
    throw new Error(
      `No market demand summary found at ${SUMMARY_DATA_PATH} or ${SUMMARY_FIXTURE_PATH}`,
    );
  }
  const raw = fs.readFileSync(path, "utf8");
  const summary = JSON.parse(raw) as MarketDemandSummary;
  const stat = fs.statSync(path);
  let runState: Record<string, unknown> | null = null;
  if (fs.existsSync(RUN_STATE_PATH)) {
    try {
      runState = JSON.parse(fs.readFileSync(RUN_STATE_PATH, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      runState = null;
    }
  }
  return {
    summary,
    path,
    source: preferData ? "data" : "fixture",
    mtimeMs: stat.mtimeMs,
    runState,
  };
}

/** Ensure memory dir exists; seed from fixtures if empty. */
export function ensureMemoryDir(): string {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
  const businessTarget = `${MEMORY_DIR}/business.json`;
  if (!fs.existsSync(businessTarget) && fs.existsSync(`${FIXTURE_MEMORY_DIR}/business.json`)) {
    fs.copyFileSync(`${FIXTURE_MEMORY_DIR}/business.json`, businessTarget);
  }
  const notesTarget = `${MEMORY_DIR}/notes.jsonl`;
  if (!fs.existsSync(notesTarget) && fs.existsSync(`${FIXTURE_MEMORY_DIR}/notes.jsonl`)) {
    fs.copyFileSync(`${FIXTURE_MEMORY_DIR}/notes.jsonl`, notesTarget);
  }
  return MEMORY_DIR;
}
