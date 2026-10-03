/**
 * /app/billing — Plan selection page
 */

import { useLoaderData, useFetcher, data, redirect } from "react-router";
import {
  Page, Layout, Card, Text, Button, BlockStack, InlineStack,
  Divider, Badge, Banner, List, Toast, Box,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS, getPlanDetails } from "../plans.js";
import { getShopPlan, createSubscriptionUrl, cancelToPlan } from "../billing.server";
import { useState, useEffect } from "react";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop   = session.shop;
  const record = await getShopPlan(shop, prisma);
  const plan   = getPlanDetails(record);
  // Serialise plans as plain objects (Infinity → null for JSON)
  const plans  = Object.values(PLANS).map((p) => ({
    ...p,
    limit: p.limit === Infinity ? null : p.limit,
  }));
  return data({ currentPlanId: plan.id, plans, shop });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop   = session.shop;
  const fd     = await request.formData();
  const intent = fd.get("intent");
  const planId = fd.get("planId");

  if (intent === "upgrade") {
    if (planId === "FREE") {
      await cancelToPlan(admin, prisma, shop);
      return data({ success: true, downgraded: true });
    }
    const confirmUrl = await createSubscriptionUrl(admin, planId);
    if (confirmUrl) return redirect(confirmUrl);
    return data({ success: false, error: "Could not create subscription URL. Check that SHOPIFY_APP_URL is set correctly." });
  }

  return data({ success: false, error: "Unknown intent" });
};

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({ plan, isCurrent, onSelect, loading }) {
  const isFree = plan.price === 0;

  return (
    <Card>
      <Box padding="400">
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text variant="headingMd" as="h2" fontWeight="bold">{plan.name}</Text>
              <Text variant="bodySm" tone="subdued">{plan.description}</Text>
            </BlockStack>
            <BlockStack gap="100" inlineAlign="end">
              {plan.badge === "popular" && <Badge tone="success">Popular</Badge>}
              {isCurrent && <Badge tone="info">Current</Badge>}
            </BlockStack>
          </InlineStack>

          <Box>
            <Text variant="heading2xl" as="p" fontWeight="bold">
              {isFree ? "Free" : `$${plan.price}`}
            </Text>
            {!isFree && (
              <Text variant="bodySm" tone="subdued">per month</Text>
            )}
          </Box>

          <Divider />

          <List type="bullet">
            <List.Item>
              {plan.limit === null ? "Unlimited" : `Up to ${plan.limit}`} media items
            </List.Item>
            <List.Item>Floating storefront widget</List.Item>
            <List.Item>YouTube, TikTok, Instagram, Facebook, and direct files</List.Item>
            <List.Item>Theme embed and settings controls</List.Item>
          </List>

          {isCurrent ? (
            <Button disabled fullWidth>
              Current plan
            </Button>
          ) : (
            <Button
              variant={plan.price > 0 ? "primary" : "secondary"}
              onClick={() => onSelect(plan.id)}
              loading={loading}
              fullWidth
            >
              {isFree ? "Downgrade to Free" : `Upgrade to ${plan.name}`}
            </Button>
          )}
        </BlockStack>
      </Box>
    </Card>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { currentPlanId, plans } = useLoaderData();
  const fetcher = useFetcher();

  const [toastActive,  setToastActive]  = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError,   setToastError]   = useState(false);
  const [loadingPlan,  setLoadingPlan]  = useState(null);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    // fetcher just became idle — check the result
    if (fetcher.data?.downgraded) {
      setToastMessage("Downgraded to Free plan.");
      setToastError(false);
      setToastActive(true);
    } else if (fetcher.data?.error) {
      setToastMessage(fetcher.data.error);
      setToastError(true);
      setToastActive(true);
    }
    setLoadingPlan(null);
  }, [fetcher.state, fetcher.data]);

  const handleSelect = (planId) => {
    setLoadingPlan(planId);
    const fd = new FormData();
    fd.append("intent", "upgrade");
    fd.append("planId", planId);
    fetcher.submit(fd, { method: "POST" });
  };

  return (
    <Page
      title="Plans & Billing"
      subtitle="Choose the plan that fits your store"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            <Text as="span" variant="bodyMd">
              Plans are billed monthly through Shopify. Upgrade or downgrade anytime.
              Charges appear on your Shopify invoice.
            </Text>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" align="start" wrap={false}>
            {plans.map((plan) => (
              <Box
                key={plan.id}
                width="100%"
                maxWidth="calc((100% - 32px) / 3)"
                minWidth="260px"
                css={{ flex: "1 1 0", minWidth: "260px" }}
              >
                <PlanCard
                  plan={plan}
                  isCurrent={currentPlanId === plan.id}
                  onSelect={handleSelect}
                  loading={loadingPlan === plan.id && fetcher.state !== "idle"}
                />
              </Box>
            ))}
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2" fontWeight="semibold">Billing FAQ</Text>
                <Divider />
                <BlockStack gap="200">
                  <BlockStack gap="50">
                    <Text variant="bodySm" fontWeight="medium">When am I charged?</Text>
                    <Text variant="bodySm" tone="subdued">
                      Every 30 days through Shopify billing.
                    </Text>
                  </BlockStack>
                  <BlockStack gap="50">
                    <Text variant="bodySm" fontWeight="medium">Can I downgrade?</Text>
                    <Text variant="bodySm" tone="subdued">
                      Yes — instantly. Existing items remain, but you cannot add more items
                      beyond the Free plan limit.
                    </Text>
                  </BlockStack>
                  <BlockStack gap="50">
                    <Text variant="bodySm" fontWeight="medium">Do I need a trial?</Text>
                    <Text variant="bodySm" tone="subdued">
                      No. The Free plan has no time limit and includes up to 2 media items.
                    </Text>
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>

      {toastActive && (
        <Toast
          content={toastMessage}
          error={toastError}
          onDismiss={() => setToastActive(false)}
          duration={4000}
        />
      )}
    </Page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
