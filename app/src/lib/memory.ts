import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { loadBusinessMemory } from "./business";
import { ensureMemoryDir, loadSummary } from "./loadSummary";
import { MEMORY_DIR } from "./paths";
import { readSecrets } from "./secrets";
import { shopsInIndia } from "./sellers";
import { writeRunDigest } from "./toonDigest";
import type { MarketDemandSummary, MemoryNote } from "./types";

const VECTORS_DB = () => path.join(MEMORY_DIR, "vectors.sqlite");
const NOTES_PATH = () => path.join(MEMORY_DIR, "notes.jsonl");

export type MemoryChunk = {
  id: string;
  kind: string;
  text: string;
};

function openDb() {
  ensureMemoryDir();
  const db = new Database(VECTORS_DB());
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT
    );
  `);
  return db;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function readNotes(): MemoryNote[] {
  ensureMemoryDir();
  const p = NOTES_PATH();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MemoryNote);
}

export function appendNote(text: string, meta?: Partial<MemoryNote>): MemoryNote {
  ensureMemoryDir();
  const note: MemoryNote = {
    id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    text,
    tags: meta?.tags,
    category: meta?.category,
    run_id: meta?.run_id,
  };
  fs.appendFileSync(NOTES_PATH(), JSON.stringify(note) + "\n");
  return note;
}

export function buildChunks(summary: MarketDemandSummary): MemoryChunk[] {
  const business = loadBusinessMemory();
  const chunks: MemoryChunk[] = [
    {
      id: "business_rules",
      kind: "business",
      text: [
        `Brand context: ${business.brand}`,
        `Materials: ${business.materials.join(", ")}`,
        `Wave-1 categories: ${business.wave1_categories.join(", ")}`,
        `Prefer: ${business.prefer.join("; ")}`,
        `Avoid: ${business.avoid.join("; ")}`,
        `Compliance: ${business.compliance_notes.join(" ")}`,
        `Scoring caveats: ${business.scoring_caveats.join(" ")}`,
      ].join("\n"),
    },
    {
      id: "scoring_notes",
      kind: "scoring",
      text: summary.scoring_notes || "Proxy scores only; no exact unit sales.",
    },
  ];

  for (const t of summary.us?.product_types ?? []) {
    chunks.push({
      id: `cat_us_${t.category}`,
      kind: "category",
      text: `US category ${t.category}: noise ${t.noise_points}, listings ${t.listing_count}, reviews_30d_sum ${t.reviews_last_30d_sum}, median_price ${t.median_price}, makeable=${t.makeable}. Examples: ${(t.examples ?? [])
        .slice(0, 3)
        .map((e) => `${e.title} (${e.url}) score=${e.market_score}`)
        .join("; ")}`,
    });
  }

  for (const r of summary.wave1_makeable_shortlist ?? []) {
    chunks.push({
      id: `wave1_${r.category}`,
      kind: "wave1",
      text: `Wave-1 ${r.category}: combined_noise ${r.combined_noise}, us_noise ${r.us_noise}, ca_noise ${r.ca_noise}, us_median ${r.us_median_price}, us_reviews_30d ${r.us_reviews_30d}. Example US: ${r.example_us?.title ?? "n/a"} ${r.example_us?.url ?? ""}`,
    });
  }

  const ships = (summary.seller_intel?.ships_from_top ?? []).slice(0, 10);
  if (ships.length) {
    chunks.push({
      id: "seller_ships_from",
      kind: "seller_intel",
      text: `Top ships_from (often marketing blurbs): ${ships
        .map((s) => `${s.origin} (${s.listings})`)
        .join("; ")}`,
    });
  }

  const locs = (summary.seller_intel?.shop_location_top ?? []).slice(0, 30);
  if (locs.length) {
    chunks.push({
      id: "seller_shop_locations",
      kind: "seller_intel",
      text: `Shop locations (${summary.seller_intel?.shops_with_location ?? locs.length} shops with location): ${locs
        .map((s) => `${s.location} (${s.shops})`)
        .join("; ")}`,
    });
  }

  const india = shopsInIndia(40);
  if (india.length) {
    chunks.push({
      id: "sellers_india",
      kind: "seller_geo",
      text: `India-based shops (${india.length}): ${india
        .map(
          (s) =>
            `${s.shop_name} @ ${s.location} sales=${s.sales_count} ${s.shop_url}`,
        )
        .join("; ")}`,
    });
  }

  for (const n of readNotes()) {
    chunks.push({
      id: n.id,
      kind: "note",
      text: `Analyst note (${n.created_at}${n.category ? `, ${n.category}` : ""}): ${n.text}`,
    });
  }

  return chunks;
}

export async function reindexMemory(summary?: MarketDemandSummary): Promise<{
  chunks: number;
  embedded: number;
}> {
  const loaded = summary ?? loadSummary().summary;
  writeRunDigest(loaded);
  const chunks = buildChunks(loaded);
  const db = openDb();
  const upsert = db.prepare(
    `INSERT INTO chunks (id, kind, text, embedding) VALUES (@id, @kind, @text, @embedding)
     ON CONFLICT(id) DO UPDATE SET kind=@kind, text=@text, embedding=COALESCE(@embedding, embedding)`,
  );

  const secrets = readSecrets();
  let embedded = 0;

  if (secrets.openaiApiKey) {
    const openai = createOpenAI({ apiKey: secrets.openaiApiKey });
    const model = openai.embedding("text-embedding-3-small");
    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      try {
        const { embeddings } = await embedMany({
          model,
          values: batch.map((c) => c.text),
        });
        const tx = db.transaction(() => {
          batch.forEach((c, idx) => {
            upsert.run({
              id: c.id,
              kind: c.kind,
              text: c.text,
              embedding: JSON.stringify(embeddings[idx]),
            });
            embedded++;
          });
        });
        tx();
      } catch {
        const tx = db.transaction(() => {
          for (const c of batch) {
            upsert.run({
              id: c.id,
              kind: c.kind,
              text: c.text,
              embedding: null,
            });
          }
        });
        tx();
      }
    }
  } else {
    const tx = db.transaction(() => {
      for (const c of chunks) {
        upsert.run({
          id: c.id,
          kind: c.kind,
          text: c.text,
          embedding: null,
        });
      }
    });
    tx();
  }

  // Drop stale ids
  const ids = new Set(chunks.map((c) => c.id));
  const all = db.prepare(`SELECT id FROM chunks`).all() as { id: string }[];
  const del = db.prepare(`DELETE FROM chunks WHERE id = ?`);
  for (const row of all) {
    if (!ids.has(row.id)) del.run(row.id);
  }
  db.close();
  return { chunks: chunks.length, embedded };
}

export async function retrieveMemory(
  query: string,
  k = 8,
): Promise<MemoryChunk[]> {
  ensureMemoryDir();
  if (!fs.existsSync(VECTORS_DB())) {
    await reindexMemory();
  }
  const db = openDb();
  const rows = db
    .prepare(`SELECT id, kind, text, embedding FROM chunks`)
    .all() as {
    id: string;
    kind: string;
    text: string;
    embedding: string | null;
  }[];
  db.close();

  if (!rows.length) return [];

  const secrets = readSecrets();
  if (secrets.openaiApiKey) {
    try {
      const openai = createOpenAI({ apiKey: secrets.openaiApiKey });
      const { embedding } = await embed({
        model: openai.embedding("text-embedding-3-small"),
        value: query,
      });
      const scored = rows
        .map((r) => {
          const vec = r.embedding ? (JSON.parse(r.embedding) as number[]) : null;
          return {
            id: r.id,
            kind: r.kind,
            text: r.text,
            score: vec ? cosine(embedding, vec) : 0,
          };
        })
        .sort((a, b) => b.score - a.score);
      const top = scored.filter((s) => s.score > 0).slice(0, k);
      if (top.length) return top;
    } catch {
      // fall through to keyword
    }
  }

  const q = query.toLowerCase();
  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      score: q
        .split(/\s+/)
        .filter(Boolean)
        .reduce((acc, w) => acc + (r.text.toLowerCase().includes(w) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function memoryStatus() {
  ensureMemoryDir();
  const notes = readNotes();
  const hasDigest = fs.existsSync(path.join(MEMORY_DIR, "run_digest.toon"));
  const hasVectors = fs.existsSync(VECTORS_DB());
  let chunkCount = 0;
  if (hasVectors) {
    const db = openDb();
    chunkCount = (
      db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }
    ).c;
    db.close();
  }
  return {
    notes: notes.length,
    hasDigest,
    hasVectors,
    chunkCount,
    memoryDir: MEMORY_DIR,
  };
}
