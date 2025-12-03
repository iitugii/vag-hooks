import { prisma } from "../src/lib/prisma";
import { providerDirectory } from "../src/routes/employees";

async function main() {
  const [, , arg1, arg2] = process.argv;
  const hasProviderArgument = Boolean(arg2);
  const providerId = hasProviderArgument ? arg1 : undefined;
  const targetDate = hasProviderArgument ? arg2 : arg1;

  if (!targetDate) {
    console.error(
      "Usage: tsx scripts/checkProviderDay.ts <providerId> <YYYY-MM-DD> | tsx scripts/checkProviderDay.ts <YYYY-MM-DD>"
    );
    process.exit(1);
  }

  if (providerId) {
    const rows = await prisma.$queryRaw<
      {
        event_id: string | null;
        ts_local: Date | null;
      }[]
    >`
      WITH base AS (
        SELECT
          "eventId" AS event_id,
          COALESCE("createdDate", "receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local,
          COALESCE(
            NULLIF((payload->>'serviceProviderId')::text, ''),
            NULLIF((payload->'payload'->>'serviceProviderId')::text, '')
          ) AS provider_id
        FROM "WebhookEvent"
      )
      SELECT event_id, ts_local
      FROM base
      WHERE provider_id = ${providerId}
        AND ts_local::date = ${targetDate}::date
      ORDER BY ts_local;
    `;

    if (!rows.length) {
      console.log("No webhook events found for", providerId, "on", targetDate);
    } else {
      console.log(`Found ${rows.length} webhook event(s) for ${providerId} on ${targetDate}`);
      for (const row of rows) {
        console.log("-", row.event_id || "(missing eventId)", "@", row.ts_local ?? "(no timestamp)");
      }
    }
    return;
  }

  const providers = await prisma.$queryRaw<
    {
      provider_id: string | null;
      event_count: bigint;
    }[]
  >`
    WITH base AS (
      SELECT
        "eventId" AS event_id,
        COALESCE("createdDate", "receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local,
        COALESCE(
          NULLIF((payload->>'serviceProviderId')::text, ''),
          NULLIF((payload->'payload'->>'serviceProviderId')::text, '')
        ) AS provider_id
      FROM "WebhookEvent"
    )
    SELECT provider_id, COUNT(*) AS event_count
    FROM base
    WHERE ts_local::date = ${targetDate}::date
      AND provider_id IS NOT NULL
    GROUP BY provider_id
    ORDER BY provider_id;
  `;

  if (!providers.length) {
    console.log("No webhook events found for any provider on", targetDate);
    return;
  }

  console.log(`Providers with webhook events on ${targetDate}:`);
  for (const row of providers) {
    const name = row.provider_id ? providerDirectory[row.provider_id] || "(unknown)" : "(unknown)";
    console.log(`- ${name} [${row.provider_id}] : ${row.event_count.toString()} event(s)`);
  }
}

main()
  .catch(err => {
    console.error("Failed to check provider events", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
