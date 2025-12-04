-- Create per-week provider configuration table
CREATE TABLE "ProviderWeekConfig" (
    "providerId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "servicePercentage" DOUBLE PRECISION,
    "tipFeePercentage" DOUBLE PRECISION,
    "specialDeduction" DOUBLE PRECISION,
    "specialAddition" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderWeekConfig_pkey" PRIMARY KEY ("providerId", "weekStart")
);

CREATE INDEX "ProviderWeekConfig_weekStart_idx" ON "ProviderWeekConfig"("weekStart");
