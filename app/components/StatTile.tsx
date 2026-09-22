// Shared "icon badge + label/value" building blocks used across every
// screen (Dashboard stat cards, Orders summary tiles, section headings on
// Settings/Ad Spend/etc). Centralizing this fixes two things at once:
//   1. Alignment — a fixed-size, centered icon badge sitting directly next
//      to tightly-grouped label/value text, instead of a bare Icon (whose
//      SVG bounding box has uneven internal whitespace and reads as
//      "floating" away from its label).
//   2. Branding — every icon on every screen now inherits the app's navy
//      "financial" color (via Icon's tone="inherit") instead of Polaris's
//      default subdued gray, giving the app a consistent signature look.
import { useState } from "react";
import { Link } from "@remix-run/react";
import { BlockStack, InlineStack, Text, Icon } from "@shopify/polaris";
import type { IconSource } from "@shopify/polaris";
import { ChevronRightIcon } from "@shopify/polaris-icons";
import { BRAND } from "./theme";

// #RRGGBB -> "rgba(r,g,b,alpha)", used for the destination hover tint/glow
// below — keeps that math in one place instead of re-deriving it per color.
export function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type Tone = "success" | "critical" | undefined;

const BADGE_BG: Record<"neutral" | "success" | "critical", string> = {
  neutral: BRAND.paleNavyBg,
  success: "#E4F3EE",
  critical: "#FAEAE8",
};

const BADGE_FG: Record<"neutral" | "success" | "critical", string> = {
  neutral: BRAND.navy,
  success: BRAND.profit,
  critical: BRAND.loss,
};

export function IconBadge({
  icon,
  tone,
  size = 36,
  bg,
}: {
  icon: IconSource;
  tone?: Tone;
  size?: number;
  // Override the badge's background — used by StatCard's "quiet" variant,
  // where the card itself already carries a pale tint, so the badge needs
  // to be white instead of blending into it.
  bg?: string;
}) {
  const key = tone ?? "neutral";
  return (
    <div
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: 8,
        background: bg ?? BADGE_BG[key],
        color: BADGE_FG[key],
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon source={icon} tone="inherit" />
    </div>
  );
}

export function SectionHeading({
  icon,
  title,
  subtitle,
}: {
  icon: IconSource;
  title: string;
  subtitle?: string;
}) {
  return (
    <InlineStack gap="300" blockAlign="center">
      <IconBadge icon={icon} />
      <BlockStack gap="0">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        {subtitle && (
          <Text as="p" tone="subdued" variant="bodySm">
            {subtitle}
          </Text>
        )}
      </BlockStack>
    </InlineStack>
  );
}

// Compact tile: icon badge tightly grouped with a stacked label/value pair.
// Used for Orders' summary row and anywhere a small stat needs to sit in a
// horizontal row of cards.
export function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: IconSource;
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <InlineStack gap="300" blockAlign="center" wrap={false}>
      <IconBadge icon={icon} tone={tone} />
      <BlockStack gap="0">
        <Text as="span" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="span" variant="headingMd" tone={tone}>
          {value}
        </Text>
      </BlockStack>
    </InlineStack>
  );
}

// Larger stat card used on the Dashboard, with an optional trend delta row.
// `size="large"` is an opt-in hero treatment (bigger number, bigger icon,
// roomier padding) for the one headline metric a screen wants the eye to
// land on first — every existing call site (Orders' summary row, the rest
// of the Dashboard's tiles) omits it and renders exactly as before.
export function StatCard({
  label,
  value,
  tone,
  icon,
  deltaPercent,
  deltaLabel = "vs previous 30 days",
  footnote,
  size = "default",
  variant = "default",
  url,
  destinationLabel,
  destinationColor,
}: {
  label: string;
  value: string;
  tone?: Tone;
  icon?: IconSource;
  deltaPercent?: number | null;
  deltaLabel?: string;
  // Plain subdued caption line — no arrow/percent styling. Used for context
  // that isn't a period-over-period delta (e.g. "AOV Rs 4,144.03").
  footnote?: string;
  size?: "default" | "large";
  // "quiet" is an opt-in recessive treatment — pale tinted background, no
  // top accent border, smaller value type — for secondary/status metrics
  // that shouldn't compete visually with headline numbers in the same grid
  // (e.g. Reports' Pipeline row: Blended CAC, Pending fulfillment,
  // Unrealized revenue). Every existing call site omits it and renders
  // exactly as before.
  variant?: "default" | "quiet";
  // When set, the whole card becomes a link to this in-app route (e.g. the
  // Dashboard's "Ad spend" card linking to /app/ad-spend) — the card's own
  // tone border (profit/loss) always wins for the top border, since that's
  // real performance information; destinationColor only drives the hover
  // glow and the small label underneath, so clicking somewhere never
  // requires guessing where it goes.
  url?: string;
  destinationLabel?: string;
  destinationColor?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const isLarge = size === "large";
  const isQuiet = variant === "quiet";
  const toneBorder = tone === "critical" ? BRAND.loss : tone === "success" ? BRAND.profit : BRAND.navy;
  const dc = destinationColor ?? BRAND.navy;
  const clickable = Boolean(url);

  const card = (
    <div
      onMouseEnter={clickable ? () => setHovered(true) : undefined}
      onMouseLeave={clickable ? () => setHovered(false) : undefined}
      style={{
        background: isQuiet ? BRAND.paleNavyBg : clickable && hovered ? hexToRgba(dc, 0.05) : "#FFFFFF",
        border: `1px solid ${clickable && hovered ? hexToRgba(dc, 0.35) : "#E3E8EF"}`,
        borderTop: isQuiet ? "1px solid #E3E8EF" : `${isLarge ? 4 : 3}px solid ${toneBorder}`,
        borderRadius: 12,
        padding: isQuiet ? "14px 16px" : isLarge ? "24px" : "16px",
        position: "relative",
        cursor: clickable ? "pointer" : undefined,
        transform: clickable && hovered ? "translateY(-3px)" : "translateY(0)",
        boxShadow: clickable && hovered ? `0 10px 22px ${hexToRgba(dc, 0.2)}` : "none",
        transition: "transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease, background 150ms ease",
      }}
    >
      {clickable && (
        <span
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            color: dc,
            opacity: hovered ? 1 : 0,
            transition: "opacity 150ms ease",
          }}
        >
          <Icon source={ChevronRightIcon} tone="inherit" />
        </span>
      )}
      <BlockStack gap={isLarge ? "300" : "200"}>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          {icon && (
            <IconBadge
              icon={icon}
              tone={tone}
              size={isQuiet ? 26 : isLarge ? 48 : 36}
              bg={isQuiet ? "#FFFFFF" : undefined}
            />
          )}
          <BlockStack gap="0">
            <Text as="span" tone="subdued" variant={isLarge ? "bodyMd" : "bodySm"}>
              {label}
            </Text>
            <Text as="span" variant={isQuiet ? "headingMd" : isLarge ? "heading2xl" : "headingLg"} tone={tone}>
              {value}
            </Text>
          </BlockStack>
        </InlineStack>
        {deltaPercent !== undefined && deltaPercent !== null && (
          <Text
            as="span"
            variant="bodySm"
            tone={deltaPercent >= 0 ? "success" : "critical"}
          >
            {deltaPercent >= 0 ? "▲" : "▼"} {Math.abs(deltaPercent).toFixed(1)}% {deltaLabel}
          </Text>
        )}
        {footnote && (
          <Text as="span" variant="bodySm" tone="subdued">
            {footnote}
          </Text>
        )}
        {destinationLabel && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 2 }}>
            <span style={{ width: 6, height: 6, borderRadius: 2, background: dc, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: dc }}>
              {destinationLabel}
            </span>
          </span>
        )}
      </BlockStack>
    </div>
  );

  if (!url) return card;
  return (
    <Link to={url} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      {card}
    </Link>
  );
}
