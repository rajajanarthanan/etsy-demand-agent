import {
  evaluateDestinationPrice,
  operatingMarginForPrice,
  operatingProfitForPrice,
  resolveOptions,
  type EvaluateArgs,
} from "./engine";
import {
  loadDestination,
  loadFeeSchedule,
  loadOperatingDefaults,
  loadWithholding,
} from "./loadConfig";
import { fromInr, round2 } from "./money";
import type {
  DestinationCode,
  DestinationOverrides,
  DestinationResult,
  ExportPriceInput,
  ExportPriceResult,
} from "./types";

const MAX_ITER = 40;
const PRICE_TOLERANCE = 0.01;

function buildCtx(
  input: ExportPriceInput,
  destination: DestinationCode,
): Omit<EvaluateArgs, "itemPriceListing" | "shippingPriceListing"> {
  const fees = loadFeeSchedule();
  const withholding = loadWithholding();
  const destCfg = loadDestination(destination);
  const options = resolveOptions(input);
  const overrides: DestinationOverrides = {
    ...(input.destinationOverrides?.[destination] ?? {}),
  };
  // Seed export handling default if unset
  if (overrides.exportHandlingInr == null) {
    overrides.exportHandlingInr = loadOperatingDefaults().defaults.export_handling_inr;
  }
  return {
    listingCurrency: destCfg.currency,
    destination,
    input,
    overrides,
    options,
    fees,
    withholding,
    destCfg,
    fxRates: input.fxRates,
  };
}

/**
 * Binary-search item price (listing currency) to hit a target operating margin or profit.
 * Re-evaluates the full deterministic engine each iteration so price-dependent duties/fees stay consistent.
 */
export function solveDestination(input: ExportPriceInput, destination: DestinationCode): DestinationResult {
  const ctx = buildCtx(input, destination);
  const shippingListing = input.bundleShippingIntoItemPrice
    ? 0
    : (input.shippingPriceInListingCurrency ?? 0);

  const target = input.target;

  if (target.mode === "fixed_price") {
    let itemListing = target.itemPrice;
    let shipListing = target.shippingPrice ?? shippingListing;
    if (target.itemCurrency.toUpperCase() !== ctx.listingCurrency.toUpperCase()) {
      const asInr =
        target.itemCurrency.toUpperCase() === "INR"
          ? target.itemPrice
          : (() => {
              const direct = input.fxRates.find(
                (r) =>
                  r.from.toUpperCase() === target.itemCurrency.toUpperCase() &&
                  r.to.toUpperCase() === "INR",
              );
              const inv = input.fxRates.find(
                (r) =>
                  r.from.toUpperCase() === "INR" &&
                  r.to.toUpperCase() === target.itemCurrency.toUpperCase(),
              );
              if (direct) return target.itemPrice * direct.rate;
              if (inv) return target.itemPrice / inv.rate;
              return target.itemPrice;
            })();
      itemListing = fromInr(asInr, ctx.listingCurrency, input.fxRates).amount;
    }
    if (input.bundleShippingIntoItemPrice) shipListing = 0;
    const result = evaluateDestinationPrice({
      ...ctx,
      itemPriceListing: itemListing,
      shippingPriceListing: shipListing,
    });
    result.iterations = 1;
    return result;
  }

  // Bracket search on item price in listing currency
  let lo = 0.01;
  let hi = 5;
  // Grow upper bound until target is achievable (or cap)
  const metric = (price: number) =>
    target.mode === "target_margin"
      ? operatingMarginForPrice(price, shippingListing, ctx)
      : operatingProfitForPrice(price, shippingListing, ctx);

  const goal =
    target.mode === "target_margin"
      ? target.targetOperatingMargin
      : target.targetOperatingProfitInr;

  let guard = 0;
  while (metric(hi) < goal && hi < 1_000_000 && guard < 30) {
    hi *= 2;
    guard += 1;
  }

  let iterations = 0;
  let mid = hi;
  while (iterations < MAX_ITER) {
    mid = (lo + hi) / 2;
    const m = metric(mid);
    iterations += 1;
    if (Math.abs(m - goal) < 1e-4 || hi - lo < PRICE_TOLERANCE) break;
    if (m < goal) lo = mid;
    else hi = mid;
  }

  // If customs basis is selling_price, another outer pass helps convergence
  let result = evaluateDestinationPrice({
    ...ctx,
    itemPriceListing: mid,
    shippingPriceListing: shippingListing,
  });
  const basis =
    ctx.overrides.customsValueBasis ?? loadOperatingDefaults().defaults.customs_value_basis;
  if (basis === "selling_price") {
    for (let i = 0; i < 8; i++) {
      // re-solve with updated evaluation already reflecting selling-price customs
      lo = Math.max(0.01, mid * 0.5);
      hi = mid * 1.5;
      for (let j = 0; j < 20; j++) {
        mid = (lo + hi) / 2;
        const m = metric(mid);
        iterations += 1;
        if (m < goal) lo = mid;
        else hi = mid;
      }
      result = evaluateDestinationPrice({
        ...ctx,
        itemPriceListing: mid,
        shippingPriceListing: shippingListing,
      });
    }
  }

  result.iterations = iterations;
  result.recommendedItemPrice = round2(result.recommendedItemPrice);
  result.recommendedShippingPrice = round2(result.recommendedShippingPrice);
  result.recommendedBuyerTotal = round2(result.recommendedBuyerTotal);
  return result;
}

function runSensitivity(
  input: ExportPriceInput,
  destination: DestinationCode,
  base: DestinationResult,
): DestinationResult {
  const sens = input.sensitivity;
  if (!sens) return base;
  const rows: DestinationResult["sensitivity"] = [];

  for (const pct of sens.productionCostDeltaPct ?? []) {
    const cloned: ExportPriceInput = {
      ...input,
      productionCostInr: input.productionCostInr * (1 + pct),
      sensitivity: undefined,
    };
    const r = solveDestination(cloned, destination);
    rows.push({
      label: `production_cost ${(pct * 100).toFixed(0)}%`,
      operatingMargin: r.operatingMargin,
      operatingProfitInr: r.operatingProfitInr,
      recommendedBuyerTotal: r.recommendedBuyerTotal,
    });
  }
  for (const pct of sens.freightDeltaPct ?? []) {
    const ov = { ...(input.destinationOverrides?.[destination] ?? {}) };
    if (ov.internationalFreightInr != null) {
      ov.internationalFreightInr = ov.internationalFreightInr * (1 + pct);
    }
    const cloned: ExportPriceInput = {
      ...input,
      destinationOverrides: {
        ...input.destinationOverrides,
        [destination]: ov,
      },
      sensitivity: undefined,
    };
    const r = solveDestination(cloned, destination);
    rows.push({
      label: `freight ${(pct * 100).toFixed(0)}%`,
      operatingMargin: r.operatingMargin,
      operatingProfitInr: r.operatingProfitInr,
      recommendedBuyerTotal: r.recommendedBuyerTotal,
    });
  }
  for (const pct of sens.fxDeltaPct ?? []) {
    const fxRates = input.fxRates.map((r) => ({ ...r, rate: r.rate * (1 + pct) }));
    const cloned: ExportPriceInput = { ...input, fxRates, sensitivity: undefined };
    const r = solveDestination(cloned, destination);
    rows.push({
      label: `fx ${(pct * 100).toFixed(0)}%`,
      operatingMargin: r.operatingMargin,
      operatingProfitInr: r.operatingProfitInr,
      recommendedBuyerTotal: r.recommendedBuyerTotal,
    });
  }

  return { ...base, sensitivity: rows };
}

export function calculateExportPrice(input: ExportPriceInput): ExportPriceResult {
  const fees = loadFeeSchedule();
  const options = resolveOptions(input);
  const destinations = input.destinations.map((d) => {
    const solved = solveDestination(input, d);
    return runSensitivity(input, d, solved);
  });

  const globalUnresolved = [
    ...new Map(
      destinations.flatMap((d) => d.unresolvedAssumptions).map((u) => [u.code, u]),
    ).values(),
  ];
  const globalApprovals = [
    ...new Map(
      destinations.flatMap((d) => d.approvalFlags).map((a) => [a.code, a]),
    ).values(),
  ];

  return {
    calculatedAt: new Date().toISOString(),
    workflow: input.workflow,
    baseCurrency: "INR",
    shippingMode: "DDP",
    feeSchedule: {
      marketplace: fees.marketplace,
      ruleVersion: fees.rule_version,
      effectiveFrom: fees.effective_from,
      verificationStatus: fees.verification_status,
      sources: fees.sources,
    },
    productionCost: {
      amountInr: input.productionCostInr,
      isEstimate: options.productionCostIsEstimate,
      confidence: options.productionCostConfidence,
      assumptions: options.productionCostAssumptions,
    },
    packagingDispatchInr: input.packagingDispatchInr,
    destinations,
    comparison: destinations.map((d) => ({
      destination: d.destination,
      recommendedBuyerTotal: d.recommendedBuyerTotal,
      listingCurrency: d.listingCurrency,
      operatingMargin: d.operatingMargin,
      operatingProfitInr: d.operatingProfitInr,
      estimatedCashPayoutInr: d.estimatedCashPayoutInr,
      status: d.status,
    })),
    globalUnresolved,
    globalApprovals,
  };
}
