import {
  loadOperatingDefaults,
  type DestinationConfig,
  type FeeScheduleConfig,
  type WithholdingConfig,
} from "./loadConfig";
import { fromInr, round2, round4, toInr } from "./money";
import type {
  ApprovalFlag,
  AuditLine,
  DestinationCode,
  DestinationOverrides,
  DestinationResult,
  ExportPriceInput,
  FxRate,
  UnresolvedAssumption,
  VerificationStatus,
} from "./types";

type ResolvedOptions = {
  hasGstin: boolean;
  hasCompliantPan: boolean;
  etsyChargesGstOnFees: boolean;
  gstOnFeesIsInputCredit: boolean;
  applyCurrencyConversionFee: boolean;
  applyOffsiteAds: boolean;
  shopTrailing365dSalesUsd: number;
  amortizeListingFeePerSale: boolean;
  returnsAllowanceRate: number;
  damageAllowanceRate: number;
  advertisingRate: number;
  settlementChargeFlatInr: number;
  settlementChargeRate: number;
  productionCostIsEstimate: boolean;
  productionCostConfidence?: "high" | "medium" | "low";
  productionCostAssumptions: string[];
  materialComplianceApproved: boolean;
  hsClassificationApproved: boolean;
  finalDdpPricingApproved: boolean;
};

function resolveOptions(input: ExportPriceInput): ResolvedOptions {
  const d = loadOperatingDefaults().defaults;
  const o = input.options ?? {};
  return {
    hasGstin: o.hasGstin ?? d.has_gstin,
    hasCompliantPan: o.hasCompliantPan ?? d.has_compliant_pan,
    etsyChargesGstOnFees: o.etsyChargesGstOnFees ?? d.etsy_charges_gst_on_fees,
    gstOnFeesIsInputCredit: o.gstOnFeesIsInputCredit ?? d.gst_on_fees_is_input_credit,
    applyCurrencyConversionFee:
      o.applyCurrencyConversionFee ?? d.apply_currency_conversion_fee,
    applyOffsiteAds: o.applyOffsiteAds ?? d.apply_offsite_ads,
    shopTrailing365dSalesUsd:
      o.shopTrailing365dSalesUsd ?? d.shop_trailing_365d_sales_usd,
    amortizeListingFeePerSale:
      o.amortizeListingFeePerSale ?? d.amortize_listing_fee_per_sale,
    returnsAllowanceRate: o.returnsAllowanceRate ?? d.returns_allowance_rate,
    damageAllowanceRate: o.damageAllowanceRate ?? d.damage_allowance_rate,
    advertisingRate: o.advertisingRate ?? d.advertising_rate,
    settlementChargeFlatInr: o.settlementChargeFlatInr ?? d.settlement_charge_flat_inr,
    settlementChargeRate: o.settlementChargeRate ?? d.settlement_charge_rate,
    productionCostIsEstimate: o.productionCostIsEstimate ?? false,
    productionCostConfidence: o.productionCostConfidence,
    productionCostAssumptions: o.productionCostAssumptions ?? [],
    materialComplianceApproved: o.materialComplianceApproved ?? false,
    hsClassificationApproved: o.hsClassificationApproved ?? false,
    finalDdpPricingApproved: o.finalDdpPricingApproved ?? false,
  };
}

function line(partial: Omit<AuditLine, "amountInr"> & { amountInr?: number }): AuditLine {
  return {
    ...partial,
    amountInr: round2(partial.amountInr ?? partial.amount),
    amount: round2(partial.amount),
  };
}

export type EvaluateArgs = {
  itemPriceListing: number;
  shippingPriceListing: number;
  listingCurrency: string;
  destination: DestinationCode;
  input: ExportPriceInput;
  overrides: DestinationOverrides;
  options: ResolvedOptions;
  fees: FeeScheduleConfig;
  withholding: WithholdingConfig;
  destCfg: DestinationConfig;
  fxRates: FxRate[];
};

export function evaluateDestinationPrice(args: EvaluateArgs): DestinationResult {
  const {
    itemPriceListing,
    shippingPriceListing,
    listingCurrency,
    destination,
    input,
    overrides,
    options,
    fees,
    withholding,
    destCfg,
    fxRates,
  } = args;

  const unresolved: UnresolvedAssumption[] = [];
  const approvals: ApprovalFlag[] = [];
  const lines: AuditLine[] = [];

  const buyerTotalListing = itemPriceListing + shippingPriceListing;
  const itemFx = toInr(itemPriceListing, listingCurrency, fxRates);
  const shipFx = toInr(shippingPriceListing, listingCurrency, fxRates);
  const totalFx = toInr(buyerTotalListing, listingCurrency, fxRates);

  if (itemFx.missing || shipFx.missing || totalFx.missing) {
    unresolved.push({
      code: "fx_rate_missing",
      message: `Missing FX rate for ${listingCurrency}↔INR.`,
      neededToConfirm: `Provide a user-supplied FX rate with retrieval date (do not invent).`,
    });
  }

  const revenueInr = round2(totalFx.amountInr);
  const itemInr = round2(itemFx.amountInr);
  const shippingInr = round2(shipFx.amountInr);

  lines.push(
    line({
      id: "revenue_item",
      label: "Item selling price",
      kind: "revenue",
      amount: itemPriceListing,
      currency: listingCurrency,
      amountInr: itemInr,
      formula: `item_price (${itemPriceListing} ${listingCurrency}) × FX`,
      sourceRefs: [],
      verificationStatus: itemFx.missing ? "unverified" : "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "revenue_shipping",
      label: "Shipping charged to buyer (DDP mode)",
      kind: "revenue",
      amount: shippingPriceListing,
      currency: listingCurrency,
      amountInr: shippingInr,
      formula: `shipping_price (${shippingPriceListing} ${listingCurrency}) × FX`,
      sourceRefs: [],
      verificationStatus: "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  // COGS — two top-level amounts only
  const production = round2(input.productionCostInr);
  const packaging = round2(input.packagingDispatchInr);
  lines.push(
    line({
      id: "cogs_production",
      label: options.productionCostIsEstimate
        ? "Production cost (ESTIMATE)"
        : "Production cost",
      kind: "cogs",
      amount: production,
      currency: "INR",
      formula: "user productionCostInr (top-level; no SKU BOM here)",
      sourceRefs: [],
      verificationStatus: options.productionCostIsEstimate ? "assumption" : "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
      notes: options.productionCostAssumptions.join("; ") || undefined,
    }),
    line({
      id: "cogs_packaging_dispatch",
      label: "Packaging & Dispatch",
      kind: "cogs",
      amount: packaging,
      currency: "INR",
      formula: "user packagingDispatchInr (top-level)",
      sourceRefs: [],
      verificationStatus: "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  // Fulfillment / DDP
  const freight = overrides.internationalFreightInr;
  const exportHandling =
    overrides.exportHandlingInr ?? loadOperatingDefaults().defaults.export_handling_inr;
  let insurance = overrides.insuranceInr;
  const clearance = overrides.clearanceFeeInr;
  const ddpService = overrides.ddpServiceFeeInr;

  if (freight == null || freight < 0) {
    unresolved.push({
      code: "freight_missing",
      message: "International freight quote is missing.",
      neededToConfirm:
        "Enter a carrier/broker freight quote with source URL and retrieval date. The engine never invents shipping quotes.",
    });
    approvals.push({
      code: "freight_unverified",
      severity: "required",
      message: "Human approval required: DDP freight charge is not verified.",
    });
  }

  const freightInr = round2(freight ?? 0);
  lines.push(
    line({
      id: "fulfillment_freight",
      label: "International freight",
      kind: "fulfillment",
      amount: freightInr,
      currency: "INR",
      formula: "user internationalFreightInr (carrier quote)",
      sourceRefs: overrides.freightQuoteSourceUrl
        ? [
            {
              title: "Freight quote",
              url: overrides.freightQuoteSourceUrl,
              retrieved_at: overrides.freightRetrievedAt ?? "unknown",
            },
          ]
        : [],
      verificationStatus: freight == null ? "unverified" : "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  const cifBeforeInsurance = production + packaging + freightInr + round2(exportHandling);
  if (insurance == null) {
    const rate = loadOperatingDefaults().defaults.insurance_rate_of_cif;
    insurance = round2(cifBeforeInsurance * rate);
    unresolved.push({
      code: "insurance_assumed",
      message: `Insurance estimated at ${(rate * 100).toFixed(2)}% of CIF cost components (assumption).`,
      neededToConfirm: "Replace with a carrier insurance quote or set insuranceInr explicitly.",
    });
  }
  const insuranceInr = round2(insurance);

  lines.push(
    line({
      id: "fulfillment_insurance",
      label: "Cargo insurance",
      kind: "fulfillment",
      amount: insuranceInr,
      currency: "INR",
      formula: overrides.insuranceInr != null
        ? "user insuranceInr"
        : "assumption: insurance_rate_of_cif × (production + packaging + freight + export_handling)",
      sourceRefs: [],
      verificationStatus: overrides.insuranceInr != null ? "user_supplied" : "assumption",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "fulfillment_export_handling",
      label: "Export handling",
      kind: "fulfillment",
      amount: round2(exportHandling),
      currency: "INR",
      formula: "user/default exportHandlingInr",
      sourceRefs: [],
      verificationStatus: overrides.exportHandlingInr != null ? "user_supplied" : "assumption",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  const basis =
    overrides.customsValueBasis ?? loadOperatingDefaults().defaults.customs_value_basis;
  let customsValueInr: number;
  if (basis === "user_declared" && overrides.userDeclaredCustomsValueInr != null) {
    customsValueInr = round2(overrides.userDeclaredCustomsValueInr);
  } else if (basis === "selling_price") {
    customsValueInr = revenueInr;
  } else {
    customsValueInr = round2(production + packaging + freightInr + insuranceInr);
  }

  const dutyRate =
    overrides.dutyAdValoremRate ?? destCfg.duty.default_ad_valorem_rate ?? null;
  const addTariffRate = overrides.additionalTariffRate ?? 0;
  const addTariffFlat = overrides.additionalTariffFlatInr ?? 0;

  if (dutyRate == null) {
    unresolved.push({
      code: "duty_rate_missing",
      message: `No verified customs duty rate for ${destination}.`,
      neededToConfirm:
        "Provide HS code + official tariff rate (HTS/CBSA/Trade Tariff/FCA/ZATCA). Never invent a duty rate.",
    });
    approvals.push({
      code: "duty_rate_unverified",
      severity: "required",
      message: "Human approval required: customs duty rate is unverified.",
    });
  }
  if (!overrides.hsCode || overrides.hsCodeConfidence === "unconfirmed") {
    approvals.push({
      code: "hs_code_uncertain",
      severity: "required",
      message: "Human approval required: customs classification (HS code) is uncertain.",
    });
  } else if (!options.hsClassificationApproved) {
    approvals.push({
      code: "hs_classification_approval",
      severity: "required",
      message: "Confirm HS classification before treating DDP duty as final.",
    });
  }

  const dutyInr = round2(customsValueInr * (dutyRate ?? 0));
  const addTariffInr = round2(customsValueInr * addTariffRate + addTariffFlat);

  lines.push(
    line({
      id: "customs_duty",
      label: "Customs duty",
      kind: "customs",
      amount: dutyInr,
      currency: "INR",
      rate: dutyRate,
      formula: `customs_value_inr(${customsValueInr}) × duty_rate(${dutyRate ?? "MISSING"})`,
      sourceRefs: destCfg.sources,
      verificationStatus: dutyRate == null ? "unverified" : "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
      notes: destCfg.duty.notes,
    }),
    line({
      id: "customs_additional_tariffs",
      label: "Additional tariffs",
      kind: "customs",
      amount: addTariffInr,
      currency: "INR",
      rate: addTariffRate,
      formula: `customs_value_inr × additionalTariffRate + flat`,
      sourceRefs: destCfg.sources,
      verificationStatus: addTariffRate || addTariffFlat ? "user_supplied" : "verified",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  const importTaxApplies = overrides.importTaxApplies ?? true;
  let importTaxRate =
    overrides.importTaxRate ?? destCfg.import_taxes.default_rate ?? null;
  let importTaxStatus: VerificationStatus =
    overrides.importTaxRate != null
      ? "user_supplied"
      : (destCfg.import_taxes.default_rate_verification ?? "provisional");

  // US sales tax: typically marketplace-collected from buyer — do not treat as seller DDP cost by default
  if (destination === "US" && overrides.importTaxRate == null) {
    importTaxRate = 0;
    importTaxStatus = "verified";
    lines.push(
      line({
        id: "customs_import_tax_note",
        label: "US sales tax (marketplace-collected — excluded from seller DDP cost)",
        kind: "info",
        amount: 0,
        currency: "INR",
        formula: "Etsy typically collects/remits US sales tax from buyers",
        sourceRefs: fees.sources,
        verificationStatus: "verified",
        affectsOperatingProfit: false,
        affectsCashPayout: false,
        notes: destCfg.import_taxes.notes,
      }),
    );
  } else if (!importTaxApplies) {
    importTaxRate = 0;
  } else if (importTaxRate == null) {
    unresolved.push({
      code: "import_tax_missing",
      message: `Import tax/VAT rate missing for ${destination}.`,
      neededToConfirm: "Confirm official import VAT/GST rate and who remits it.",
    });
    importTaxRate = 0;
    importTaxStatus = "unverified";
  } else if (importTaxStatus === "provisional") {
    unresolved.push({
      code: "import_tax_provisional",
      message: `Import tax rate for ${destination} is provisional.`,
      neededToConfirm: destCfg.import_taxes.notes,
    });
    approvals.push({
      code: "vat_path_unverified",
      severity: "required",
      message: `Human approval required: verify ${destination} import tax/VAT collection path.`,
    });
  }

  const importTaxBase = customsValueInr + dutyInr + addTariffInr;
  const importTaxInr = round2(importTaxBase * (importTaxRate ?? 0));
  if (!(destination === "US" && overrides.importTaxRate == null)) {
    lines.push(
      line({
        id: "customs_import_tax",
        label: `Import tax / VAT (${destCfg.import_taxes.type})`,
        kind: "customs",
        amount: importTaxInr,
        currency: "INR",
        rate: importTaxRate,
        formula: `(customs_value + duty + additional_tariffs) × import_tax_rate`,
        sourceRefs: destCfg.sources,
        verificationStatus: importTaxStatus,
        affectsOperatingProfit: true,
        affectsCashPayout: true,
        notes: destCfg.import_taxes.notes,
      }),
    );
  }

  if (clearance == null) {
    unresolved.push({
      code: "clearance_missing",
      message: "Customs clearance fee not provided.",
      neededToConfirm: "Enter clearance fee from broker/carrier quote.",
    });
  }
  if (ddpService == null) {
    unresolved.push({
      code: "ddp_service_missing",
      message: "DDP service charge not provided.",
      neededToConfirm: "Enter DDP service charge from logistics provider quote.",
    });
  }
  const clearanceInr = round2(clearance ?? 0);
  const ddpInr = round2(ddpService ?? 0);
  lines.push(
    line({
      id: "customs_clearance",
      label: "Customs clearance",
      kind: "customs",
      amount: clearanceInr,
      currency: "INR",
      formula: "user clearanceFeeInr",
      sourceRefs: [],
      verificationStatus: clearance == null ? "unverified" : "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "customs_ddp_service",
      label: "DDP service charges",
      kind: "customs",
      amount: ddpInr,
      currency: "INR",
      formula: "user ddpServiceFeeInr",
      sourceRefs: [],
      verificationStatus: ddpService == null ? "unverified" : "user_supplied",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  // Marketplace fees (Etsy India)
  const listingFeeUsd = fees.fees.listing_fee_usd;
  const listingFeeFx = toInr(listingFeeUsd, "USD", fxRates);
  const listingFeeInr = options.amortizeListingFeePerSale
    ? round2(listingFeeFx.missing ? 0 : listingFeeFx.amountInr)
    : 0;
  if (options.amortizeListingFeePerSale && listingFeeFx.missing) {
    unresolved.push({
      code: "fx_usd_missing_listing_fee",
      message: "USD→INR FX missing; listing fee ($0.20) could not be converted.",
      neededToConfirm: "Provide USD/INR rate.",
    });
  }

  const transactionFeeInr = round2(revenueInr * fees.fees.transaction_fee_rate);
  const regulatoryInr = round2(revenueInr * fees.fees.regulatory_operating_fee_rate);

  const flatProc = fees.fees.payment_processing_flat;
  const flatProcFx = toInr(flatProc.amount, flatProc.currency, fxRates);
  const paymentProcInr = round2(
    revenueInr * fees.fees.payment_processing_rate +
      (flatProcFx.missing ? 0 : flatProcFx.amountInr),
  );
  if (flatProcFx.missing) {
    unresolved.push({
      code: "fx_inr_flat_processing",
      message: "Could not price ₹25 payment processing flat fee (unexpected).",
      neededToConfirm: "INR amounts should not need FX.",
    });
  }

  const feeBaseForGst = listingFeeInr + transactionFeeInr + paymentProcInr + regulatoryInr;
  let offsiteAdsInr = 0;
  if (options.applyOffsiteAds) {
    const rate =
      options.shopTrailing365dSalesUsd >= 10000
        ? fees.fees.offsite_ads_rate_at_or_over_10k
        : fees.fees.offsite_ads_rate_under_10k;
    offsiteAdsInr = round2(revenueInr * rate);
    const capFx = toInr(fees.fees.offsite_ads_cap_usd, "USD", fxRates);
    if (!capFx.missing) {
      offsiteAdsInr = Math.min(offsiteAdsInr, round2(capFx.amountInr));
    }
  }

  const gstOnFeesInr =
    options.etsyChargesGstOnFees
      ? round2((feeBaseForGst + offsiteAdsInr) * fees.fees.vat_gst_on_seller_fees_rate)
      : 0;

  const gstIsCredit = options.gstOnFeesIsInputCredit && options.hasGstin;

  lines.push(
    line({
      id: "fee_listing",
      label: "Etsy listing fee (allocated)",
      kind: "marketplace_fee",
      amount: listingFeeInr,
      currency: "INR",
      formula: `$${listingFeeUsd} × USDINR (amortised per sale)`,
      sourceRefs: fees.sources,
      verificationStatus: fees.verification_status,
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "fee_transaction",
      label: "Etsy transaction fee 6.5%",
      kind: "marketplace_fee",
      amount: transactionFeeInr,
      currency: "INR",
      rate: fees.fees.transaction_fee_rate,
      formula: "buyer_total_inr × 0.065",
      sourceRefs: fees.sources,
      verificationStatus: fees.verification_status,
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "fee_payment_processing",
      label: "Etsy Payments processing (India 5% + ₹25)",
      kind: "marketplace_fee",
      amount: paymentProcInr,
      currency: "INR",
      rate: fees.fees.payment_processing_rate,
      formula: "buyer_total_inr × 0.05 + 25 INR",
      sourceRefs: fees.sources,
      verificationStatus: fees.verification_status,
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "fee_regulatory",
      label: "Regulatory operating fee 0.05%",
      kind: "marketplace_fee",
      amount: regulatoryInr,
      currency: "INR",
      rate: fees.fees.regulatory_operating_fee_rate,
      formula: "buyer_total_inr × 0.0005",
      sourceRefs: fees.sources,
      verificationStatus: fees.verification_status,
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "fee_offsite_ads",
      label: options.applyOffsiteAds
        ? "Offsite Ads fee"
        : "Offsite Ads fee (not applied)",
      kind: "marketplace_fee",
      amount: offsiteAdsInr,
      currency: "INR",
      formula: options.applyOffsiteAds
        ? "buyer_total_inr × 12% or 15% (capped)"
        : "disabled in options",
      sourceRefs: fees.sources,
      verificationStatus: fees.verification_status,
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "fee_gst_on_fees",
      label: gstIsCredit
        ? "GST on Etsy fees (recoverable input credit)"
        : "GST on Etsy fees (operating if not credited)",
      kind: gstIsCredit ? "recoverable_tax_credit" : "marketplace_fee",
      amount: gstOnFeesInr,
      currency: "INR",
      rate: fees.fees.vat_gst_on_seller_fees_rate,
      formula: "sum(etsy_fee_lines) × 18%",
      sourceRefs: fees.sources,
      verificationStatus: fees.verification_status,
      affectsOperatingProfit: !gstIsCredit,
      affectsCashPayout: true,
      notes: fees.fees.vat_gst_on_seller_fees_notes,
    }),
  );

  let fxConversionInr = 0;
  if (options.applyCurrencyConversionFee && listingCurrency.toUpperCase() !== "INR") {
    fxConversionInr = round2(revenueInr * fees.fees.currency_conversion_fee_rate);
    lines.push(
      line({
        id: "fx_conversion",
        label: "Etsy currency conversion fee 2.5%",
        kind: "fx",
        amount: fxConversionInr,
        currency: "INR",
        rate: fees.fees.currency_conversion_fee_rate,
        formula: "buyer_total_inr × 0.025 (listing currency ≠ payment account currency)",
        sourceRefs: fees.sources,
        verificationStatus: fees.verification_status,
        affectsOperatingProfit: true,
        affectsCashPayout: true,
      }),
    );
  }

  const returnsInr = round2(revenueInr * options.returnsAllowanceRate);
  const damageInr = round2(revenueInr * options.damageAllowanceRate);
  const adsInr = round2(revenueInr * options.advertisingRate);
  const settlementInr = round2(
    options.settlementChargeFlatInr + revenueInr * options.settlementChargeRate,
  );

  lines.push(
    line({
      id: "opex_returns",
      label: "Returns allowance",
      kind: "operating_expense",
      amount: returnsInr,
      currency: "INR",
      rate: options.returnsAllowanceRate,
      formula: "buyer_total_inr × returns_allowance_rate",
      sourceRefs: [],
      verificationStatus: "assumption",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "opex_damage",
      label: "Damage allowance",
      kind: "operating_expense",
      amount: damageInr,
      currency: "INR",
      rate: options.damageAllowanceRate,
      formula: "buyer_total_inr × damage_allowance_rate",
      sourceRefs: [],
      verificationStatus: "assumption",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "opex_advertising",
      label: "Advertising (non-Offsite)",
      kind: "operating_expense",
      amount: adsInr,
      currency: "INR",
      rate: options.advertisingRate,
      formula: "buyer_total_inr × advertising_rate",
      sourceRefs: [],
      verificationStatus: "assumption",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
    line({
      id: "opex_settlement",
      label: "Settlement charges",
      kind: "operating_expense",
      amount: settlementInr,
      currency: "INR",
      formula: "flat + rate × buyer_total_inr",
      sourceRefs: [],
      verificationStatus: options.settlementChargeFlatInr || options.settlementChargeRate
        ? "user_supplied"
        : "assumption",
      affectsOperatingProfit: true,
      affectsCashPayout: true,
    }),
  );

  // India TCS / TDS — cash withholding, recoverable tax credits (not opex)
  const tcsInr = round2(revenueInr * withholding.withholding.tcs_rate);
  const tdsRate =
    options.hasGstin || options.hasCompliantPan
      ? withholding.withholding.tds_rate_with_pan_or_gstin
      : withholding.withholding.tds_rate_without_pan_or_gstin;
  const tdsInr = round2(revenueInr * tdsRate);

  lines.push(
    line({
      id: "withhold_tcs",
      label: "GST TCS 0.5% (cash withholding / recoverable credit)",
      kind: "cash_withholding",
      amount: tcsInr,
      currency: "INR",
      rate: withholding.withholding.tcs_rate,
      formula: "buyer_total_inr × 0.005",
      sourceRefs: withholding.sources,
      verificationStatus: withholding.verification_status,
      affectsOperatingProfit: false,
      affectsCashPayout: true,
      notes: "Recoverable tax credit — not an operating expense.",
    }),
    line({
      id: "withhold_tds",
      label: `Income-tax TDS ${(tdsRate * 100).toFixed(2)}% (cash withholding / recoverable credit)`,
      kind: "cash_withholding",
      amount: tdsInr,
      currency: "INR",
      rate: tdsRate,
      formula: "buyer_total_inr × tds_rate",
      sourceRefs: withholding.sources,
      verificationStatus: withholding.verification_status,
      affectsOperatingProfit: false,
      affectsCashPayout: true,
      notes: "Recoverable tax credit when PAN/GSTIN attributed correctly.",
    }),
  );

  const operatingCosts = lines
    .filter((l) => l.affectsOperatingProfit && l.kind !== "revenue")
    .reduce((s, l) => s + l.amountInr, 0);
  const operatingRevenue = lines
    .filter((l) => l.kind === "revenue")
    .reduce((s, l) => s + l.amountInr, 0);
  const operatingProfitInr = round2(operatingRevenue - operatingCosts);
  const operatingMargin = operatingRevenue > 0 ? round4(operatingProfitInr / operatingRevenue) : 0;

  const cashDeductions = lines
    .filter((l) => l.affectsCashPayout && l.kind !== "revenue")
    .reduce((s, l) => s + l.amountInr, 0);
  const estimatedCashPayoutInr = round2(operatingRevenue - cashDeductions);
  const recoverableTaxCreditsInr = round2(
    tcsInr + tdsInr + (gstIsCredit ? gstOnFeesInr : 0),
  );
  const cashWithholdingInr = round2(tcsInr + tdsInr);

  if (!options.materialComplianceApproved) {
    approvals.push({
      code: "material_compliance",
      severity: "recommended",
      message:
        "Confirm material compliance (e.g. Lacey Act / food-contact) before finalising export offers.",
    });
  }

  const hasUnverifiedDdp =
    freight == null ||
    dutyRate == null ||
    clearance == null ||
    ddpService == null ||
    unresolved.some((u) =>
      ["freight_missing", "duty_rate_missing", "clearance_missing", "ddp_service_missing"].includes(
        u.code,
      ),
    );

  if (hasUnverifiedDdp && !options.finalDdpPricingApproved) {
    approvals.push({
      code: "final_ddp_pricing",
      severity: "required",
      message:
        "Human approval required for final DDP pricing: one or more freight/duty/clearance/DDP charges are unverified.",
    });
  }

  const status: DestinationResult["status"] =
    unresolved.some((u) =>
      [
        "freight_missing",
        "duty_rate_missing",
        "fx_rate_missing",
        "clearance_missing",
        "ddp_service_missing",
        "import_tax_missing",
      ].includes(u.code),
    ) || hasUnverifiedDdp
      ? "provisional"
      : "confirmed_inputs";

  if (status === "provisional") {
    unresolved.unshift({
      code: "provisional_result",
      message: "Result is PROVISIONAL — essential verified inputs are missing.",
      neededToConfirm: unresolved.map((u) => u.neededToConfirm).join(" | "),
    });
  }

  return {
    destination,
    destinationName: destCfg.name,
    listingCurrency,
    shippingMode: "DDP",
    status,
    recommendedItemPrice: round2(itemPriceListing),
    recommendedShippingPrice: round2(shippingPriceListing),
    recommendedBuyerTotal: round2(buyerTotalListing),
    revenueInr,
    operatingProfitInr,
    operatingMargin,
    estimatedCashPayoutInr,
    recoverableTaxCreditsInr,
    cashWithholdingInr,
    lines,
    unresolvedAssumptions: dedupeUnresolved(unresolved),
    approvalFlags: dedupeApprovals(approvals),
    iterations: 1,
  };
}

function dedupeUnresolved(items: UnresolvedAssumption[]): UnresolvedAssumption[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.code)) return false;
    seen.add(i.code);
    return true;
  });
}

function dedupeApprovals(items: ApprovalFlag[]): ApprovalFlag[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.code)) return false;
    seen.add(i.code);
    return true;
  });
}

export function operatingMarginForPrice(
  itemPriceListing: number,
  shippingPriceListing: number,
  ctx: Omit<EvaluateArgs, "itemPriceListing" | "shippingPriceListing">,
): number {
  return evaluateDestinationPrice({
    ...ctx,
    itemPriceListing,
    shippingPriceListing,
  }).operatingMargin;
}

export function operatingProfitForPrice(
  itemPriceListing: number,
  shippingPriceListing: number,
  ctx: Omit<EvaluateArgs, "itemPriceListing" | "shippingPriceListing">,
): number {
  return evaluateDestinationPrice({
    ...ctx,
    itemPriceListing,
    shippingPriceListing,
  }).operatingProfitInr;
}

export { resolveOptions, fromInr, toInr };
