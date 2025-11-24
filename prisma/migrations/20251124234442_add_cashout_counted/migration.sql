-- AlterTable
ALTER TABLE "WebhookEvent" ALTER COLUMN "day" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "CashoutCounted" (
    "id" SERIAL NOT NULL,
    "day" DATE NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashoutCounted_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashoutCounted_day_key" ON "CashoutCounted"("day");
