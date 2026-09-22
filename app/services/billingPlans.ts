// Plain plan data + pure helpers — deliberately has NO ".server" suffix and
// touches no database or network, so it's safe to import from both
// loaders/actions (server) and route components (client). Anything that
// needs Prisma or the Shopify Admin API lives in billing.server.ts instead,
// and that file must only ever be imported from a loader/action — never
// directly into a component (Remix can't bundle server-only code for the
// client, and will fail the build if a component pulls in a ".server" value).

export type Tier = "free" | "starter" | "growth" | "pro";

export const FREE_ORDER_LIMIT = 100;

export type BillingInterval = "monthly" | "annual";

export type Plan = {
  key: Tier;
  name: string;
  price: number; // USD/month, 0 for Free
  annualPrice: number | null; // USD/year (flat, not price*12), null for Free — Free has no paid tier to annualize
  orderCap: number | null; // null = unlimited
  platforms: "meta-only" | "all";
  blurb: string;
  popular?: boolean;
};

export const PLANS: Plan[] = [
  {
    key: "free",
    name: "Free",
    price: 0,
    annualPrice: null,
    orderCap: FREE_ORDER_LIMIT,
    platforms: "meta-only",
    blurb: `Up to ${FREE_ORDER_LIMIT} orders/month, Meta ad spend only, basic report.`,
  },
  {
    key: "starter",
    name: "Starter",
    price: 9.99,
    annualPrice: 59.99, // ~50% off 9.99 * 12 ($119.88)
    orderCap: 1000,
    platforms: "meta-only",
    blurb: "Up to 1,000 orders/month, Meta ad spend only, full Reports access.",
  },
  {
    key: "growth",
    name: "Growth",
    price: 19.99,
    annualPrice: 119.99, // ~50% off 19.99 * 12 ($239.88)
    orderCap: 2000,
    platforms: "all",
    blurb: "Up to 2,000 orders/month, all ad platforms, full Reports access.",
    popular: true,
  },
  {
    key: "pro",
    name: "Pro",
    price: 30,
    annualPrice: 180, // exactly 50% off 30 * 12 ($360)
    orderCap: null,
    platforms: "all",
    blurb: "Unlimited orders, all ad platforms, full Reports access.",
  },
];

export const PAID_PLANS = PLANS.filter((p) => p.key !== "free");

export function getPlan(tier: Tier): Plan {
  return PLANS.find((p) => p.key === tier) ?? PLANS[0];
}

export function hasFullAccess(tier: Tier) {
  return tier === "growth" || tier === "pro";
}

// Reports access (Reports hub, City Performance, CSV export): everyone
// EXCEPT Free gets the full report suite — Free gets a basic report only
// (headline range metrics, last 30 days, no custom range/breakdowns/export).
// This is deliberately a separate, wider gate than hasFullAccess above,
// which still governs ad-platform access (Starter stays Meta-only there).
export function hasReportsAccess(tier: Tier) {
  return tier !== "free";
}

export function allowedAdPlatforms(
  tier: Tier,
): Array<"meta" | "google" | "tiktok" | "snapchat"> {
  return hasFullAccess(tier) ? ["meta", "google", "tiktok", "snapchat"] : ["meta"];
}
