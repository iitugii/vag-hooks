import path from "path";
import Excel from "exceljs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { providerDirectory } from "../src/routes/employees";

type SheetTransaction = {
  rowNumber: number;
  transactionId: string;
  providerName: string;
  itemSold: string;
  amount: number;
  tip: number;
  checkoutDate: Date | null;
};

type DbMatch = {
  event_id: string;
  transaction_id: string | null;
  provider_id: string | null;
};

const TARGET_PROVIDER_NAME = "Isabel Guerrero";
const TARGET_PROVIDER_ID = Object.entries(providerDirectory).find(
  ([, name]) => name.trim().toLowerCase() === TARGET_PROVIDER_NAME.toLowerCase()
)?.[0];

if (!TARGET_PROVIDER_ID) {
  throw new Error("Unable to locate provider ID for Isabel Guerrero in provider directory");
}

type CellValue = Excel.CellValue | undefined;

function cellToString(value: CellValue): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const candidate: any = value;
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((part: { text: string }) => part.text).join("").trim();
    }
    if (typeof candidate.text === "string") {
      return candidate.text.trim();
    }
    if (typeof candidate.result === "string") {
      return candidate.result.trim();
    }
  }
  return String(value).trim();
}

function cellToNumber(value: CellValue): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  const numeric = Number(cellToString(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseLocalDate(value: CellValue): Date | null {
  if (value instanceof Date) return value;
  const str = cellToString(value);
  if (!str) return null;
  const normalized = str.replace(/\s+-\s+/g, " ");
  const attempt = new Date(`${normalized} ET`);
  if (!Number.isNaN(attempt.getTime())) return attempt;
  const fallback = new Date(normalized);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return null;
}

async function loadSheetTransactions(): Promise<SheetTransaction[]> {
  const filePath = path.resolve(__dirname, "../src/csv/compare.xlsx");
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("compare.xlsx is empty");
  }

  const transactions: SheetTransaction[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;
    const providerName = cellToString(row.getCell(9).value);
    const itemSold = cellToString(row.getCell(6).value);
    const transactionId = cellToString(row.getCell(3).value);

    if (!providerName || !transactionId || !itemSold) return;
    if (itemSold.trim().toLowerCase() === "total") return;
    if (providerName.trim().toLowerCase() !== TARGET_PROVIDER_NAME.toLowerCase()) return;

    transactions.push({
      rowNumber,
      transactionId,
      providerName,
      itemSold,
      amount: cellToNumber(row.getCell(12).value),
      tip: cellToNumber(row.getCell(14).value),
      checkoutDate: parseLocalDate(row.getCell(1).value),
    });
  });

  return transactions;
}

async function fetchWebhookMatches(transactionIds: string[]): Promise<DbMatch[]> {
  if (!transactionIds.length) return [];
  return prisma.$queryRaw<DbMatch[]>`
    SELECT "eventId" AS event_id,
           payload->'payload'->>'transactionId' AS transaction_id,
           payload->'payload'->>'serviceProviderId' AS provider_id
    FROM "WebhookEvent"
    WHERE payload->'payload'->>'transactionId' IN (${Prisma.join(transactionIds)});
  `;
}

async function main() {
  const sheetTransactions = await loadSheetTransactions();
  const uniqueIds = Array.from(new Set(sheetTransactions.map(tx => tx.transactionId)));

  const dbMatches = await fetchWebhookMatches(uniqueIds);
  const matchMap = new Map<string, DbMatch[]>();
  for (const match of dbMatches) {
    const key = match.transaction_id || "";
    if (!key) continue;
    const list = matchMap.get(key) ?? [];
    list.push(match);
    matchMap.set(key, list);
  }

  const missing: SheetTransaction[] = [];
  const mismatched: { transaction: SheetTransaction; providers: (string | null)[] }[] = [];

  for (const tx of sheetTransactions) {
    const matches = matchMap.get(tx.transactionId);
    if (!matches || matches.length === 0) {
      missing.push(tx);
      continue;
    }

    const hasTargetProvider = matches.some(m => (m.provider_id || "") === TARGET_PROVIDER_ID);
    if (!hasTargetProvider) {
      mismatched.push({ transaction: tx, providers: matches.map(m => m.provider_id) });
    }
  }

  console.log("Sheet rows:", sheetTransactions.length);
  console.log("Distinct transaction IDs:", uniqueIds.length);
  console.log("Webhook matches found:", dbMatches.length);

  if (missing.length) {
    const groupedMissing = new Map<
      string,
      { rows: number[]; services: string[]; total: number; tips: number }
    >();
    for (const tx of missing) {
      const bucket =
        groupedMissing.get(tx.transactionId) ||
        { rows: [], services: [], total: 0, tips: 0 };
      bucket.rows.push(tx.rowNumber);
      bucket.services.push(tx.itemSold);
      bucket.total += tx.amount;
      bucket.tips += tx.tip;
      groupedMissing.set(tx.transactionId, bucket);
    }

    console.log("\nTransactions missing from webhook events:");
    for (const [transactionId, data] of groupedMissing) {
      console.log(
        `- ${transactionId} (rows ${data.rows.join(", ")}) | services: ${data.services.join(", " )} | gross $${data.total.toFixed(2)} | tip $${data.tips.toFixed(2)}`
      );
    }
  } else {
    console.log("\nNo missing transactions; every sheet entry has at least one webhook event.");
  }

  if (mismatched.length) {
    console.log("\nTransactions present but not assigned to Isabel in webhook events:");
    for (const entry of mismatched) {
      const providerList = entry.providers.map(p => p || "(null)").join(", ");
      console.log(`- ${entry.transaction.transactionId} => providers [${providerList}]`);
    }
  } else {
    console.log("\nNo transactions were assigned to other providers; all matches reference Isabel's ID.");
  }
}

main()
  .catch(err => {
    console.error("Failed to compare webhook events", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
