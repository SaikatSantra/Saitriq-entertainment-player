/**
 * Shopify App Pricing helpers — server-only logic.
 */

export { PLANS, getPlanDetails } from "./plans.js";
import { getPlanDetails } from "./plans.js";

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

const CURRENT_APP_PRICING_SUBSCRIPTION_QUERY = `#graphql
  query CurrentAppPricingSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                planHandle
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const planCache = new Map();
const planRefreshes = new Map();

export class AppPricingVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AppPricingVerificationError";
  }
}

async function getActivePricingSubscription(admin) {
  try {
    const response = await admin.graphql(CURRENT_APP_PRICING_SUBSCRIPTION_QUERY);
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new AppPricingVerificationError(
        payload.errors.map(({ message }) => message).join(", "),
      );
    }
    const subscriptions = payload.data?.currentAppInstallation?.activeSubscriptions;
    if (!Array.isArray(subscriptions)) {
      throw new AppPricingVerificationError(
        "Shopify did not return the current app installation's active subscriptions.",
      );
    }
    return subscriptions;
  } catch (error) {
    if (error instanceof AppPricingVerificationError) throw error;
    throw new AppPricingVerificationError(
      `Shopify subscription lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
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
  const recurringItems = (subscription.lineItems ?? [])
    .map(({ plan }) => plan?.pricingDetails)
    .filter((pricing) => pricing?.__typename === "AppRecurringPricing");
  const handles = recurringItems
    .map((pricing) => pricing.planHandle)
    .filter(Boolean);
  const candidates = (handles.length ? handles : [subscription.name]).filter(Boolean);
  const planIds = new Set();

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes("unlimited")) planIds.add("UNLIMITED");
    else if (
      ["pro", "proplan", "professional", "professionalplan"].includes(normalized)
    ) {
      planIds.add("PRO");
    } else if (["free", "freeplan"].includes(normalized)) {
      planIds.add("FREE");
    }
  }

  if (planIds.size !== 1) {
    const handlesLabel = handles.length ? handles.join(", ") : "none";
    throw new AppPricingVerificationError(
      `Could not uniquely match Shopify plan handle(s) "${handlesLabel}" to this app's Free, Pro, or Unlimited limits.`,
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
  { forceRefresh = false } = {},
) {
  if (!admin) {
    throw new Error("An authenticated Shopify Admin API client is required to refresh billing.");
  }

  const now = Date.now();
  const inMemory = planCache.get(shop);
  if (!forceRefresh && inMemory && now - inMemory.cachedAt < PLAN_CACHE_TTL_MS) {
    return inMemory.record;
  }

  if (!forceRefresh && planRefreshes.has(shop)) {
    return planRefreshes.get(shop);
  }

  const refreshPromise = refreshShopPlan(shop, prisma, admin, { forceRefresh });
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

async function refreshShopPlan(shop, prisma, admin, { forceRefresh }) {
  const cachedRecord = await prisma.appSubscription.findUnique({ where: { shop } });
  if (
    !forceRefresh &&
    cachedRecord &&
    Date.now() - new Date(cachedRecord.updatedAt).getTime() < PLAN_CACHE_TTL_MS
  ) {
    return cachedRecord;
  }

  const subscriptions = await getActivePricingSubscription(admin);
  const managedSubscriptions = subscriptions.filter((subscription) =>
    (subscription.lineItems ?? []).some(
      ({ plan }) => plan?.pricingDetails?.planHandle,
    ),
  );
  if (!managedSubscriptions.length && subscriptions.length) {
    throw new AppPricingVerificationError(
      "Shopify returned an active subscription without a Shopify App Pricing plan handle.",
    );
  }
  if (managedSubscriptions.length > 1) {
    throw new AppPricingVerificationError(
      "Shopify returned more than one active App Pricing subscription for this installation.",
    );
  }

  const subscription = managedSubscriptions[0] ?? null;
  const planId = subscription ? resolvePlanId(subscription) : "FREE";
  const shopifySubscriptionId = subscription?.id ?? null;

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
      error instanceof AppPricingVerificationError
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
