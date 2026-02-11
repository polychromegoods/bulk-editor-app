import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") || "free";
  const chargeId = url.searchParams.get("charge_id") || null;

  // Update the shop's plan in the database
  await prisma.shopPlan.upsert({
    where: { shop },
    update: {
      plan: plan,
      chargeId: chargeId,
    },
    create: {
      shop,
      plan: plan,
      chargeId: chargeId,
      trialUsed: true,
    },
  });

  // Redirect back to billing page with success
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
