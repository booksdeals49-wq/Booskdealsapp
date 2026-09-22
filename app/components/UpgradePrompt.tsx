// Shown in place of a Growth/Pro-only feature when the shop's current
// billing tier doesn't have access to it — see app/services/billing.server.ts
// for the tier logic. Kept as one shared component so every gated screen
// (Reports, City Performance, Ad Spend platform tabs) looks consistent.
import { Card, BlockStack, InlineStack, Text, Button, Badge } from "@shopify/polaris";
import { LockIcon } from "@shopify/polaris-icons";
import { IconBadge } from "./StatTile";
import type { Tier } from "../services/billingPlans";

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
};

export function UpgradePrompt({
  feature,
  currentTier,
  detail,
}: {
  feature: string;
  currentTier: Tier;
  detail: string;
}) {
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack gap="300" blockAlign="center">
          <IconBadge icon={LockIcon} />
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">
              {feature} is part of Growth and Pro
            </Text>
            <Badge>{`You're currently on ${TIER_LABEL[currentTier]}`}</Badge>
          </BlockStack>
        </InlineStack>
        <Text as="p" tone="subdued">
          {detail}
        </Text>
        <InlineStack>
          <Button variant="primary" url="/app/billing">
            View plans
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
