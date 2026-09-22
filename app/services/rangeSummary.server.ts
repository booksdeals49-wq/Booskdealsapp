// Top-line "Range Metrics" numbers for the Reports hub — orders, gross vs.
// realized revenue, ROAS, and ad-spend-derived metrics (Blended CAC) for an
// arbitrary date range. Shared between the Reports page and its CSV export
// so the two always agree.

import prisma from "../db.server";
import {
  computeOrderProfit,
  summarizeProfit,
  computeRoas,
  type ProfitSummary,
  type RoasResult,
} from "./profit.server";
import { wasDispatched } from "./orderSync.server";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
  costRecognitionDate,
  computeAdSpendTax,
} from "./costSettingsHistory.server";
import { getCourierRateOverrides } from "./courierRates.server";

type OrderRow = {
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  cancelledAt: Date | null;
  deliveredAt: Date | null;
  dispatchedAt: Date | null;
  createdAt: Date;
  fulfillmentStatus: string | null;
  trackingCompany: string | null;
  lineItemsJson: string;
};

export type RangeSummaryData = {
  currency: string;
  orderCount: number;
  rtoCount: number;
  rtoRatePercent: number;
  grossRevenue: number; // sum of totalPrice across all orders, delivered or not
  returnsAmount: number; // gross value of RTO'd orders — potential revenue lost
  aov: number; // grossRevenue / orderCount
  summary: ProfitSummary; // realized (delivered) revenue, per-order netProfit — excludes ad spend
  roas: RoasResult;
  totalAdSpend: number;
  ecommerceTransactionTax: number; // govt tax on ad-platform transactions (% of ad spend, blended across Meta/Google/TikTok/Snapchat)
  netProfitAfterAdSpend: number; // the "true" bottom line, ad spend + transaction tax included
  profitPerOrder: number; // netProfitAfterAdSpend / orderCount
  blendedCac: number; // totalAdSpend / orderCount — a simple proxy since we don't track distinct customers
};

export async function getRangeSummary(
  shop: string,
  from: Date,
  to: Date,
): Promise<RangeSummaryData> {
  const [orders, costSettingsHistory, productCosts, adSpendRows, courierRates] = await Promise.all([
    prisma.orderRecord.findMany({ where: { shop, createdAt: { gte: from, lt: to } } }),
    getCostSettingsHistory(shop),
    prisma.productCost.findMany({ where: { shop } }),
    prisma.adSpend.findMany({ where: { shop, date: { gte: from, lt: to } } }),
    getCourierRateOverrides(shop),
  ]);

  const overrides = productCosts.map(
    (p: { variantId: string; costPerUnit: number }) => ({
      variantId: p.variantId,
      costPerUnit: p.costPerUnit,
    }),
  );

  const rows = orders as OrderRow[];
  const breakdowns = rows.map((o) =>
    computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        isCancelled: Boolean(o.cancelledAt) && !o.isRto,
        isDelivered: Boolean(o.deliveredAt),
        isDispatched: wasDispatched(o.fulfillmentStatus),
        courierName: o.trackingCompany,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      resolveCostSettingsAt(costSettingsHistory, costRecognitionDate(o)),
      overrides,
      courierRates,
    ),
  );
  const summary = summarizeProfit(breakdowns, rows.map((o) => o.isRto));

  const totalAdSpend = (adSpendRows as Array<{ spend: number }>).reduce(
    (s, r) => s + r.spend,
    0,
  );

  const grossRevenue = rows.reduce((s, o) => s + o.totalPrice, 0);
  const returnsAmount = rows.reduce((s, o) => s + (o.isRto ? o.totalPrice : 0), 0);
  const orderCount = rows.length;
  const rtoCount = summary.rtoCount;

  const roas = computeRoas(grossRevenue, summary.revenue, summary.netProfit, totalAdSpend);
  const ecommerceTransactionTax = computeAdSpendTax(
    adSpendRows as Array<{ date: Date; spend: number }>,
    costSettingsHistory,
  );
  const netProfitAfterAdSpend = summary.netProfit - totalAdSpend - ecommerceTransactionTax;

  return {
    currency: costSettingsHistory[costSettingsHistory.length - 1].currency,
    orderCount,
    rtoCount,
    rtoRatePercent: summary.rtoRatePercent,
    grossRevenue,
    returnsAmount,
    aov: orderCount > 0 ? grossRevenue / orderCount : 0,
    summary,
    roas,
    totalAdSpend,
    ecommerceTransactionTax,
    netProfitAfterAdSpend,
    profitPerOrder: orderCount > 0 ? netProfitAfterAdSpend / orderCount : 0,
    blendedCac: orderCount > 0 ? totalAdSpend / orderCount : 0,
  };
}
