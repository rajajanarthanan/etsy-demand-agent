import fs from "fs";
import path from "path";
import type { DestinationCode, SourceRef, VerificationStatus } from "./types";

export type FeeScheduleConfig = {
  marketplace: string;
  seller_country: string;
  currency_payment_account: string;
  rule_version: string;
  effective_from: string;
  effective_to: string | null;
  retrieved_at: string;
  verification_status: VerificationStatus;
  sources: SourceRef[];
  fees: {
    listing_fee_usd: number;
    transaction_fee_rate: number;
    payment_processing_rate: number;
    payment_processing_flat: { amount: number; currency: string };
    regulatory_operating_fee_rate: number;
    offsite_ads_rate_under_10k: number;
    offsite_ads_rate_at_or_over_10k: number;
    offsite_ads_cap_usd: number;
    currency_conversion_fee_rate: number;
    vat_gst_on_seller_fees_rate: number;
    vat_gst_on_seller_fees_notes: string;
  };
  assumptions: string[];
};

export type WithholdingConfig = {
  jurisdiction: string;
  rule_version: string;
  effective_from: string;
  effective_to: string | null;
  retrieved_at: string;
  verification_status: VerificationStatus;
  sources: SourceRef[];
  withholding: {
    tcs_rate: number;
    tcs_classification: string;
    tds_rate_with_pan_or_gstin: number;
    tds_rate_without_pan_or_gstin: number;
    tds_classification: string;
  };
  notes: string[];
};

export type OperatingDefaultsConfig = {
  rule_version: string;
  retrieved_at: string;
  verification_status: VerificationStatus;
  sources: SourceRef[];
  defaults: {
    base_currency: string;
    shipping_mode: string;
    marketplace: string;
    seller_country: string;
    has_gstin: boolean;
    has_compliant_pan: boolean;
    etsy_charges_gst_on_fees: boolean;
    gst_on_fees_is_input_credit: boolean;
    listing_currency_differs_from_payment: boolean;
    apply_currency_conversion_fee: boolean;
    apply_offsite_ads: boolean;
    shop_trailing_365d_sales_usd: number;
    amortize_listing_fee_per_sale: boolean;
    returns_allowance_rate: number;
    damage_allowance_rate: number;
    advertising_rate: number;
    settlement_charge_flat_inr: number;
    settlement_charge_rate: number;
    export_handling_inr: number;
    insurance_rate_of_cif: number;
    customs_value_basis: "cif_cost" | "selling_price" | "user_declared";
  };
  notes: string[];
};

export type DestinationConfig = {
  destination: DestinationCode;
  name: string;
  currency: string;
  shipping_mode_required: "DDP";
  rule_version: string;
  retrieved_at: string;
  verification_status: VerificationStatus;
  sources: SourceRef[];
  import_taxes: {
    type: string;
    collected_by: string;
    default_rate: number | null;
    default_rate_verification?: VerificationStatus;
    notes: string;
  };
  duty: {
    requires_hs_code: boolean;
    default_ad_valorem_rate: number | null;
    additional_tariffs: { name: string; rate: number; verification_status: VerificationStatus }[];
    notes: string;
  };
  clearance_and_ddp: {
    clearance_fee_default: number | null;
    ddp_service_default: number | null;
    notes: string;
  };
  human_approval_required_when: string[];
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function configDir(): string {
  const candidates = [
    path.join(process.cwd(), "src/lib/exportPrice/config"),
    path.join(process.cwd(), "app/src/lib/exportPrice/config"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function loadFeeSchedule(): FeeScheduleConfig {
  return readJson(path.join(configDir(), "etsy_india_fees.json"));
}

export function loadWithholding(): WithholdingConfig {
  return readJson(path.join(configDir(), "india_tax_withholding.json"));
}

export function loadOperatingDefaults(): OperatingDefaultsConfig {
  return readJson(path.join(configDir(), "operating_defaults.json"));
}

export function loadDestination(code: DestinationCode): DestinationConfig {
  return readJson(path.join(configDir(), "destinations", `${code}.json`));
}

export function loadAllDestinations(): DestinationConfig[] {
  const codes: DestinationCode[] = ["US", "CA", "GB", "AE", "SA"];
  return codes.map(loadDestination);
}

export function getPublicConfigSnapshot() {
  const fees = loadFeeSchedule();
  const withholding = loadWithholding();
  const defaults = loadOperatingDefaults();
  const destinations = loadAllDestinations();
  return {
    fees: {
      marketplace: fees.marketplace,
      sellerCountry: fees.seller_country,
      ruleVersion: fees.rule_version,
      effectiveFrom: fees.effective_from,
      verificationStatus: fees.verification_status,
      sources: fees.sources,
      feeLines: fees.fees,
      assumptions: fees.assumptions,
    },
    withholding: {
      ruleVersion: withholding.rule_version,
      verificationStatus: withholding.verification_status,
      sources: withholding.sources,
      rates: withholding.withholding,
      notes: withholding.notes,
    },
    defaults: defaults.defaults,
    defaultNotes: defaults.notes,
    destinations: destinations.map((d) => ({
      code: d.destination,
      name: d.name,
      currency: d.currency,
      verificationStatus: d.verification_status,
      sources: d.sources,
      importTaxNotes: d.import_taxes.notes,
      dutyNotes: d.duty.notes,
      defaultImportTaxRate: d.import_taxes.default_rate,
      defaultImportTaxVerification: d.import_taxes.default_rate_verification ?? null,
    })),
  };
}
