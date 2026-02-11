import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GDPR Mandatory Webhooks Handler
 *
 * Shopify requires all apps to handle these 3 compliance webhooks:
 * 1. CUSTOMERS_DATA_REQUEST - Customer requests their data
 * 2. CUSTOMERS_REDACT - Customer requests data deletion
 * 3. SHOP_REDACT - Shop uninstalls, requests data deletion (48h after uninstall)
 *
 * These are registered in shopify.app.toml via compliance_topics.
 * They hit the /webhooks route (same as other webhooks).
 */

export const action = async ({ request }) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log(`[GDPR] Received ${topic} webhook for ${shop}`);

    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        // A customer has requested their data.
        // This app doesn't store customer-specific data (only product prices),
        // so we respond with 200 OK to acknowledge.
        console.log(`[GDPR] Customer data request for shop ${shop}`);
        // If you ever store customer data, you'd compile and send it here.
        break;
      }

      case "CUSTOMERS_REDACT": {
        // A customer has requested deletion of their data.
        // This app doesn't store customer-specific data, so we acknowledge.
        console.log(`[GDPR] Customer redact request for shop ${shop}`);
        // If you ever store customer data, you'd delete it here.
        break;
      }

      case "SHOP_REDACT": {
        // The shop has uninstalled the app and requested data deletion.
        // We should clean up all shop-specific data.
        console.log(`[GDPR] Shop redact request for shop ${shop} — cleaning up data`);

        try {
          // Delete all shop data from our database
          await Promise.all([
            prisma.shopPlan.deleteMany({ where: { shop } }),
            prisma.bulkEdit.deleteMany({ where: { shop } }),
            prisma.priceHistory.deleteMany({ where: { shop } }),
            prisma.automationRule.deleteMany({ where: { shop } }),
            prisma.scheduledEdit.deleteMany({ where: { shop } }),
            prisma.savedSearch.deleteMany({ where: { shop } }),
          ]);
          console.log(`[GDPR] Successfully cleaned up all data for ${shop}`);
        } catch (cleanupError) {
          console.error(`[GDPR] Error cleaning up data for ${shop}:`, cleanupError);
          // Still return 200 — Shopify will retry if we return an error
        }
        break;
      }

      default:
        console.log(`[GDPR] Unhandled topic: ${topic}`);
        return new Response("Unhandled webhook topic", { status: 404 });
    }

    return new Response("Webhook received", { status: 200 });
  } catch (error) {
    console.error("[GDPR] Webhook error:", error);
    if (error instanceof Response) throw error;
    return new Response("Internal Server Error", { status: 500 });
  }
};
