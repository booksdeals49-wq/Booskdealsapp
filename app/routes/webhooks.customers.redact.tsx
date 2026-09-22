import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

// Mandatory GDPR webhook, fired 10 days after a customer redaction request.
// We don't store per-customer identifiers directly, but we do clear the
// city/country fields on that customer's orders as a conservative measure
// since city can be identifying in combination with other data.
//
// Can fire for a shop that has since uninstalled — see
// webhookAuth.server.ts for why that makes the resilient wrapper necessary
// here too.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticateWebhookResilient(request);
  const orderIds: number[] = (payload as any)?.orders_to_redact ?? [];

  if (orderIds.length > 0) {
    await prisma.orderRecord.updateMany({
      where: {
        shop,
        orderId: { in: orderIds.map((id) => `gid://shopify/Order/${id}`) },
      },
      data: { city: null, country: null },
    });
  }

  return new Response();
};
