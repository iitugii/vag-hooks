import { prisma } from "../src/lib/prisma";

function parseDate(dateStr: string, label: string): Date {
  if (!dateStr) {
    throw new Error(`Missing ${label} date argument (expected YYYY-MM-DD)`);
  }
  const parsed = new Date(`${dateStr}T00:00:00-05:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label} date: ${dateStr}`);
  }
  return parsed;
}

async function main() {
  const [, , providerId, startArg, endArg] = process.argv;
  if (!providerId || !startArg) {
    console.error(
      "Usage: tsx scripts/deleteProviderRange.ts <providerId> <start YYYY-MM-DD> [end YYYY-MM-DD]"
    );
    process.exit(1);
  }

  const startDate = parseDate(startArg, "start");
  const endDate = endArg ? parseDate(endArg, "end") : new Date(startDate);

  const startDateStr = startArg;
  const endDateStr = endArg ?? startArg;

  const rows = await prisma.$queryRaw<{ event_id: string }[]>`
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
    SELECT event_id
    FROM base
    WHERE provider_id = ${providerId}
      AND ts_local::date BETWEEN ${startDateStr}::date AND ${endDateStr}::date;
  `;

  if (!rows.length) {
    console.log(
      `No webhook events found for provider ${providerId} between ${startArg} and ${endArg ?? startArg}.`
    );
    return;
  }

  const ids = rows.map(row => row.event_id);
  const deleted = await prisma.webhookEvent.deleteMany({ where: { eventId: { in: ids } } });
  console.log(
    `Deleted ${deleted.count} webhook events for provider ${providerId} between ${startArg} and ${endArg ?? startArg}.`
  );
}

main()
  .catch(err => {
    console.error("Failed to delete provider range", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
