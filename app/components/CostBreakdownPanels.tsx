// Two-panel "Costs Breakdown" / "Net Profit Breakdown" — a nested line-item
// waterfall (COGS by country, ad spend by platform, then the flat fee
// lines) that mirrors the reference layout, built on the app's own navy
// "financial" palette instead of arbitrary per-line colors.
import { BlockStack, InlineStack, Text, Divider } from "@shopify/polaris";
import { BRAND } from "./theme";
import type { CostBreakdownData } from "../services/costBreakdown.server";

function Line({
  label,
  value,
  indent = 0,
  emphasis,
  negative,
}: {
  label: string;
  value: string;
  indent?: number;
  emphasis?: boolean;
  negative?: boolean;
}) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      <Text
        as="span"
        variant={emphasis ? "bodyMd" : "bodySm"}
        fontWeight={emphasis ? "semibold" : "regular"}
        tone={emphasis ? undefined : "subdued"}
      >
        {" ".repeat(indent * 3)}
        {label}
      </Text>
      <Text
        as="span"
        variant={emphasis ? "bodyMd" : "bodySm"}
        fontWeight={emphasis ? "semibold" : "regular"}
        tone={negative ? "critical" : emphasis ? undefined : "subdued"}
      >
        {value}
      </Text>
    </InlineStack>
  );
}

export function CostBreakdownPanel({
  data,
  money,
}: {
  data: CostBreakdownData;
  money: (n: number, currency: string) => string;
}) {
  const c = data.currency;
  return (
    <BlockStack gap="300">
      <Line label="Product costs (COGS) — total" value={money(data.totalCogs, c)} emphasis />
      {data.cogsByCountry.map((row) => (
        <BlockStack key={row.country} gap="100">
          <Line label={row.country} value="" indent={1} />
          <Line label="Total COGS" value={money(row.totalCogs, c)} indent={2} />
          {row.returnedCogs > 0 && (
            <Line label="Returned COGS (recovered)" value={`-${money(row.returnedCogs, c)}`} indent={2} />
          )}
          <Line label="Final COGS (used)" value={money(row.finalCogsUsed, c)} indent={2} emphasis />
        </BlockStack>
      ))}

      <Divider />
      <Line label="Cash handling / payment fees" value={money(data.cashHandlingFees, c)} />
      <Line label="Delivery fees" value={money(data.deliveryFees, c)} />
      <Line label="RTO shipping costs" value={money(data.rtoCosts, c)} />
      <Line label="Taxes" value={money(data.taxes, c)} />
      <Line label="Packaging fees" value={money(data.packagingFees, c)} />

      <Divider />
      <Line label="Ad spend — total" value={money(data.totalAdSpend, c)} emphasis />
      {data.adSpendByPlatform.map((row) => (
        <Line key={row.platform} label={row.platform} value={money(row.spend, c)} indent={1} />
      ))}
      {data.adSpendByPlatform.length === 0 && (
        <Text as="p" tone="subdued" variant="bodySm">
          {" ".repeat(3)}No ad spend synced for this period — connect and sync a platform on the Ad Spend page.
        </Text>
      )}
      <Line label="Ecommerce transaction tax" value={money(data.ecommerceTransactionTax, c)} indent={1} />

      <Divider />
      <Line
        label="Total costs (incl. ad spend)"
        value={money(data.totalCostsInclAdSpend, c)}
        emphasis
        negative
      />
    </BlockStack>
  );
}

export function NetProfitWaterfall({
  data,
  money,
}: {
  data: CostBreakdownData;
  money: (n: number, currency: string) => string;
}) {
  const c = data.currency;
  const positive = data.netProfitAfterAdSpend >= 0;
  return (
    <BlockStack gap="300">
      <Line label="Revenue starting point: Delivered GMV" value={`+${money(data.deliveredGmv, c)}`} emphasis />
      <Divider />
      <Text as="p" tone="subdued" variant="bodySm">
        Cost deductions
      </Text>
      <Line label="Final COGS (used)" value={`-${money(data.finalCogsUsed, c)}`} />
      <Line label="Cash handling / payment fees" value={`-${money(data.cashHandlingFees, c)}`} />
      <Line label="Delivery fees" value={`-${money(data.deliveryFees, c)}`} />
      <Line label="RTO shipping costs" value={`-${money(data.rtoCosts, c)}`} />
      <Line label="Taxes" value={`-${money(data.taxes, c)}`} />
      <Line label="Packaging fees" value={`-${money(data.packagingFees, c)}`} />
      <Line label="Ad spend (all platforms)" value={`-${money(data.totalAdSpend, c)}`} />
      <Line label="Ecommerce transaction tax" value={`-${money(data.ecommerceTransactionTax, c)}`} />
      <Divider />
      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" variant="headingSm">
          Net profit (realized)
        </Text>
        <Text
          as="span"
          variant="headingSm"
          tone={positive ? "success" : "critical"}
          fontWeight="bold"
        >
          {money(data.netProfitAfterAdSpend, c)}
        </Text>
      </InlineStack>
      <Text as="p" tone="subdued" variant="bodySm">
        Starts from delivered/realized revenue, not gross order value — COD
        orders that came back RTO contributed nothing here, but their COGS,
        delivery, and ad spend were still real costs, which is why this can
        run negative even when total order value looks healthy.
      </Text>
    </BlockStack>
  );
}
