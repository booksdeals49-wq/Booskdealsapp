import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Uninstalling is exactly the moment Shopify revokes this shop's access
  // token, which is exactly when the plain authenticate.webhook() call can
  // crash trying to refresh it — see webhookAuth.server.ts. Use the
  // resilient wrapper so this cleanup still runs even when that happens.
  const { shop } = await authenticateWebhookResilient(request);

  // Clean up all shop-scoped data. In a multi-tenant production app you
  // may prefer to soft-delete / retain for a grace period instead.
  // deleteMany is a safe no-op if a table has nothing for this shop, so
  // there's no need to gate this on whether a session was ever found.
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.costSettings.deleteMany({ where: { shop } });
  await prisma.productCost.deleteMany({ where: { shop } });
  await prisma.orderRecord.deleteMany({ where: { shop } });
  await prisma.adAccountConnection.deleteMany({ where: { shop } });
  await prisma.adSpend.deleteMany({ where: { shop } });

  return new Response();
};
