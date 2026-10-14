import path from "path";

/** Repo root (etsy-demand-agent), one level above the Next.js `app/` package. */
export const REPO_ROOT = path.resolve(process.cwd(), "..");

export const DATA_DIR = path.join(REPO_ROOT, "data");
export const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
export const MEMORY_DIR = path.join(DATA_DIR, "memory");
export const FIXTURE_MEMORY_DIR = path.join(FIXTURES_DIR, "memory");
export const SECRETS_PATH = path.join(DATA_DIR, "desk-secrets.json");
export const SUMMARY_DATA_PATH = path.join(DATA_DIR, "market_demand_summary.json");
export const SUMMARY_FIXTURE_PATH = path.join(
  FIXTURES_DIR,
  "market_demand_summary.sample.json",
);
export const RUN_STATE_PATH = path.join(DATA_DIR, "run_state.json");
export const CONFIG_PATH = path.join(REPO_ROOT, "config.json");
