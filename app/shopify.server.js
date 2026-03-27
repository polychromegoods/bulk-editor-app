import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

export const PLAN_NAMES = {
  UNLIMITED_MONTHLY: "Unlimited Edits Monthly",
  UNLIMITED_YEARLY: "Unlimited Edits Yearly",
  PRO_MONTHLY: "Pro Monthly",
  PRO_YEARLY: "Pro Yearly",
  PREMIUM_MONTHLY: "Premium Pro Monthly",
  PREMIUM_YEARLY: "Premium Pro Yearly",
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    /* ── Unlimited Edits: $6.99/mo or $67.10/yr (20% off) ── */
    [PLAN_NAMES.UNLIMITED_MONTHLY]: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      trialDays: 7,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: 6.99,
          currencyCode: "USD",
        },
      ],
    },
    [PLAN_NAMES.UNLIMITED_YEARLY]: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      trialDays: 7,
      lineItems: [
        {
          interval: BillingInterval.Annual,
          amount: 67.10,
          currencyCode: "USD",
        },
      ],
    },
    /* ── Pro: $14.99/mo or $143.90/yr (20% off) ── */
    [PLAN_NAMES.PRO_MONTHLY]: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      trialDays: 7,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: 14.99,
          currencyCode: "USD",
        },
      ],
    },
    [PLAN_NAMES.PRO_YEARLY]: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      trialDays: 7,
      lineItems: [
        {
          interval: BillingInterval.Annual,
          amount: 143.90,
          currencyCode: "USD",
        },
      ],
    },
    /* ── Premium Pro: $24.99/mo or $239.90/yr (20% off) ── */
    [PLAN_NAMES.PREMIUM_MONTHLY]: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      trialDays: 7,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: 24.99,
          currencyCode: "USD",
        },
      ],
    },
    [PLAN_NAMES.PREMIUM_YEARLY]: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      trialDays: 7,
      lineItems: [
        {
          interval: BillingInterval.Annual,
          amount: 239.90,
          currencyCode: "USD",
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
