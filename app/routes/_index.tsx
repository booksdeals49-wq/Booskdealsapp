import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// Bare-domain visits (not embedded) bounce to the OAuth flow if a shop is
// present, otherwise there's nothing useful to render standalone.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (shop) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }
  return redirect("/app");
};
