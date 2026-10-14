# Etsy headed scrape — runbook

Repo root: `portfolio/etsy-demand-agent` (this project).

## Setup (once)

```bash
cd /path/to/etsy-demand-agent
python3 -m venv .venv
.venv/bin/pip install -r browser_scrape/requirements.txt
# Optional legacy ScrapeOps HTTP scraper:
# .venv/bin/pip install requests beautifulsoup4 lxml

cp config.example.json config.json
# Fill DataImpulse (and optional ScrapeOps api_key) in config.json — never commit it.

# Worker uses rebrowser-playwright (CDP patches). Default launch uses system Chrome via CDP.
.venv/bin/rebrowser-playwright install chromium   # optional bundled browser
```

## Proxy + IP rotation (DataImpulse)

Default path: **system Chrome → local auth forwarder → DataImpulse** (`--launch-mode cdp_chrome`), driven by **rebrowser-playwright**.

```text
Rotating (default):  LOGIN__cr.us:PASSWORD@gw.dataimpulse.com:823
Sticky:              LOGIN__cr.us;sessid.NAME:PASSWORD@...   (--sticky)
```

- **Rotating (default):** new exit IP each browser session.
- **Sticky:** `--sticky` keeps one IP ~30 min per `sessid`.
- Worker logs `Chrome confirmed egress via proxy: {"ip":"..."}` **before** Etsy — if you don’t see that, traffic is not proxied.
- Cursor IDE / MCP browser does **not** use DataImpulse.

## Harvest (Phase A)

```bash
.venv/bin/python -m browser_scrape.run_harvest --countries us,ca --pages 2
```

- Headed by default. On DataDome, solve the captcha in the Chrome window (worker waits ~120s).
- `--enqueue-only` fills SQLite without browsing. Re-run to resume.

Output: `data/harvest_listings.csv`

## Deep scrape (Phase B/C)

```bash
.venv/bin/python -m browser_scrape.run_deep --limit 0
# smoke: --limit 2 --max-jobs 5
```

Outputs: `data/product_details.jsonl` (`reviews_last_30d` / `90d`), `data/shop_profiles.jsonl`

## Summarize (Phase D)

```bash
.venv/bin/python -m browser_scrape.run_summarize
```

→ `data/market_demand_summary.json`

## Resume

```bash
.venv/bin/python -m browser_scrape.worker --kinds search
.venv/bin/python -m browser_scrape.worker --kinds product,shop
```

Queue: `data/jobs.sqlite` · Progress: `data/run_state.json`

## Demand Desk (app — to be built)

See root [`REQUIREMENTS.md`](../REQUIREMENTS.md). Ingest path for v1: `data/market_demand_summary.json` or `fixtures/market_demand_summary.sample.json`.
