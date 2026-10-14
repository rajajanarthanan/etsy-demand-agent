import fs from "fs";
import path from "path";
import { CONFIG_PATH, DATA_DIR, SECRETS_PATH } from "./paths";
import type { DeskSecrets } from "./types";

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readSecrets(): DeskSecrets {
  ensureDataDir();
  if (!fs.existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")) as DeskSecrets;
  } catch {
    return {};
  }
}

export function writeSecrets(partial: DeskSecrets): DeskSecrets {
  ensureDataDir();
  const current = readSecrets();
  const diPatch = partial.dataimpulse ?? {};
  const diNext = { ...current.dataimpulse };
  if (typeof diPatch.login === "string" && diPatch.login.trim()) {
    diNext.login = diPatch.login.trim();
  }
  if (typeof diPatch.password === "string" && diPatch.password.trim()) {
    diNext.password = diPatch.password.trim();
  }
  if (typeof diPatch.host === "string" && diPatch.host.trim()) {
    diNext.host = diPatch.host.trim();
  }
  if (typeof diPatch.port === "number" && diPatch.port > 0) {
    diNext.port = diPatch.port;
  }
  const next: DeskSecrets = {
    ...current,
    ...partial,
    dataimpulse: diNext,
  };
  // Drop empty strings
  if (!next.openaiApiKey) delete next.openaiApiKey;
  if (!next.scrapeOpsApiKey) delete next.scrapeOpsApiKey;
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  syncConfigJson(next);
  return next;
}

/** Keep root config.json in sync for the Python scrape pipeline. */
function syncConfigJson(secrets: DeskSecrets) {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      existing = {};
    }
  }
  const di = secrets.dataimpulse ?? {};
  const prevDi = (existing.dataimpulse as {
    login?: string;
    password?: string;
    host?: string;
    port?: number;
  }) || {};
  // Never overwrite existing credentials with empty strings from the Settings UI
  const login = (di.login || "").trim() || prevDi.login || "";
  const password = (di.password || "").trim() || prevDi.password || "";
  const next = {
    ...existing,
    api_key: secrets.scrapeOpsApiKey || existing.api_key || "",
    dataimpulse: {
      login,
      password,
      host: (di.host || "").trim() || prevDi.host || "gw.dataimpulse.com",
      port: di.port ?? prevDi.port ?? 823,
    },
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function secretsPublicView(secrets: DeskSecrets) {
  return {
    hasOpenAI: Boolean(secrets.openaiApiKey),
    hasScrapeOps: Boolean(secrets.scrapeOpsApiKey),
    hasDataImpulse: Boolean(
      secrets.dataimpulse?.login && secrets.dataimpulse?.password,
    ),
    dataimpulseHost: secrets.dataimpulse?.host ?? "gw.dataimpulse.com",
    dataimpulsePort: secrets.dataimpulse?.port ?? 823,
    openaiKeyHint: secrets.openaiApiKey
      ? `••••${secrets.openaiApiKey.slice(-4)}`
      : "",
    scrapeOpsHint: secrets.scrapeOpsApiKey
      ? `••••${secrets.scrapeOpsApiKey.slice(-4)}`
      : "",
    dataimpulseLogin: secrets.dataimpulse?.login ?? "",
  };
}
