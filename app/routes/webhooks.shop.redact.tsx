import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

// Mandatory GDPR webhook, fired 48 hours after an app is uninstalled and
// the shop requests full data erasure. Delete everything for this shop.
//
// This always fires for an already-uninstalled shop, i.e. a shop whose
// access token Shopify has already revoked — exactly the condition that
// crashes a plain authenticate.webhook() call trying to refresh it. Use
// the resilient wrapper so this cleanup still runs. See
// webhookAuth.server.ts.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateWebhookResilient(request);

  await prisma.orderRecord.deleteMany({ where: { shop } });
  await prisma.costSettings.deleteMany({ where: { shop } });
  await prisma.productCost.deleteMany({ where: { shop } });
  await prisma.adAccountConnection.deleteMany({ where: { shop } });
  await prisma.adSpend.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });

  return new Response();
};
