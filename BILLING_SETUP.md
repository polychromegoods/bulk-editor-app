# Billing & GDPR Setup Guide

## Step 1: Add Billing Config to shopify.server.js

Add the billing configuration to your `shopifyApp()` call in `shopify.server.js`.

Find the `shopifyApp({...})` call and add the `billing` property:

```js
import { BillingInterval } from "@shopify/shopify-app-remix/server";

// Add these exports at the top of the file (after imports)
export const PLAN_NAMES = {
  PRO: "Pro Plan",
  PLUS: "Plus Plan",
};

// Inside the shopifyApp({...}) config, add:
billing: {
  [PLAN_NAMES.PRO]: {
    amount: 9.99,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
  },
  [PLAN_NAMES.PLUS]: {
    amount: 19.99,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
  },
},
```

## Step 2: Add GDPR Compliance Webhooks to shopify.app.toml

Add this to your `shopify.app.toml` file under the `[webhooks]` section:

```toml
[webhooks]
api_version = "2025-01"

  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "/webhooks/gdpr"
```

If you already have a `[webhooks]` section, just add the `[[webhooks.subscriptions]]` block with `compliance_topics`.

## Step 3: Run Database Migration

After updating the Prisma schema (which now includes the `ShopPlan` model), run:

```bash
npx prisma db push
```

This will create the new `ShopPlan` table in your database.

## Step 4: Restart the Dev Server

```bash
shopify app dev
```

## Plan Structure

| Plan | Price | Bulk Edits/Month | Automations | Scheduled Edits |
|------|-------|------------------|-------------|-----------------|
| Free | $0 | 3 | ❌ | ❌ |
| Pro | $9.99/mo | 50 | ❌ | ❌ |
| Plus | $19.99/mo | Unlimited | ✅ | ✅ |

All paid plans include a 7-day free trial (first time only).

## Files Changed/Added

### New Files:
- `app/routes/app.billing.jsx` — Plans & pricing page
- `app/routes/app.billing-callback.jsx` — Billing redirect handler
- `app/routes/webhooks.gdpr.jsx` — GDPR compliance webhook handler
- `BILLING_SETUP.md` — This file

### Modified Files:
- `prisma/schema.prisma` — Added `ShopPlan` model
- `app/routes/app.jsx` — Added "Plans" to navigation
- `app/routes/app._index.jsx` — Added plan status banner + usage meter
- `app/routes/app.automations.jsx` — Gated behind Plus plan
- `app/routes/app.scheduled.jsx` — Gated behind Plus plan
- `app/routes/app.bulk-edit.jsx` — Added usage limit checking

## Testing Billing

1. In development, billing requests use `isTest: true` automatically
2. On your development store, you can approve test charges without real money
3. After approving, check the billing page to confirm the plan updated
4. Test the monthly edit counter by running a few bulk edits
5. Test plan gating by checking Automations/Scheduled pages on Free plan
