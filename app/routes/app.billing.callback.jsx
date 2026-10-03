/**
 * GET /app/billing/callback
 *
 * Shopify redirects here after the merchant approves or declines a
 * subscription on the Shopify billing confirmation page.
 *
 * Query params Shopify sends:
 *   charge_id — the subscription ID (same as appSubscription.id in GraphQL)
 *   plan       — the planId we encoded in the returnUrl
 */

import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { activatePlan } from "../billing.server";

const SUBSCRIPTION_STATUS = `#graphql
  query getSubscription($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        status
      }
    }
  }
`;

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url  = new URL(request.url);

  const chargeId = url.searchParams.get("charge_id");
  const planId   = url.searchParams.get("plan");

  if (!chargeId || !planId) {
    return redirect("/app/billing?error=missing_params");
  }

  try {
    // Verify the subscription is ACTIVE before saving
    const res  = await admin.graphql(SUBSCRIPTION_STATUS, {
      variables: { id: `gid://shopify/AppSubscription/${chargeId}` },
    });
    const json = await res.json();
    const sub  = json.data?.node;

    if (!sub || sub.status !== "ACTIVE") {
      return redirect("/app/billing?error=subscription_not_active");
    }

    await activatePlan(admin, prisma, planId, sub.id, shop);
    return redirect("/app/billing?upgraded=1");
  } catch (err) {
    console.error("[billing/callback]", err);
    return redirect(`/app/billing?error=${encodeURIComponent(err.message)}`);
  }
};
