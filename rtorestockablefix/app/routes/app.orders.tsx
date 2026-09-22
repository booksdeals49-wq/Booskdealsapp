import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  useIndexResourceState,
  BlockStack,
  Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { computeOrderProfit, type CostSettings as CostSettingsType } from "../services/profit.server";

const PAGE_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [orders, costSettings, productCosts] = await Promise.all([
    prisma.orderRecord.findMany({
      where: {
        shop,
        createdAt: { gte: new Date(Date.now() - PAGE_DAYS * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.costSettings.upsert({
      where: { shop },
      update: {},
      create: { shop },
    }),
    prisma.productCost.findMany({ where: { shop } }),
  ]);

  const settings: CostSettingsType = costSettings;
  const overrides = productCosts.map(
    (p: { variantId: string; costPerUnit: number }) => ({
      variantId: p.variantId,
      costPerUnit: p.costPerUnit,
    }),
  );

  type OrderRow = {
    id: string;
    orderId: string;
    orderNumber: string;
    createdAt: Date;
    city: string | null;
    isCod: boolean;
    isRto: boolean;
    currency: string;
    totalPrice: number;
    subtotalPrice: number;
    lineItemsJson: string;
  };

  const rows = (orders as OrderRow[]).map((o) => {
    const breakdown = computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      settings,
      overrides,
    );
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      city: o.city,
      isCod: o.isCod,
      isRto: o.isRto,
      currency: o.currency,
      ...breakdown,
    };
  });

  return json({ rows });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const orderRecordId = String(form.get("orderRecordId"));
  const nextIsRto = form.get("nextIsRto") === "true";

  const order = await prisma.orderRecord.update({
    where: { id: orderRecordId },
    data: { isRto: nextIsRto },
  });

  // Mirror the flag onto the Shopify order as a tag, so it stays visible
  // and consistent if other apps/staff look at the order directly.
  try {
    await admin.graphql(
      `#graphql
      mutation TagOrder($id: ID!, $tags: [String!]!) {
        ${nextIsRto ? "tagsAdd" : "tagsRemove"}(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
      { variables: { id: order.orderId, tags: ["RTO"] } },
    );
  } catch (e) {
    // Non-fatal: local flag is already saved even if the Shopify tag call fails.
    console.error("Failed to sync RTO tag to Shopify order", e);
  }

  return json({ ok: true });
};

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export default function Orders() {
  const { rows } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const toggleRto = (orderRecordId: string, currentIsRto: boolean) => {
    submit(
      { orderRecordId, nextIsRto: String(!currentIsRto) },
      { method: "post" },
    );
  };

  return (
    <Page title="Orders" subtitle={`Last ${PAGE_DAYS} days · profit per order`}>
      <Card padding="0">
        <IndexTable
          resourceName={{ singular: "order", plural: "orders" }}
          itemCount={rows.length}
          selectable={false}
          headings={[
            { title: "Order" },
            { title: "City" },
            { title: "Total" },
            { title: "COGS" },
            { title: "Net profit" },
            { title: "Status" },
          ]}
        >
          {rows.map((r, index) => (
            <IndexTable.Row id={r.id} key={r.id} position={index}>
              <IndexTable.Cell>
                <Text as="span" fontWeight="semibold">
                  {r.orderNumber}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {new Date(r.createdAt).toLocaleDateString()}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>{r.city || "—"}</IndexTable.Cell>
              <IndexTable.Cell>
                {money(r.revenue > 0 ? r.revenue : 0, r.currency)}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {money(r.cogsLoss, r.currency)}
                {r.isRto && r.cogsLoss === 0 && r.cogs > 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Recovered (restocked)
                  </Text>
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text
                  as="span"
                  tone={r.netProfit >= 0 ? "success" : "critical"}
                  fontWeight="semibold"
                >
                  {money(r.netProfit, r.currency)}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <BlockStack gap="150">
                  {r.isRto ? (
                    <Badge tone="critical">RTO</Badge>
                  ) : (
                    <Badge tone="success">Delivered/active</Badge>
                  )}
                  <Button
                    size="micro"
                    onClick={() => toggleRto(r.id, r.isRto)}
                    disabled={navigation.state === "submitting"}
                  >
                    Mark as {r.isRto ? "not RTO" : "RTO"}
                  </Button>
                </BlockStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>
    </Page>
  );
}
