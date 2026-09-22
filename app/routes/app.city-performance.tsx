// City Performance was pulled from the app (nav link removed in app.tsx,
// dashboard card removed in app._index.tsx) because it depended on Shopify's
// shipping-address city field, which the app no longer requests at all
// (dropping it avoided the Protected Customer Data Level 2 requirement — see
// orderSync.server.ts). Keeping this route as a redirect, rather than
// deleting it outright, means anyone with the old URL bookmarked just lands
// back on the dashboard instead of hitting a dead page.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  throw redirect("/app");
};
