"use client";

import type { SyncStatus } from "@/lib/types";

export function SyncBar({
  sync,
  onStart,
  onCancel,
  onReload,
  onReindex,
}: {
  sync: SyncStatus;
  onStart: () => void;
  onCancel: () => void;
  onReload: () => void;
  onReindex: () => void;
}) {
  return (
    <div className="panel">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: "0.75rem",
          alignItems: "center",
        }}
      >
        <div>
          <h2 style={{ marginBottom: "0.25rem" }}>One-click market sync</h2>
          <p className="muted" style={{ margin: 0 }}>
            Runs harvest → deep → summarize on this machine (headed browser). Then
            reindexes portable memory.
          </p>
          <p className="muted" style={{ margin: "0.35rem 0 0" }}>
            Status:{" "}
            <strong className={sync.phase === "error" ? "status-err" : "status-ok"}>
              {sync.phase}
            </strong>{" "}
            — {sync.message}
            {sync.error ? ` (${sync.error})` : ""}
          </p>
        </div>
        <div className="nav-actions">
          <button
            type="button"
            className="btn btn-accent"
            onClick={onStart}
            disabled={sync.running}
          >
            Sync now
          </button>
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={!sync.running}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-ghost" onClick={onReload}>
            Reload data
          </button>
          <button type="button" className="btn btn-ghost" onClick={onReindex}>
            Reindex memory
          </button>
        </div>
      </div>
    </div>
  );
}
