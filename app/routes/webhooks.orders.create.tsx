import type { ActionFunctionArgs } from "@remix-run/node";
import { syncOrderFromPayload, type ShopifyOrderPayload } from "../services/orderSync.server";
import { incrementOrderCount } from "../services/billing.server";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // This route never needs `admin` — see webhookAuth.server.ts for why the
  // plain authenticate.webhook() can still crash here (an expired-offline-
  // token refresh attempt unrelated to whether this order webhook itself
  // is legitimate) and why the resilient wrapper avoids that.
  const { shop, payload } = await authenticateWebhookResilient(request);
  const { isNew } = await syncOrderFromPayload(shop, payload as ShopifyOrderPayload);
  // Only brand-new orders count toward the plan's order limit — a webhook
  // redelivery for an order we already have shouldn't count it twice.
  if (isNew) {
    await incrementOrderCount(shop);
  }
  return new Response();
};
