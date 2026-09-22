import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// Workaround for a Shopify Admin embedding quirk: the initial embedded
// iframe request sometimes lands on `/apps/{handle}` instead of this
// app's real entry route. Redirect it into /app, preserving the full
// query string (shop, host, id_token, hmac, etc) so auth still works.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  return redirect(`/app${url.search}`);
};
