import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Page, Card, BlockStack, InlineGrid, Text, Button, Banner, InlineStack } from "@shopify/polaris";
import { WalletIcon, ReceiptDollarIcon, CheckIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  currentTier,
  createSubscription,
  refreshSubscriptionStatus,
  cancelSubscription,
} from "../services/billing.server";
import { useState } from "react";
import {
  PLANS,
  PAID_PLANS,
  FREE_ORDER_LIMIT,
  type Tier,
  type BillingInterval,
} from "../services/billingPlans";
import { IconBadge, SectionHeading } from "../components/StatTile";
import { BRAND } from "../components/theme";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let state = await getBillingState(shop);

  // Just came back from Shopify's approval screen (or revisiting while
  // still pending) — check the real status rather than trusting our cache.
  if (state.status === "pending" && state.subscriptionId) {
    const refreshed = await refreshSubscriptionStatus(admin, shop, state.subscriptionId);
    if (refreshed) state = await getBillingState(shop);
  }

  return json({
    tier: currentTier(state),
    orderCount: state.orderCount,
    status: state.status,
    billingInterval: (state.billingInterval as BillingInterval) ?? "monthly",
    pendingConfirmationUrl: state.status === "pending" ? state.confirmationUrl : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const appUrl =
    process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.HOST || "";
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "subscribe") {
    const tier = String(form.get("tier") ?? "") as Tier;
    const interval = (String(form.get("interval") ?? "monthly") as BillingInterval);
    if (!PAID_PLANS.some((p) => p.key === tier)) {
      return json({ error: "Unknown plan." }, { status: 400 });
    }
    if (interval !== "monthly" && interval !== "annual") {
      return json({ error: "Unknown billing interval." }, { status: 400 });
    }
    try {
      const confirmationUrl = await createSubscription(admin, shop, tier, appUrl, interval);
      return json({ confirmationUrl });
    } catch (e: any) {
      return json({ error: e.message ?? "Couldn't start that plan." }, { status: 500 });
    }
  }

  if (intent === "cancel") {
    const state = await getBillingState(shop);
    if (state.subscriptionId) {
      await cancelSubscription(admin, shop, state.subscriptionId);
    }
    return json({ cancelled: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
};

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
};

export default function Billing() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [interval, setBillingInterval] = useState<BillingInterval>(
    data.tier !== "free" ? data.billingInterval : "monthly",
  );

  const confirmationUrl =
    (actionData && "confirmationUrl" in actionData && actionData.confirmationUrl) ||
    data.pendingConfirmationUrl;

  if (confirmationUrl) {
    return (
      <Page title="Plan &amp; Billing">
        <Card>
          <BlockStack gap="400">
            <SectionHeading icon={WalletIcon} title="One more step" />
            <Text as="p" tone="subdued">
              Approve this plan on Shopify's confirmation screen to activate it.
            </Text>
            <div>
              <a
                href={confirmationUrl}
                target="_top"
                style={{
                  display: "inline-block",
                  background: BRAND.navy,
                  color: "#FFFFFF",
                  fontWeight: 600,
                  fontSize: 14,
                  padding: "10px 18px",
                  borderRadius: 8,
                  textDecoration: "none",
                }}
              >
                Approve on Shopify →
              </a>
            </div>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  const overLimit = data.tier === "free" && data.orderCount >= FREE_ORDER_LIMIT;

  return (
    <Page
      title="Plan &amp; Billing"
      subtitle={`${data.orderCount} orders this billing period`}
    >
      <BlockStack gap="400">
        {overLimit && (
          <Banner tone="warning">
            You've reached the {FREE_ORDER_LIMIT}-order free limit for this month.
            Choose a plan below to keep using cod-profit-app.
          </Banner>
        )}
        {actionData && "error" in actionData && actionData.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}

        <InlineStack align="center" gap="200">
          <div
            style={{
              display: "inline-flex",
              background: "#F1F3F7",
              borderRadius: 999,
              padding: 4,
              gap: 4,
            }}
          >
            {(["monthly", "annual"] as BillingInterval[]).map((opt) => {
              const active = interval === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setBillingInterval(opt)}
                  style={{
                    border: "none",
                    cursor: "pointer",
                    borderRadius: 999,
                    padding: "6px 16px",
                    fontSize: 13,
                    fontWeight: 600,
                    background: active ? BRAND.navy : "transparent",
                    color: active ? "#FFFFFF" : "#4A5568",
                  }}
                >
                  {opt === "monthly" ? "Monthly" : "Annual — save 50%"}
                </button>
              );
            })}
          </div>
        </InlineStack>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          {PLANS.map((plan) => {
            const isCurrent =
              data.tier === plan.key &&
              (plan.key === "free" || data.billingInterval === interval);
            const showAnnual = interval === "annual" && plan.annualPrice != null;
            const displayPrice = showAnnual ? plan.annualPrice! : plan.price;
            return (
              <div
                key={plan.key}
                style={{
                  position: "relative",
                  background: "#FFFFFF",
                  border: plan.popular
                    ? `1px solid ${BRAND.navy}`
                    : "1px solid #E3E8EF",
                  borderTop: `3px solid ${isCurrent ? BRAND.gold : BRAND.navy}`,
                  borderRadius: 12,
                  padding: "20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  boxShadow: plan.popular ? "0 4px 16px rgba(11,37,69,0.08)" : "none",
                }}
              >
                {plan.popular && !isCurrent && (
                  <span
                    style={{
                      position: "absolute",
                      top: -11,
                      left: 20,
                      background: BRAND.navy,
                      color: "#FFFFFF",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.03em",
                      textTransform: "uppercase",
                      padding: "3px 10px",
                      borderRadius: 999,
                    }}
                  >
                    Most popular
                  </span>
                )}
                <InlineStack align="space-between" blockAlign="start">
                  <IconBadge icon={ReceiptDollarIcon} />
                  {isCurrent && (
                    <span
                      style={{
                        background: BRAND.goldBg,
                        color: BRAND.gold,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.03em",
                        textTransform: "uppercase",
                        padding: "3px 8px",
                        borderRadius: 999,
                      }}
                    >
                      Current plan
                    </span>
                  )}
                </InlineStack>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">
                    {plan.name}
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {displayPrice === 0 ? "$0" : `$${displayPrice.toFixed(2)}`}
                    <Text as="span" variant="bodySm" tone="subdued">
                      {displayPrice === 0 ? "" : showAnnual ? "/yr" : "/mo"}
                    </Text>
                  </Text>
                  {showAnnual && plan.price > 0 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      vs ${(plan.price * 12).toFixed(2)}/yr billed monthly
                    </Text>
                  )}
                </BlockStack>
                <Text as="p" tone="subdued">
                  {plan.blurb}
                </Text>
                <div style={{ marginTop: "auto", paddingTop: 8 }}>
                  {isCurrent ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      You're on this plan.
                    </Text>
                  ) : plan.key === "free" ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Cancel your paid plan below to return to Free.
                    </Text>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="subscribe" />
                      <input type="hidden" name="tier" value={plan.key} />
                      <input
                        type="hidden"
                        name="interval"
                        value={showAnnual ? "annual" : "monthly"}
                      />
                      <Button submit loading={busy} variant="primary" fullWidth>
                        Choose {plan.name}
                      </Button>
                    </Form>
                  )}
                </div>
              </div>
            );
          })}
        </InlineGrid>

        {data.tier !== "free" && (
          <Card>
            <BlockStack gap="200">
              <SectionHeading icon={ReceiptDollarIcon} title="Cancel subscription" />
              <Text as="p" tone="subdued">
                You'll drop back to the Free plan ({FREE_ORDER_LIMIT} orders/month,
                Meta only) at the start of your next billing period.
              </Text>
              <div>
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <Button submit loading={busy} tone="critical">
                    Cancel and return to Free
                  </Button>
                </Form>
              </div>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="200">
            <SectionHeading icon={CheckIcon} title="Good to know" />
            <BlockStack gap="150">
              <Text as="p" tone="subdued">
                Plans reset every ~30 days from when you first installed.
              </Text>
              <Text as="p" tone="subdued">
                You're currently on <Text as="span" fontWeight="semibold">{TIER_LABEL[data.tier]}</Text>
                {data.tier !== "free" &&
                  (data.billingInterval === "annual" ? ", billed annually." : ", billed monthly.")}
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
