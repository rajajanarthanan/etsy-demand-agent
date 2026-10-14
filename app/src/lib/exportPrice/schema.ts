import { z } from "zod";

export const destinationCodeSchema = z.enum(["US", "CA", "GB", "AE", "SA"]);

export const fxRateSchema = z.object({
  from: z.string().min(3).max(3),
  to: z.string().min(3).max(3),
  rate: z.number().positive(),
  retrieved_at: z.string(),
  source_url: z.string().url().optional(),
  verification_status: z.enum([
    "verified",
    "provisional",
    "assumption",
    "unverified",
    "user_supplied",
  ]),
});

export const calculateRequestSchema = z.object({
  workflow: z.enum(["known_cost", "url_analysis"]).default("known_cost"),
  productionCostInr: z.number().min(0),
  packagingDispatchInr: z.number().min(0),
  destinations: z.array(destinationCodeSchema).min(1),
  target: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("target_margin"),
      targetOperatingMargin: z.number().gt(0).lt(1),
    }),
    z.object({
      mode: z.literal("target_profit"),
      targetOperatingProfitInr: z.number(),
    }),
    z.object({
      mode: z.literal("fixed_price"),
      itemPrice: z.number().positive(),
      itemCurrency: z.string().min(3).max(3),
      shippingPrice: z.number().min(0).optional(),
    }),
  ]),
  shippingPriceInListingCurrency: z.number().min(0).optional(),
  bundleShippingIntoItemPrice: z.boolean().optional(),
  fxRates: z.array(fxRateSchema).min(1),
  destinationOverrides: z
    .partialRecord(
      destinationCodeSchema,
      z.object({
        hsCode: z.string().optional(),
        hsCodeConfidence: z.enum(["high", "medium", "low", "unconfirmed"]).optional(),
        dutyAdValoremRate: z.number().min(0).nullable().optional(),
        additionalTariffRate: z.number().min(0).nullable().optional(),
        additionalTariffFlatInr: z.number().min(0).nullable().optional(),
        importTaxRate: z.number().min(0).nullable().optional(),
        importTaxApplies: z.boolean().optional(),
        clearanceFeeInr: z.number().min(0).nullable().optional(),
        ddpServiceFeeInr: z.number().min(0).nullable().optional(),
        internationalFreightInr: z.number().min(0).nullable().optional(),
        insuranceInr: z.number().min(0).nullable().optional(),
        exportHandlingInr: z.number().min(0).nullable().optional(),
        freightQuoteSourceUrl: z.string().optional(),
        freightRetrievedAt: z.string().optional(),
        customsValueBasis: z.enum(["cif_cost", "selling_price", "user_declared"]).optional(),
        userDeclaredCustomsValueInr: z.number().min(0).nullable().optional(),
      }),
    )
    .optional(),
  options: z
    .object({
      hasGstin: z.boolean().optional(),
      hasCompliantPan: z.boolean().optional(),
      etsyChargesGstOnFees: z.boolean().optional(),
      gstOnFeesIsInputCredit: z.boolean().optional(),
      applyCurrencyConversionFee: z.boolean().optional(),
      applyOffsiteAds: z.boolean().optional(),
      shopTrailing365dSalesUsd: z.number().min(0).optional(),
      amortizeListingFeePerSale: z.boolean().optional(),
      returnsAllowanceRate: z.number().min(0).max(1).optional(),
      damageAllowanceRate: z.number().min(0).max(1).optional(),
      advertisingRate: z.number().min(0).max(1).optional(),
      settlementChargeFlatInr: z.number().min(0).optional(),
      settlementChargeRate: z.number().min(0).max(1).optional(),
      listingUrl: z.string().optional(),
      productionCostIsEstimate: z.boolean().optional(),
      productionCostConfidence: z.enum(["high", "medium", "low"]).optional(),
      productionCostAssumptions: z.array(z.string()).optional(),
      materialComplianceApproved: z.boolean().optional(),
      hsClassificationApproved: z.boolean().optional(),
      finalDdpPricingApproved: z.boolean().optional(),
    })
    .optional(),
  sensitivity: z
    .object({
      productionCostDeltaPct: z.array(z.number()).optional(),
      freightDeltaPct: z.array(z.number()).optional(),
      fxDeltaPct: z.array(z.number()).optional(),
    })
    .optional(),
});

export const analyzeRequestSchema = z.object({
  url: z.string().url(),
  fxUsdInr: z.number().positive().optional(),
});
