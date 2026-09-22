import type { ActionFunctionArgs } from "@remix-run/node";
import { syncOrderFromPayload, type ShopifyOrderPayload } from "../services/orderSync.server";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

// Handles both orders/updated and orders/cancelled — a cancellation is
// often how an RTO surfaces (cancel_reason: "declined"/"undeliverable")
// so we re-run the same sync + RTO inference logic either way.
//
// This route never needs `admin` — see webhookAuth.server.ts for why the
// resilient wrapper is used instead of calling authenticate.webhook()
// directly.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticateWebhookResilient(request);
  await syncOrderFromPayload(shop, payload as ShopifyOrderPayload);
  return new Response();
};
