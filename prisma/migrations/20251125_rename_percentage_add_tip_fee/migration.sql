-- Adjust provider payout configuration to track service and tip fee percentages separately
ALTER TABLE "ProviderPercentage"
  RENAME COLUMN "percentage" TO "servicePercentage";

ALTER TABLE "ProviderPercentage"
  ALTER COLUMN "servicePercentage" DROP NOT NULL;

ALTER TABLE "ProviderPercentage"
  ADD COLUMN "tipFeePercentage" DOUBLE PRECISION;
