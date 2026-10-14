import { describe, expect, it } from "vitest";
import { calculateExportPrice } from "./solve";
import { evaluateDestinationPrice, resolveOptions } from "./engine";
import { loadDestination, loadFeeSchedule, loadWithholding } from "./loadConfig";
import type { ExportPriceInput, FxRate } from "./types";

const fx: FxRate[] = [
  {
    from: "USD",
    to: "INR",
    rate: 83,
    retrieved_at: "2026-10-14",
    verification_status: "user_supplied",
  },
  {
    from: "GBP",
    to: "INR",
    rate: 105,
    retrieved_at: "2026-10-14",
    verification_status: "user_supplied",
  },
];

function baseInput(over: Partial<ExportPriceInput> = {}): ExportPriceInput {
  return {
    workflow: "known_cost",
    productionCostInr: 800,
    packagingDispatchInr: 150,
    destinations: ["US"],
    target: { mode: "target_margin", targetOperatingMargin: 0.2 },
    bundleShippingIntoItemPrice: true,
    fxRates: fx,
    destinationOverrides: {
      US: {
        internationalFreightInr: 900,
        clearanceFeeInr: 200,
        ddpServiceFeeInr: 150,
        dutyAdValoremRate: 0,
        hsCode: "4419.90",
        hsCodeConfidence: "medium",
        importTaxRate: 0,
        importTaxApplies: false,
      },
    },
    options: {
      applyOffsiteAds: false,
      advertisingRate: 0,
      returnsAllowanceRate: 0,
      damageAllowanceRate: 0,
      hasGstin: true,
      hasCompliantPan: true,
      hsClassificationApproved: true,
      finalDdpPricingApproved: true,
      materialComplianceApproved: true,
    },
    ...over,
  };
}

describe("Etsy India fee schedule", () => {
  it("loads verified India fee rates with sources", () => {
    const fees = loadFeeSchedule();
    expect(fees.fees.transaction_fee_rate).toBe(0.065);
    expect(fees.fees.payment_processing_rate).toBe(0.05);
    expect(fees.fees.payment_processing_flat).toEqual({
      amount: 25,
      currency: "INR",
    });
    expect(fees.fees.regulatory_operating_fee_rate).toBe(0.0005);
    expect(fees.verification_status).toBe("verified");
    expect(fees.sources.length).toBeGreaterThan(0);
  });

  it("loads TCS/TDS withholding distinctly from operating expenses", () => {
    const w = loadWithholding();
    expect(w.withholding.tcs_rate).toBe(0.005);
    expect(w.withholding.tds_rate_with_pan_or_gstin).toBe(0.001);
    expect(w.withholding.tcs_classification).toContain("recoverable");
  });
});

describe("deterministic pricing engine", () => {
  it("marks GST on fees as recoverable credit when GSTIN present", () => {
    const input = baseInput();
    const fees = loadFeeSchedule();
    const withholding = loadWithholding();
    const destCfg = loadDestination("US");
    const options = resolveOptions(input);
    const result = evaluateDestinationPrice({
      itemPriceListing: 40,
      shippingPriceListing: 0,
      listingCurrency: "USD",
      destination: "US",
      input,
      overrides: input.destinationOverrides!.US!,
      options,
      fees,
      withholding,
      destCfg,
      fxRates: fx,
    });
    const gst = result.lines.find((l) => l.id === "fee_gst_on_fees");
    expect(gst?.kind).toBe("recoverable_tax_credit");
    expect(gst?.affectsOperatingProfit).toBe(false);
    expect(gst?.affectsCashPayout).toBe(true);

    const tcs = result.lines.find((l) => l.id === "withhold_tcs");
    expect(tcs?.affectsOperatingProfit).toBe(false);
    expect(tcs?.affectsCashPayout).toBe(true);
  });

  it("solves target margin and keeps DDP mode", () => {
    const result = calculateExportPrice(baseInput());
    expect(result.shippingMode).toBe("DDP");
    const us = result.destinations[0];
    expect(us.shippingMode).toBe("DDP");
    expect(us.operatingMargin).toBeGreaterThan(0.19);
    expect(us.operatingMargin).toBeLessThan(0.21);
    expect(us.recommendedBuyerTotal).toBeGreaterThan(0);
    expect(us.estimatedCashPayoutInr).toBeLessThan(us.revenueInr);
  });

  it("produces provisional result when freight and duty are missing", () => {
    const result = calculateExportPrice(
      baseInput({
        destinationOverrides: { US: {} },
        options: {
          advertisingRate: 0,
          returnsAllowanceRate: 0,
          damageAllowanceRate: 0,
          finalDdpPricingApproved: false,
        },
      }),
    );
    const us = result.destinations[0];
    expect(us.status).toBe("provisional");
    expect(us.unresolvedAssumptions.some((u) => u.code === "freight_missing")).toBe(
      true,
    );
    expect(us.approvalFlags.some((a) => a.code === "final_ddp_pricing")).toBe(true);
  });

  it("compares multiple destinations", () => {
    const result = calculateExportPrice(
      baseInput({
        destinations: ["US", "GB"],
        destinationOverrides: {
          US: {
            internationalFreightInr: 900,
            clearanceFeeInr: 200,
            ddpServiceFeeInr: 150,
            dutyAdValoremRate: 0,
            importTaxApplies: false,
            hsCode: "4419.90",
            hsCodeConfidence: "medium",
          },
          GB: {
            internationalFreightInr: 1100,
            clearanceFeeInr: 250,
            ddpServiceFeeInr: 180,
            dutyAdValoremRate: 0,
            importTaxRate: 0.2,
            hsCode: "4419.90",
            hsCodeConfidence: "medium",
          },
        },
      }),
    );
    expect(result.comparison).toHaveLength(2);
    expect(result.comparison.map((c) => c.destination).sort()).toEqual([
      "GB",
      "US",
    ]);
  });

  it("never invents duty — null duty stays unresolved", () => {
    const result = calculateExportPrice(
      baseInput({
        destinationOverrides: {
          US: {
            internationalFreightInr: 900,
            clearanceFeeInr: 100,
            ddpServiceFeeInr: 100,
            dutyAdValoremRate: null,
          },
        },
      }),
    );
    expect(
      result.destinations[0].unresolvedAssumptions.some(
        (u) => u.code === "duty_rate_missing",
      ),
    ).toBe(true);
  });
});
