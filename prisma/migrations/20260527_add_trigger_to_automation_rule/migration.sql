-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "trigger" TEXT NOT NULL DEFAULT 'product_updated_or_created';
