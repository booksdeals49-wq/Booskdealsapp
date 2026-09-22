// Dashboard "Insights" section — a small grid of auto-generated callouts
// (trend, anomaly, top/lowest performer) computed by
// app/services/insights.server.ts. Purely presentational: takes the
// already-generated Insight[] and renders it to match the approved
// navy/gold dashboard mockup (tone-colored left border, icon badge,
// uppercase tag, bold headline, subdued detail).
//
// NOTE: only TYPE imports come from insights.server (erased at compile
// time by TS, so this stays safe to use directly from a route component —
// see billingPlans.ts's header comment for why a route component must
// never pull runtime values from a ".server" file).
import { BlockStack, InlineGrid, Text, Icon } from "@shopify/polaris";
import type { IconSource } from "@shopify/polaris";
import {
  ArrowUpIcon,
  ArrowDownIcon,
  AlertTriangleIcon,
  StarFilledIcon,
  AlertDiamondIcon,
} from "@shopify/polaris-icons";
import type { Insight, InsightTone } from "../services/insights.server";
import { BRAND } from "./theme";

const TONE_COLORS: Record<InsightTone, { fg: string; bg: string }> = {
  success: { fg: BRAND.profit, bg: BRAND.profitBg },
  critical: { fg: BRAND.loss, bg: BRAND.lossBg },
  warn: { fg: BRAND.warn, bg: BRAND.warnBg },
  gold: { fg: BRAND.gold, bg: BRAND.goldBg },
};

function iconFor(insight: Insight): IconSource {
  switch (insight.tag) {
    case "Trend":
      return insight.tone === "success" ? ArrowUpIcon : ArrowDownIcon;
    case "Anomaly":
      return AlertTriangleIcon;
    case "Top performer":
      return StarFilledIcon;
    default:
      return AlertDiamondIcon;
  }
}

function InsightCard({ insight }: { insight: Insight }) {
  const colors = TONE_COLORS[insight.tone];
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #E3E8EF",
        borderLeft: `4px solid ${colors.fg}`,
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        gap: 12,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          minWidth: 30,
          borderRadius: 7,
          background: colors.bg,
          color: colors.fg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon source={iconFor(insight)} tone="inherit" />
      </div>
      <BlockStack gap="0">
        <Text as="span" variant="bodyXs" fontWeight="bold" tone="subdued">
          <span style={{ letterSpacing: "0.03em", textTransform: "uppercase" }}>
            {insight.tag}
          </span>
        </Text>
        <Text as="p" variant="bodySm" fontWeight="semibold">
          {insight.headline}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {insight.detail}
        </Text>
      </BlockStack>
    </div>
  );
}

export function InsightsRow({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
      {insights.map((insight, i) => (
        <InsightCard key={`${insight.tag}-${i}`} insight={insight} />
      ))}
    </InlineGrid>
  );
}
