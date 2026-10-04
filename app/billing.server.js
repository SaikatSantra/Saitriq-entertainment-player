/**
 * Shopify App Pricing helpers — server-only logic.
 */

export { PLANS, getPlanDetails } from "./plans.js";
import { PLANS, getPlanDetails } from "./plans.js";

const IDENTITY_QUERY = `#graphql
  query AppAndShopIdentity {
    app {
      id
      handle
    }
    shop {
      id
    }
  }
`;

const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      legacySubscriptionId
      items {
        handle
      }
    }
  }
`;

const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const planCache = new Map();
const planRefreshes = new Map();

export class PartnerApiConfigurationError extends Error {
  constructor(
    message =
      "Subscription status cannot be verified: set SHOPIFY_PARTNER_ORG_ID and SHOPIFY_PARTNER_API_ACCESS_TOKEN using a Partner API client with Manage apps permission.",
  ) {
    super(message);
    this.name = "PartnerApiConfigurationError";
  }
}

export class PartnerApiVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PartnerApiVerificationError";
  }
}

function getPlanItemHandleMap() {
  const raw = process.env.SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES;
  if (!raw) {
    throw new PartnerApiConfigurationError(
      "SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES must map Shopify App Pricing subscription item handles to local plan IDs.",
    );
  }

  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new PartnerApiConfigurationError(
      "SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES must contain valid JSON.",
    );
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new PartnerApiConfigurationError(
      "SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES must be a JSON object.",
    );
  }

  for (const [handle, planId] of Object.entries(map)) {
    if (!handle || typeof planId !== "string" || !Object.hasOwn(PLANS, planId)) {
      throw new PartnerApiConfigurationError(
        "SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES must map each item handle to FREE, PRO, or UNLIMITED.",
      );
    }
  }
  return map;
}

async function getActivePricingSubscription(admin, identity) {
  const organizationId =
    process.env.SHOPIFY_PARTNER_ORG_ID ??
    process.env.SHOPIFY_PARTNER_ORGANIZATION_ID;
  const accessToken =
    process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN ??
    process.env.SHOPIFY_PARTNER_API_TOKEN;
  if (!organizationId || !accessToken) {
    throw new PartnerApiConfigurationError(
      "Shopify App Pricing checks need SHOPIFY_PARTNER_ORG_ID and SHOPIFY_PARTNER_API_ACCESS_TOKEN from a Partner API client with Manage apps permission.",
    );
  }

  const appShopIdentity = identity ?? (await getAppShopIdentity(admin));
  const appId = process.env.SHOPIFY_APP_GID || appShopIdentity.appId;
  const shopId = appShopIdentity.shopId;

  const endpoint =
    `https://partners.shopify.com/${encodeURIComponent(organizationId)}` +
    "/api/2026-07/graphql.json";
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION_QUERY,
        variables: { appId, shopId },
      }),
    });
  } catch (error) {
    throw new PartnerApiVerificationError(
      `Partner API request failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  if (!response.ok) {
    throw new PartnerApiVerificationError(
      `Shopify Partner API request failed with HTTP ${response.status}.`,
    );
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new PartnerApiVerificationError(
      payload.errors.map(({ message }) => message).join(", "),
    );
  }
  if (!payload.data || !Object.hasOwn(payload.data, "activeSubscription")) {
    throw new PartnerApiVerificationError(
      "Shopify Partner API did not return active subscription data.",
    );
  }

  return payload.data.activeSubscription;
}

export async function getAppShopIdentity(admin) {
  const response = await admin.graphql(IDENTITY_QUERY);
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(({ message }) => message).join(", "));
  }

  const identity = {
    appId: payload.data?.app?.id,
    appHandle: payload.data?.app?.handle,
    shopId: payload.data?.shop?.id,
  };
  if (!identity.appId || !identity.appHandle || !identity.shopId) {
    throw new Error("Shopify did not return the app and shop identity required for billing.");
  }
  return identity;
}

function resolvePlanId(subscription) {
  if (!subscription) return "FREE";
  const handleMap = getPlanItemHandleMap();
  const items = subscription.items ?? [];
  if (!items.length) {
    throw new Error("The active Shopify App Pricing subscription has no plan items.");
  }
  const planIds = new Set(items.map(({ handle }) => {
    const planId = handleMap[handle];
    if (!planId) {
      throw new PartnerApiConfigurationError(
        `Shopify App Pricing item "${handle}" has no local plan mapping. Check SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES.`,
      );
    }
    return planId;
  }));
  if (planIds.size !== 1) {
    throw new PartnerApiConfigurationError(
      "The active Shopify App Pricing subscription does not map to exactly one local plan. Check SHOPIFY_APP_PRICING_PLAN_ITEM_HANDLES.",
    );
  }
  return [...planIds][0];
}

/**
 * Refresh the local entitlement from Shopify's canonical managed subscription.
 * A missing active subscription is the Free plan; API errors are surfaced.
 */
export async function getShopPlan(
  shop,
  prisma,
  admin,
  { forceRefresh = false, identity } = {},
) {
  if (!admin) {
    throw new Error("An authenticated Shopify Admin API client is required to refresh billing.");
  }

  if (
    !(process.env.SHOPIFY_PARTNER_ORG_ID ?? process.env.SHOPIFY_PARTNER_ORGANIZATION_ID) ||
    !(process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN ?? process.env.SHOPIFY_PARTNER_API_TOKEN)
  ) {
    throw new PartnerApiConfigurationError();
  }

  const now = Date.now();
  const inMemory = planCache.get(shop);
  if (!forceRefresh && inMemory && now - inMemory.cachedAt < PLAN_CACHE_TTL_MS) {
    return inMemory.record;
  }

  if (!forceRefresh && planRefreshes.has(shop)) {
    return planRefreshes.get(shop);
  }

  const refreshPromise = refreshShopPlan(shop, prisma, admin, { forceRefresh, identity });
  planRefreshes.set(shop, refreshPromise);
  try {
    const record = await refreshPromise;
    planCache.set(shop, { record, cachedAt: Date.now() });
    if (planCache.size > 500) {
      const oldestShop = planCache.keys().next().value;
      if (oldestShop) planCache.delete(oldestShop);
    }
    return record;
  } finally {
    if (planRefreshes.get(shop) === refreshPromise) {
      planRefreshes.delete(shop);
    }
  }
}

async function refreshShopPlan(shop, prisma, admin, { forceRefresh, identity }) {
  const cachedRecord = await prisma.appSubscription.findUnique({ where: { shop } });
  if (
    !forceRefresh &&
    cachedRecord &&
    Date.now() - new Date(cachedRecord.updatedAt).getTime() < PLAN_CACHE_TTL_MS
  ) {
    return cachedRecord;
  }

  const subscription = await getActivePricingSubscription(admin, identity);
  const planId = resolvePlanId(subscription);
  const shopifySubscriptionId = subscription?.legacySubscriptionId ?? null;

  return prisma.appSubscription.upsert({
    where: { shop },
    update: { planId, shopifySubscriptionId },
    create: { shop, planId, shopifySubscriptionId },
  });
}

export async function getShopPlanStatus(shop, prisma, admin, options) {
  try {
    return {
      record: await getShopPlan(shop, prisma, admin, options),
      verified: true,
      reason: null,
    };
  } catch (error) {
    if (
      error instanceof PartnerApiConfigurationError ||
      error instanceof PartnerApiVerificationError
    ) {
      return { record: null, verified: false, reason: error.message };
    }
    throw error;
  }
}

/** True if the shop can add more items under the current Shopify plan */
export async function canAddItem(shop, prisma, admin) {
  const record = await getShopPlan(shop, prisma, admin);
  const plan = getPlanDetails(record);
  if (plan.limit === Infinity) return true;
  const count = await prisma.playlistMedia.count({ where: { shop } });
  return count < plan.limit;
}

/** Construct Shopify's hosted managed-pricing page URL. */
export async function getPricingPageUrl(admin, shop, identity) {
  const { appHandle } = identity ?? (await getAppShopIdentity(admin));

  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(storeHandle)) {
    throw new Error("Could not derive the Shopify store handle.");
  }

  return (
    `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}` +
    `/charges/${encodeURIComponent(appHandle)}/pricing_plans`
  );
}
