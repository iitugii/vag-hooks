-- CreateTable
CREATE TABLE "ProviderPercentage" (
    "providerId" TEXT NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderPercentage_pkey" PRIMARY KEY ("providerId")
);
