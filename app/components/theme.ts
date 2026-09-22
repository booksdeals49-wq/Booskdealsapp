// The app's signature color palette — applied only to elements we render
// ourselves (icons wrapped with tone="inherit", chart lines/bars, accent
// borders, stat values). Deliberately does NOT touch Polaris's own internal
// CSS variables or Shopify Admin's chrome (nav, top bar) — those stay
// exactly as Shopify renders them, so the app remains visually consistent
// with the rest of Admin while still having a distinct, professional
// "financial" identity of its own within its own screens.

export const BRAND = {
  // Deep navy — primary brand color, used for headings/icons/accents.
  navy: "#0B2545",
  navySoft: "#13315C",
  // Muted gold — a restrained "premium" highlight, used sparingly.
  gold: "#B8860B",
  // Financial green/red — deliberately a shade more muted/"bankerly" than
  // Polaris's own bright success/critical greens/reds.
  profit: "#0F6E5C",
  loss: "#A1291E",
  // Neutral slate for subdued text/icons/gridlines.
  slate: "#5B6B82",
  slateBg: "#EEF2F7",
  paleNavyBg: "#F3F6FB",
  // Muted amber — a third "needs attention" tone, distinct from critical/loss
  // red, used where something is a soft drag rather than an outright problem
  // (e.g. the Dashboard's "Lowest performer" insight).
  warn: "#8A5A2B",
  // Light background tints paired with the tones above (badges, card
  // accents). Kept alongside their foreground colors so every screen pulls
  // from the same source instead of re-deriving tints ad hoc.
  profitBg: "#E4F3EE",
  lossBg: "#FAEAE8",
  warnBg: "#FBF1E6",
  goldBg: "#FBF1DA",
} as const;

export const CHART_PALETTE = [
  BRAND.navy,
  BRAND.gold,
  "#2F7A6B", // teal-green
  BRAND.loss,
  "#6B7A99", // slate-blue
  "#8A5A2B", // bronze
  "#4A6FA5", // steel blue
  "#6B4C7A", // muted plum
];
