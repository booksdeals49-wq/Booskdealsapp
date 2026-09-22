// The enhanced, multi-dimensional cost breakdown for the Reports hub: COGS
// split by shipping country, ad spend split by platform, plus the flat cost
// lines already in ProfitSummary — and a matching "Net Profit Breakdown"
// waterfall from realized (delivered) revenue down to true net profit
// (i.e. AFTER ad spend, unlike the plain per-order netProfit figure, which
// intentionally excludes ad spend since profit.server.ts is ad-platform
// agnostic — ad spend only enters the picture once it's aggregated here).

import prisma from "../db.server";
import { computeOrderProfit, summarizeProfit } from "./profit.server";
import { wasDispatched } from "./orderSync.server";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
  costRecognitionDate,
  computeAdSpendTax,
} from "./costSettingsHistory.server";

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
  lineItemsJson: string;
  country: string | null;
};

export type CountryCogsRow = {
  country: string;
  totalCogs: number;
  returnedCogs: number; // COGS recovered because the RTO'd item is restockable
  finalCogsUsed: number; // what's actually counted as a loss (= totalCogs - returnedCogs)
};

export type PlatformSpendRow = { platform: string; spend: number };

export type CostBreakdownData = {
  currency: string;
  cogsByCountry: CountryCogsRow[];
  totalCogs: number;
  totalReturnedCogs: number;
  finalCogsUsed: number;
  adSpendByPlatform: PlatformSpendRow[];
  totalAdSpend: number;
  ecommerceTransactionTax: number; // govt tax on ad-platform transactions (% of ad spend, blended across Meta/Google/TikTok/Snapchat)
  cashHandlingFees: number;
  taxes: number;
  packagingFees: number;
  deliveryFees: number;
  rtoCosts: number;
  totalCostsInclAdSpend: number;
  deliveredGmv: number; // realized revenue — the waterfall's starting point
  netProfitAfterAdSpend: number;
};

const PLATFORM_LABEL: Record<string, string> = {
  meta: "Facebook / Instagram",
  google: "Google Ads",
  tiktok: "TikTok",
  snapchat: "Snapchat",
};

export async function getCostBreakdown(
  shop: string,
  from: Date,
  to: Date,
): Promise<CostBreakdownData> {
  const [orders, costSettingsHistory, productCosts, adSpendRows] = await Promise.all([
    prisma.orderRecord.findMany({
      where: { shop, createdAt: { gte: from, lt: to } },
    }),
    getCostSettingsHistory(shop),
    prisma.productCost.findMany({ where: { shop } }),
    prisma.adSpend.findMany({ where: { shop, date: { gte: from, lt: to } } }),
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
        lineItems: JSON.parse(o.lineItemsJson),
      },
      resolveCostSettingsAt(costSettingsHistory, costRecognitionDate(o)),
      overrides,
    ),
  );
  const summary = summarizeProfit(breakdowns, rows.map((o) => o.isRto));

  // COGS by shipping country.
  const byCountry = new Map<string, { totalCogs: number; finalCogsUsed: number }>();
  rows.forEach((o, i) => {
    const key = o.country || "Unknown";
    const b = breakdowns[i];
    const entry = byCountry.get(key) || { totalCogs: 0, finalCogsUsed: 0 };
    entry.totalCogs += b.cogs;
    entry.finalCogsUsed += b.cogsLoss;
    byCountry.set(key, entry);
  });
  const cogsByCountry: CountryCogsRow[] = Array.from(byCountry.entries())
    .map(([country, v]) => ({
      country,
      totalCogs: v.totalCogs,
      returnedCogs: v.totalCogs - v.finalCogsUsed,
      finalCogsUsed: v.finalCogsUsed,
    }))
    .sort((a, b) => b.totalCogs - a.totalCogs);

  const totalCogs = cogsByCountry.reduce((s, r) => s + r.totalCogs, 0);
  const totalReturnedCogs = cogsByCountry.reduce((s, r) => s + r.returnedCogs, 0);
  const finalCogsUsed = cogsByCountry.reduce((s, r) => s + r.finalCogsUsed, 0);

  // Ad spend by platform.
  const byPlatform = new Map<string, number>();
  (adSpendRows as Array<{ platform: string; spend: number }>).forEach((r) => {
    byPlatform.set(r.platform, (byPlatform.get(r.platform) || 0) + r.spend);
  });
  const adSpendByPlatform: PlatformSpendRow[] = Array.from(byPlatform.entries())
    .map(([platform, spend]) => ({ platform: PLATFORM_LABEL[platform] ?? platform, spend }))
    .sort((a, b) => b.spend - a.spend);
  const totalAdSpend = adSpendByPlatform.reduce((s, r) => s + r.spend, 0);
  const ecommerceTransactionTax = computeAdSpendTax(
    adSpendRows as Array<{ date: Date; spend: number }>,
    costSettingsHistory,
  );

  const totalCostsInclAdSpend =
    finalCogsUsed +
    summary.deliveryFees +
    summary.rtoCosts +
    summary.cashHandlingFees +
    summary.taxes +
    summary.packagingFees +
    totalAdSpend +
    ecommerceTransactionTax;

  const deliveredGmv = summary.revenue;
  const netProfitAfterAdSpend = deliveredGmv - totalCostsInclAdSpend;

  return {
    currency: costSettingsHistory[costSettingsHistory.length - 1].currency,
    cogsByCountry,
    totalCogs,
    totalReturnedCogs,
    finalCogsUsed,
    adSpendByPlatform,
    totalAdSpend,
    ecommerceTransactionTax,
    cashHandlingFees: summary.cashHandlingFees,
    taxes: summary.taxes,
    packagingFees: summary.packagingFees,
    deliveryFees: summary.deliveryFees,
    rtoCosts: summary.rtoCosts,
    totalCostsInclAdSpend,
    deliveredGmv,
    netProfitAfterAdSpend,
  };
}
