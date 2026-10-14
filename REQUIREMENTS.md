# REQUIREMENTS — Demand Desk

**Document type:** Product / engineering brief (what I scoped and built)  
**Status:** v1 delivered in this repo  
**Portfolio intent:** Yes — scrape pipeline + Demand Desk as a freelance case study

Client identity and commercial terms are confidential and intentionally omitted.

---

## 0. Scope I owned

1. Plan and build the **Demand Desk** app in this repo (`etsy-demand-agent`).
2. Integrate with the existing scrape pipeline under `browser_scrape/`.
3. Primary data input:
   - Working copy: `data/market_demand_summary.json`
   - Demo / CI fixture: `fixtures/market_demand_summary.sample.json`
4. Treat harvest CSV / product & shop JSONL as optional enrichment; summary JSON alone is enough for v1.
5. Optimize for: **fast demo**, **honest caveats**, **periodic re-ingest** when a new summary is produced.
6. Working name: **Demand Desk**.
7. Stay focused on marketplace demand intelligence — not a multi-channel business planner.

---

## 1. Problem

The scrape/summarize pipeline writes dense JSON. Operators need:

- A **plain-language briefing** (“what’s making noise, what’s makeable, what to ignore”)
- **Visuals** (categories, prices, review velocity, geo slices when present)
- **Interactive Q&A** grounded in the latest dataset
- **Periodic updates** when a new summary is produced

Without this, research dies as a static file and never becomes operating intelligence.

---

## 2. Goals (must)

| ID | Goal |
|----|------|
| G1 | **Summarize** the current market demand summary into executive + operator views |
| G2 | **Visualize** product types, noise/scores, price bands, Wave‑1 shortlist, seller intel where usable |
| G3 | **Interact** via chat grounded in loaded data (cite categories, listings, scores) |
| G4 | **Update periodically** — watch/re-load when `data/market_demand_summary.json` refreshes |
| G5 | **Portfolio-ready** — README, one-command run, screenshots, no secrets in git |

## 3. Non-goals (v1)

- Rewriting the harvester (only integrate/read outputs)
- Exact unit-sales prediction (scores are proxies — see `scoring_notes`)
- Multi-tenant SaaS billing
- Auto-listing to marketplaces
- Treating catch-all categories (e.g. `other_wood`) as automatic production SKUs

---

## 4. Data contract

### 4.1 Primary file

| Role | Path |
|------|------|
| Producer | `browser_scrape/run_summarize.py` |
| Output | `data/market_demand_summary.json` |
| Run pointer | `data/run_state.json` → `summary_path` |
| Fixture | `fixtures/market_demand_summary.sample.json` |

Pipeline: harvest → deep → summarize — see `browser_scrape/RUNBOOK.md`.

### 4.2 Top-level schema

```text
{
  "source": { "harvest_rows", "unique_harvest", "products", "shops" },
  "us": { "listing_count", "product_types": [ProductTypeBucket], "top_listings": [ListingExample] },
  "ca": { "listing_count", "product_types", "top_listings" },
  "wave1_makeable_shortlist": [Wave1Row],
  "seller_intel": {
    "products_with_ships_from", "shops_with_location",
    "ships_from_top": [{ "origin", "listings" }],
    "shop_location_top": [{ "location", "shops" }]
  },
  "scoring_notes": string
}
```

**ProductTypeBucket:** `category`, `noise_points`, `listing_count`, `reviews_last_30d_sum`, `median_price`, `makeable`, `examples[]`  
**ListingExample:** `title`, `url`, `price`, `rank`, `market_score`, `reviews_last_30d`, `reviews_last_90d`  
**Wave1Row:** `category`, `combined_noise`, `us_noise`, `ca_noise`, prices, reviews, `example_us` / `example_ca`

### 4.3 Scoring semantics

From `scoring_notes` / producer: bestseller rank, badges, **reviews_last_30d (heavy)**, reviews_last_90d, light lifetime reviews, shop sales.  
**Exact unit sales are not public** — never present scores as verified volume.

### 4.4 Optional enrichment (`data/`)

| File | Role |
|------|------|
| `harvest_listings.csv` | Search harvest / ranks |
| `product_details.jsonl` | Deep listing fields |
| `shop_profiles.jsonl` | Shop signals |
| `run_state.json` | Job / scrape metadata |

### 4.5 Known caveats

- Runs may be **US-heavy**; `ca` may be empty — do not fake CA insights
- Catch-all categories can dominate noise — warn; prefer named Wave‑1 SKUs for production advice
- `ships_from` / shop location strings are often marketing blurbs — summarize cautiously

---

## 5. Operator constraints (sample vertical)

Configurable via `data/memory/business.json` (defaults ship with the desk):

- Materials focus: hardwood housewares suitable for overseas ship
- Wave‑1 makeable categories: `cutting_board`, `kitchen_utensils`, `coasters_slices`, `bowls_trays`, `shelves_hooks`, `frames`, `other_wood`
- Prefer clear SKUs (boards, utensils, trays, coasters, frames) over slab/table noise
- Footnote compliance needs — do not invent certificates

---

## 6. User experience

### Personas

1. **Operator** — “what changed, what should we make”  
2. **Portfolio viewer** — 2–5 min demo

### Minimum surfaces

1. Briefing panel  
2. Visual panel (≥2 charts + Wave‑1 table)  
3. Chat grounded in data (sample Q&A on home for demos)  
4. Freshness / reload / optional Sync

### Acceptance prompts

- Top makeable Wave‑1 categories and why  
- Compare `cutting_board` vs `kitchen_utensils`  
- Five example listings for boards  
- What’s wrong with trusting a catch-all category as #1  
- Any Canada signal in this file?  
- Usable vs junk in `seller_intel`

---

## 7. Periodic updates

When summary file changes: refresh without rebuild (watcher, poll, or Reload).  
Scheduling the scrape worker is out of scope for the desk — see `browser_scrape/RUNBOOK.md`.

---

## 8. AI agent behavior

- Ground in loaded JSON; cite fields/URLs  
- Deterministic metrics first; LLM narrative second  
- No invented listings  
- Offline metrics mode must work without an LLM key  

---

## 9. Portfolio packaging

| Artifact | Why |
|----------|-----|
| Root README | First-person case study + screenshots + run paths |
| `docs/PORTFOLIO.md` | Upwork-ready blurb |
| `docs/ARCHITECTURE.md` | Technical one-pager |
| Screenshots under `docs/screenshots/` | Proof on GitHub |
| `config.example.json` only | No secrets |

---

## 10. Success criteria (v1)

1. Loads `data/` or `fixtures/` summary; briefing + charts + Wave‑1  
2. Chat passes §6 prompts with citations  
3. Reload after file replace updates UI  
4. Stranger can run demo from README  
5. Empty-geo and catch-all caveats visible  

---

## 11. Layout

```text
etsy-demand-agent/
  README.md
  REQUIREMENTS.md
  browser_scrape/
  data/                     # local runs (gitignored bulky bits)
  fixtures/                 # committed sample
  app/                      # Demand Desk
  docs/                     # architecture + portfolio + screenshots
  config.example.json
```

---

## 12. Decisions (v1)

- Local Next.js web UI in `app/`  
- OpenAI via BYOK in Settings (offline metrics without key)  
- Desk defaults to `data/market_demand_summary.json`, else `fixtures/` sample  
- Portable memory: TOON + notes + local vectors (no knowledge-graph UI)  

---

## 13. Handoff checklist

- [x] Scraper + data in this workspace  
- [x] Demand Desk v1 (`app/` — briefing, charts, chat, sync, BYOK, memory, export price)  
- [x] Screenshots for portfolio README  
- [ ] Sanitize + publish public GitHub when ready  

---

*Demand Desk v1 — freelance deliverable documented for portfolio use.*
