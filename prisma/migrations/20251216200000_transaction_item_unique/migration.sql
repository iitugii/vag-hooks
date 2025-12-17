-- Add transactionId and itemSold for line-level idempotency; de-scope eventId uniqueness
ALTER TABLE "WebhookEvent"
  ADD COLUMN "transactionId" TEXT,
  ADD COLUMN "itemSold" TEXT;

-- Drop prior uniqueness on eventId to allow multiple line items per event
ALTER TABLE "WebhookEvent"
  DROP CONSTRAINT IF EXISTS "WebhookEvent_eventId_key";

-- Enforce idempotency on (transactionId, itemSold) when both are present
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_transactionId_itemSold_key"
  ON "WebhookEvent" ("transactionId", "itemSold");
