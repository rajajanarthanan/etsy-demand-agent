"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnalyticsCharts } from "./AnalyticsCharts";
import { ChatPanel } from "./ChatPanel";
import { SyncBar } from "./SyncBar";
import { Wave1Table } from "./Wave1Table";
import type { SyncStatus } from "@/lib/types";

type DeskPayload = {
  ok: boolean;
  source: "data" | "fixture";
  path: string;
  mtimeIso: string;
  briefing: {
    executive: string;
    operator: string;
    caveats: string[];
  };
  charts: {
    categoryNoise: {
      category: string;
      noise: number;
      listings: number;
      makeable: boolean;
    }[];
    priceBands: {
      category: string;
      medianPrice: number;
      listings: number;
    }[];
  };
  wave1: {
    category: string;
    combined_noise: number;
    us_noise: number | null;
    ca_noise: number | null;
    us_median_price: number | null;
    us_reviews_30d: number | null;
    example_us: { title: string; url: string; price: number | null } | null;
  }[];
  memory: {
    notes: number;
    hasDigest: boolean;
    chunkCount: number;
  };
  sync: SyncStatus;
  keys: { hasOpenAI: boolean };
  summary: {
    ca?: { listing_count: number };
    us?: { listing_count: number };
    source?: { products: number; shops: number };
  };
  error?: string;
};

export function DeskApp() {
  const [data, setData] = useState<DeskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      const json = (await res.json()) as DeskPayload;
      if (!json.ok) throw new Error(json.error || "Failed to load");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data?.sync?.running) return;
    const t = setInterval(async () => {
      const res = await fetch("/api/sync", { cache: "no-store" });
      const json = await res.json();
      setData((prev) =>
        prev ? { ...prev, sync: json.sync as SyncStatus } : prev,
      );
      if (json.sync && !json.sync.running && json.sync.phase === "done") {
        void load();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [data?.sync?.running, load]);

  async function startSync() {
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", countries: "us", pages: 1 }),
    });
    const res = await fetch("/api/sync");
    const json = await res.json();
    setData((prev) => (prev ? { ...prev, sync: json.sync } : prev));
  }

  async function cancelSync() {
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    const res = await fetch("/api/sync");
    const json = await res.json();
    setData((prev) => (prev ? { ...prev, sync: json.sync } : prev));
  }

  async function reindex() {
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reindex" }),
    });
    await load();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1 className="brand">
            Demand <span>Desk</span>
          </h1>
          <p className="tagline">
            Market demand briefing, analytics, and grounded analyst chat — local
            data, your API keys.
          </p>
        </div>
        <div className="nav-actions">
          <Link className="btn" href="/export-price">
            Export Price
          </Link>
          <Link className="btn" href="/settings">
            Settings / API keys
          </Link>
        </div>
      </header>

      {error && <p className="status-err">{error}</p>}
      {loading && !data && <p className="muted">Loading market summary…</p>}

      {data && (
        <div className="desk-body">
          <div className="desk-chrome">
            <div className="meta-row">
              <span className="pill">
                Source: <strong>{data.source}</strong>
              </span>
              <span className="pill">
                Updated: {new Date(data.mtimeIso).toLocaleString()}
              </span>
              <span className="pill">
                US {data.summary.us?.listing_count ?? 0} · CA{" "}
                {data.summary.ca?.listing_count ?? 0}
              </span>
              <span className="pill">
                Memory chunks: {data.memory.chunkCount} · notes:{" "}
                {data.memory.notes}
              </span>
              {!data.keys.hasOpenAI && (
                <span className="pill warn">OpenAI key not set</span>
              )}
              {(data.summary.ca?.listing_count ?? 0) === 0 && (
                <span className="pill warn">CA empty in this file</span>
              )}
            </div>

            <SyncBar
              sync={data.sync}
              onStart={() => void startSync()}
              onCancel={() => void cancelSync()}
              onReload={() => void load()}
              onReindex={() => void reindex()}
            />
          </div>

          <div className="grid">
            <div className="desk-left stack-sm">
              <section className="panel">
                <h2>Briefing</h2>
                <p className="briefing-exec">{data.briefing.executive}</p>
                <pre className="briefing-op">{data.briefing.operator}</pre>
                <ul className="caveats">
                  {data.briefing.caveats.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </section>
              <section className="panel">
                <AnalyticsCharts
                  categoryNoise={data.charts.categoryNoise}
                  priceBands={data.charts.priceBands}
                />
              </section>
              <section className="panel">
                <Wave1Table rows={data.wave1} />
              </section>
            </div>
            <ChatPanel hasOpenAI={data.keys.hasOpenAI} />
          </div>
        </div>
      )}
    </div>
  );
}
