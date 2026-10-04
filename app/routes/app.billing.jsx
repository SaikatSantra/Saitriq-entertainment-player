/**
 * /app/billing — Plan selection page
 */

import { useLoaderData, data } from "react-router";
import {
  Page, Layout, Card, Text, Button, BlockStack, InlineStack,
  Divider, Badge, Banner, List, Toast, Box,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS, getPlanDetails } from "../plans.js";
import {
  getAppShopIdentity,
  getShopPlanStatus,
  getPricingPageUrl,
} from "../billing.server";
import { useState, useEffect } from "react";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop   = session.shop;
  const url = new URL(request.url);
  const pricingReturn =
    url.searchParams.has("plan_handle") ||
    ["updated", "unverified"].includes(url.searchParams.get("pricing"));
  const identity = await getAppShopIdentity(admin);
  const [planStatus, pricingPageUrl] = await Promise.all([
    getShopPlanStatus(shop, prisma, admin, { identity, forceRefresh: pricingReturn }),
    getPricingPageUrl(admin, shop, identity),
  ]);
  const plan   = getPlanDetails(planStatus.record);
  // Serialise plans as plain objects (Infinity → null for JSON)
  const plans  = Object.values(PLANS).map((p) => ({
    ...p,
    limit: p.limit === Infinity ? null : p.limit,
  }));
  return data({
    currentPlanId: planStatus.verified ? plan.id : null,
    billingVerified: planStatus.verified,
    billingStatusReason: planStatus.reason,
    pricingPageUrl,
    plans,
    shop,
    pricingUpdated: url.searchParams.get("pricing") === "updated",
    pricingError: url.searchParams.get("error"),
  });
};

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({ plan, isCurrent, pricingPageUrl }) {
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
              url={pricingPageUrl}
              target="_top"
              fullWidth
            >
              View plans on Shopify
            </Button>
          )}
        </BlockStack>
      </Box>
    </Card>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const {
    currentPlanId,
    billingVerified,
    billingStatusReason,
    pricingPageUrl,
    plans,
    pricingUpdated,
    pricingError,
  } = useLoaderData();

  const [toastActive,  setToastActive]  = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError,   setToastError]   = useState(false);

  useEffect(() => {
    if (pricingUpdated) {
      setToastMessage("Shopify subscription status updated.");
      setToastError(false);
      setToastActive(true);
    } else if (pricingError) {
      setToastMessage("Unable to confirm the Shopify plan update. Try refreshing billing status.");
      setToastError(true);
      setToastActive(true);
    }
  }, [pricingUpdated, pricingError]);

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

        {!billingVerified && (
          <Layout.Section>
            <Banner tone="warning" title="Subscription status is not verified">
              <Text as="span" variant="bodyMd">
                {billingStatusReason} Until verification is restored, Free limits are applied.
                You can still use the buttons below to manage your plan on Shopify.
              </Text>
              <Box paddingBlockStart="200">
                <Button url={pricingPageUrl} target="_top" variant="secondary">
                  Open Shopify plan selection
                </Button>
              </Box>
            </Banner>
          </Layout.Section>
        )}

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
                  pricingPageUrl={pricingPageUrl}
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
