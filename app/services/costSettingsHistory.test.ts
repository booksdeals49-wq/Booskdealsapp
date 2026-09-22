// Standalone test for the CostSettings versioning logic — no test framework
// or database needed, since resolveCostSettingsAt/costRecognitionDate are
// pure functions. Run with: npm run test:cost-settings

import assert from "node:assert/strict";
import {
  resolveCostSettingsAt,
  costRecognitionDate,
  computeAdSpendTax,
  type CostSettingsVersion,
} from "./costSettingsResolver.ts";

function version(effectiveFrom: string, deliveryFeeFlat: number): CostSettingsVersion {
  return {
    id: `v-${effectiveFrom}`,
    currency: "PKR",
    defaultCogsPercent: 35,
    deliveryFeeFlat,
    rtoFeeFlat: 0,
    cashHandlingPercent: 0,
    taxPercent: 0,
    packagingFeeFlat: 0,
    rtoRestockable: false,
    ecommerceTransactionTaxPercent: 0,
    effectiveFrom: new Date(effectiveFrom),
  };
}

function versionWithAdTax(effectiveFrom: string, ecommerceTransactionTaxPercent: number): CostSettingsVersion {
  return { ...version(effectiveFrom, 0), ecommerceTransactionTaxPercent };
}

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

console.log("CostSettings versioning tests");

check("orders dispatched before any rate change keep the old rate", () => {
  // The scenario from the merchant's own example: Rs 290/parcel for the
  // first 30 days (Sept 1), raised to Rs 320 on day 31 (Oct 1). An order
  // dispatched on Sept 15 must resolve to the Sept 1 version forever, even
  // after the Oct 1 version exists.
  const history = [version("2026-09-01", 290), version("2026-10-01", 320)];
  const resolved = resolveCostSettingsAt(history, new Date("2026-09-15"));
  assert.equal(resolved.deliveryFeeFlat, 290);
});

check("orders dispatched on/after the change date use the new rate", () => {
  const history = [version("2026-09-01", 290), version("2026-10-01", 320)];
  const resolved = resolveCostSettingsAt(history, new Date("2026-10-01"));
  assert.equal(resolved.deliveryFeeFlat, 320);

  const resolvedLater = resolveCostSettingsAt(history, new Date("2026-10-15"));
  assert.equal(resolvedLater.deliveryFeeFlat, 320);
});

check("a rate change never retroactively changes an already-resolved past order", () => {
  const historyBefore = [version("2026-09-01", 290)];
  const before = resolveCostSettingsAt(historyBefore, new Date("2026-09-15"));

  // The merchant now saves a new rate effective Oct 1 — this must not
  // change what the Sept 15 order resolves to.
  const historyAfter = [version("2026-09-01", 290), version("2026-10-01", 320)];
  const after = resolveCostSettingsAt(historyAfter, new Date("2026-09-15"));

  assert.equal(before.deliveryFeeFlat, 290);
  assert.equal(after.deliveryFeeFlat, 290);
});

check("a date before the earliest version falls back to the earliest version", () => {
  const history = [version("2026-09-01", 290), version("2026-10-01", 320)];
  const resolved = resolveCostSettingsAt(history, new Date("2026-01-01"));
  assert.equal(resolved.deliveryFeeFlat, 290);
});

check("more than two versions resolves to the most recent one <= the date", () => {
  const history = [
    version("2026-01-01", 250),
    version("2026-06-01", 270),
    version("2026-09-01", 290),
    version("2026-10-01", 320),
  ];
  assert.equal(resolveCostSettingsAt(history, new Date("2026-07-15")).deliveryFeeFlat, 270);
  assert.equal(resolveCostSettingsAt(history, new Date("2026-09-30")).deliveryFeeFlat, 290);
  assert.equal(resolveCostSettingsAt(history, new Date("2027-01-01")).deliveryFeeFlat, 320);
});

check("costRecognitionDate uses dispatchedAt when the order has shipped", () => {
  const date = costRecognitionDate({
    dispatchedAt: new Date("2026-09-15"),
    createdAt: new Date("2026-09-10"),
  });
  assert.equal(date.toISOString(), new Date("2026-09-15").toISOString());
});

check("costRecognitionDate falls back to createdAt for an order that hasn't shipped", () => {
  const date = costRecognitionDate({
    dispatchedAt: null,
    createdAt: new Date("2026-09-10"),
  });
  assert.equal(date.toISOString(), new Date("2026-09-10").toISOString());
});

check("computeAdSpendTax applies the flat % across all platforms' spend", () => {
  const history = [versionWithAdTax("2026-01-01", 5)];
  const rows = [
    { date: new Date("2026-09-01"), spend: 100 }, // meta
    { date: new Date("2026-09-01"), spend: 50 }, // google, same day
    { date: new Date("2026-09-02"), spend: 30 }, // tiktok
  ];
  // (100 + 50 + 30) * 5% = 9 — one blended rate, platform-agnostic.
  assert.equal(computeAdSpendTax(rows, history), 9);
});

check("computeAdSpendTax uses the rate in effect on each row's own date, not today's", () => {
  const history = [versionWithAdTax("2026-01-01", 2), versionWithAdTax("2026-09-05", 10)];
  const rows = [
    { date: new Date("2026-09-01"), spend: 100 }, // still under the 2% rate
    { date: new Date("2026-09-10"), spend: 100 }, // under the new 10% rate
  ];
  // 100*2% + 100*10% = 2 + 10 = 12, not 100*10%*2 = 20.
  assert.equal(computeAdSpendTax(rows, history), 12);
});

check("computeAdSpendTax is 0 when the rate is 0 or there's no ad spend", () => {
  const history = [versionWithAdTax("2026-01-01", 0)];
  assert.equal(computeAdSpendTax([{ date: new Date("2026-09-01"), spend: 500 }], history), 0);
  assert.equal(computeAdSpendTax([], [versionWithAdTax("2026-01-01", 8)]), 0);
});

console.log(`\n${passed} passed`);
