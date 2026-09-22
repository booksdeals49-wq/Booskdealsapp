import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  DataTable,
  Badge,
  Divider,
  Tabs,
  Banner,
} from "@shopify/polaris";
import {
  ExportIcon,
  OrderIcon,
  ChartLineIcon,
  CashDollarIcon,
  WalletIcon,
  ReceiptIcon,
  ChartHistogramGrowthIcon,
  MegaphoneIcon,
  PersonIcon,
  GlobeIcon,
  ProductIcon,
  ClockIcon,
  ReceiptDollarIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { resolveDateRange } from "../utils/dateRange.server";
import { getRangeSummary } from "../services/rangeSummary.server";
import { getCostBreakdown } from "../services/costBreakdown.server";
import { getChannelPerformance } from "../services/channelPerformance.server";
import { getProductDelivery } from "../services/productDelivery.server";
import { StatCard, SectionHeading } from "../components/StatTile";
import { CostBreakdownPanel, NetProfitWaterfall } from "../components/CostBreakdownPanels";
import { DateRangePicker } from "../components/DateRangePicker";
import { getBillingState, currentTier } from "../services/billing.server";
import { hasReportsAccess } from "../services/billingPlans";
import { UpgradePrompt } from "../components/UpgradePrompt";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const billingState = await getBillingState(shop);
  const tier = currentTier(billingState);
  const url = new URL(request.url);
  const range = resolveDateRange(url);

  if (!hasReportsAccess(tier)) {
    // Free plan: a basic report — headline range metrics for the last 30
    // days only. Custom date ranges, cost breakdown, channel/product
    // performance and CSV export are part of the full Reports hub
    // (Starter, Growth and Pro).
    const rangeSummary = await getRangeSummary(shop, range.from, range.to);
    return json({ locked: true as const, tier, range, rangeSummary });
  }

  const [rangeSummary, costBreakdown, channelPerformance, productDelivery] = await Promise.all([
    getRangeSummary(shop, range.from, range.to),
    getCostBreakdown(shop, range.from, range.to),
    getChannelPerformance(shop, range.from, range.to),
    getProductDelivery(shop, range.from, range.to),
  ]);

  return json({
    locked: false as const,
    range,
    rangeSummary,
    costBreakdown,
    channelPerformance,
    productDelivery,
  });
};

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// A net-profit dip isn't necessarily a loss — it can just mean a lot got
// dispatched recently. Cost (COGS/delivery/packaging) is deducted the
// moment an order ships, but that order's revenue doesn't land until it's
// delivered, so a big dispatch day shows its cost now and its revenue
// later. Spell that out instead of leaving the number looking like a
// straight loss.
function netProfitFootnote(
  inTransitCost: number,
  pipelineRevenue: number,
  currency: string,
): string {
  if (inTransitCost <= 0) return "After ad spend, from delivered orders";
  return `After ad spend · includes ${money(inTransitCost, currency)} in cost for orders still in transit — ${money(pipelineRevenue, currency)} in matching revenue expected once delivered`;
}

const PERFORMANCE_TONE: Record<string, "success" | "warning" | "critical"> = {
  good: "success",
  average: "warning",
  poor: "critical",
};
const PERFORMANCE_LABEL: Record<string, string> = {
  good: "Good performance",
  average: "Average performance",
  poor: "Poor performance",
};

// Small uppercase "eyebrow" heading used to group stat cards within the
// Overview tab (Performance / Costs & ad spend / Pipeline) — Polaris's own
// Text variants don't include this letter-spaced label treatment, so it's
// a plain styled element rather than a Text variant.
function GroupLabel({ children }: { children: string }) {
  return (
    <p
      style={{
        fontSize: 11.5,
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "#5B6B82",
        margin: 0,
      }}
    >
      {children}
    </p>
  );
}

const REPORT_TABS = [
  {
    id: "overview",
    content: "Overview",
    subtitle: "Performance, pipeline and ad spend for the selected period.",
  },
  {
    id: "costs-profit",
    content: "Costs & Profit",
    subtitle: "Where every dollar of cost goes, and how realized net profit is built up.",
  },
  {
    id: "channels-products",
    content: "Channels & Products",
    subtitle: "Which channels and products are converting, delivering, and returning.",
  },
];

export default function Reports() {
  const data = useLoaderData<typeof loader>();
  const [selectedTab, setSelectedTab] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // A plain <a target="_blank"> download link is unreliable inside
  // Shopify's embedded admin iframe — the new-tab navigation can get
  // queued/suppressed by the browser instead of firing immediately, which
  // is exactly the "I clicked it, nothing happened, then it appeared after
  // I reloaded the app" symptom. Fetching the file in-page and triggering
  // the save from a Blob URL avoids opening a second tab/window entirely,
  // so it isn't subject to that, and it lets the button show a real
  // loading state plus a real error message instead of failing silently.
  async function handleDownload(fromLabel: string, toLabel: string) {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(`/app/reports/download?from=${fromLabel}&to=${toLabel}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `The server returned an error (${res.status}).`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `profitability-report-${fromLabel}-to-${toLabel}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : "Couldn't generate the Excel report — please try again.",
      );
    } finally {
      setDownloading(false);
    }
  }

  if (data.locked) {
    const { rangeSummary } = data;
    const currency = rangeSummary.currency;
    return (
      <Page
        title="Reports"
        subtitle="Basic report — last 30 days"
        backAction={{ url: "/app" }}
      >
        <BlockStack gap="400">
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <StatCard
              label="Total orders"
              value={String(rangeSummary.orderCount)}
              icon={OrderIcon}
              footnote={`${rangeSummary.rtoCount} returned`}
            />
            <StatCard
              label="Total revenue (gross)"
              value={money(rangeSummary.grossRevenue, currency)}
              icon={ChartLineIcon}
              footnote={`AOV ${money(rangeSummary.aov, currency)}`}
            />
            <StatCard
              label="Net profit (realized)"
              value={money(rangeSummary.netProfitAfterAdSpend, currency)}
              tone={rangeSummary.netProfitAfterAdSpend >= 0 ? "success" : "critical"}
              icon={CashDollarIcon}
              footnote={netProfitFootnote(
                rangeSummary.summary.inTransitCost,
                rangeSummary.summary.pipelineRevenue,
                currency,
              )}
            />
            <StatCard
              label="RTO rate"
              value={`${rangeSummary.rtoRatePercent.toFixed(1)}%`}
              tone={rangeSummary.rtoRatePercent > 20 ? "critical" : undefined}
              icon={ReceiptIcon}
            />
            <StatCard
              label="Pending fulfillment"
              value={money(rangeSummary.summary.pendingFulfillmentRevenue, currency)}
              icon={ClockIcon}
              footnote="Placed COD orders you haven't shipped yet"
            />
            <StatCard
              label="Unrealized revenue (pipeline)"
              value={money(rangeSummary.summary.pipelineRevenue, currency)}
              icon={ClockIcon}
              footnote="Dispatched COD orders awaiting courier-confirmed delivery"
            />
          </InlineGrid>
          <UpgradePrompt
            feature="The full Reports hub"
            currentTier={data.tier}
            detail="Custom date ranges, cost breakdown, channel-wise performance, product-wise delivery analysis, and Excel export are part of Starter, Growth and Pro."
          />
        </BlockStack>
      </Page>
    );
  }

  const { range, rangeSummary, costBreakdown, channelPerformance, productDelivery } = data;
  const currency = rangeSummary.currency;

  return (
    <Page
      title="Reports"
      subtitle={REPORT_TABS[selectedTab].subtitle}
      backAction={{ url: "/app" }}
    >
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                {range.fromLabel} to {range.toLabel}
              </Text>
              <Button
                icon={ExportIcon}
                loading={downloading}
                onClick={() => handleDownload(range.fromLabel, range.toLabel)}
              >
                Download Excel
              </Button>
            </InlineStack>
            <DateRangePicker fromLabel={range.fromLabel} toLabel={range.toLabel} />
            {downloadError && (
              <Banner tone="critical" onDismiss={() => setDownloadError(null)}>
                {downloadError}
              </Banner>
            )}
          </BlockStack>
        </Card>

        <Card padding="0">
          <Tabs tabs={REPORT_TABS} selected={selectedTab} onSelect={setSelectedTab} />
        </Card>

        {selectedTab === 0 && (
          <BlockStack gap="500">
            <BlockStack gap="300">
              <GroupLabel>Performance</GroupLabel>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                <StatCard
                  label="Total orders"
                  value={String(rangeSummary.orderCount)}
                  icon={OrderIcon}
                  footnote={`${rangeSummary.rtoCount} returned · ${rangeSummary.rtoRatePercent.toFixed(1)}% RTO rate`}
                />
                <StatCard
                  label="Total revenue (gross)"
                  value={money(rangeSummary.grossRevenue, currency)}
                  icon={ChartLineIcon}
                  footnote={`AOV ${money(rangeSummary.aov, currency)}`}
                />
                <StatCard
                  label="Net profit (realized)"
                  value={money(rangeSummary.netProfitAfterAdSpend, currency)}
                  tone={rangeSummary.netProfitAfterAdSpend >= 0 ? "success" : "critical"}
                  icon={CashDollarIcon}
                  footnote={netProfitFootnote(
                    rangeSummary.summary.inTransitCost,
                    rangeSummary.summary.pipelineRevenue,
                    currency,
                  )}
                />
                <StatCard
                  label="Profit / order"
                  value={money(rangeSummary.profitPerOrder, currency)}
                  tone={rangeSummary.profitPerOrder >= 0 ? "success" : "critical"}
                  icon={ReceiptIcon}
                />
              </InlineGrid>
            </BlockStack>

            <BlockStack gap="300">
              <GroupLabel>Costs &amp; ad spend</GroupLabel>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                <StatCard
                  label="Total costs"
                  value={money(costBreakdown.totalCostsInclAdSpend, currency)}
                  icon={WalletIcon}
                  footnote="Product + fees + shipping + ad spend"
                />
                <StatCard
                  label="ROAS (return on ad spend)"
                  value={`${rangeSummary.roas.trueRoas.toFixed(2)}x`}
                  tone={
                    rangeSummary.totalAdSpend > 0 && rangeSummary.roas.trueRoas < 1
                      ? "critical"
                      : undefined
                  }
                  icon={ChartHistogramGrowthIcon}
                  footnote={`Gross ROAS ${rangeSummary.roas.grossRoas.toFixed(2)}x`}
                />
                <StatCard
                  label="Total ad spend"
                  value={money(rangeSummary.totalAdSpend, currency)}
                  icon={MegaphoneIcon}
                  footnote={`${costBreakdown.adSpendByPlatform.length} platform${costBreakdown.adSpendByPlatform.length === 1 ? "" : "s"}`}
                />
                <StatCard
                  label="Ecommerce transaction tax"
                  value={money(rangeSummary.ecommerceTransactionTax, currency)}
                  icon={ReceiptDollarIcon}
                  footnote="Govt. tax on Meta/Google/TikTok/Snapchat spend"
                />
              </InlineGrid>
            </BlockStack>

            <BlockStack gap="300">
              <GroupLabel>Pipeline</GroupLabel>
              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                <StatCard
                  variant="quiet"
                  label="Blended CAC"
                  value={money(rangeSummary.blendedCac, currency)}
                  icon={PersonIcon}
                  footnote="Ad spend ÷ total orders"
                />
                <StatCard
                  variant="quiet"
                  label="Pending fulfillment"
                  value={money(rangeSummary.summary.pendingFulfillmentRevenue, currency)}
                  icon={ClockIcon}
                  footnote="Placed COD orders you haven't shipped yet"
                />
                <StatCard
                  variant="quiet"
                  label="Unrealized revenue (pipeline)"
                  value={money(rangeSummary.summary.pipelineRevenue, currency)}
                  icon={ClockIcon}
                  footnote="Dispatched COD orders awaiting courier-confirmed delivery"
                />
              </InlineGrid>
            </BlockStack>
          </BlockStack>
        )}

        {selectedTab === 1 && (
          <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <SectionHeading icon={WalletIcon} title="Costs breakdown" />
                <CostBreakdownPanel data={costBreakdown} money={money} />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <SectionHeading icon={CashDollarIcon} title="Net profit (realized) breakdown" />
                <NetProfitWaterfall data={costBreakdown} money={money} />
              </BlockStack>
            </Card>
          </InlineGrid>
        )}

        {selectedTab === 2 && (
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <SectionHeading
                  icon={GlobeIcon}
                  title="Channel-wise performance"
                  subtitle="Classified from the referring link captured at checkout — new orders only (see note below)."
                />
                {channelPerformance.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No orders in this range yet.
                  </Text>
                ) : (
                  <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                    {channelPerformance.map((row) => (
                      <div
                        key={row.channel}
                        style={{
                          border: "1px solid #E3E8EF",
                          borderRadius: 12,
                          padding: 16,
                        }}
                      >
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="span" variant="headingSm">
                              {row.channel}
                            </Text>
                            <Badge tone={PERFORMANCE_TONE[row.performance]}>
                              {PERFORMANCE_LABEL[row.performance]}
                            </Badge>
                          </InlineStack>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {row.orders} total orders
                          </Text>
                          <BlockStack gap="050">
                            <InlineStack align="space-between">
                              <Text as="span" variant="bodySm" tone="subdued">
                                Delivery rate
                              </Text>
                              <Text as="span" variant="bodySm" fontWeight="medium">
                                {row.deliveryRatePercent.toFixed(1)}%
                              </Text>
                            </InlineStack>
                            <div style={{ background: "#EEF2F7", borderRadius: 4, height: 6 }}>
                              <div
                                style={{
                                  width: `${Math.min(row.deliveryRatePercent, 100)}%`,
                                  background: "#0F6E5C",
                                  height: 6,
                                  borderRadius: 4,
                                }}
                              />
                            </div>
                          </BlockStack>
                          <BlockStack gap="050">
                            <InlineStack align="space-between">
                              <Text as="span" variant="bodySm" tone="subdued">
                                RTO rate
                              </Text>
                              <Text as="span" variant="bodySm" fontWeight="medium">
                                {row.rtoRatePercent.toFixed(1)}%
                              </Text>
                            </InlineStack>
                            <div style={{ background: "#EEF2F7", borderRadius: 4, height: 6 }}>
                              <div
                                style={{
                                  width: `${Math.min(row.rtoRatePercent, 100)}%`,
                                  background: "#A1291E",
                                  height: 6,
                                  borderRadius: 4,
                                }}
                              />
                            </div>
                          </BlockStack>
                          <Divider />
                          <Text as="span" variant="headingSm">
                            {money(row.avgOrderValue, currency)}{" "}
                            <Text as="span" tone="subdued" variant="bodySm">
                              avg order value
                            </Text>
                          </Text>
                        </BlockStack>
                      </div>
                    ))}
                  </InlineGrid>
                )}
                <Text as="p" tone="subdued" variant="bodySm">
                  Channel classification uses the referring link captured when
                  each order was placed. This is only recorded for orders synced
                  via webhook after this feature was enabled — older backfilled
                  orders show up as "Direct" until a future update re-syncs them.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  icon={ProductIcon}
                  title="Product-wise delivery analysis"
                  subtitle="Orders with multiple products appear under each product — totals may exceed the order count above."
                />
                {productDelivery.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No orders in this range yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                    headings={["Product", "Orders", "In process", "Delivery rate", "RTO rate", "Revenue impact"]}
                    rows={productDelivery.map((r) => [
                      r.title,
                      String(r.orders),
                      String(r.inProcess),
                      `${r.deliveryRatePercent.toFixed(1)}%`,
                      r.rtoRatePercent > 20 ? `⚠ ${r.rtoRatePercent.toFixed(1)}%` : `${r.rtoRatePercent.toFixed(1)}%`,
                      money(r.revenueImpact, currency),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
