import { prisma } from "../src/lib/prisma";

async function main() {
  const row = await prisma.webhookEvent.findFirst({ orderBy: { createdDate: "desc" } });
  console.log(JSON.stringify(row, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
