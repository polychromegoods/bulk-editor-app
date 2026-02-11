/**
 * BILLING CONFIG SNIPPET
 * 
 * Add this to your shopify.server.js file.
 * 
 * 1. Add the import at the top:
 *    import { BillingInterval } from "@shopify/shopify-app-remix/server";
 * 
 * 2. Add this export before the shopifyApp() call:
 */

export const PLAN_NAMES = {
  PRO: "Pro Plan",
  PLUS: "Plus Plan",
};

/**
 * 3. Add this `billing` property inside your shopifyApp({...}) config:
 */

const billingConfig = {
  [PLAN_NAMES.PRO]: {
    amount: 9.99,
    currencyCode: "USD",
    interval: "Every30Days", // BillingInterval.Every30Days
  },
  [PLAN_NAMES.PLUS]: {
    amount: 19.99,
    currencyCode: "USD",
    interval: "Every30Days", // BillingInterval.Every30Days
  },
};

/**
 * Your shopifyApp() call should look something like:
 * 
 * const shopify = shopifyApp({
 *   apiKey: process.env.SHOPIFY_API_KEY,
 *   ...other config...
 *   billing: {
 *     [PLAN_NAMES.PRO]: {
 *       amount: 9.99,
 *       currencyCode: "USD",
 *       interval: BillingInterval.Every30Days,
 *     },
 *     [PLAN_NAMES.PLUS]: {
 *       amount: 19.99,
 *       currencyCode: "USD",
 *       interval: BillingInterval.Every30Days,
 *     },
 *   },
 * });
 */
