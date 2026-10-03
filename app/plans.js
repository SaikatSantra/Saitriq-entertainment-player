/**
 * Client-safe plan definitions — no server imports.
 * Import this in route components that need plan data in the browser.
 */

export const PLANS = {
  FREE: {
    name:        "Free",
    id:          "FREE",
    price:       0,
    limit:       2,
    description: "Up to 2 media items",
    badge:       null,
  },
  PRO: {
    name:        "Pro",
    id:          "PRO",
    price:       5,
    limit:       50,
    description: "Up to 50 media items",
    badge:       "popular",
  },
  UNLIMITED: {
    name:        "Unlimited",
    id:          "UNLIMITED",
    price:       50,
    limit:       Infinity,
    description: "Unlimited media items",
    badge:       null,
  },
};

/** Return the plan details object from a DB subscription record */
export function getPlanDetails(record) {
  return PLANS[record?.planId] ?? PLANS.FREE;
}
