"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SettingsView = {
  hasOpenAI: boolean;
  hasScrapeOps: boolean;
  hasDataImpulse: boolean;
  openaiKeyHint: string;
  scrapeOpsHint: string;
  dataimpulseLogin: string;
  dataimpulseHost: string;
  dataimpulsePort: number;
};

export function SettingsForm() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [scrapeOpsApiKey, setScrapeOpsApiKey] = useState("");
  const [dataimpulseLogin, setDataimpulseLogin] = useState("");
  const [dataimpulsePassword, setDataimpulsePassword] = useState("");
  const [dataimpulseHost, setDataimpulseHost] = useState("gw.dataimpulse.com");
  const [dataimpulsePort, setDataimpulsePort] = useState(823);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings");
      const json = await res.json();
      setView(json);
      setDataimpulseLogin(json.dataimpulseLogin || "");
      setDataimpulseHost(json.dataimpulseHost || "gw.dataimpulse.com");
      setDataimpulsePort(json.dataimpulsePort || 823);
    })();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openaiApiKey: openaiApiKey || undefined,
        scrapeOpsApiKey: scrapeOpsApiKey || undefined,
        // Only send login/password when the user typed something (blank = keep existing)
        dataimpulseLogin: dataimpulseLogin.trim() || undefined,
        dataimpulsePassword: dataimpulsePassword || undefined,
        dataimpulseHost,
        dataimpulsePort,
      }),
    });
    const json = await res.json();
    setView(json);
    setOpenaiApiKey("");
    setScrapeOpsApiKey("");
    setDataimpulsePassword("");
    setMsg("Saved locally to data/desk-secrets.json (gitignored).");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1 className="brand">
            Settings <span>· keys</span>
          </h1>
          <p className="tagline">
            Bring your own keys. Nothing is stored in a cloud SaaS vault — keys
            stay on this machine.
          </p>
        </div>
        <Link className="btn" href="/">
          Back to desk
        </Link>
      </header>

      <section className="panel">
        {view && (
          <div className="meta-row">
            <span className="pill">
              OpenAI: {view.hasOpenAI ? view.openaiKeyHint : "not set"}
            </span>
            <span className="pill">
              ScrapeOps: {view.hasScrapeOps ? view.scrapeOpsHint : "optional"}
            </span>
            <span className="pill">
              DataImpulse: {view.hasDataImpulse ? "set" : "needed for sync"}
            </span>
          </div>
        )}

        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <label>
            OpenAI API key
            <input
              type="password"
              autoComplete="off"
              placeholder={view?.openaiKeyHint || "sk-…"}
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
            />
          </label>
          <label>
            ScrapeOps API key (optional / legacy HTTP scrape)
            <input
              type="password"
              autoComplete="off"
              placeholder={view?.scrapeOpsHint || "optional"}
              value={scrapeOpsApiKey}
              onChange={(e) => setScrapeOpsApiKey(e.target.value)}
            />
          </label>
          <label>
            DataImpulse login
            <input
              value={dataimpulseLogin}
              onChange={(e) => setDataimpulseLogin(e.target.value)}
            />
          </label>
          <label>
            DataImpulse password
            <input
              type="password"
              autoComplete="off"
              placeholder="leave blank to keep existing"
              value={dataimpulsePassword}
              onChange={(e) => setDataimpulsePassword(e.target.value)}
            />
          </label>
          <label>
            DataImpulse host
            <input
              value={dataimpulseHost}
              onChange={(e) => setDataimpulseHost(e.target.value)}
            />
          </label>
          <label>
            DataImpulse port
            <input
              type="number"
              value={dataimpulsePort}
              onChange={(e) => setDataimpulsePort(Number(e.target.value))}
            />
          </label>
          <button className="btn btn-accent" type="submit">
            Save keys
          </button>
        </form>
        {msg && <p className="status-ok">{msg}</p>}
        <p className="muted" style={{ marginTop: "1rem" }}>
          Saving also updates <code>config.json</code> for the Python scrape
          worker. Never commit secrets.
        </p>
      </section>
    </div>
  );
}
