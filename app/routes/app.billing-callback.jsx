import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/* Map Shopify Managed Pricing plan handles → internal plan keys */
const HANDLE_TO_PLAN = {
  "bulk-editor-free": "free",
  "bulk-editor-unlimited": "unlimited",
  "bulk-editor-pro": "pro",
  "bulk-editor-premium": "premium",
};

const CURRENT_SUBSCRIPTION_QUERY = `
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
                  interval
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
`;

/**
 * This route is the "welcome link" for Managed Pricing.
 * After a merchant approves a plan change on Shopify's hosted plan page,
 * Shopify redirects here with a `charge_id` URL parameter.
 *
 * We query GraphQL to determine the current plan and sync our database.
 */
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id") || null;

  // Query Shopify for the current subscription
  let planKey = "free";
  try {
    const response = await admin.graphql(CURRENT_SUBSCRIPTION_QUERY);
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

    console.log(`[Billing Callback] Shop ${shop}: detected plan = ${planKey}, chargeId = ${chargeId}`);
  } catch (err) {
    console.error("[Billing Callback] Failed to query subscription:", err.message);
  }

  // Update the shop's plan in the database
  await prisma.shopPlan.upsert({
    where: { shop },
    update: {
      plan: planKey,
      chargeId: chargeId,
      trialUsed: planKey !== "free" ? true : undefined,
    },
    create: {
      shop,
      plan: planKey,
      chargeId: chargeId,
      trialUsed: planKey !== "free",
    },
  });

  // Redirect back to billing page
  return redirect("/app/billing");
};

export default function BillingCallback() {
  return (
    <s-page title="Processing...">
      <s-section>
        <s-box padding="loose">
          <div style={{ textAlign: "center", padding: "40px" }}>
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>⏳</div>
            <div style={{ fontSize: "16px", color: "#202223", fontWeight: 600 }}>Setting up your plan...</div>
            <div style={{ fontSize: "14px", color: "#637381", marginTop: "4px" }}>You'll be redirected in a moment.</div>
          </div>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
