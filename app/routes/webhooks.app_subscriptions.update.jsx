import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/* Map Shopify Managed Pricing plan handles → internal plan keys */
const HANDLE_TO_PLAN = {
  "bulk-editor-free": "free",
  "bulk-editor-unlimited": "unlimited",
  "bulk-editor-pro": "pro",
  "bulk-editor-premium": "premium",
};

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
  if (["ACTIVE", "ACCEPTED", "FROZEN"].includes(subscriptionStatus)) {
    let planKey = "free";

    try {
      const response = await admin.graphql(`
        query {
          currentAppInstallation {
            allSubscriptions(first: 5, sortKey: CREATED_AT) {
              nodes {
                id
                name
                status
                lineItems {
                  plan {
                    pricingDetails {
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
        }
      `);
      const data = await response.json();
      const allSubs = data?.data?.currentAppInstallation?.allSubscriptions?.nodes || [];

      for (const sub of allSubs) {
        if (sub.status === "ACTIVE" || sub.status === "ACCEPTED") {
          const lineItem = sub.lineItems?.[0];
          const handle = lineItem?.plan?.pricingDetails?.planHandle;
          if (handle && HANDLE_TO_PLAN[handle]) {
            planKey = HANDLE_TO_PLAN[handle];
            break;
          }
          // Fallback: infer from price
          const price = parseFloat(lineItem?.plan?.pricingDetails?.price?.amount || "0");
          if (price >= 24) { planKey = "premium"; break; }
          if (price >= 14) { planKey = "pro"; break; }
          if (price >= 6) { planKey = "unlimited"; break; }
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
