import "dotenv/config";

import path from "path";
import Excel from "exceljs";

type CellValue = Excel.CellValue | undefined;

type XlsxRow = {
  file: string;
  rowNumber: number;
  checkoutDate: Date;
  providerName: string;
  providerId: string;
  transactionId: string;
  itemSold: string;
  amountDue: number;
  tip: number;
  cashTendered: number;
  ccAmount: number;
  gcRedemption: number;
  changeDue: number;
  checkedOutBy: string;
  source: string;
  chargeMethod: string;
  customerName: string;
  appointmentDate: Date | null;
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
    if (typeof candidate.text === "string") return candidate.text.trim();
    if (typeof candidate.result === "string") return candidate.result.trim();
  }
  return String(value).trim();
}

function cellToNumber(value: CellValue): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  const cleaned = cellToString(value).replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLocalDate(value: CellValue): Date | null {
  if (value instanceof Date) return value;
  const str = cellToString(value);
  if (!str) return null;
  const normalized = str.replace(/\s+-\s+/g, " ");
  const withTz = `${normalized} ET`;
  const parsedWithTz = new Date(withTz);
  if (!Number.isNaN(parsedWithTz.getTime())) return parsedWithTz;
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
}

function etDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function timeKeyLocal(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function moneyKey(n: number): string {
  return (Math.round((n || 0) * 100) / 100).toFixed(2);
}

async function readXlsx(filePath: string): Promise<XlsxRow[]> {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`${path.basename(filePath)} has no sheets`);

  const headerRowNumber = 23;
  if (sheet.rowCount < headerRowNumber) {
    throw new Error(`${path.basename(filePath)} has only ${sheet.rowCount} rows; expected header at row 23`);
  }

  const file = path.basename(filePath);
  const suffix = file.replace(/\.xlsx$/i, "");

  const rows: XlsxRow[] = [];

  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);

    const itemSold = cellToString(row.getCell(6).value);

    if (itemSold && itemSold.trim().toLowerCase() === "total") break;
    if (!itemSold) continue;

    const checkoutDate = parseLocalDate(row.getCell(1).value);
    if (!checkoutDate) continue;

    const lowered = itemSold.trim().toLowerCase();
    if (
      lowered === "redeemed" ||
      lowered === "money earned" ||
      lowered.startsWith("cash:") ||
      lowered.startsWith("credit card:") ||
      lowered.startsWith("total:")
    ) {
      continue;
    }

    const transactionId = cellToString(row.getCell(3).value);
    const providerName = cellToString(row.getCell(9).value);

    const appointmentDate = parseLocalDate(row.getCell(4).value);
    const customerName = cellToString(row.getCell(5).value) || `Customer ${rowNumber}`;
    const checkedOutBy = cellToString(row.getCell(2).value) || "manual-upload";
    const source = cellToString(row.getCell(8).value) || "Manual";
    const chargeMethod = cellToString(row.getCell(31).value) || "Manual";

    const amountDue = cellToNumber(row.getCell(12).value);
    const tip = cellToNumber(row.getCell(14).value);

    const cashTendered = Math.max(cellToNumber(row.getCell(17).value), 0);
    const changeDue = Math.max(cellToNumber(row.getCell(32).value), 0);

    const ccAmount = Math.max(cellToNumber(row.getCell(22).value), 0);
    const gcRedemption = Math.max(cellToNumber(row.getCell(19).value), 0);

    rows.push({
      file,
      rowNumber,
      checkoutDate,
      providerName: providerName || "Unknown Tech",
      providerId: "", // not required for ingestion
      transactionId: transactionId || `dec2025-${suffix}-row-${rowNumber}`,
      itemSold,
      amountDue,
      tip,
      cashTendered,
      ccAmount,
      gcRedemption,
      changeDue,
      checkedOutBy,
      source,
      chargeMethod,
      customerName,
      appointmentDate,
    });
  }

  return rows;
}

function buildVagaroWrapper(row: XlsxRow) {
  const suffix = row.file.replace(/\.xlsx$/i, "");
  const eventId = `manual-dec2025-${suffix}-${row.transactionId}-${row.rowNumber}`;
  const transactionId = row.transactionId;

  const cashTender = row.cashTendered;
  const cardTender = row.ccAmount;
  const tenderTotal = cashTender + cardTender;

  const payload = {
    id: transactionId,
    transactionId,
    userPaymentsMstId: transactionId,
    createdDate: row.checkoutDate.toISOString(),
    transactionDate: row.checkoutDate.toISOString(),

    customerName: row.customerName,
    checkedOutBy: row.checkedOutBy,
    source: row.source,

    itemSold: row.itemSold,
    providerName: row.providerName,

    amountDue: row.amountDue,
    tip: row.tip,

    cashAmount: cashTender,
    amountCash: cashTender,
    cash_tender: cashTender,

    creditCardAmount: cardTender,
    amountCard: cardTender,
    card_tender: cardTender,

    gcRedemption: row.gcRedemption,

    changeDue: row.changeDue,
    change_due: row.changeDue,

    tenderAmount: tenderTotal,
    tender_total: tenderTotal,
    totalAmount: tenderTotal,
  };

  return {
    eventId,
    body: {
      id: eventId,
      type: "transaction",
      action: "created",
      createdDate: row.checkoutDate.toISOString(),
      payload: {
        ...payload,
        transactionId,
        userPaymentsMstId: transactionId,
      },
    },
  };
}

type ScriptOptions = {
  filePath: string;
  day: string;
  baseUrl: string;
  authToken: string | null;
  limit: number;
  delayMs: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): ScriptOptions {
  const args = argv.slice(2);
  const getArg = (name: string): string | null => {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    const prefix = `${name}=`;
    const match = args.find((a) => a.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
  };

  const fileArg = getArg("--file") ?? getArg("-f") ?? "src/csv/dec2025/12-13-2025.xlsx";
  const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);

  const day = (getArg("--day") ?? "2025-12-13").trim();

  const baseUrl = (getArg("--base-url") ?? process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const authToken = getArg("--auth") ?? process.env.DASH_TOKEN ?? null;

  const limit = Number(getArg("--limit") ?? "0");
  const delayMs = Number(getArg("--delay-ms") ?? "50");
  const dryRun = args.includes("--dry-run") || args.includes("--dry");

  return { filePath, day, baseUrl, authToken, limit, delayMs, dryRun };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs(process.argv);

  const rows = await readXlsx(opts.filePath);
  const rowsForDay = rows.filter((r) => etDay(r.checkoutDate) === opts.day);

  const totals = rowsForDay.reduce(
    (acc, r) => {
      acc.amountDue += r.amountDue;
      acc.cash += r.cashTendered;
      acc.cc += r.ccAmount;
      acc.gc += r.gcRedemption;
      acc.tip += r.tip;
      return acc;
    },
    { amountDue: 0, cash: 0, cc: 0, gc: 0, tip: 0 }
  );

  console.log("MANUAL WEBHOOK SENDER (Dec 2025)");
  console.log("- Base URL:", opts.baseUrl);
  console.log("- File:", opts.filePath);
  console.log("- Day:", opts.day);
  console.log("- Rows:", rowsForDay.length);
  console.log("- Total amountDue:", moneyKey(totals.amountDue));
  console.log("- Total cash (raw):", moneyKey(totals.cash));
  console.log("- Total cc:", moneyKey(totals.cc));
  console.log("- Total gc redemption:", moneyKey(totals.gc));
  console.log("- Total tip:", moneyKey(totals.tip));
  console.log("- Mode:", opts.dryRun ? "DRY-RUN" : "SEND");
  console.log("");

  const endpoint = `${opts.baseUrl}/webhooks/vagaro`;

  const sendRows = opts.limit > 0 ? rowsForDay.slice(0, opts.limit) : rowsForDay;

  for (let i = 0; i < sendRows.length; i++) {
    const row = sendRows[i];
    const built = buildVagaroWrapper(row);

    const label = `${i + 1}/${sendRows.length} ${opts.day} ${timeKeyLocal(row.checkoutDate)} | ${row.itemSold} | $${moneyKey(row.amountDue)} | cash=$${moneyKey(row.cashTendered)} cc=$${moneyKey(row.ccAmount)}`;

    if (opts.dryRun) {
      console.log("DRY", label, "eventId=", built.eventId);
      continue;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    // IMPORTANT: /webhooks/vagaro is NOT gated by DASH_TOKEN in index.ts,
    // but we can still send x-auth-token safely if you want parity.
    if (opts.authToken) headers["x-auth-token"] = opts.authToken;

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(built.body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST failed (${res.status}) ${label} :: ${text.slice(0, 500)}`);
    }

    const json = (await res.json().catch(() => null)) as any;
    console.log("OK", label, "->", json?.eventId ?? "(no eventId)");

    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Sender failed:", err);
  process.exitCode = 1;
});
