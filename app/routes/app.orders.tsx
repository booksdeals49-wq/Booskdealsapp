import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  InlineGrid,
  Button,
} from "@shopify/polaris";
import { OrderIcon, ReturnIcon, CashDollarIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { computeOrderProfit } from "../services/profit.server";
import { wasDispatched } from "../services/orderSync.server";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
  costRecognitionDate,
} from "../services/costSettingsHistory.server";
import { getCourierRateOverrides } from "../services/courierRates.server";
import { StatCard, SectionHeading } from "../components/StatTile";

const PAGE_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [orders, costSettingsHistory, productCosts, courierRates] = await Promise.all([
    prisma.orderRecord.findMany({
      where: {
        shop,
        createdAt: { gte: new Date(Date.now() - PAGE_DAYS * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    getCostSettingsHistory(shop),
    prisma.productCost.findMany({ where: { shop } }),
    getCourierRateOverrides(shop),
  ]);

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
    cancelledAt: Date | null;
    deliveredAt: Date | null;
    dispatchedAt: Date | null;
    inTransitAt: Date | null;
    fulfillmentStatus: string | null;
    trackingCompany: string | null;
    currency: string;
    totalPrice: number;
    subtotalPrice: number;
    lineItemsJson: string;
  };

  const rows = (orders as OrderRow[]).map((o) => {
    // Cancelled-but-not-RTO is its own state: an order Shopify shows as
    // cancelled before it was ever dispatched (stock issue, fraud check,
    // customer request), as opposed to isRto, which means it WAS
    // dispatched and came back. See orderSync.server.ts's computeIsRto.
    const isCancelled = Boolean(o.cancelledAt) && !o.isRto;
    const isDelivered = Boolean(o.deliveredAt);
    const breakdown = computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        isCancelled,
        isDelivered,
        isDispatched: wasDispatched(o.fulfillmentStatus),
        courierName: o.trackingCompany,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      // This order's own dispatch/placement date picks which historical
      // rate version applies — never today's rates for an
      // already-dispatched order. See costSettingsHistory.server.ts.
      resolveCostSettingsAt(costSettingsHistory, costRecognitionDate(o)),
      overrides,
      courierRates,
    );
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      city: o.city,
      trackingCompany: o.trackingCompany,
      isCod: o.isCod,
      isRto: o.isRto,
      isCancelled,
      isDelivered,
      // Shopify shows this order as fulfilled/handed off — NOT the same as
      // the courier actually having it moving (see isInTransit below).
      isDispatched: wasDispatched(o.fulfillmentStatus),
      // The courier's own tracking has confirmed real movement. Only this
      // (not isDispatched) should ever produce the "In transit" badge —
      // see app.orders.tsx's status column below.
      isInTransit: Boolean(o.inTransitAt),
      currency: o.currency,
      // breakdown.totalCost (cogsLoss + deliveryFee + rtoCost +
      // cashHandlingFee + tax + packagingFee) backs the Costs column below
      // — bold total up top, itemized breakdown underneath.
      ...breakdown,
    };
  });

  return json({ rows });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const orderRecordId = String(form.get("orderRecordId"));

  // This action handles two independent manual overrides from the Orders
  // table — which one fired is determined by which field the form
  // submitted. Both are explicit merchant actions, so unlike the
  // auto-reconciliation in orderSync.server.ts (which may only ever flip
  // isRto/deliveredAt from false/null -> true, never back, to avoid
  // clobbering a manual correction), a manual toggle here is free to move
  // in either direction.
  if (form.has("nextIsDelivered")) {
    const nextIsDelivered = form.get("nextIsDelivered") === "true";
    await prisma.orderRecord.update({
      where: { id: orderRecordId },
      data: { deliveredAt: nextIsDelivered ? new Date() : null },
    });
    return json({ ok: true });
  }

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
      minimumFractionDigits: 2,
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

  const toggleDelivered = (orderRecordId: string, currentIsDelivered: boolean) => {
    submit(
      { orderRecordId, nextIsDelivered: String(!currentIsDelivered) },
      { method: "post" },
    );
  };

  const rtoCount = rows.filter((r) => r.isRto).length;
  const totalNetProfit = rows.reduce((s, r) => s + r.netProfit, 0);
  const currency = rows[0]?.currency ?? "USD";

  return (
    <Page title="Orders" subtitle={`Last ${PAGE_DAYS} days · profit per order`}>
      <BlockStack gap="400">
        {rows.length > 0 && (
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <StatCard icon={OrderIcon} label="Orders" value={String(rows.length)} />
            <StatCard
              icon={ReturnIcon}
              label="RTO"
              value={`${rtoCount} (${rows.length > 0 ? ((rtoCount / rows.length) * 100).toFixed(1) : "0"}%)`}
              tone={rtoCount / Math.max(rows.length, 1) > 0.2 ? "critical" : undefined}
            />
            <StatCard
              icon={CashDollarIcon}
              label="Net profit"
              value={money(totalNetProfit, currency)}
              tone={totalNetProfit >= 0 ? "success" : "critical"}
            />
          </InlineGrid>
        )}
      <Card padding="0">
        <BlockStack gap="0">
          <div style={{ padding: "16px 16px 0" }}>
            <SectionHeading
              icon={OrderIcon}
              title="Recent orders"
              subtitle={`Last ${PAGE_DAYS} days, most recent first`}
            />
          </div>
        <IndexTable
          resourceName={{ singular: "order", plural: "orders" }}
          itemCount={rows.length}
          selectable={false}
          headings={[
            { title: "Order" },
            { title: "Courier" },
            { title: "Total" },
            { title: "Costs" },
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
              <IndexTable.Cell>
                <Text as="span" tone={r.trackingCompany ? undefined : "subdued"}>
                  {r.trackingCompany || "—"}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {/* pipelineRevenue and pendingFulfillmentRevenue are mutually
                    exclusive (see profit.server.ts) — either one being
                    nonzero means this order's cash hasn't been collected
                    yet, whether it's shipped or not, so both get the same
                    "Pending (COD)" treatment here; the Status column already
                    shows exactly which stage it's in. */}
                {r.pipelineRevenue > 0 || r.pendingFulfillmentRevenue > 0 ? (
                  <>
                    {money(r.pipelineRevenue + r.pendingFulfillmentRevenue, r.currency)}
                    <Text as="p" tone="subdued" variant="bodySm">
                      Pending (COD)
                    </Text>
                  </>
                ) : (
                  money(r.revenue > 0 ? r.revenue : 0, r.currency)
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {/* Bold total up top, itemized breakdown underneath —
                    every cost line that fed into it, so a merchant can see
                    exactly where an order's cost went without leaving this
                    table. Zero-value lines (RTO fee on a non-RTO order, tax
                    on a shop with no tax rate set, etc.) are skipped so a
                    quiet order doesn't show a wall of $0.00s — COGS is the
                    one line that always shows, since it's the anchor figure
                    the old column already surfaced on its own. */}
                <Text as="span" fontWeight="semibold">
                  {money(r.totalCost, r.currency)}
                </Text>
                <BlockStack gap="0">
                  <Text as="p" tone="subdued" variant="bodySm">
                    COGS {money(r.cogsLoss, r.currency)}
                  </Text>
                  {r.isRto && r.cogsLoss === 0 && r.cogs > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Recovered (restocked)
                    </Text>
                  )}
                  {r.deliveryFee > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Delivery {money(r.deliveryFee, r.currency)}
                    </Text>
                  )}
                  {r.rtoCost > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      RTO fee {money(r.rtoCost, r.currency)}
                    </Text>
                  )}
                  {r.cashHandlingFee > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Cash handling {money(r.cashHandlingFee, r.currency)}
                    </Text>
                  )}
                  {r.tax > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Tax {money(r.tax, r.currency)}
                    </Text>
                  )}
                  {r.packagingFee > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Packaging {money(r.packagingFee, r.currency)}
                    </Text>
                  )}
                </BlockStack>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {/* A pending order's netProfit is a real intermediate
                    number internally (cost already committed, revenue not
                    yet realized — see profit.server.ts), but showing that
                    as a stark red dollar figure per-order reads as "this
                    order is a loss", which isn't true yet. Net profit for a
                    single order only means something once its outcome is
                    known — delivered (real profit) or RTO (real loss) — so
                    every other in-flight state shows a dash here instead. */}
                {r.isCod && !r.isRto && !r.isCancelled && !r.isDelivered ? (
                  <>
                    <Text as="span" tone="subdued" fontWeight="semibold">
                      —
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Pending delivery
                    </Text>
                  </>
                ) : (
                  <Text
                    as="span"
                    tone={r.netProfit >= 0 ? "success" : "critical"}
                    fontWeight="semibold"
                  >
                    {money(r.netProfit, r.currency)}
                  </Text>
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                <BlockStack gap="150">
                  {r.isRto ? (
                    <Badge tone="critical" icon={ReturnIcon}>
                      RTO
                    </Badge>
                  ) : r.isCancelled ? (
                    <Badge tone="warning">Cancelled</Badge>
                  ) : r.isCod && !r.isDelivered ? (
                    r.isInTransit ? (
                      <Badge tone="attention">In transit</Badge>
                    ) : r.isDispatched ? (
                      <Badge tone="attention">Fulfilled, awaiting courier</Badge>
                    ) : (
                      <Badge tone="attention">Awaiting fulfillment</Badge>
                    )
                  ) : (
                    <Badge tone="success">Delivered/active</Badge>
                  )}
                  {/* Side-by-side rather than stacked, so a row with both
                      the RTO and delivery toggles (any active COD order)
                      isn't visibly taller than a row with just one — keeps
                      row heights consistent down the table. */}
                  <InlineStack gap="150" wrap>
                    <Button
                      size="micro"
                      onClick={() => toggleRto(r.id, r.isRto)}
                      disabled={navigation.state === "submitting"}
                    >
                      Mark as {r.isRto ? "not RTO" : "RTO"}
                    </Button>
                    {/* Only COD orders have a realized-vs-pipeline
                        distinction to correct — a prepaid order's cash is
                        already in hand regardless of delivery status, so
                        this toggle would be meaningless for it. */}
                    {r.isCod && !r.isRto && !r.isCancelled && (
                      <Button
                        size="micro"
                        onClick={() => toggleDelivered(r.id, r.isDelivered)}
                        disabled={navigation.state === "submitting"}
                      >
                        Mark as {r.isDelivered ? "not delivered" : "delivered"}
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
        </BlockStack>
      </Card>
      </BlockStack>
    </Page>
  );
}
