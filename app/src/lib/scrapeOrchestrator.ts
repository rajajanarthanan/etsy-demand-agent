import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { DATA_DIR, REPO_ROOT } from "./paths";
import { reindexMemory } from "./memory";
import type { SyncStatus } from "./types";

const STATUS_PATH = path.join(DATA_DIR, "sync_status.json");

let child: ChildProcess | null = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readSyncStatus(): SyncStatus {
  ensureDataDir();
  if (!fs.existsSync(STATUS_PATH)) {
    return { running: false, phase: "idle", message: "Idle" };
  }
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf8")) as SyncStatus;
  } catch {
    return { running: false, phase: "idle", message: "Idle" };
  }
}

function writeSyncStatus(status: SyncStatus) {
  ensureDataDir();
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
}

function pythonBin(): string {
  const venv = path.join(REPO_ROOT, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

function runPhase(
  phase: SyncStatus["phase"],
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const status = readSyncStatus();
    writeSyncStatus({
      ...status,
      running: true,
      phase,
      message: `Running ${phase}…`,
    });

    const proc = spawn(pythonBin(), args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    writeSyncStatus({
      ...readSyncStatus(),
      pid: proc.pid,
    });

    let stderr = "";
    proc.stderr?.on("data", (buf) => {
      stderr += buf.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.stdout?.on("data", (buf) => {
      const line = buf.toString().trim().slice(0, 200);
      if (line) {
        writeSyncStatus({
          ...readSyncStatus(),
          message: `${phase}: ${line}`,
        });
      }
    });

    proc.on("error", (err) => {
      child = null;
      reject(err);
    });
    proc.on("close", (code) => {
      child = null;
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${phase} exited ${code}${stderr ? `: ${stderr.slice(-500)}` : ""}`,
          ),
        );
    });
  });
}

export async function startSync(options?: {
  countries?: string;
  pages?: number;
  skipHarvest?: boolean;
  skipDeep?: boolean;
}): Promise<SyncStatus> {
  const current = readSyncStatus();
  if (current.running) {
    return current;
  }

  const countries = options?.countries ?? "us";
  const pages = options?.pages ?? 1;

  writeSyncStatus({
    running: true,
    phase: "harvest",
    message: "Starting sync…",
    started_at: new Date().toISOString(),
  });

  // Fire-and-forget pipeline
  void (async () => {
    try {
      if (!options?.skipHarvest) {
        await runPhase("harvest", [
          "-m",
          "browser_scrape.run_harvest",
          "--countries",
          countries,
          "--pages",
          String(pages),
        ]);
      }
      if (!options?.skipDeep) {
        await runPhase("deep", ["-m", "browser_scrape.run_deep", "--limit", "0"]);
      }
      await runPhase("summarize", ["-m", "browser_scrape.run_summarize"]);
      writeSyncStatus({
        ...readSyncStatus(),
        phase: "reindex",
        message: "Reindexing portable memory…",
      });
      await reindexMemory();
      writeSyncStatus({
        running: false,
        phase: "done",
        message: "Sync complete. Summary and memory refreshed.",
        started_at: readSyncStatus().started_at,
        finished_at: new Date().toISOString(),
      });
    } catch (err) {
      writeSyncStatus({
        running: false,
        phase: "error",
        message: "Sync failed",
        started_at: readSyncStatus().started_at,
        finished_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return readSyncStatus();
}

export function cancelSync(): SyncStatus {
  if (child?.pid) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    child = null;
  }
  writeSyncStatus({
    running: false,
    phase: "idle",
    message: "Cancelled",
    finished_at: new Date().toISOString(),
  });
  return readSyncStatus();
}
