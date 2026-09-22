// Pure CostSettings-versioning logic — no Prisma/Remix imports, same
// framework-free rationale as profit.server.ts, so it can be unit tested
// without a live database. costSettingsHistory.server.ts wraps this with
// the actual Prisma read.
//
// CostSettings used to be a single row per shop, upserted in place — so
// changing, say, the delivery fee silently changed the cost of every order
// ever computed, past and future alike. That's wrong for a COD business:
// the courier's rate on the day an order actually shipped is what was
// really paid for it, and that doesn't change retroactively just because
// the courier raised prices later. Now CostSettings is versioned — a shop
// can have many rows, each stamped with the moment its rates started
// applying (effectiveFrom) — and this module picks the right one per order.
import type { CostSettings as CostSettingsType } from "./profit.server";

export type CostSettingsVersion = CostSettingsType & {
  id: string;
  currency: string;
  effectiveFrom: Date;
};

/**
 * The CostSettings version in effect at a given point in time: the most
 * recent version whose effectiveFrom is <= that date. Falls back to the
 * earliest version for a date before any recorded version (e.g. an order
 * whose dispatch/placement predates the shop's very first saved version).
 * `history` must be sorted oldest-first and non-empty.
 */
export function resolveCostSettingsAt(
  history: CostSettingsVersion[],
  at: Date,
): CostSettingsVersion {
  let chosen = history[0];
  for (const version of history) {
    if (version.effectiveFrom.getTime() <= at.getTime()) {
      chosen = version;
    } else {
      break;
    }
  }
  return chosen;
}

/**
 * The date that decides which CostSettings version an order's costs are
 * computed under. COGS/delivery fee/packaging become real costs at dispatch
 * (see profit.server.ts), so that's the date that matters once an order has
 * shipped; an order that hasn't shipped yet has no committed cost to pin to
 * a rate, but still needs some date to resolve against (e.g. for whichever
 * rate will apply to its cash-handling/tax once it eventually delivers), so
 * it falls back to when it was placed.
 */
export function costRecognitionDate(order: {
  dispatchedAt: Date | null;
  createdAt: Date;
}): Date {
  return order.dispatchedAt ?? order.createdAt;
}

/**
 * Government tax on ad-platform transactions (e.g. a card-processing tax
 * charged when paying Meta/Google/TikTok/Snapchat), as one blended rate
 * across every platform — not versioned per platform, since it's the same
 * government charge whichever platform the spend went to.
 *
 * Computed the same way per-order costs are: each AdSpend row is taxed at
 * whatever rate was in effect ON THAT ROW'S OWN DATE, so raising the rate
 * today never retroactively changes the tax already reported for past
 * spend — same guarantee resolveCostSettingsAt gives every other rate.
 * `history` must be sorted oldest-first and non-empty (see
 * resolveCostSettingsAt above).
 */
export function computeAdSpendTax(
  adSpendRows: Array<{ date: Date; spend: number }>,
  history: CostSettingsVersion[],
): number {
  let tax = 0;
  for (const row of adSpendRows) {
    const settings = resolveCostSettingsAt(history, row.date);
    tax += row.spend * (settings.ecommerceTransactionTaxPercent / 100);
  }
  return tax;
}
