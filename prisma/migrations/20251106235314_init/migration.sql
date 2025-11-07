-- Clean initial schema for WebhookEvent
CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventId" TEXT NOT NULL UNIQUE,
  "entityType" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "businessIds" TEXT[] NOT NULL,
  "createdDate" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawBody" TEXT NOT NULL,
  "headers" JSONB NOT NULL,
  "payload" JSONB NOT NULL,
  "sourceIp" TEXT,
  "userAgent" TEXT,
  "day" DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX "WebhookEvent_entityType_action_idx"
  ON "WebhookEvent" ("entityType","action");

CREATE INDEX "WebhookEvent_day_idx"
  ON "WebhookEvent" ("day");