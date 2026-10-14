# Case study — Demand Desk (freelance engagement)

I built this end-to-end for a private client who needed marketplace demand research turned into something their operators could actually use — not another static spreadsheet or keyword vanity tool.

Client name and commercial terms stay confidential. What follows is the technical story I share on Upwork and similar platforms.

## One-liner

End-to-end marketplace demand pipeline: geotargeted scrape → proxy scoring → local AI Demand Desk (briefing, charts, grounded chat, sync) with portable memory and bring-your-own API keys.

## Problem I was hired to solve

Operators needed a clear answer to “what’s making noise on the marketplace, and what’s actually makeable?” without confusing keyword tools or private dashboards for verified unit sales (which marketplaces usually don’t publish).

## What I delivered

1. **Harvest pipeline** — headed browser scrape with residential proxy, job queue, deep listing/shop enrichment, and a scored `market_demand_summary.json`.
2. **Client-ready scrape files** — CSV/Excel harvest grids + JSONL deep listings + scored JSON summary (see README screenshots `04`–`07` and `fixtures/*.sample.*`).
3. **Demand Desk** — local Next.js app: executive/operator briefing, analytics charts, Wave‑1 shortlist, Sync, Settings (BYOK).
4. **Grounded analyst chat** — Vercel AI SDK agent that answers from the loaded dataset, business rules, run state, TOON digest, and retrieved memory — with honest caveats.
5. **Export Price** — deterministic DDP reverse-engineer / cost-plus pricing for key export destinations, with auditable fee and tax lines.
6. **Portable memory** — business context + analyst notes + TOON digest + local vector index travel with the dataset.

### Why Excel/JSON shots matter on Upwork

For pure scraping proposals, buyers often ask “what do I get?” — a tidy `.xlsx` / `.csv` and a clean JSON schema close more deals than UI alone. I keep both: raw pipeline artifacts **and** the Demand Desk that consumes them.

## Stack

| Layer | Choices |
|-------|---------|
| Scrape | Python, rebrowser-playwright, Chrome CDP, residential proxy, SQLite job queue, CSV/JSONL artifacts |
| Desk | Next.js App Router, Vercel AI SDK (`ai` + `@ai-sdk/openai`), Recharts, `@toon-format/toon`, local SQLite vectors (`better-sqlite3`) |

## Why this lands well with clients

- **Honest proxies** — UI and agent call out empty geo slices and catch-all categories; scores are never sold as verified volume.
- **Keys stay with the client** — BYOK in Settings; no SaaS key vault.
- **Memory travels** — copy the summary + `data/memory/` and another machine keeps analyst context.
- **Sync where the browser lives** — one-click harvest from the desk on the same machine as headed Chrome.

## Demo path (2–5 minutes)

```bash
cd app && npm install && npm run desk
```

Open http://localhost:3000 → read the briefing → scan Wave‑1 → review the sample analyst chat (or ask your own question with an OpenAI key in Settings) → optional Export Price and Sync.

## What I do not claim

Exact marketplace unit sales. Scores are proxies (rank, badges, recent reviews). That honesty is part of the deliverable.
