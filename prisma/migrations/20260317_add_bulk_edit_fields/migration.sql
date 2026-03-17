-- AlterTable: Add bulkEditId and bulkEditName to PriceHistory
ALTER TABLE "PriceHistory" ADD COLUMN IF NOT EXISTS "bulkEditId" TEXT;
ALTER TABLE "PriceHistory" ADD COLUMN IF NOT EXISTS "bulkEditName" TEXT;
