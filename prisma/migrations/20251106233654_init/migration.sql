-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "businessIds" TEXT[],
    "createdDate" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawBody" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceIp" TEXT,
    "userAgent" TEXT,
    "day" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_entityType_action_idx" ON "WebhookEvent"("entityType", "action");

-- CreateIndex
CREATE INDEX "WebhookEvent_day_idx" ON "WebhookEvent"("day");

