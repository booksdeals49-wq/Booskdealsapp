// Server-only: touches Prisma and the Shopify Admin API. Only ever import
// this from a loader/action, never from a route's default component —
// Remix can't bundle server-only code for the client. Plan data and pure
// helpers that ARE safe to use in components live in billingPlans.ts.
import prisma from "../db.server";
import { FREE_ORDER_LIMIT, getPlan, type BillingInterval, type Tier } from "./billingPlans";

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function isTestCharge() {
  // Charges against a Shopify development store are always treated as test
  // charges by Shopify regardless of this flag. For a LIVE store, set
  // SHOPIFY_BILLING_TEST=false in your environment once you're ready to
  // charge real merchants — defaults to true (no real money) as a safety net.
  return process.env.SHOPIFY_BILLING_TEST !== "false";
}

export async function getBillingState(shop: string) {
  let state = await prisma.billingState.findUnique({ where: { shop } });
  if (!state) {
    state = await prisma.billingState.create({ data: { shop } });
  }
  // Lazy reset of the free plan's monthly order count — checked on every
  // read rather than via a cron job. Only meaningful while on Free; a paid
  // plan's own Shopify subscription period governs billing, not this.
  if (Date.now() - state.periodStart.getTime() > PERIOD_MS) {
    state = await prisma.billingState.update({
      where: { shop },
      data: { periodStart: new Date(), orderCount: 0 },
    });
  }
  return state;
}

export function currentTier(state: { plan: string; status: string }): Tier {
  if (state.status === "active") return state.plan as Tier;
  return "free";
}

export function isOverFreeLimit(state: { orderCount: number }) {
  return state.orderCount >= FREE_ORDER_LIMIT;
}

/** Call after a NEW order is synced (not on updates/cancellations). */
export async function incrementOrderCount(shop: string) {
  await getBillingState(shop); // ensures the row exists + applies any lazy reset first
  await prisma.billingState.update({
    where: { shop },
    data: { orderCount: { increment: 1 } },
  });
}

type AdminGraphql = { graphql: (query: string, opts?: any) => Promise<Response> };

/**
 * Create a flat-rate subscription for the chosen paid plan and billing
 * interval. Returns the Shopify-hosted approval URL. Shopify's Billing API
 * natively supports an ANNUAL interval alongside EVERY_30_DAYS — same
 * mutation, just a different interval + price line item.
 */
export async function createSubscription(
  admin: AdminGraphql,
  shop: string,
  tier: Tier,
  appUrl: string,
  interval: BillingInterval = "monthly",
) {
  const plan = getPlan(tier);
  if (plan.price <= 0) {
    throw new Error("Cannot create a paid subscription for the free plan.");
  }
  const isAnnual = interval === "annual";
  if (isAnnual && plan.annualPrice == null) {
    throw new Error("Annual billing isn't available for this plan.");
  }
  const price = isAnnual ? plan.annualPrice! : plan.price;
  const shopifyInterval = isAnnual ? "ANNUAL" : "EVERY_30_DAYS";

  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean!, $price: Decimal!, $interval: AppPricingInterval!) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        test: $test
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $price, currencyCode: USD }
              interval: $interval
            }
          }
        }]
      ) {
        appSubscription { id status }
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: `cod-profit-app — ${plan.name}${isAnnual ? " (annual)" : ""}`,
        returnUrl: `${appUrl}/app/billing`,
        test: isTestCharge(),
        price: price.toFixed(2),
        interval: shopifyInterval,
      },
    },
  );
  const body = await response.json();
  const result = body?.data?.appSubscriptionCreate;
  const errors = result?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((e: any) => e.message).join(", "));
  }

  const subscriptionId = result.appSubscription.id as string;
  const confirmationUrl = result.confirmationUrl as string;

  await prisma.billingState.update({
    where: { shop },
    data: {
      subscriptionId,
      confirmationUrl,
      plan: tier,
      billingInterval: interval,
      status: "pending",
    },
  });

  return confirmationUrl;
}

/** Re-check a pending subscription's real status with Shopify and sync it into our DB. */
export async function refreshSubscriptionStatus(
  admin: AdminGraphql,
  shop: string,
  subscriptionId: string,
) {
  const response = await admin.graphql(
    `#graphql
    query GetSubscription($id: ID!) {
      node(id: $id) {
        ... on AppSubscription { id status }
      }
    }`,
    { variables: { id: subscriptionId } },
  );
  const body = await response.json();
  const status: string | undefined = body?.data?.node?.status;
  if (!status) return null;

  const mapped =
    status === "ACTIVE" ? "active" : status === "PENDING" ? "pending" : "declined";
  await prisma.billingState.update({ where: { shop }, data: { status: mapped } });
  return mapped;
}

/** Cancel the active subscription and drop the shop back to Free. */
export async function cancelSubscription(
  admin: AdminGraphql,
  shop: string,
  subscriptionId: string,
) {
  await admin.graphql(
    `#graphql
    mutation AppSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription { id status }
        userErrors { field message }
      }
    }`,
    { variables: { id: subscriptionId } },
  );
  await prisma.billingState.update({
    where: { shop },
    data: {
      status: "none",
      plan: "free",
      billingInterval: "monthly",
      subscriptionId: null,
      confirmationUrl: null,
    },
  });
}
