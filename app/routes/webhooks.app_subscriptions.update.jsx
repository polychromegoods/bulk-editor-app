import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/* Map Shopify Managed Pricing plan handles → internal plan keys */
const HANDLE_TO_PLAN = {
  "bulk-editor-free": "free",
  "bulk-editor-unlimited": "unlimited",
  "bulk-editor-pro": "pro",
  "bulk-editor-premium": "premium",
};

/* Plan tier ordering for picking the highest active plan */
const PLAN_TIER = { free: 0, unlimited: 1, pro: 2, premium: 3 };

/* Helper: resolve a subscription's lineItem to an internal plan key */
function resolveSubPlan(sub) {
  const lineItem = sub?.lineItems?.[0];
  if (!lineItem) return null;
  const details = lineItem.plan?.pricingDetails;
  const handle = details?.planHandle;
  if (handle && HANDLE_TO_PLAN[handle]) return HANDLE_TO_PLAN[handle];
  const rawPrice = parseFloat(details?.price?.amount || "0");
  if (rawPrice === 0) return null;
  const interval = details?.interval;
  const price = interval === "ANNUAL" ? rawPrice / 12 : rawPrice;
  if (price >= 20) return "premium";
  if (price >= 10) return "pro";
  if (price >= 4) return "unlimited";
  return null;
}

/**
 * Webhook: APP_SUBSCRIPTIONS_UPDATE
 *
 * Fired by Shopify whenever a merchant's subscription changes
 * (upgrade, downgrade, cancel, trial start/end, etc.)
 *
 * Payload includes:
 *   - app_subscription.admin_graphql_api_id
 *   - app_subscription.name
 *   - app_subscription.status (ACTIVE, CANCELLED, DECLINED, EXPIRED, FROZEN, PENDING)
 */
export const action = async ({ request }) => {
  const { shop, payload, admin } = await authenticate.webhook(request);

  console.log(`[Webhook] APP_SUBSCRIPTIONS_UPDATE for shop: ${shop}`);
  console.log(`[Webhook] Payload:`, JSON.stringify(payload, null, 2));

  const subscriptionStatus = payload?.app_subscription?.status;
  const subscriptionName = payload?.app_subscription?.name;

  // If the subscription was cancelled/declined/expired, downgrade to free
  if (["CANCELLED", "DECLINED", "EXPIRED"].includes(subscriptionStatus)) {
    console.log(`[Webhook] Subscription ${subscriptionStatus} for ${shop}, downgrading to free`);
    await prisma.shopPlan.upsert({
      where: { shop },
      update: { plan: "free", chargeId: null },
      create: { shop, plan: "free" },
    });
    return new Response("OK", { status: 200 });
  }

  // For ACTIVE/ACCEPTED/FROZEN, query GraphQL to get the current plan handle
  // IMPORTANT: When upgrading, multiple subscriptions may coexist briefly.
  // We pick the HIGHEST-TIER plan among all active/accepted subscriptions.
  if (["ACTIVE", "ACCEPTED", "FROZEN"].includes(subscriptionStatus)) {
    let planKey = "free";

    try {
      const response = await admin.graphql(`
        query {
          currentAppInstallation {
            activeSubscriptions {
              id
              name
              status
              lineItems {
                plan {
                  pricingDetails {
                    ... on AppRecurringPricing {
                      interval
                      planHandle
                      price { amount currencyCode }
                    }
                  }
                }
              }
            }
            allSubscriptions(first: 10, sortKey: CREATED_AT) {
              nodes {
                id
                name
                status
                createdAt
                lineItems {
                  plan {
                    pricingDetails {
                      ... on AppRecurringPricing {
                        interval
                        planHandle
                        price { amount currencyCode }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);
      const data = await response.json();
      const installation = data?.data?.currentAppInstallation;

      // 1. Check activeSubscriptions
      const activeSubs = installation?.activeSubscriptions || [];
      for (const sub of activeSubs) {
        const resolved = resolveSubPlan(sub);
        if (resolved && (PLAN_TIER[resolved] || 0) > (PLAN_TIER[planKey] || 0)) {
          planKey = resolved;
        }
      }

      // 2. Also check allSubscriptions for ACTIVE/ACCEPTED
      const allSubs = installation?.allSubscriptions?.nodes || [];
      for (const sub of allSubs) {
        if (sub.status === "ACTIVE" || sub.status === "ACCEPTED") {
          const resolved = resolveSubPlan(sub);
          if (resolved && (PLAN_TIER[resolved] || 0) > (PLAN_TIER[planKey] || 0)) {
            planKey = resolved;
          }
        }
      }
    } catch (err) {
      console.error(`[Webhook] Failed to query GraphQL for ${shop}:`, err.message);
      // Fallback: try to infer from subscription name
      const nameLower = (subscriptionName || "").toLowerCase();
      if (nameLower.includes("premium")) planKey = "premium";
      else if (nameLower.includes("pro")) planKey = "pro";
      else if (nameLower.includes("unlimited")) planKey = "unlimited";
    }

    console.log(`[Webhook] Updating ${shop} to plan: ${planKey}`);
    await prisma.shopPlan.upsert({
      where: { shop },
      update: { plan: planKey, trialUsed: planKey !== "free" ? true : undefined },
      create: { shop, plan: planKey, trialUsed: planKey !== "free" },
    });
  }

  return new Response("OK", { status: 200 });
};
