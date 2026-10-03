/**
 * Billing helpers — server-only logic.
 *
 * All functions that touch Prisma or Shopify accept them as arguments
 * so this file has NO top-level Node imports and Vite can process it
 * without "server-only" errors.
 *
 * Plans:
 *   FREE       — 2 items,       $0/month
 *   PRO        — 50 items,      $5/month recurring
 *   UNLIMITED  — unlimited,    $50/month recurring
 */

export { PLANS, getPlanDetails } from "./plans.js";
import { PLANS, getPlanDetails } from "./plans.js";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const CREATE_SUBSCRIPTION = `#graphql
  mutation createSubscription(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      lineItems: $lineItems
      test: $test
    ) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const CANCEL_SUBSCRIPTION = `#graphql
  mutation cancelSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

// ─── Helpers that receive prisma/admin as args ────────────────────────────────

/** Return the plan record for a shop, creating a FREE row if missing */
export async function getShopPlan(shop, prisma) {
  let record = await prisma.appSubscription.findUnique({ where: { shop } });
  if (!record) {
    record = await prisma.appSubscription.create({
      data: { shop, planId: "FREE", shopifySubscriptionId: null },
    });
  }
  return record;
}

/** True if the shop can add more items under their current plan */
export async function canAddItem(shop, prisma) {
  const record = await getShopPlan(shop, prisma);
  const plan   = getPlanDetails(record);
  if (plan.limit === Infinity) return true;
  const count = await prisma.playlistMedia.count({ where: { shop } });
  return count < plan.limit;
}

/**
 * Create a Shopify recurring charge and return the confirmation URL.
 * Returns null for FREE plan (no charge needed).
 */
export async function createSubscriptionUrl(admin, planId) {
  const plan = PLANS[planId];
  if (!plan || plan.price === 0) return null;

  const appUrl    = process.env.SHOPIFY_APP_URL || "";
  const returnUrl = `${appUrl}/app/billing/callback?plan=${planId}`;
  const isTest    = process.env.NODE_ENV !== "production";

  const res = await admin.graphql(CREATE_SUBSCRIPTION, {
    variables: {
      name:      `Audio & Video Playlist — ${plan.name}`,
      returnUrl,
      test:      isTest,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price:    { amount: plan.price, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    },
  });

  const json   = await res.json();
  const errors = json.data?.appSubscriptionCreate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join(", "));
  return json.data.appSubscriptionCreate.confirmationUrl;
}

/** Activate a plan after Shopify billing confirmation */
export async function activatePlan(admin, prisma, planId, shopifySubscriptionId, shop) {
  const existing = await prisma.appSubscription.findUnique({ where: { shop } });
  if (existing?.shopifySubscriptionId && existing.planId !== "FREE") {
    try {
      await admin.graphql(CANCEL_SUBSCRIPTION, {
        variables: { id: existing.shopifySubscriptionId },
      });
    } catch (_) {}
  }

  await prisma.appSubscription.upsert({
    where:  { shop },
    update: { planId, shopifySubscriptionId },
    create: { shop, planId, shopifySubscriptionId },
  });
}

/** Downgrade to FREE: cancel current paid subscription */
export async function cancelToPlan(admin, prisma, shop) {
  const existing = await prisma.appSubscription.findUnique({ where: { shop } });
  if (existing?.shopifySubscriptionId) {
    try {
      await admin.graphql(CANCEL_SUBSCRIPTION, {
        variables: { id: existing.shopifySubscriptionId },
      });
    } catch (_) {}
  }

  await prisma.appSubscription.upsert({
    where:  { shop },
    update: { planId: "FREE", shopifySubscriptionId: null },
    create: { shop, planId: "FREE", shopifySubscriptionId: null },
  });
}
