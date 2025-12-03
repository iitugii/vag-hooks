import { prisma } from "../src/lib/prisma";

async function main() {
  const [, , providerId, targetDate] = process.argv;
  if (!providerId || !targetDate) {
    console.error("Usage: tsx scripts/listProviderTransactions.ts <providerId> <YYYY-MM-DD>");
    process.exit(1);
  }

  const rows = await prisma.$queryRaw<
    {
      event_id: string;
      transaction_id: string | null;
      ts_local: Date | null;
    }[]
  >`
    WITH base AS (
      SELECT
        "eventId" AS event_id,
        COALESCE("createdDate", "receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local,
        payload->'payload'->>'transactionId' AS transaction_id,
        COALESCE(
          NULLIF((payload->>'serviceProviderId')::text, ''),
          NULLIF((payload->'payload'->>'serviceProviderId')::text, '')
        ) AS provider_id
      FROM "WebhookEvent"
    )
    SELECT event_id, transaction_id, ts_local
    FROM base
    WHERE provider_id = ${providerId}
      AND ts_local::date = ${targetDate}::date
    ORDER BY ts_local;
  `;

  if (!rows.length) {
    console.log("No webhook events found for", providerId, "on", targetDate);
    return;
  }

  console.log(`Found ${rows.length} event(s):`);
  for (const row of rows) {
    console.log("-", row.transaction_id || "(no tx id)", "=>", row.event_id, "@", row.ts_local);
  }
}

main()
  .catch(err => {
    console.error("Failed to list provider transactions", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
