import path from "path";
import Excel from "exceljs";
import { providerDirectory } from "../src/routes/employees";

const TARGET_PROVIDER_NAME = "Isabel Guerrero";
const TARGET_PROVIDER_ID = Object.entries(providerDirectory).find(
  ([, name]) => name.trim().toLowerCase() === TARGET_PROVIDER_NAME.toLowerCase()
)?.[0];

if (!TARGET_PROVIDER_ID) {
  throw new Error("Unable to locate provider ID for Isabel Guerrero");
}

type CellValue = Excel.CellValue | undefined;

type SheetTransaction = {
  rowNumber: number;
  transactionId: string;
  service: string;
  amount: number;
  tip: number;
  checkoutDate: Date | null;
};

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
      service: itemSold,
      amount: cellToNumber(row.getCell(12).value),
      tip: cellToNumber(row.getCell(14).value),
      checkoutDate: parseLocalDate(row.getCell(1).value),
    });
  });

  return transactions;
}

function parseDate(arg: string | undefined, label: string): Date {
  if (!arg) {
    throw new Error(`Missing ${label} date argument (expected YYYY-MM-DD)`);
  }
  const parsed = new Date(`${arg}T00:00:00-05:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label} date: ${arg}`);
  }
  return parsed;
}

(async function main() {
  const [, , startArg, endArg] = process.argv;
  const startDate = parseDate(startArg, "start");
  const endDate = new Date(parseDate(endArg ?? startArg, "end").getTime() + 24 * 60 * 60 * 1000);

  const sheetTransactions = await loadSheetTransactions();
  const targetRows = sheetTransactions.filter(tx => {
    if (!tx.checkoutDate) return false;
    return tx.checkoutDate >= startDate && tx.checkoutDate < endDate;
  });

  targetRows.sort((a, b) => {
    if (!a.checkoutDate || !b.checkoutDate) return 0;
    return a.checkoutDate.getTime() - b.checkoutDate.getTime();
  });

  const localFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  });

  console.log(
    `Found ${targetRows.length} rows for ${TARGET_PROVIDER_NAME} between ${startArg} and ${endArg ?? startArg}`
  );
  for (const tx of targetRows) {
    const tsIso = tx.checkoutDate ? tx.checkoutDate.toISOString() : "(no time)";
    const tsLocal = tx.checkoutDate ? localFormatter.format(tx.checkoutDate) : "(no time)";
    console.log(
      `- row ${tx.rowNumber} | ${tsLocal} (ISO ${tsIso}) | ${tx.service} | amount $${tx.amount.toFixed(2)} | tip $${tx.tip.toFixed(2)} | tx ${tx.transactionId}`
    );
  }
})().catch(err => {
  console.error("Failed to list sheet range", err);
  process.exit(1);
});
