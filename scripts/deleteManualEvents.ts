import { prisma } from "../src/lib/prisma";

async function main() {
  const prefix = "manual-";
  const result = await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: prefix } } });
  console.log(`Deleted ${result.count} webhook events with eventId starting with "${prefix}".`);
}

main()
  .catch(err => {
    console.error("Failed to delete manual webhook events", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
