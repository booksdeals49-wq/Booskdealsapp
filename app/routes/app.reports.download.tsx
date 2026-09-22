// Resource route (no UI) — streams a downloadable .xlsx workbook covering
// everything shown on the Reports page: range metrics, the enhanced
// cost/profit breakdown, channel-wise performance, product-wise delivery
// analysis, and a full per-order detail table.
//
// One workbook, four worksheets — mirroring the Reports page's own tab
// split (Overview / Costs & Profit / Channels & Products) so the export
// reads the same way the page does, plus a fourth "Order Detail" sheet for
// the per-order table that only ever existed in this export, not on the
// page itself.

import type { LoaderFunctionArgs } from "@remix-run/node";
import ExcelJS from "exceljs";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveDateRange } from "../utils/dateRange.server";
import { getRangeSummary } from "../services/rangeSummary.server";
import { getCostBreakdown } from "../services/costBreakdown.server";
import { getChannelPerformance } from "../services/channelPerformance.server";
import { getProductDelivery } from "../services/productDelivery.server";
import { computeOrderProfit } from "../services/profit.server";
import { getBillingState, currentTier } from "../services/billing.server";
import { hasReportsAccess } from "../services/billingPlans";
import { wasDispatched } from "../services/orderSync.server";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
  costRecognitionDate,
} from "../services/costSettingsHistory.server";
import { getCourierRateOverrides } from "../services/courierRates.server";

type OrderRow = {
  orderNumber: string;
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  cancelledAt: Date | null;
  deliveredAt: Date | null;
  dispatchedAt: Date | null;
  inTransitAt: Date | null;
  fulfillmentStatus: string | null;
  trackingCompany: string | null;
  lineItemsJson: string;
  city: string | null;
  createdAt: Date;
};

// --- the app's own "financial" palette (see app/components/theme.ts) —
// reused here so the workbook reads as the same product as the Reports
// page, not a generic spreadsheet export.
const NAVY = "FF0B2545";
const SLATE = "FF5B6B82";
const LOSS = "FFA1291E";
const PROFIT = "FF0F6E5C";
const HEADER_FILL = "FFEEF2F7";
const BORDER = "FFE3E8EF";

const MONEY_FMT = "#,##0.00";
const PERCENT_FMT = '0.00"%"';
const RATIO_FMT = "0.00";
const INT_FMT = "#,##0";

// Every sheet opens with the same four-line identity block (report title,
// period, generated timestamp, currency) so each one is meaningful on its
// own if a merchant forwards just that sheet or prints it separately.
function titleBlock(
  ws: ExcelJS.Worksheet,
  shop: string,
  periodLabel: string,
  generatedAt: string,
  currency: string,
): number {
  ws.getCell("A1").value = `COD Profit Report — ${shop}`;
  ws.getCell("A1").font = { bold: true, size: 13, color: { argb: NAVY } };
  ws.getCell("A2").value = `Period: ${periodLabel}`;
  ws.getCell("A2").font = { size: 10, color: { argb: SLATE } };
  ws.getCell("A3").value = `Generated: ${generatedAt}`;
  ws.getCell("A3").font = { size: 10, color: { argb: SLATE } };
  ws.getCell("A4").value = `Currency: ${currency}`;
  ws.getCell("A4").font = { size: 10, color: { argb: SLATE } };
  return 6; // next free row after a blank spacer row
}

// A shaded, bold banner row — used to separate sections within a sheet
// (e.g. "Costs Breakdown" vs "Net Profit (Realized) Breakdown").
function sectionHeader(ws: ExcelJS.Worksheet, row: number, title: string, span: number): number {
  for (let c = 1; c <= span; c++) {
    const cell = ws.getCell(row, c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    if (c === 1) {
      cell.value = title;
      cell.font = { bold: true, size: 11, color: { argb: NAVY } };
    }
  }
  return row + 2;
}

// A bold, bottom-bordered column-heading row for a proper data table.
function tableHeader(ws: ExcelJS.Worksheet, row: number, headings: string[]): number {
  headings.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: SLATE } };
    cell.border = { bottom: { style: "thin", color: { argb: BORDER } } };
  });
  return row + 1;
}

type Kind = "money" | "percent" | "ratio" | "int" | "text";

// One "Label ...... value" row, formatted by kind. Returns the next free
// row so callers can chain writes without tracking the counter by hand.
function writeKV(
  ws: ExcelJS.Worksheet,
  row: number,
  label: string,
  value: number | string,
  kind: Kind,
  opts: { indent?: number; bold?: boolean; italic?: boolean; negative?: boolean } = {},
): number {
  const labelCell = ws.getCell(row, 1);
  labelCell.value = label;
  labelCell.font = {
    bold: !!opts.bold,
    italic: !!opts.italic,
    size: 10.5,
    color: opts.italic ? { argb: SLATE } : undefined,
  };
  if (opts.indent) labelCell.alignment = { indent: opts.indent };

  const valueCell = ws.getCell(row, 2);
  if (kind === "text") {
    valueCell.value = value;
  } else {
    valueCell.value = typeof value === "number" ? value : Number(value);
    valueCell.numFmt =
      kind === "percent" ? PERCENT_FMT : kind === "ratio" ? RATIO_FMT : kind === "int" ? INT_FMT : MONEY_FMT;
  }
  valueCell.font = { bold: !!opts.bold, size: 10.5, color: opts.negative ? { argb: LOSS } : undefined };
  valueCell.alignment = { ...valueCell.alignment, horizontal: "right" };
  return row + 1;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const billingState = await getBillingState(shop);
  if (!hasReportsAccess(currentTier(billingState))) {
    return new Response(
      "Report export is part of the Starter, Growth and Pro plans. Visit Plan & Billing in the app to upgrade.",
      { status: 402, headers: { "Content-Type": "text/plain" } },
    );
  }

  const url = new URL(request.url);
  const range = resolveDateRange(url);
  const { from, to } = range;

  const [rangeSummary, costBreakdown, channelPerformance, productDelivery, orders, costSettingsHistory, productCosts, courierRates] =
    await Promise.all([
      getRangeSummary(shop, from, to),
      getCostBreakdown(shop, from, to),
      getChannelPerformance(shop, from, to),
      getProductDelivery(shop, from, to),
      prisma.orderRecord.findMany({
        where: { shop, createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: "desc" },
      }),
      getCostSettingsHistory(shop),
      prisma.productCost.findMany({ where: { shop } }),
      getCourierRateOverrides(shop),
    ]);

  const overrides = productCosts.map(
    (p: { variantId: string; costPerUnit: number }) => ({
      variantId: p.variantId,
      costPerUnit: p.costPerUnit,
    }),
  );

  const rows = orders as OrderRow[];
  const currency = rangeSummary.currency;
  const generatedAt = new Date().toISOString();
  const periodLabel = `${range.fromLabel} to ${range.toLabel}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "True COD Profit";
  workbook.created = new Date();

  // ---------------- Sheet 1: Overview ----------------
  const overviewWs = workbook.addWorksheet("Overview");
  overviewWs.columns = [{ width: 46 }, { width: 18 }];
  let r = titleBlock(overviewWs, shop, periodLabel, generatedAt, currency);
  r = sectionHeader(overviewWs, r, "Range Metrics", 2);
  r = writeKV(overviewWs, r, "Total orders", rangeSummary.orderCount, "int");
  r = writeKV(overviewWs, r, "Returned (RTO)", rangeSummary.rtoCount, "int");
  r = writeKV(overviewWs, r, "RTO rate", rangeSummary.rtoRatePercent, "percent");
  r = writeKV(overviewWs, r, "Total revenue (gross)", rangeSummary.grossRevenue, "money");
  r = writeKV(overviewWs, r, "Revenue (realized)", rangeSummary.summary.revenue, "money");
  r = writeKV(overviewWs, r, "Pending fulfillment revenue", rangeSummary.summary.pendingFulfillmentRevenue, "money");
  r = writeKV(overviewWs, r, "Unrealized revenue (pipeline)", rangeSummary.summary.pipelineRevenue, "money");
  r = writeKV(overviewWs, r, "Average order value", rangeSummary.aov, "money");
  r = writeKV(overviewWs, r, "Returns value (lost)", rangeSummary.returnsAmount, "money");
  r = writeKV(overviewWs, r, "Net profit (realized, after ad spend)", rangeSummary.netProfitAfterAdSpend, "money", {
    bold: true,
    negative: rangeSummary.netProfitAfterAdSpend < 0,
  });
  // Of the net profit line above, how much is cost already deducted for
  // orders still in transit (dispatched, not yet delivered) — their
  // matching revenue is the "Unrealized revenue (pipeline)" line above, not
  // yet landed. Kept as an italic note rather than a plain metric.
  r = writeKV(
    overviewWs,
    r,
    "of which: cost for orders still in transit (not yet a loss)",
    rangeSummary.summary.inTransitCost,
    "money",
    { indent: 1, italic: true },
  );
  r = writeKV(overviewWs, r, "Profit per order", rangeSummary.profitPerOrder, "money", {
    negative: rangeSummary.profitPerOrder < 0,
  });
  r = writeKV(overviewWs, r, "Total costs (incl. ad spend)", costBreakdown.totalCostsInclAdSpend, "money");
  r = writeKV(overviewWs, r, "Gross ROAS (x)", rangeSummary.roas.grossRoas, "ratio");
  r = writeKV(overviewWs, r, "True ROAS, COD-adjusted (x)", rangeSummary.roas.trueRoas, "ratio", {
    negative: rangeSummary.totalAdSpend > 0 && rangeSummary.roas.trueRoas < 1,
  });
  r = writeKV(overviewWs, r, "Total ad spend", rangeSummary.totalAdSpend, "money");
  r = writeKV(overviewWs, r, "Ecommerce transaction tax (on ad spend)", rangeSummary.ecommerceTransactionTax, "money");
  r = writeKV(overviewWs, r, "Blended CAC", rangeSummary.blendedCac, "money");

  // ---------------- Sheet 2: Costs & Profit ----------------
  const costsWs = workbook.addWorksheet("Costs & Profit");
  costsWs.columns = [{ width: 46 }, { width: 18 }];
  r = titleBlock(costsWs, shop, periodLabel, generatedAt, currency);
  r = sectionHeader(costsWs, r, "Costs Breakdown", 2);
  r = writeKV(costsWs, r, "Product costs (COGS) — total", costBreakdown.totalCogs, "money", { bold: true });
  costBreakdown.cogsByCountry.forEach((row) => {
    r = writeKV(costsWs, r, row.country, "", "text", { indent: 1, bold: true });
    r = writeKV(costsWs, r, "Total COGS", row.totalCogs, "money", { indent: 2 });
    if (row.returnedCogs > 0) {
      r = writeKV(costsWs, r, "Returned COGS (recovered)", -row.returnedCogs, "money", { indent: 2 });
    }
    r = writeKV(costsWs, r, "Final COGS (used)", row.finalCogsUsed, "money", { indent: 2, bold: true });
  });
  r = writeKV(costsWs, r, "Cash handling / payment fees", costBreakdown.cashHandlingFees, "money");
  r = writeKV(costsWs, r, "Delivery fees", costBreakdown.deliveryFees, "money");
  r = writeKV(costsWs, r, "RTO shipping costs", costBreakdown.rtoCosts, "money");
  r = writeKV(costsWs, r, "Taxes", costBreakdown.taxes, "money");
  r = writeKV(costsWs, r, "Packaging fees", costBreakdown.packagingFees, "money");
  r = writeKV(costsWs, r, "Ad spend — total", costBreakdown.totalAdSpend, "money", { bold: true });
  costBreakdown.adSpendByPlatform.forEach((row) => {
    r = writeKV(costsWs, r, row.platform, row.spend, "money", { indent: 1 });
  });
  r = writeKV(costsWs, r, "Ecommerce transaction tax", costBreakdown.ecommerceTransactionTax, "money", { indent: 1 });
  r = writeKV(costsWs, r, "Total costs (incl. ad spend)", costBreakdown.totalCostsInclAdSpend, "money", {
    bold: true,
    negative: true,
  });

  r += 1;
  r = sectionHeader(costsWs, r, "Net Profit (Realized) Breakdown", 2);
  r = writeKV(costsWs, r, "Revenue starting point: Delivered GMV", costBreakdown.deliveredGmv, "money", { bold: true });
  r = writeKV(costsWs, r, "Final COGS (used)", -costBreakdown.finalCogsUsed, "money");
  r = writeKV(costsWs, r, "Cash handling / payment fees", -costBreakdown.cashHandlingFees, "money");
  r = writeKV(costsWs, r, "Delivery fees", -costBreakdown.deliveryFees, "money");
  r = writeKV(costsWs, r, "RTO shipping costs", -costBreakdown.rtoCosts, "money");
  r = writeKV(costsWs, r, "Taxes", -costBreakdown.taxes, "money");
  r = writeKV(costsWs, r, "Packaging fees", -costBreakdown.packagingFees, "money");
  r = writeKV(costsWs, r, "Ad spend (all platforms)", -costBreakdown.totalAdSpend, "money");
  r = writeKV(costsWs, r, "Ecommerce transaction tax", -costBreakdown.ecommerceTransactionTax, "money");
  r = writeKV(costsWs, r, "Net profit (realized)", costBreakdown.netProfitAfterAdSpend, "money", {
    bold: true,
    negative: costBreakdown.netProfitAfterAdSpend < 0,
  });

  // ---------------- Sheet 3: Channels & Products ----------------
  const chanWs = workbook.addWorksheet("Channels & Products");
  chanWs.columns = [
    { width: 30 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 14 },
    { width: 12 },
    { width: 16 },
    { width: 16 },
  ];
  r = titleBlock(chanWs, shop, periodLabel, generatedAt, currency);
  r = sectionHeader(chanWs, r, "Channel-wise Performance", 7);
  r = tableHeader(chanWs, r, ["Channel", "Orders", "Delivered", "RTO", "Delivery rate", "RTO rate", "Avg order value"]);
  channelPerformance.forEach((row) => {
    chanWs.getCell(r, 1).value = row.channel;
    chanWs.getCell(r, 2).value = row.orders;
    chanWs.getCell(r, 2).numFmt = INT_FMT;
    chanWs.getCell(r, 3).value = row.delivered;
    chanWs.getCell(r, 3).numFmt = INT_FMT;
    chanWs.getCell(r, 4).value = row.rto;
    chanWs.getCell(r, 4).numFmt = INT_FMT;
    chanWs.getCell(r, 5).value = row.deliveryRatePercent;
    chanWs.getCell(r, 5).numFmt = PERCENT_FMT;
    chanWs.getCell(r, 6).value = row.rtoRatePercent;
    chanWs.getCell(r, 6).numFmt = PERCENT_FMT;
    chanWs.getCell(r, 7).value = row.avgOrderValue;
    chanWs.getCell(r, 7).numFmt = MONEY_FMT;
    r += 1;
  });

  r += 1;
  r = sectionHeader(chanWs, r, "Product-wise Delivery Analysis", 8);
  r = tableHeader(chanWs, r, [
    "Product",
    "Orders",
    "In process",
    "Delivered",
    "RTO",
    "Delivery rate",
    "RTO rate",
    "Revenue impact",
  ]);
  productDelivery.forEach((row) => {
    chanWs.getCell(r, 1).value = row.title;
    chanWs.getCell(r, 2).value = row.orders;
    chanWs.getCell(r, 2).numFmt = INT_FMT;
    chanWs.getCell(r, 3).value = row.inProcess;
    chanWs.getCell(r, 3).numFmt = INT_FMT;
    chanWs.getCell(r, 4).value = row.delivered;
    chanWs.getCell(r, 4).numFmt = INT_FMT;
    chanWs.getCell(r, 5).value = row.rto;
    chanWs.getCell(r, 5).numFmt = INT_FMT;
    chanWs.getCell(r, 6).value = row.deliveryRatePercent;
    chanWs.getCell(r, 6).numFmt = PERCENT_FMT;
    const rtoCell = chanWs.getCell(r, 7);
    rtoCell.value = row.rtoRatePercent;
    rtoCell.numFmt = PERCENT_FMT;
    if (row.rtoRatePercent > 20) rtoCell.font = { color: { argb: LOSS }, bold: true };
    chanWs.getCell(r, 8).value = row.revenueImpact;
    chanWs.getCell(r, 8).numFmt = MONEY_FMT;
    r += 1;
  });

  // ---------------- Sheet 4: Order Detail ----------------
  const orderWs = workbook.addWorksheet("Order Detail");
  const orderHeadings = [
    "Order",
    "Date",
    "City",
    "Courier",
    "Status",
    "Order total",
    "Realized revenue",
    "Pending fulfillment revenue",
    "Pipeline (unrealized) revenue",
    "COGS loss",
    "Delivery fee",
    "RTO fee",
    "Cash handling",
    "Tax",
    "Packaging",
    "Net profit",
    "Margin %",
  ];
  orderWs.columns = orderHeadings.map((h) => ({
    width: ["Order", "Date", "City", "Courier", "Status"].includes(h) ? 16 : 14,
  }));
  let orderHeaderRow = titleBlock(orderWs, shop, periodLabel, generatedAt, currency);
  orderHeaderRow = sectionHeader(orderWs, orderHeaderRow, "Order Detail", orderHeadings.length);
  const headerRowIndex = tableHeader(orderWs, orderHeaderRow, orderHeadings) - 1;
  orderWs.autoFilter = { from: { row: headerRowIndex, column: 1 }, to: { row: headerRowIndex, column: orderHeadings.length } };
  orderWs.views = [{ state: "frozen", ySplit: headerRowIndex }];

  let orow = headerRowIndex + 1;
  rows.forEach((o) => {
    const isCancelled = Boolean(o.cancelledAt) && !o.isRto;
    const isDelivered = Boolean(o.deliveredAt);
    const isDispatched = wasDispatched(o.fulfillmentStatus);
    const isInTransit = Boolean(o.inTransitAt);
    const isPending = o.isCod && !o.isRto && !isCancelled && !isDelivered;
    const b = computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        isCancelled,
        isDelivered,
        isDispatched,
        courierName: o.trackingCompany,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      // This order's own dispatch/placement date, not today's rates — see
      // costSettingsHistory.server.ts.
      resolveCostSettingsAt(costSettingsHistory, costRecognitionDate(o)),
      overrides,
      courierRates,
    );
    const status = o.isRto
      ? "RTO"
      : isCancelled
        ? "Cancelled"
        : o.isCod && !isDelivered
          ? isInTransit
            ? "In transit"
            : isDispatched
              ? "Fulfilled, awaiting courier"
              : "Awaiting fulfillment"
          : "Delivered/active";

    orderWs.getCell(orow, 1).value = o.orderNumber;
    orderWs.getCell(orow, 2).value = new Date(o.createdAt).toISOString().slice(0, 10);
    orderWs.getCell(orow, 3).value = o.city || "Unknown";
    orderWs.getCell(orow, 4).value = o.trackingCompany || "Unknown";
    orderWs.getCell(orow, 5).value = status;
    orderWs.getCell(orow, 6).value = o.totalPrice;
    orderWs.getCell(orow, 7).value = b.revenue;
    orderWs.getCell(orow, 8).value = b.pendingFulfillmentRevenue;
    orderWs.getCell(orow, 9).value = b.pipelineRevenue;
    orderWs.getCell(orow, 10).value = b.cogsLoss;
    orderWs.getCell(orow, 11).value = b.deliveryFee;
    orderWs.getCell(orow, 12).value = b.rtoCost;
    orderWs.getCell(orow, 13).value = b.cashHandlingFee;
    orderWs.getCell(orow, 14).value = b.tax;
    orderWs.getCell(orow, 15).value = b.packagingFee;
    // Net profit only means something once an order's outcome is known
    // (delivered or RTO) — see app.orders.tsx for the same rule applied to
    // the Orders table. "N/A" rather than a computed dollar figure avoids
    // this reading as a real loss on a still-pending order.
    orderWs.getCell(orow, 16).value = isPending ? "N/A" : b.netProfit;
    orderWs.getCell(orow, 17).value = isPending ? "N/A" : b.marginPercent;

    for (let c = 6; c <= 15; c++) orderWs.getCell(orow, c).numFmt = MONEY_FMT;
    if (!isPending) {
      orderWs.getCell(orow, 16).numFmt = MONEY_FMT;
      orderWs.getCell(orow, 16).font = { color: { argb: b.netProfit < 0 ? LOSS : PROFIT } };
      orderWs.getCell(orow, 17).numFmt = PERCENT_FMT;
    }
    orow += 1;
  });

  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="profitability-report-${range.fromLabel}-to-${range.toLabel}.xlsx"`,
    },
  });
};
