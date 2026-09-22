import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, Form } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Select,
  Checkbox,
  Icon,
} from "@shopify/polaris";
import { SettingsIcon, PackageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const CURRENCIES = ["USD", "PKR", "INR", "AED", "SAR", "EGP", "PHP", "BDT"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.costSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });
  return json({ settings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const num = (key: string) => Number(form.get(key) ?? 0);

  const updated = await prisma.costSettings.update({
    where: { shop: session.shop },
    data: {
      currency: String(form.get("currency") ?? "USD"),
      defaultCogsPercent: num("defaultCogsPercent"),
      deliveryFeeFlat: num("deliveryFeeFlat"),
      rtoFeeFlat: num("rtoFeeFlat"),
      cashHandlingPercent: num("cashHandlingPercent"),
      taxPercent: num("taxPercent"),
      packagingFeeFlat: num("packagingFeeFlat"),
      rtoRestockable: form.get("rtoRestockable") === "true",
    },
  });

  return json({ ok: true, settings: updated });
};

type FormState = {
  currency: string;
  defaultCogsPercent: string;
  deliveryFeeFlat: string;
  rtoFeeFlat: string;
  cashHandlingPercent: string;
  taxPercent: string;
  packagingFeeFlat: string;
  rtoRestockable: boolean;
};

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [form, setForm] = useState<FormState>({
    currency: settings.currency,
    defaultCogsPercent: String(settings.defaultCogsPercent),
    deliveryFeeFlat: String(settings.deliveryFeeFlat),
    rtoFeeFlat: String(settings.rtoFeeFlat),
    cashHandlingPercent: String(settings.cashHandlingPercent),
    taxPercent: String(settings.taxPercent),
    packagingFeeFlat: String(settings.packagingFeeFlat),
    rtoRestockable: settings.rtoRestockable,
  });

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Page title="Cost Settings" subtitle="Used to compute true COD profit on every order">
      <BlockStack gap="400">
        {actionData?.ok && (
          <Banner tone="success" title="Settings saved">
            <p>New orders and the dashboard will use these values immediately.</p>
          </Banner>
        )}
        <Card>
          <Form method="post">
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Icon source={SettingsIcon} tone="subdued" />
                <Text as="h2" variant="headingMd">
                  Currency &amp; cost model
                </Text>
              </InlineStack>
            <FormLayout>
              <Select
                label="Currency"
                name="currency"
                options={CURRENCIES}
                value={form.currency}
                onChange={set("currency")}
              />
              <TextField
                label="Default COGS (% of item price)"
                name="defaultCogsPercent"
                type="number"
                step={0.1}
                autoComplete="off"
                value={form.defaultCogsPercent}
                onChange={set("defaultCogsPercent")}
                helpText="Used when a product has no specific cost override configured below."
              />
              <TextField
                label="Delivery fee (flat, per order)"
                name="deliveryFeeFlat"
                type="number"
                step={0.01}
                autoComplete="off"
                value={form.deliveryFeeFlat}
                onChange={set("deliveryFeeFlat")}
              />
              <TextField
                label="RTO fee (flat, per returned order)"
                name="rtoFeeFlat"
                type="number"
                step={0.01}
                autoComplete="off"
                value={form.rtoFeeFlat}
                onChange={set("rtoFeeFlat")}
                helpText="Extra cost incurred only when an order is returned to origin (return shipping, restocking, etc)."
              />
              <input
                type="hidden"
                name="rtoRestockable"
                value={form.rtoRestockable ? "true" : "false"}
              />
              <Checkbox
                label="Returned (RTO) inventory goes back into stock and can be resold"
                checked={form.rtoRestockable}
                onChange={(checked) =>
                  setForm((f) => ({ ...f, rtoRestockable: checked }))
                }
                helpText={
                  form.rtoRestockable
                    ? "Only delivery + RTO shipping count as a loss on returned orders — product cost isn't written off, since you get it back and can resell it."
                    : "Product cost (COGS) is written off in full on every returned order too, on top of delivery + RTO shipping — the conservative assumption that returns are often damaged or unsellable. Turn this on if your returns usually come back sellable."
                }
              />
              <TextField
                label="Cash handling fee (% of order total)"
                name="cashHandlingPercent"
                type="number"
                step={0.1}
                autoComplete="off"
                value={form.cashHandlingPercent}
                onChange={set("cashHandlingPercent")}
              />
              <TextField
                label="Tax / VAT (% of order total)"
                name="taxPercent"
                type="number"
                step={0.1}
                autoComplete="off"
                value={form.taxPercent}
                onChange={set("taxPercent")}
              />
              <TextField
                label="Packaging fee (flat, per order)"
                name="packagingFeeFlat"
                type="number"
                step={0.01}
                autoComplete="off"
                value={form.packagingFeeFlat}
                onChange={set("packagingFeeFlat")}
              />
              <Button submit variant="primary" loading={saving}>
                Save settings
              </Button>
            </FormLayout>
            </BlockStack>
          </Form>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Icon source={PackageIcon} tone="subdued" />
              <Text as="h2" variant="headingMd">
                Per-product cost overrides
              </Text>
            </InlineStack>
            <Text as="p" tone="subdued">
              Coming in the Orders screen: click any order line to set an
              exact cost-per-unit for that product/variant instead of relying
              on the default COGS percentage above.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
