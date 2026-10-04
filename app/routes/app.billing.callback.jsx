/**
 * Shopify App Pricing welcome link. Shopify appends plan_handle and shop;
 * subscription state is verified from the Partner API, not these parameters.
 */

import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getShopPlan,
  PartnerApiConfigurationError,
  PartnerApiVerificationError,
} from "../billing.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  try {
    await getShopPlan(session.shop, prisma, admin, { forceRefresh: true });
    return redirect("/app/billing?pricing=updated");
  } catch (error) {
    if (
      !(error instanceof PartnerApiConfigurationError) &&
      !(error instanceof PartnerApiVerificationError)
    ) {
      throw error;
    }
    return redirect("/app/billing?pricing=unverified");
  }
};
