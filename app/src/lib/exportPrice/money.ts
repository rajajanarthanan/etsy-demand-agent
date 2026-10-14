import type { FxRate, VerificationStatus } from "./types";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/** Convert amount to INR using provided FX table. Rates may be XXX→INR or INR→XXX. */
export function toInr(
  amount: number,
  currency: string,
  fxRates: FxRate[],
): { amountInr: number; rateUsed: number; status: VerificationStatus; missing: boolean } {
  const cur = currency.toUpperCase();
  if (cur === "INR") {
    return { amountInr: amount, rateUsed: 1, status: "verified", missing: false };
  }

  const direct = fxRates.find(
    (r) => r.from.toUpperCase() === cur && r.to.toUpperCase() === "INR",
  );
  if (direct && direct.rate > 0) {
    return {
      amountInr: amount * direct.rate,
      rateUsed: direct.rate,
      status: direct.verification_status,
      missing: false,
    };
  }

  const inverse = fxRates.find(
    (r) => r.from.toUpperCase() === "INR" && r.to.toUpperCase() === cur,
  );
  if (inverse && inverse.rate > 0) {
    const rate = 1 / inverse.rate;
    return {
      amountInr: amount * rate,
      rateUsed: rate,
      status: inverse.verification_status,
      missing: false,
    };
  }

  return { amountInr: 0, rateUsed: 0, status: "unverified", missing: true };
}

export function fromInr(
  amountInr: number,
  currency: string,
  fxRates: FxRate[],
): { amount: number; rateUsed: number; missing: boolean } {
  const cur = currency.toUpperCase();
  if (cur === "INR") {
    return { amount: amountInr, rateUsed: 1, missing: false };
  }
  const { rateUsed, missing } = toInr(1, cur, fxRates);
  if (missing || rateUsed === 0) {
    return { amount: 0, rateUsed: 0, missing: true };
  }
  return { amount: amountInr / rateUsed, rateUsed, missing: false };
}
