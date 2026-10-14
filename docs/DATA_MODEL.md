# Data model (conceptual ER)

I use this diagram when walking reviewers through the system. **Demand Desk v1 does not ship a knowledge-graph database or interactive ER explorer** — the live product uses JSON artifacts + a portable memory pack.

```mermaid
erDiagram
  Run ||--o{ Category : contains
  Run ||--o{ Listing : scores
  Run ||--o{ Shop : observes
  Category ||--o{ Listing : groups
  Shop ||--o{ Listing : sells
  Run ||--o| MemoryDigest : projects
  Run ||--o{ MemoryNote : remembers
  Category ||--o{ MemoryNote : tags
  Run ||--o| RunState : tracked_by

  Run {
    string summary_path
    int products
    int shops
    string scoring_notes
  }

  Category {
    string category
    float noise_points
    int listing_count
    float median_price
    boolean makeable
  }

  Listing {
    string title
    string url
    float price
    float market_score
    int reviews_last_30d
  }

  Shop {
    string location_blurb
    string ships_from_blurb
  }

  MemoryDigest {
    string run_digest_toon
  }

  MemoryNote {
    string id
    string text
    string category
    string created_at
  }

  RunState {
    string summary_path
    object counts
    string[] countries
  }
```

## Artifact mapping

| Entity | File / field |
|--------|----------------|
| Run | `data/market_demand_summary.json` (+ `data/run_state.json`) |
| Category | `us.product_types[]` / `ca.product_types[]` / `wave1_makeable_shortlist[]` |
| Listing | `examples[]`, `top_listings[]`, Wave‑1 `example_us` / `example_ca` |
| Shop | `seller_intel` aggregates (blurbs — treat cautiously) |
| MemoryDigest | `data/memory/run_digest.toon` |
| MemoryNote | `data/memory/notes.jsonl` |
| Business context | `data/memory/business.json` |

## Scoring semantics

`market_score` / `noise_points` are **proxies** (rank, badges, recent reviews, light lifetime / shop signals). They are not verified unit sales.
