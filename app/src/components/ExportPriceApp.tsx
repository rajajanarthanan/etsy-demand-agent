"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DestinationCode,
  DestinationResult,
  ExportPriceResult,
} from "@/lib/exportPrice/types";

const DESTINATIONS: { code: DestinationCode; label: string }[] = [
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "GB", label: "United Kingdom" },
  { code: "AE", label: "UAE" },
  { code: "SA", label: "Saudi Arabia" },
];

type DestForm = {
  internationalFreightInr: string;
  clearanceFeeInr: string;
  ddpServiceFeeInr: string;
  dutyAdValoremRate: string;
  importTaxRate: string;
  hsCode: string;
  freightQuoteSourceUrl: string;
};

const emptyDest = (): DestForm => ({
  internationalFreightInr: "",
  clearanceFeeInr: "",
  ddpServiceFeeInr: "",
  dutyAdValoremRate: "",
  importTaxRate: "",
  hsCode: "",
  freightQuoteSourceUrl: "",
});

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function ExportPriceApp() {
  const [workflow, setWorkflow] = useState<"known_cost" | "url_analysis">(
    "known_cost",
  );
  const [listingUrl, setListingUrl] = useState("");
  const [analyzeMsg, setAnalyzeMsg] = useState("");
  const [productionCostInr, setProductionCostInr] = useState("800");
  const [packagingDispatchInr, setPackagingDispatchInr] = useState("150");
  const [productionIsEstimate, setProductionIsEstimate] = useState(false);
  const [productionAssumptions, setProductionAssumptions] = useState<string[]>(
    [],
  );
  const [selected, setSelected] = useState<DestinationCode[]>(["US", "GB"]);
  const [targetMode, setTargetMode] = useState<
    "target_margin" | "target_profit"
  >("target_margin");
  const [targetMargin, setTargetMargin] = useState("0.25");
  const [targetProfit, setTargetProfit] = useState("500");
  const [usdInr, setUsdInr] = useState("83.5");
  const [cadInr, setCadInr] = useState("61");
  const [gbpInr, setGbpInr] = useState("106");
  const [aedInr, setAedInr] = useState("22.7");
  const [sarInr, setSarInr] = useState("22.2");
  const [fxRetrievedAt, setFxRetrievedAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [fxSourceUrl, setFxSourceUrl] = useState("");
  const [bundleShipping, setBundleShipping] = useState(true);
  const [shippingPrice, setShippingPrice] = useState("0");
  const [applyOffsiteAds, setApplyOffsiteAds] = useState(false);
  const [hasGstin, setHasGstin] = useState(true);
  const [destForms, setDestForms] = useState<Record<DestinationCode, DestForm>>(
    {
      US: emptyDest(),
      CA: emptyDest(),
      GB: emptyDest(),
      AE: emptyDest(),
      SA: emptyDest(),
    },
  );
  const [hsApproved, setHsApproved] = useState(false);
  const [ddpApproved, setDdpApproved] = useState(false);
  const [complianceApproved, setComplianceApproved] = useState(false);
  const [runSensitivity, setRunSensitivity] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportPriceResult | null>(null);
  const [activeDest, setActiveDest] = useState<DestinationCode>("US");
  const [feeMeta, setFeeMeta] = useState<{
    ruleVersion?: string;
    effectiveFrom?: string;
    sources?: { title: string; url: string }[];
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/export-price/config");
      const json = await res.json();
      if (json.ok) {
        setFeeMeta({
          ruleVersion: json.config.fees.ruleVersion,
          effectiveFrom: json.config.fees.effectiveFrom,
          sources: json.config.fees.sources,
        });
      }
    })();
  }, []);

  const toggleDest = (code: DestinationCode) => {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const updateDest = (code: DestinationCode, patch: Partial<DestForm>) => {
    setDestForms((prev) => ({ ...prev, [code]: { ...prev[code], ...patch } }));
  };

  const analyzeUrl = useCallback(async () => {
    setAnalyzeMsg("");
    setError(null);
    const res = await fetch("/api/export-price/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: listingUrl,
        fxUsdInr: Number(usdInr) || undefined,
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error || "Analyze failed");
      return;
    }
    const warnings = (json.warnings as string[]) ?? [];
    setAnalyzeMsg(
      [
        json.evidence
          ? `Evidence: ${json.evidence.title || "(no title)"} · price ${json.evidence.price ?? "?"} ${json.evidence.currency ?? ""} · source ${json.evidence.source}`
          : "No listing evidence recovered.",
        ...warnings,
        ...(json.productionEstimate?.assumptions ?? []),
      ].join("\n"),
    );
    if (
      json.productionEstimate?.amountInr != null &&
      json.productionEstimate.confidence !== "insufficient_evidence"
    ) {
      setProductionCostInr(String(json.productionEstimate.amountInr));
      setProductionIsEstimate(true);
      setProductionAssumptions(json.productionEstimate.assumptions ?? []);
    } else {
      setProductionIsEstimate(false);
      setProductionAssumptions([]);
    }
  }, [listingUrl, usdInr]);

  const calculate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fxRates = [
        {
          from: "USD",
          to: "INR",
          rate: Number(usdInr),
          retrieved_at: fxRetrievedAt,
          source_url: fxSourceUrl || undefined,
          verification_status: "user_supplied" as const,
        },
        {
          from: "CAD",
          to: "INR",
          rate: Number(cadInr),
          retrieved_at: fxRetrievedAt,
          source_url: fxSourceUrl || undefined,
          verification_status: "user_supplied" as const,
        },
        {
          from: "GBP",
          to: "INR",
          rate: Number(gbpInr),
          retrieved_at: fxRetrievedAt,
          source_url: fxSourceUrl || undefined,
          verification_status: "user_supplied" as const,
        },
        {
          from: "AED",
          to: "INR",
          rate: Number(aedInr),
          retrieved_at: fxRetrievedAt,
          source_url: fxSourceUrl || undefined,
          verification_status: "user_supplied" as const,
        },
        {
          from: "SAR",
          to: "INR",
          rate: Number(sarInr),
          retrieved_at: fxRetrievedAt,
          source_url: fxSourceUrl || undefined,
          verification_status: "user_supplied" as const,
        },
      ];

      const destinationOverrides: Record<string, Record<string, unknown>> = {};
      for (const code of selected) {
        const f = destForms[code];
        destinationOverrides[code] = {
          hsCode: f.hsCode || undefined,
          hsCodeConfidence: f.hsCode ? "medium" : "unconfirmed",
          dutyAdValoremRate: f.dutyAdValoremRate
            ? Number(f.dutyAdValoremRate)
            : null,
          importTaxRate: f.importTaxRate ? Number(f.importTaxRate) : null,
          internationalFreightInr: f.internationalFreightInr
            ? Number(f.internationalFreightInr)
            : null,
          clearanceFeeInr: f.clearanceFeeInr ? Number(f.clearanceFeeInr) : null,
          ddpServiceFeeInr: f.ddpServiceFeeInr
            ? Number(f.ddpServiceFeeInr)
            : null,
          freightQuoteSourceUrl: f.freightQuoteSourceUrl || undefined,
          freightRetrievedAt: fxRetrievedAt,
        };
      }

      const body = {
        workflow,
        productionCostInr: Number(productionCostInr),
        packagingDispatchInr: Number(packagingDispatchInr),
        destinations: selected,
        target:
          targetMode === "target_margin"
            ? {
                mode: "target_margin" as const,
                targetOperatingMargin: Number(targetMargin),
              }
            : {
                mode: "target_profit" as const,
                targetOperatingProfitInr: Number(targetProfit),
              },
        bundleShippingIntoItemPrice: bundleShipping,
        shippingPriceInListingCurrency: bundleShipping
          ? 0
          : Number(shippingPrice),
        fxRates,
        destinationOverrides,
        options: {
          applyOffsiteAds,
          hasGstin,
          hasCompliantPan: hasGstin,
          gstOnFeesIsInputCredit: hasGstin,
          listingUrl: listingUrl || undefined,
          productionCostIsEstimate: productionIsEstimate,
          productionCostConfidence: productionIsEstimate ? "low" : undefined,
          productionCostAssumptions: productionAssumptions,
          hsClassificationApproved: hsApproved,
          finalDdpPricingApproved: ddpApproved,
          materialComplianceApproved: complianceApproved,
        },
        sensitivity: runSensitivity
          ? {
              productionCostDeltaPct: [-0.1, 0.1],
              freightDeltaPct: [-0.1, 0.1],
              fxDeltaPct: [-0.05, 0.05],
            }
          : undefined,
      };

      const res = await fetch("/api/export-price/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(
          json.error ||
            (json.details ? JSON.stringify(json.details) : "Calculate failed"),
        );
        setResult(null);
        return;
      }
      setResult(json.result as ExportPriceResult);
      if (json.result.destinations?.[0]) {
        setActiveDest(json.result.destinations[0].destination);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [
    workflow,
    productionCostInr,
    packagingDispatchInr,
    selected,
    targetMode,
    targetMargin,
    targetProfit,
    bundleShipping,
    shippingPrice,
    usdInr,
    cadInr,
    gbpInr,
    aedInr,
    sarInr,
    fxRetrievedAt,
    fxSourceUrl,
    destForms,
    applyOffsiteAds,
    hasGstin,
    listingUrl,
    productionIsEstimate,
    productionAssumptions,
    hsApproved,
    ddpApproved,
    complianceApproved,
    runSensitivity,
  ]);

  const active: DestinationResult | undefined = useMemo(
    () => result?.destinations.find((d) => d.destination === activeDest),
    [result, activeDest],
  );

  return (
    <div className="app-shell export-shell">
      <header className="topbar">
        <div>
          <h1 className="brand">
            Export Price <span>Reverse Engineer</span>
          </h1>
          <p className="tagline">
            DDP selling price & operating margin for US · CA · UK · UAE · Saudi —
            deterministic engine, auditable sources. Shipping mode fixed to DDP.
          </p>
        </div>
        <div className="nav-actions">
          <Link className="btn" href="/">
            Demand Desk
          </Link>
          <Link className="btn" href="/settings">
            Settings
          </Link>
        </div>
      </header>

      {feeMeta && (
        <div className="meta-row">
          <span className="pill">
            Etsy India fees · v{feeMeta.ruleVersion} · effective{" "}
            {feeMeta.effectiveFrom}
          </span>
          <span className="pill">Shipping mode: DDP (required)</span>
        </div>
      )}

      <div className="export-grid">
        <div className="stack-sm export-inputs">
          <section className="panel">
            <h2>Workflow</h2>
            <div className="row-actions">
              <button
                type="button"
                className={`btn ${workflow === "known_cost" ? "btn-accent" : ""}`}
                onClick={() => setWorkflow("known_cost")}
              >
                Known production cost
              </button>
              <button
                type="button"
                className={`btn ${workflow === "url_analysis" ? "btn-accent" : ""}`}
                onClick={() => setWorkflow("url_analysis")}
              >
                Listing URL
              </button>
            </div>

            {workflow === "url_analysis" && (
              <div className="settings-form" style={{ marginTop: "0.85rem" }}>
                <label>
                  Marketplace listing URL
                  <input
                    value={listingUrl}
                    onChange={(e) => setListingUrl(e.target.value)}
                    placeholder="https://www.etsy.com/listing/…"
                  />
                </label>
                <div className="row-actions">
                  <button type="button" className="btn" onClick={() => void analyzeUrl()}>
                    Retrieve evidence
                  </button>
                </div>
                {analyzeMsg && (
                  <pre className="briefing-op" style={{ marginTop: "0.5rem" }}>
                    {analyzeMsg}
                  </pre>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Top-level costs (INR)</h2>
            <p className="muted">
              Production Cost and Packaging &amp; Dispatch only — SKU BOM stays
              elsewhere.
            </p>
            <div className="settings-form">
              <label>
                Production cost (INR)
                <input
                  value={productionCostInr}
                  onChange={(e) => setProductionCostInr(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              {productionIsEstimate && (
                <span className="pill warn">Production cost is an ESTIMATE</span>
              )}
              <label>
                Packaging &amp; Dispatch (INR)
                <input
                  value={packagingDispatchInr}
                  onChange={(e) => setPackagingDispatchInr(e.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
          </section>

          <section className="panel">
            <h2>Destinations (DDP)</h2>
            <div className="dest-checks">
              {DESTINATIONS.map((d) => (
                <label key={d.code} className="check-pill">
                  <input
                    type="checkbox"
                    checked={selected.includes(d.code)}
                    onChange={() => toggleDest(d.code)}
                  />
                  {d.label}
                </label>
              ))}
            </div>

            {selected.map((code) => (
              <details key={code} className="dest-details" open={code === selected[0]}>
                <summary>
                  {DESTINATIONS.find((d) => d.code === code)?.label} — freight /
                  duty / clearance
                </summary>
                <div className="settings-form" style={{ marginTop: "0.65rem" }}>
                  <label>
                    International freight (INR) — carrier quote only
                    <input
                      value={destForms[code].internationalFreightInr}
                      onChange={(e) =>
                        updateDest(code, {
                          internationalFreightInr: e.target.value,
                        })
                      }
                      placeholder="Required for non-provisional"
                    />
                  </label>
                  <label>
                    Freight quote source URL
                    <input
                      value={destForms[code].freightQuoteSourceUrl}
                      onChange={(e) =>
                        updateDest(code, {
                          freightQuoteSourceUrl: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    HS code (provisional until approved)
                    <input
                      value={destForms[code].hsCode}
                      onChange={(e) =>
                        updateDest(code, { hsCode: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Duty ad valorem rate (e.g. 0.05) — official tariff only
                    <input
                      value={destForms[code].dutyAdValoremRate}
                      onChange={(e) =>
                        updateDest(code, { dutyAdValoremRate: e.target.value })
                      }
                      placeholder="Leave blank → provisional"
                    />
                  </label>
                  <label>
                    Import tax / VAT rate override (optional)
                    <input
                      value={destForms[code].importTaxRate}
                      onChange={(e) =>
                        updateDest(code, { importTaxRate: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Clearance fee (INR)
                    <input
                      value={destForms[code].clearanceFeeInr}
                      onChange={(e) =>
                        updateDest(code, { clearanceFeeInr: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    DDP service charge (INR)
                    <input
                      value={destForms[code].ddpServiceFeeInr}
                      onChange={(e) =>
                        updateDest(code, { ddpServiceFeeInr: e.target.value })
                      }
                    />
                  </label>
                </div>
              </details>
            ))}
          </section>

          <section className="panel">
            <h2>Target &amp; FX</h2>
            <div className="settings-form">
              <label>
                Pricing target
                <select
                  value={targetMode}
                  onChange={(e) =>
                    setTargetMode(e.target.value as typeof targetMode)
                  }
                >
                  <option value="target_margin">Target operating margin</option>
                  <option value="target_profit">Target operating profit (INR)</option>
                </select>
              </label>
              {targetMode === "target_margin" ? (
                <label>
                  Target margin (0–1)
                  <input
                    value={targetMargin}
                    onChange={(e) => setTargetMargin(e.target.value)}
                  />
                </label>
              ) : (
                <label>
                  Target profit (INR)
                  <input
                    value={targetProfit}
                    onChange={(e) => setTargetProfit(e.target.value)}
                  />
                </label>
              )}
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={bundleShipping}
                  onChange={(e) => setBundleShipping(e.target.checked)}
                />
                Bundle DDP shipping into item price (buyer shipping line = 0)
              </label>
              {!bundleShipping && (
                <label>
                  Shipping price (listing currency units)
                  <input
                    value={shippingPrice}
                    onChange={(e) => setShippingPrice(e.target.value)}
                  />
                </label>
              )}
              <label>
                USD→INR
                <input value={usdInr} onChange={(e) => setUsdInr(e.target.value)} />
              </label>
              <label>
                CAD→INR
                <input value={cadInr} onChange={(e) => setCadInr(e.target.value)} />
              </label>
              <label>
                GBP→INR
                <input value={gbpInr} onChange={(e) => setGbpInr(e.target.value)} />
              </label>
              <label>
                AED→INR
                <input value={aedInr} onChange={(e) => setAedInr(e.target.value)} />
              </label>
              <label>
                SAR→INR
                <input value={sarInr} onChange={(e) => setSarInr(e.target.value)} />
              </label>
              <label>
                FX retrieved date
                <input
                  value={fxRetrievedAt}
                  onChange={(e) => setFxRetrievedAt(e.target.value)}
                />
              </label>
              <label>
                FX source URL (optional)
                <input
                  value={fxSourceUrl}
                  onChange={(e) => setFxSourceUrl(e.target.value)}
                  placeholder="https://…"
                />
              </label>
            </div>
          </section>

          <section className="panel">
            <h2>Seller options &amp; approvals</h2>
            <div className="dest-checks">
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={hasGstin}
                  onChange={(e) => setHasGstin(e.target.checked)}
                />
                GSTIN + PAN on file (0.1% TDS; GST on fees as input credit)
              </label>
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={applyOffsiteAds}
                  onChange={(e) => setApplyOffsiteAds(e.target.checked)}
                />
                Apply Offsite Ads fee
              </label>
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={hsApproved}
                  onChange={(e) => setHsApproved(e.target.checked)}
                />
                HS classification approved
              </label>
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={ddpApproved}
                  onChange={(e) => setDdpApproved(e.target.checked)}
                />
                Final DDP charges approved
              </label>
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={complianceApproved}
                  onChange={(e) => setComplianceApproved(e.target.checked)}
                />
                Material compliance reviewed
              </label>
              <label className="check-pill">
                <input
                  type="checkbox"
                  checked={runSensitivity}
                  onChange={(e) => setRunSensitivity(e.target.checked)}
                />
                Sensitivity (±10% cost/freight, ±5% FX)
              </label>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-accent"
                disabled={loading || selected.length === 0}
                onClick={() => void calculate()}
              >
                {loading ? "Calculating…" : "Calculate DDP prices"}
              </button>
            </div>
            {error && <p className="status-err">{error}</p>}
          </section>
        </div>

        <div className="stack-sm export-results">
          {!result && (
            <section className="panel">
              <h2>Results</h2>
              <p className="muted">
                Run a calculation to see per-destination DDP price, operating
                margin, cash payout, and audit lines. Missing freight/duty yields
                a clearly labelled provisional result.
              </p>
            </section>
          )}

          {result && (
            <>
              <section className="panel">
                <h2>Multi-destination comparison</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th>Buyer total</th>
                        <th>Op. margin</th>
                        <th>Op. profit</th>
                        <th>Cash payout</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.comparison.map((c) => (
                        <tr
                          key={c.destination}
                          className={
                            c.destination === activeDest ? "row-active" : ""
                          }
                          onClick={() => setActiveDest(c.destination)}
                          style={{ cursor: "pointer" }}
                        >
                          <td>{c.destination}</td>
                          <td>
                            {c.recommendedBuyerTotal.toFixed(2)} {c.listingCurrency}
                          </td>
                          <td>{pct(c.operatingMargin)}</td>
                          <td>{inr(c.operatingProfitInr)}</td>
                          <td>{inr(c.estimatedCashPayoutInr)}</td>
                          <td>
                            <span
                              className={`pill ${c.status === "provisional" ? "warn" : ""}`}
                            >
                              {c.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.globalApprovals.length > 0 && (
                  <ul className="caveats">
                    {result.globalApprovals.map((a) => (
                      <li key={a.code}>
                        [{a.severity}] {a.message}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {active && (
                <section className="panel">
                  <h2>
                    {active.destinationName} — audit breakdown
                  </h2>
                  <div className="meta-row">
                    <span className="pill">
                      Item {active.recommendedItemPrice.toFixed(2)}{" "}
                      {active.listingCurrency}
                    </span>
                    <span className="pill">
                      Ship {active.recommendedShippingPrice.toFixed(2)}{" "}
                      {active.listingCurrency}
                    </span>
                    <span className="pill">
                      Margin {pct(active.operatingMargin)}
                    </span>
                    <span className="pill">
                      Cash {inr(active.estimatedCashPayoutInr)}
                    </span>
                    <span className="pill">
                      Withholding {inr(active.cashWithholdingInr)} (credit)
                    </span>
                    <span
                      className={`pill ${active.status === "provisional" ? "warn" : ""}`}
                    >
                      {active.status}
                    </span>
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Line</th>
                          <th>Kind</th>
                          <th>INR</th>
                          <th>Verify</th>
                          <th>Formula</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.lines.map((l) => (
                          <tr key={l.id}>
                            <td>{l.label}</td>
                            <td>{l.kind}</td>
                            <td>{inr(l.amountInr)}</td>
                            <td>{l.verificationStatus}</td>
                            <td className="muted">{l.formula}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {active.unresolvedAssumptions.length > 0 && (
                    <>
                      <h3 className="subhead">Unresolved assumptions</h3>
                      <ul className="caveats">
                        {active.unresolvedAssumptions.map((u) => (
                          <li key={u.code}>
                            <strong>{u.message}</strong> — {u.neededToConfirm}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {active.sensitivity && active.sensitivity.length > 0 && (
                    <>
                      <h3 className="subhead">Sensitivity</h3>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Shock</th>
                              <th>Buyer total</th>
                              <th>Margin</th>
                              <th>Profit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {active.sensitivity.map((s) => (
                              <tr key={s.label}>
                                <td>{s.label}</td>
                                <td>{s.recommendedBuyerTotal.toFixed(2)}</td>
                                <td>{pct(s.operatingMargin)}</td>
                                <td>{inr(s.operatingProfitInr)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {result.feeSchedule.sources.length > 0 && (
                    <>
                      <h3 className="subhead">Fee schedule sources</h3>
                      <ul className="caveats">
                        {result.feeSchedule.sources.map((s) => (
                          <li key={s.url}>
                            <a href={s.url} target="_blank" rel="noreferrer">
                              {s.title}
                            </a>{" "}
                            · retrieved {s.retrieved_at}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
