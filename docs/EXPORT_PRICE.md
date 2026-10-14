# Export Price Reverse Engineer

I added a deterministic DDP export pricing module to Demand Desk so operators can reverse-engineer or cost-plus a listing price without free-form AI arithmetic.

## Workflows

1. **Known cost** — enter Production Cost + Packaging & Dispatch in the seller’s settlement currency.
2. **Listing URL** — retrieve available evidence from local scrape data or a best-effort fetch; estimate production cost only when evidence exists (always labelled).

Both workflows compute recommended **DDP** selling price, operating profit/margin, estimated cash payout, and an auditable line-item breakdown for any combination of **US, CA, GB, AE, SA**.

## Architecture

| Piece | Role |
|-------|------|
| `app/src/lib/exportPrice/engine.ts` | Deterministic cost stack (never free-form AI arithmetic) |
| `app/src/lib/exportPrice/solve.ts` | Target margin/profit binary search + sensitivity |
| `app/src/lib/exportPrice/config/*` | Versioned fee/customs configs with source URLs |
| `/api/export-price/calculate` | Pricing API |
| `/api/export-price/analyze` | URL evidence retrieval |
| `/export-price` | UI |

SKU-level manufacturing/packaging BOMs are **out of scope** here — only two top-level cost inputs.

## Fee & tax treatment (India → Etsy seller path)

| Item | Treatment |
|------|-----------|
| Listing, transaction 6.5%, Payments 5%+ flat, regulatory, Offsite Ads | Operating marketplace fees |
| GST on Etsy fees (when charged) | Recoverable input credit if GSTIN (cash out, not opex) |
| TCS / TDS (PAN/GSTIN) | Cash withholding / recoverable tax credit — **not** operating expense |

Sources are recorded in versioned JSON configs with retrieval dates.

## Provisional vs confirmed

The engine **never invents** tariff rates, shipping quotes, or fees. Missing freight, duty, clearance, or DDP service charges produce a **provisional** result plus required human-approval flags for HS classification, material compliance, and final DDP pricing.

## Tests

```bash
cd app && npm test
```

## Known limitations

1. **No live carrier API** — freight, clearance, and DDP service charges come from a real quote.
2. **Customs duty rates are not defaulted** — operator supplies a verified rate from official tariff tools.
3. **Import VAT defaults are provisional** — confirm rate and collection path before treating results as final.
4. **URL analysis is best-effort** — prefers local scrape artifacts; marketplace HTTP fetch may be blocked.
5. **FX rates are user-supplied** — no live FX feed.
6. **Advertising / returns / insurance defaults** are operator assumptions unless overridden.
7. **Human approval gates** remain for uncertain HS classification, material compliance, and final DDP pricing.
