import { prisma } from "../src/lib/prisma";

async function main() {
  const [, , eventId] = process.argv;
  if (!eventId) {
    console.error("Usage: tsx scripts/showWebhookEvent.ts <eventId>");
    process.exit(1);
  }

  const row = await prisma.webhookEvent.findUnique({
    where: { eventId },
  });

  if (!row) {
    console.error("No webhook event found for", eventId);
    process.exit(1);
  }

  console.log("eventId:", row.eventId);
  console.log("createdDate:", row.createdDate);
  console.log("payload keys:", Object.keys(row.payload || {}));
  console.dir(row.payload, { depth: null, colors: false });
}

main()
  .catch(err => {
    console.error("Failed to show webhook event", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
