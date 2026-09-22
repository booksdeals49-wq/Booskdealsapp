import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

// Mandatory GDPR webhook. This app stores order-level shipping city/country
// for RTO analysis but does not store customer name/email/phone, so there
// is no customer PII export to produce here. If you later add PII storage,
// implement the actual data export/notification flow before going live.
//
// See webhookAuth.server.ts for why this uses the resilient wrapper rather
// than calling authenticate.webhook() directly.
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticateWebhookResilient(request);
  return new Response();
};
