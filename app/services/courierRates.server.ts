// Thin Prisma-backed reads/writes for CourierRate — the per-courier
// delivery costs a merchant configures in Cost Settings (TCS, Trax,
// Leopards, PostEx, Daraz, etc. for a Pakistan-based store, or whichever
// couriers a shop actually ships with). Deliberately NOT versioned by date
// the way CostSettings is — see the model's comment in schema.prisma for
// why (same "current value only" precedent already used for ProductCost,
// per-product cost overrides, in this app). Kept as its own small module,
// same shape as costSettingsHistory.server.ts, so every route that needs
// courier rates imports from one place.
import prisma from "../db.server";
import type { CourierRateOverride } from "./profit.server";

/** Every courier rate configured for a shop, alphabetical by name. */
export async function getCourierRates(shop: string) {
  return prisma.courierRate.findMany({
    where: { shop },
    orderBy: { courierName: "asc" },
  });
}

/** The plain {courierName, cost}[] shape computeOrderProfit expects. */
export async function getCourierRateOverrides(
  shop: string,
): Promise<CourierRateOverride[]> {
  const rates = await getCourierRates(shop);
  return rates.map((r: { courierName: string; cost: number }) => ({
    courierName: r.courierName,
    cost: r.cost,
  }));
}

function courierKeyFor(courierName: string): string {
  return courierName.trim().toLowerCase();
}

/**
 * Add a new courier or update an existing one's cost — matched
 * case-insensitively (via courierKey) so a merchant can't end up with both
 * "TCS" and "tcs" as separate rows; saving either just updates the same
 * one. Throws on a blank name.
 */
export async function upsertCourierRate(
  shop: string,
  courierName: string,
  cost: number,
) {
  const trimmedName = courierName.trim();
  const courierKey = courierKeyFor(trimmedName);
  if (!courierKey) {
    throw new Error("Courier name is required");
  }
  return prisma.courierRate.upsert({
    where: { shop_courierKey: { shop, courierKey } },
    update: { cost, courierName: trimmedName },
    create: { shop, courierName: trimmedName, courierKey, cost },
  });
}

/** Scoped to `shop` as well as `id` — a shop can never delete another shop's row. */
export async function deleteCourierRate(shop: string, id: string) {
  await prisma.courierRate.deleteMany({ where: { shop, id } });
}

/**
 * Distinct courier names Shopify has actually reported on this shop's
 * recent orders (OrderRecord.trackingCompany) that don't yet have a
 * configured rate — surfaced in Cost Settings as a nudge ("we detected
 * these couriers, add a cost for them") so a merchant can see the
 * auto-detection is genuinely working and knows what to add next. Matching
 * against configured rates is a simple case-insensitive exact check here
 * (not the fuzzier substring matching profit.server.ts's resolveDeliveryFee
 * uses) — good enough for a hint, not a billing-critical computation.
 */
export async function getUnmappedCouriers(
  shop: string,
  days = 30,
): Promise<string[]> {
  const [detected, rates] = await Promise.all([
    prisma.orderRecord.findMany({
      where: {
        shop,
        trackingCompany: { not: null },
        createdAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
      },
      distinct: ["trackingCompany"],
      select: { trackingCompany: true },
      take: 25,
    }),
    getCourierRates(shop),
  ]);

  const configuredKeys = new Set(
    rates.map((r: { courierName: string }) => courierKeyFor(r.courierName)),
  );
  const seen = new Set<string>();
  const unmapped: string[] = [];
  for (const row of detected as Array<{ trackingCompany: string | null }>) {
    const name = row.trackingCompany;
    if (!name) continue;
    const key = courierKeyFor(name);
    if (configuredKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    unmapped.push(name);
  }
  return unmapped;
}
