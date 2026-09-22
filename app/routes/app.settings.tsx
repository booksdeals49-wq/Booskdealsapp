import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit, Form } from "@remix-run/react";
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
} from "@shopify/polaris";
import { SettingsIcon, DeliveryIcon, ReceiptDollarIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SectionHeading } from "../components/StatTile";
import { getCostSettingsHistory } from "../services/costSettingsHistory.server";
import {
  getCourierRates,
  getUnmappedCouriers,
  upsertCourierRate,
  deleteCourierRate,
} from "../services/courierRates.server";

const CURRENCIES = ["USD", "PKR", "INR", "AED", "SAR", "EGP", "PHP", "BDT"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const history = await getCostSettingsHistory(session.shop);
  // Pre-fill the form with the most recent (currently active) version —
  // older versions stay attached to whichever orders they were effective
  // for, but aren't editable here (see the action below: saving always
  // creates a new version rather than editing an old one).
  const settings = history[history.length - 1];
  const [courierRates, unmappedCouriers] = await Promise.all([
    getCourierRates(session.shop),
    getUnmappedCouriers(session.shop),
  ]);
  return json({ settings, versionCount: history.length, courierRates, unmappedCouriers });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "saveCostSettings");

  // Courier costs are a separate, non-versioned list (see CourierRate in
  // schema.prisma) — added/edited/removed independently of the main
  // cost-model form below, so each gets its own intent rather than being
  // folded into the same submit.
  if (intent === "addCourierRate") {
    const courierName = String(form.get("courierName") ?? "").trim();
    const cost = Number(form.get("courierCost") ?? 0);
    if (!courierName) {
      return json(
        { ok: false as const, error: "Enter a courier name before saving." },
        { status: 400 },
      );
    }
    await upsertCourierRate(session.shop, courierName, cost);
    return json({ ok: true as const, courierSaved: true as const });
  }

  if (intent === "deleteCourierRate") {
    const id = String(form.get("courierRateId") ?? "");
    if (id) {
      await deleteCourierRate(session.shop, id);
    }
    return json({ ok: true as const, courierDeleted: true as const });
  }

  const num = (key: string) => Number(form.get(key) ?? 0);

  // Insert a new version rather than editing the existing row in place — a
  // rate change (e.g. the courier raising its delivery fee) must only
  // apply to orders dispatched from this moment forward. Every order
  // already dispatched keeps using whichever rate was in effect when IT
  // shipped, forever. See costSettingsHistory.server.ts for how a given
  // order's version gets picked.
  const created = await prisma.costSettings.create({
    data: {
      shop: session.shop,
      effectiveFrom: new Date(),
      currency: String(form.get("currency") ?? "USD"),
      defaultCogsPercent: num("defaultCogsPercent"),
      deliveryFeeFlat: num("deliveryFeeFlat"),
      rtoFeeFlat: num("rtoFeeFlat"),
      cashHandlingPercent: num("cashHandlingPercent"),
      taxPercent: num("taxPercent"),
      packagingFeeFlat: num("packagingFeeFlat"),
      rtoRestockable: form.get("rtoRestockable") === "true",
      ecommerceTransactionTaxPercent: num("ecommerceTransactionTaxPercent"),
    },
  });

  return json({ ok: true as const, settings: created });
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
  ecommerceTransactionTaxPercent: string;
};

export default function Settings() {
  const { settings, versionCount, courierRates, unmappedCouriers } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
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
    ecommerceTransactionTaxPercent: String(settings.ecommerceTransactionTaxPercent),
  });

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const [courierForm, setCourierForm] = useState({ name: "", cost: "" });
  // Clear the add-courier fields once a save round-trips successfully —
  // this component stays mounted across the Remix form POST (same route),
  // so without this the two fields would otherwise keep showing whatever
  // was just submitted.
  useEffect(() => {
    if (actionData && "courierSaved" in actionData && actionData.courierSaved) {
      setCourierForm({ name: "", cost: "" });
    }
  }, [actionData]);

  const deleteCourier = (id: string) => {
    submit(
      { intent: "deleteCourierRate", courierRateId: id },
      { method: "post" },
    );
  };

  return (
    <Page title="Cost Settings" subtitle="Used to compute true COD profit on every order">
      <BlockStack gap="400">
        {actionData?.ok && "settings" in actionData && (
          <Banner tone="success" title="Settings saved">
            <p>
              Applied from right now onward. Orders already dispatched keep
              the rates that were in effect when they shipped — saving never
              changes their numbers retroactively.
            </p>
          </Banner>
        )}
        {actionData?.ok && "courierSaved" in actionData && actionData.courierSaved && (
          <Banner tone="success" title="Courier saved">
            <p>
              New and future orders shipped with this courier will use its
              cost instead of the flat delivery fee.
            </p>
          </Banner>
        )}
        {actionData?.ok && "courierDeleted" in actionData && actionData.courierDeleted && (
          <Banner tone="success" title="Courier removed">
            <p>Orders with this courier now fall back to the flat delivery fee.</p>
          </Banner>
        )}
        <Banner tone="info">
          <p>
            Saving creates a new rate effective immediately —{" "}
            {versionCount > 1
              ? `this shop has ${versionCount} saved versions so far. `
              : ""}
            it doesn't edit history. If your delivery fee goes up next
            month, orders dispatched before the change keep showing the old
            fee; only orders dispatched after use the new one.
          </p>
        </Banner>
        <Form method="post">
          <input type="hidden" name="intent" value="saveCostSettings" />
          <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <SectionHeading icon={SettingsIcon} title="Currency & cost model" />
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
            </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <SectionHeading
                icon={ReceiptDollarIcon}
                title="Ecommerce Transaction Taxes"
                subtitle="Government tax on ad-platform transactions — e.g. a card-processing/withholding tax charged when you pay Meta, Google, TikTok or Snapchat. One blended rate across all four, applied to your total ad spend."
              />
              <FormLayout>
                <TextField
                  label="Transaction tax (% of total ad spend)"
                  name="ecommerceTransactionTaxPercent"
                  type="number"
                  step={0.1}
                  autoComplete="off"
                  value={form.ecommerceTransactionTaxPercent}
                  onChange={set("ecommerceTransactionTaxPercent")}
                  helpText="Calculated as total ad spend (Meta + Google + TikTok + Snapchat combined) × this percentage. Shown as its own cost line on the Dashboard, Reports and Ad Spend — it reduces net profit but doesn't change the ad spend or ROAS figures themselves."
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Button submit variant="primary" loading={saving}>
            Save settings
          </Button>
          </BlockStack>
        </Form>

        <Card>
          <BlockStack gap="400">
            <SectionHeading
              icon={DeliveryIcon}
              title="Courier costs"
              subtitle="Per-courier delivery cost — used instead of the flat delivery fee above when Shopify tells us which courier shipped an order"
            />
            {actionData &&
              "error" in actionData &&
              actionData.error && (
                <Banner tone="critical">
                  <p>{actionData.error}</p>
                </Banner>
              )}
            <Banner tone="info">
              <p>
                Add each courier you ship with and its cost per order. As
                soon as Shopify tells us which courier fulfilled an order,
                that courier's cost replaces the flat delivery fee for it
                automatically. A courier with no cost configured here just
                keeps using the flat fee.
              </p>
            </Banner>
            {unmappedCouriers.length > 0 && (
              <Banner tone="warning" title="Couriers detected on recent orders with no cost set">
                <p>
                  We've seen these on orders from the last 30 days, but
                  they're not priced yet — add a cost below so their orders
                  stop using the flat delivery fee:{" "}
                  <Text as="span" fontWeight="semibold">
                    {unmappedCouriers.join(", ")}
                  </Text>
                  .
                </p>
              </Banner>
            )}
            {courierRates.length > 0 && (
              <BlockStack gap="200">
                {courierRates.map((rate: { id: string; courierName: string; cost: number }) => (
                  <InlineStack key={rate.id} align="space-between" blockAlign="center">
                    <Text as="span" fontWeight="medium">
                      {rate.courierName}
                    </Text>
                    <InlineStack gap="300" blockAlign="center">
                      <Text as="span" tone="subdued">
                        {rate.cost.toFixed(2)} / order
                      </Text>
                      <Button
                        size="micro"
                        tone="critical"
                        variant="tertiary"
                        onClick={() => deleteCourier(rate.id)}
                        disabled={navigation.state === "submitting"}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="addCourierRate" />
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Courier name"
                    name="courierName"
                    autoComplete="off"
                    placeholder="Enter the courier's name"
                    value={courierForm.name}
                    onChange={(value) =>
                      setCourierForm((f) => ({ ...f, name: value }))
                    }
                  />
                  <TextField
                    label="Cost per order"
                    name="courierCost"
                    type="number"
                    step={0.01}
                    autoComplete="off"
                    value={courierForm.cost}
                    onChange={(value) =>
                      setCourierForm((f) => ({ ...f, cost: value }))
                    }
                  />
                </FormLayout.Group>
                <Button submit loading={saving}>
                  Add / update courier
                </Button>
              </FormLayout>
            </Form>
            <Text as="p" tone="subdued" variant="bodySm">
              Saving a courier name that already exists updates its cost —
              matching is case-insensitive, so different capitalizations of
              the same name are treated as the same courier.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
