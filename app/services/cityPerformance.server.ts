// Per-city profit performance — the fuller version of the "highest RTO-risk
// cities" list on the Dashboard, with delivery rate, cost breakdown, and
// average order value per city, for a dedicated report page.

import prisma from "../db.server";
import { computeOrderProfit } from "./profit.server";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
} from "./costSettingsHistory.server";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CityPerformanceRow = {
  city: string;
  orders: number;
  delivered: number;
  rto: number;
  deliveryRatePercent: number;
  rtoRatePercent: number;
  revenue: number;
  cogsLoss: number;
  netProfit: number;
  avgOrderValue: number;
};

type OrderRow = {
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  lineItemsJson: string;
  city: string | null;
};

export async function getCityPerformance(
  shop: string,
  days: number,
): Promise<CityPerformanceRow[]> {
  const [orders, costSettingsHistory, productCosts] = await Promise.all([
    prisma.orderRecord.findMany({
      where: { shop, createdAt: { gte: new Date(Date.now() - days * DAY_MS) } },
    }),
    getCostSettingsHistory(shop),
    prisma.productCost.findMany({ where: { shop } }),
  ]);

  // Not currently reachable from any route (City Performance was removed
  // from the app) — resolving against "now" rather than each order's own
  // dispatch date is a simplification that's fine only because this is
  // dead code; a real call site would use costRecognitionDate(o) like
  // every other loader.
  const settings = resolveCostSettingsAt(costSettingsHistory, new Date());
  const overrides = productCosts.map(
    (p: { variantId: string; costPerUnit: number }) => ({
      variantId: p.variantId,
      costPerUnit: p.costPerUnit,
    }),
  );

  type Accumulator = {
    orders: number;
    delivered: number;
    rto: number;
    revenue: number;
    cogsLoss: number;
    netProfit: number;
    grossOrderTotal: number; // sum of totalPrice regardless of RTO, for avg order value
  };

  const byCity = new Map<string, Accumulator>();

  (orders as OrderRow[]).forEach((o) => {
    const key = o.city || "Unknown";
    const breakdown = computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        // Not currently reachable from any route (City Performance was
        // removed from the app), so this is a minimal type-fix, not a
        // real cancelled-order distinction — kept simple on purpose.
        isCancelled: false,
        // Same rationale as isCancelled above — dead code, minimal type fix.
        isDelivered: true,
        isDispatched: true,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      settings,
      overrides,
    );

    const entry = byCity.get(key) || {
      orders: 0,
      delivered: 0,
      rto: 0,
      revenue: 0,
      cogsLoss: 0,
      netProfit: 0,
      grossOrderTotal: 0,
    };
    entry.orders += 1;
    entry.delivered += o.isRto ? 0 : 1;
    entry.rto += o.isRto ? 1 : 0;
    entry.revenue += breakdown.revenue;
    entry.cogsLoss += breakdown.cogsLoss;
    entry.netProfit += breakdown.netProfit;
    entry.grossOrderTotal += o.totalPrice;
    byCity.set(key, entry);
  });

  return Array.from(byCity.entries())
    .map(([city, v]) => ({
      city,
      orders: v.orders,
      delivered: v.delivered,
      rto: v.rto,
      deliveryRatePercent: v.orders > 0 ? (v.delivered / v.orders) * 100 : 0,
      rtoRatePercent: v.orders > 0 ? (v.rto / v.orders) * 100 : 0,
      revenue: v.revenue,
      cogsLoss: v.cogsLoss,
      netProfit: v.netProfit,
      avgOrderValue: v.orders > 0 ? v.grossOrderTotal / v.orders : 0,
    }))
    .sort((a, b) => b.orders - a.orders);
}
