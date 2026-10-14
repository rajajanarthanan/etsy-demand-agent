export type DestinationCode = "US" | "CA" | "GB" | "AE" | "SA";

export type VerificationStatus =
  | "verified"
  | "provisional"
  | "assumption"
  | "unverified"
  | "user_supplied";

export type LineKind =
  | "revenue"
  | "cogs"
  | "fulfillment"
  | "customs"
  | "marketplace_fee"
  | "operating_expense"
  | "recoverable_tax_credit"
  | "cash_withholding"
  | "fx"
  | "info";

export type SourceRef = {
  title: string;
  url: string;
  retrieved_at: string;
  notes?: string;
};

export type Money = {
  amount: number;
  currency: string;
};

export type AuditLine = {
  id: string;
  label: string;
  kind: LineKind;
  amount: number;
  currency: string;
  amountInr: number;
  rate?: number | null;
  formula: string;
  sourceRefs: SourceRef[];
  verificationStatus: VerificationStatus;
  affectsOperatingProfit: boolean;
  affectsCashPayout: boolean;
  notes?: string;
};

export type FxRate = {
  from: string;
  to: string;
  rate: number;
  retrieved_at: string;
  source_url?: string;
  verification_status: VerificationStatus;
};

export type DestinationOverrides = {
  hsCode?: string;
  hsCodeConfidence?: "high" | "medium" | "low" | "unconfirmed";
  dutyAdValoremRate?: number | null;
  additionalTariffRate?: number | null;
  additionalTariffFlatInr?: number | null;
  importTaxRate?: number | null;
  importTaxApplies?: boolean;
  clearanceFeeInr?: number | null;
  ddpServiceFeeInr?: number | null;
  internationalFreightInr?: number | null;
  insuranceInr?: number | null;
  exportHandlingInr?: number | null;
  freightQuoteSourceUrl?: string;
  freightRetrievedAt?: string;
  customsValueBasis?: "cif_cost" | "selling_price" | "user_declared";
  userDeclaredCustomsValueInr?: number | null;
};

export type PricingTarget =
  | { mode: "target_margin"; targetOperatingMargin: number }
  | { mode: "target_profit"; targetOperatingProfitInr: number }
  | { mode: "fixed_price"; itemPrice: number; itemCurrency: string; shippingPrice?: number };

export type ExportPriceInput = {
  workflow: "known_cost" | "url_analysis";
  productionCostInr: number;
  packagingDispatchInr: number;
  destinations: DestinationCode[];
  target: PricingTarget;
  shippingPriceInListingCurrency?: number;
  bundleShippingIntoItemPrice?: boolean;
  fxRates: FxRate[];
  destinationOverrides?: Partial<Record<DestinationCode, DestinationOverrides>>;
  options?: Partial<{
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
    listingUrl?: string;
    productionCostIsEstimate?: boolean;
    productionCostConfidence?: "high" | "medium" | "low";
    productionCostAssumptions?: string[];
    materialComplianceApproved?: boolean;
    hsClassificationApproved?: boolean;
    finalDdpPricingApproved?: boolean;
  }>;
  sensitivity?: {
    productionCostDeltaPct?: number[];
    freightDeltaPct?: number[];
    fxDeltaPct?: number[];
  };
};

export type ApprovalFlag = {
  code: string;
  severity: "required" | "recommended";
  message: string;
};

export type UnresolvedAssumption = {
  code: string;
  message: string;
  neededToConfirm: string;
};

export type DestinationResult = {
  destination: DestinationCode;
  destinationName: string;
  listingCurrency: string;
  shippingMode: "DDP";
  status: "confirmed_inputs" | "provisional";
  recommendedItemPrice: number;
  recommendedShippingPrice: number;
  recommendedBuyerTotal: number;
  revenueInr: number;
  operatingProfitInr: number;
  operatingMargin: number;
  estimatedCashPayoutInr: number;
  recoverableTaxCreditsInr: number;
  cashWithholdingInr: number;
  lines: AuditLine[];
  unresolvedAssumptions: UnresolvedAssumption[];
  approvalFlags: ApprovalFlag[];
  iterations: number;
  sensitivity?: {
    label: string;
    operatingMargin: number;
    operatingProfitInr: number;
    recommendedBuyerTotal: number;
  }[];
};

export type ExportPriceResult = {
  calculatedAt: string;
  workflow: "known_cost" | "url_analysis";
  baseCurrency: "INR";
  shippingMode: "DDP";
  feeSchedule: {
    marketplace: string;
    ruleVersion: string;
    effectiveFrom: string;
    verificationStatus: VerificationStatus;
    sources: SourceRef[];
  };
  productionCost: {
    amountInr: number;
    isEstimate: boolean;
    confidence?: "high" | "medium" | "low";
    assumptions: string[];
  };
  packagingDispatchInr: number;
  destinations: DestinationResult[];
  comparison: {
    destination: DestinationCode;
    recommendedBuyerTotal: number;
    listingCurrency: string;
    operatingMargin: number;
    operatingProfitInr: number;
    estimatedCashPayoutInr: number;
    status: "confirmed_inputs" | "provisional";
  }[];
  globalUnresolved: UnresolvedAssumption[];
  globalApprovals: ApprovalFlag[];
};

export type ListingEvidence = {
  url: string;
  listingId?: string;
  title?: string;
  price?: number | null;
  currency?: string | null;
  shipsFrom?: string | null;
  materials?: string[];
  dimensions?: string | null;
  weightHint?: string | null;
  descriptionSnippet?: string | null;
  source: "local_product_details" | "local_summary" | "url_fetch" | "user_paste";
  retrievedAt: string;
  raw?: Record<string, unknown>;
};

export type ProductionCostEstimate = {
  amountInr: number | null;
  isEstimate: true;
  confidence: "high" | "medium" | "low" | "insufficient_evidence";
  assumptions: string[];
  evidenceUsed: string[];
};
