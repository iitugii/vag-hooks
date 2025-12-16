import "dotenv/config";

import path from "path";
import Excel from "exceljs";
import { Prisma } from "@prisma/client";

import { prisma } from "../src/lib/prisma";
import { providerDirectory } from "../src/routes/employees";

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

type MissingCandidate = {
  eventId: string;
  checkoutDate: Date;
  payloadBody: Prisma.JsonObject;
  sourceRow: XlsxRow;
};

type ExistingTxRow = {
  transactionId: string | null;
};

type ExistingMatchRow = {
  itemSold: string | null;
  transactionDate: string | null;
  amountDue: string | null;
  tip: string | null;
  customerName: string | null;
  providerName: string | null;
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function normalizeServiceName(value: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "");
}

function normalizePersonName(value: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z\s]/g, "");
}

function moneyKey(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function timeKeyLocal(date: Date): string {
  // NOTE: don't use the system locale/timezone; normalize to America/New_York.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find(p => p.type === "hour")?.value ?? "00";
  const minute = parts.find(p => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function buildMatchKey(
  day: string,
  checkoutDate: Date,
  itemSold: string,
  amountDue: number,
  tip: number,
  customerName: string,
  providerName?: string
): string {
  return [
    day,
    timeKeyLocal(checkoutDate),
    normalizeServiceName(itemSold),
    moneyKey(amountDue),
    moneyKey(tip),
    normalizePersonName(customerName),
    normalizePersonName(providerName || ""),
  ].join("|");
}

function buildMatchKeyFallback(
  day: string,
  checkoutDate: Date,
  itemSold: string,
  amountDue: number,
  tip: number
): string {
  return [
    day,
    timeKeyLocal(checkoutDate),
    normalizeServiceName(itemSold),
    moneyKey(amountDue),
    moneyKey(tip),
  ].join("|");
}

function candidateMatchKey(row: XlsxRow): string {
  const day = etDay(row.checkoutDate);
  return buildMatchKey(
    day,
    row.checkoutDate,
    row.itemSold,
    row.amountDue,
    row.tip,
    row.customerName,
    row.providerName
  );
}

function candidateMatchKeyFallback(row: XlsxRow): string {
  const day = etDay(row.checkoutDate);
  return buildMatchKeyFallback(day, row.checkoutDate, row.itemSold, row.amountDue, row.tip);
}

function candidateMatchKeyUltraFallback(row: XlsxRow): string {
  const day = etDay(row.checkoutDate);
  return `${day}|${timeKeyLocal(row.checkoutDate)}|${normalizeServiceName(row.itemSold)}`;
}

function etDay(date: Date): string {
  // Stable ET day key independent of server timezone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error("Failed to compute ET day key");
  return `${y}-${m}-${d}`;
}

function utcRangeForEtDay(day: string): { start: Date; end: Date } {
  // Builds the UTC instants that correspond to [00:00, 24:00) in America/New_York.
  // Works without external deps by deriving the NY offset at local midnight.
  const [yStr, mStr, dStr] = day.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid day '${day}', expected YYYY-MM-DD`);
  }

  const guessStartUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offsetMinutesAtMidnight = (() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(guessStartUtc);
    const hh = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    // When it's 00:00 UTC, NY is typically 19:00 or 20:00 previous day,
    // so (hh:mm) represents the (negative) offset from UTC.
    // Convert that to minutes west of UTC.
    return hh * 60 + mm;
  })();

  // If NY local time at 00:00Z is 19:00, offsetMinutesAtMidnight=1140 which means UTC-5.
  // Derive offset as -(24h - localMinutes) when localMinutes > 12h.
  const offsetMinutes = offsetMinutesAtMidnight > 12 * 60 ? offsetMinutesAtMidnight - 24 * 60 : offsetMinutesAtMidnight;
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000);

  // End is start + 24h in ET, but DST boundaries can make ET "day" 23/25h.
  // Compute end by taking next ET day midnight and deriving its UTC.
  const next = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  const offsetMinutesNext = (() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(next);
    const hh = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    const localMinutes = hh * 60 + mm;
    return localMinutes > 12 * 60 ? localMinutes - 24 * 60 : localMinutes;
  })();
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - offsetMinutesNext * 60_000);

  return { start, end };
}

function toCustomerId(name: string, rowNumber: number, suffix: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `dec2025-${suffix}-customer-${slug || rowNumber}`;
}

function toAppointmentId(value: CellValue, rowNumber: number, suffix: string): string {
  const raw = cellToString(value);
  if (!raw) return `dec2025-${suffix}-appt-${rowNumber}`;
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `dec2025-${suffix}-appt-${slug || rowNumber}`;
}

function resolveProviderIdByName(providerName: string): string | null {
  const normalize = (value: string) =>
    (value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z\s]/g, "");

  const fingerprint = (value: string) => {
    const n = normalize(value).replace(/\s/g, "");
    // Quick alias for the common Betancourt/Betandcourt misspelling.
    if (n === "marybetancourt") return "marybetandcourt";
    return n;
  };

  const desired = fingerprint(providerName);

  const entries = Object.entries(providerDirectory);

  const exact = entries.find(([, name]) => fingerprint(name || "") === desired);
  if (exact) return exact[0];

  // Fallback: if the XLSX includes a middle name or extra tokens, try substring match.
  const desiredLoose = normalize(providerName);
  const loose = entries.find(([, name]) => {
    const candidate = normalize(name || "");
    if (!candidate) return false;
    return desiredLoose.includes(candidate) || candidate.includes(desiredLoose);
  });
  if (loose) return loose[0];

  return null;
}

async function readXlsx(filePath: string): Promise<XlsxRow[]> {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`${path.basename(filePath)} has no sheets`);

  const debugXlsx = process.argv.includes("--debug-xlsx");

  const rows: XlsxRow[] = [];
  const file = path.basename(filePath);
  const suffix = file.replace(/\.xlsx$/i, "");

  // All provided exports have the header in exactly row 23.
  // Data begins at row 24.
  const headerRowNumber = 23;
  if (sheet.rowCount < headerRowNumber) {
    throw new Error(
      `${path.basename(filePath)} has only ${sheet.rowCount} rows; expected header at row 23`
    );
  }

  const debug = {
    file,
    sheetRowCount: sheet.rowCount,
    headerRowNumber,
    startedAtRow: headerRowNumber + 1,
    examined: 0,
    pushed: 0,
    stoppedAtRow: 0,
    skippedBlankItemSold: 0,
    skippedNoCheckoutDate: 0,
    skippedSummaryLabel: 0,
    sample: [] as Array<{ rowNumber: number; itemSold: string; checkoutRaw: string; tip: number }>,
    watched: [] as Array<{
      rowNumber: number;
      itemSold: string;
      checkout: string;
      tip: number;
      amountDue: number;
      cash: number;
      cc: number;
      decision: string;
    }>,
  };

  const watchRows = new Set([203, 204, 205, 206, 207, 208, 209]);

  // IMPORTANT: this report has data rows past `actualRowCount` (Excel totals row etc),
  // so we iterate up to `rowCount` and stop when we hit the totals row.
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);

    debug.examined++;

    const itemSold = cellToString(row.getCell(6).value);
    const transactionId = cellToString(row.getCell(3).value);
    const providerName = cellToString(row.getCell(9).value);

    const checkoutRaw = cellToString(row.getCell(1).value);

    const watch = debugXlsx && watchRows.has(rowNumber);
    const recordWatch = (decision: string, checkoutDate: Date | null = null) => {
      if (!watch) return;
      debug.watched.push({
        rowNumber,
        itemSold,
        checkout: checkoutDate ? checkoutDate.toISOString() : checkoutRaw,
        tip: cellToNumber(row.getCell(14).value),
        amountDue: cellToNumber(row.getCell(12).value),
        cash: cellToNumber(row.getCell(17).value),
        cc: cellToNumber(row.getCell(22).value),
        decision,
      });
    };

    // Totals row ends the transaction list. Do not count it.
    if (itemSold && itemSold.trim().toLowerCase() === "total") {
      debug.stoppedAtRow = rowNumber;
      recordWatch("STOP:TOTAL");
      break;
    }

    // Skip blank/separator rows inside the table.
    if (!itemSold) {
      debug.skippedBlankItemSold++;
      recordWatch("SKIP:BLANK_ITEM_SOLD");
      continue;
    }

    // Ignore non-service report sections that can appear before/inside the table.
    // The transaction list rows always have a parsed checkout date in col 1.
    const checkoutDate = parseLocalDate(row.getCell(1).value);
    if (!checkoutDate) {
      debug.skippedNoCheckoutDate++;
      recordWatch("SKIP:NO_CHECKOUT_DATE");
      continue;
    }

    // Also ignore lines like "Cash:$390.04" / "Total:$8,461.19" that aren't services.
    const lowered = itemSold.trim().toLowerCase();
    if (
      lowered === "redeemed" ||
      lowered === "money earned" ||
      lowered.startsWith("cash:") ||
      lowered.startsWith("credit card:") ||
      lowered.startsWith("total:")
    ) {
      debug.skippedSummaryLabel++;
      recordWatch("SKIP:SUMMARY_LABEL", checkoutDate);
      continue;
    }

    const appointmentDate = parseLocalDate(row.getCell(4).value);
    const customerName = cellToString(row.getCell(5).value) || `Customer ${rowNumber}`;
    const checkedOutBy = cellToString(row.getCell(2).value) || "manual-upload";
    const source = cellToString(row.getCell(8).value) || "Manual";
    const chargeMethod = cellToString(row.getCell(31).value) || "Manual";

    const amountDue = cellToNumber(row.getCell(12).value);
    const tip = cellToNumber(row.getCell(14).value);
    const cashRaw = cellToNumber(row.getCell(17).value);
    const changeDue = cellToNumber(row.getCell(32).value);
    const cashTendered = Math.max(cashRaw, 0);

    const ccAmount = cellToNumber(row.getCell(22).value);
    const gcRedemption = cellToNumber(row.getCell(19).value);

    const providerId = resolveProviderIdByName(providerName) || "";
    const resolvedProviderName = providerId ? providerName : "Unknown Tech";

    rows.push({
      file,
      rowNumber,
      checkoutDate,
      providerName: resolvedProviderName,
      providerId,
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

    debug.pushed++;
    if (debugXlsx && debug.sample.length < 10) {
      debug.sample.push({
        rowNumber,
        itemSold,
        checkoutRaw,
        tip: cellToNumber(row.getCell(14).value),
      });
    }

    recordWatch("PUSH", checkoutDate);
  }

  if (debugXlsx) {
    console.log("XLSX DEBUG", {
      file: debug.file,
      sheetRowCount: debug.sheetRowCount,
      headerRowNumber: debug.headerRowNumber,
      startedAtRow: debug.startedAtRow,
      examined: debug.examined,
      pushed: debug.pushed,
      stoppedAtRow: debug.stoppedAtRow || null,
      skippedBlankItemSold: debug.skippedBlankItemSold,
      skippedNoCheckoutDate: debug.skippedNoCheckoutDate,
      skippedSummaryLabel: debug.skippedSummaryLabel,
    });
    console.log("XLSX DEBUG sample rows", debug.sample);
    console.log("XLSX DEBUG watched rows 203-209", debug.watched);
    console.log("");
  }

  return rows;
}

async function countExistingForDay(day: string) {
  const { start, end } = utcRangeForEtDay(day);

  // Existing events in our DB for that day.
  const count = await prisma.webhookEvent.count({
    where: {
      day: {
        gte: start,
        lt: end,
      },
    },
  });

  // Any manually backfilled in this run namespace.
  const manualCount = await prisma.webhookEvent.count({
    where: {
      day: { gte: start, lt: end },
      eventId: { startsWith: "manual-dec2025-" },
    },
  });

  return { count, manualCount };
}

async function getExistingTransactionIdsForDay(day: string): Promise<Set<string>> {
  const { start, end } = utcRangeForEtDay(day);

  const rows = await prisma.$queryRaw<ExistingTxRow[]>`
    SELECT
      COALESCE(
        payload->>'transactionId',
        payload->'payload'->>'transactionId',
        payload->>'userPaymentsMstId',
        payload->'payload'->>'userPaymentsMstId'
      ) AS "transactionId"
    FROM "WebhookEvent"
    WHERE day >= ${start} AND day < ${end};
  `;

  const ids = new Set<string>();
  for (const r of rows) {
    const tx = (r.transactionId || "").trim();
    if (tx) ids.add(tx);
  }
  return ids;
}

async function getExistingMatchKeysForDay(day: string): Promise<Set<string>> {
  const { start, end } = utcRangeForEtDay(day);

  const rows = await prisma.$queryRaw<ExistingMatchRow[]>`
    SELECT
      COALESCE(
        payload->'payload'->>'itemSold',
        payload->>'itemSold'
      ) AS "itemSold",
      COALESCE(
        payload->'payload'->>'transactionDate',
        payload->>'transactionDate',
        payload->>'createdDate'
      ) AS "transactionDate",
      COALESCE(
        payload->'payload'->>'amountDue',
        payload->>'amountDue'
      ) AS "amountDue",
      COALESCE(
        payload->'payload'->>'tip',
        payload->>'tip'
      ) AS "tip",
      COALESCE(
        payload->'payload'->>'customerName',
        payload->>'customerName'
      ) AS "customerName",
      COALESCE(
        payload->'payload'->>'serviceProviderName',
        payload->>'serviceProviderName'
      ) AS "providerName"
    FROM "WebhookEvent"
    WHERE day >= ${start} AND day < ${end};
  `;

  const keys = new Set<string>();
  for (const r of rows) {
    const itemSold = (r.itemSold || "").trim();
    const dateStr = (r.transactionDate || "").trim();
    if (!itemSold || !dateStr) continue;

    const amountDueRaw = (r.amountDue || "").toString();
    const tipRaw = (r.tip || "").toString();

    const amountDue = Number(amountDueRaw.replace(/[^0-9.-]/g, "")) || 0;
    const tip = Number(tipRaw.replace(/[^0-9.-]/g, "")) || 0;

    const customerName = (r.customerName || "").trim();
    const providerName = (r.providerName || "").trim();

    const parsed = new Date(dateStr);
    if (Number.isNaN(parsed.getTime())) continue;

    // IMPORTANT: compute day key from the parsed timestamp in ET,
    // not from the query's day parameter (prevents midnight boundary mismatches).
    const parsedDayEt = etDay(parsed);

    // Only build keys for the ET day we are querying.
    if (parsedDayEt !== day) continue;

    // Strict key (includes customer/provider when present).
    if (customerName || providerName) {
      keys.add(buildMatchKey(parsedDayEt, parsed, itemSold, amountDue, tip, customerName, providerName));
    }
    // Fallback key (ignores customer/provider).
    keys.add(buildMatchKeyFallback(parsedDayEt, parsed, itemSold, amountDue, tip));

    // Ultra fallback: some webhook payloads may omit amountDue/tip or store them differently.
    // Still allow matching on day+time+service to avoid endless "missing".
    if (moneyKey(amountDue) === "0.00" || moneyKey(tip) === "0.00") {
      keys.add(`${parsedDayEt}|${timeKeyLocal(parsed)}|${normalizeServiceName(itemSold)}`);
    }
  }

  return keys;
}

function buildCandidate(row: XlsxRow): MissingCandidate {
  const suffix = row.file.replace(/\.xlsx$/i, "");
  const eventId = `manual-dec2025-${suffix}-${row.transactionId}-${row.rowNumber}`;

  // IMPORTANT for `src/routes/cashout.ts`:
  // - It treats `amountDue` as *change due back to the customer* (subtracts from cash_tender/tender_total).
  // - It prefers `amountCash`/`cashAmount` as the *cash tendered* amount.
  // - It derives sold total from `totalAmount`/`tenderAmount`/arrays, else cash+card.
  const cashTender = row.cashTendered;
  const cardTender = row.ccAmount;
  const soldTotal = cashTender + cardTender;
  const changeDue = row.changeDue;

  const payloadBody: Prisma.JsonObject = {
    tax: "0",
    tip: row.tip,
    ccMode: "N",
    ccType: row.chargeMethod || "Manual",
    points: 0,
    ccAmount: row.ccAmount,
    cardAmount: row.ccAmount,
    discount: 0,
    itemSold: row.itemSold,
    quantity: 1,
    achAmount: 0,
    // `amountDue` is used as CHANGE DUE in the cashout calendar query.
    amountDue: changeDue,
    changeDue: changeDue,
    brandName: null,
    createdBy: row.checkedOutBy,
    businessId: "manual-dec2025",
    // Provide both `cashAmount` and `amountCash` aliases.
    cashAmount: cashTender,
    amountCash: cashTender,
    customerId: toCustomerId(row.customerName, row.rowNumber, suffix),
    checkAmount: 0,
    otherAmount: 0,
    gcRedemption: row.gcRedemption,
    purchaseType: "Service",
    appointmentId: toAppointmentId(row.appointmentDate ?? row.checkoutDate, row.rowNumber, suffix),
    businessAlias: "",
    transactionId: row.transactionId,
    userPaymentId: `dec2025-${suffix}-payment-${row.rowNumber}`,
    businessGroupId: "manual-dec2025",
    productDiscount: 0,
    serviceCategory: "ManualDec2025",
    // Help the cashout query derive sold_total.
    tenderAmount: soldTotal,
    totalAmount: soldTotal,
    transactionDate: row.checkoutDate.toISOString(),
    memberShipAmount: 0,
    bankAccountAmount: 0,
    packageRedemption: 0,
    serviceProviderId: row.providerId,
    userPaymentsMstId: `dec2025-${suffix}-mst-${row.rowNumber}`,
    vagaroPayLaterAmount: 0,
  };

  return { eventId, checkoutDate: row.checkoutDate, payloadBody, sourceRow: row };
}

function parseArgs(argv: string[]) {
  const args = new Set(argv);

  const getArg = (name: string): string | null => {
    const idx = argv.indexOf(name);
    if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
    const prefix = `${name}=`;
    const inline = argv.find(a => a.startsWith(prefix));
    return inline ? inline.slice(prefix.length) : null;
  };

  const day = getArg("--day");
  const dir = getArg("--dir") ?? "src/csv/dec2025";
  const file = getArg("--file") ?? getArg("-f");
  const dryRun = args.has("--dry-run") || args.has("--dryrun") || args.has("--dry");
  const apply = args.has("--apply") && !dryRun;

  return {
    apply,
    verbose: args.has("--verbose"),
    debugXlsx: args.has("--debug-xlsx"),
    purgeManual: args.has("--purge-manual"),
    day,
    dir,
    file,
    dryRun,
  };
}

async function main() {
  const { apply, verbose, dir, day: onlyDay, purgeManual, file } = parseArgs(process.argv.slice(2));

  const absoluteDir = path.resolve(__dirname, "..", dir);
  const defaultFiles = ["12-12-2025.xlsx", "12-13-2025.xlsx", "12-14-2025.xlsx"];
  const files = ((): string[] => {
    if (file) {
      const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
      return [resolved];
    }
    if (!onlyDay) return defaultFiles.map(f => path.join(absoluteDir, f));

    const desired = onlyDay.trim();
    const mapping: Record<string, string> = {
      "2025-12-12": "12-12-2025.xlsx",
      "2025-12-13": "12-13-2025.xlsx",
      "2025-12-14": "12-14-2025.xlsx",
    };

    const mappedFile = mapping[desired];
    if (!mappedFile) {
      throw new Error(
        `Unsupported --day '${desired}'. Supported: ${Object.keys(mapping).join(", ")}`
      );
    }

    return [path.join(absoluteDir, mappedFile)];
  })();

  const allRows: XlsxRow[] = [];
  for (const filePath of files) {
    const rows = await readXlsx(filePath);
    allRows.push(...rows);
  }

  // XLSX-only summary (useful for reconciling UI totals).
  if (onlyDay) {
    const d = onlyDay.trim();
    const rowsForDay = allRows.filter(r => etDay(r.checkoutDate) === d);
    const uniqueClients = new Set(
      rowsForDay.map(r => (r.customerName || "").trim().toLowerCase()).filter(Boolean)
    );

    const totals = rowsForDay.reduce(
      (acc, r) => {
        acc.amountDue += r.amountDue || 0;
        acc.cash += r.cashTendered || 0;
        acc.cc += r.ccAmount || 0;
        acc.gc += r.gcRedemption || 0;
        acc.tip += r.tip || 0;
        return acc;
      },
      { amountDue: 0, cash: 0, cc: 0, gc: 0, tip: 0 }
    );

    console.log("XLSX ONLY SUMMARY");
    console.log(`- Day: ${d}`);
    console.log(`- Clients (unique): ${uniqueClients.size}`);
    console.log(`- Services (rows): ${rowsForDay.length}`);
    console.log(`- Total amountDue: ${totals.amountDue}`);
    console.log(`- Total cash (net): ${totals.cash}`);
    console.log(`- Total cc: ${totals.cc}`);
    console.log(`- Total gc redemption: ${totals.gc}`);
    console.log(`- Total tip: ${totals.tip}`);
    console.log("");
  }

  const rowsByDay = new Map<string, XlsxRow[]>();
  for (const row of allRows) {
    const day = etDay(row.checkoutDate);
    if (onlyDay && day !== onlyDay.trim()) continue;
    const current = rowsByDay.get(day) || [];
    current.push(row);
    rowsByDay.set(day, current);
  }

  const dayKeys = (onlyDay ? [onlyDay.trim()] : Array.from(rowsByDay.keys()).sort()).filter(
    d => rowsByDay.has(d)
  );

  if (purgeManual) {
    if (!onlyDay) {
      throw new Error("--purge-manual requires --day YYYY-MM-DD");
    }
    const d = onlyDay.trim();
    const { start, end } = utcRangeForEtDay(d);
    const result = await prisma.webhookEvent.deleteMany({
      where: {
        day: { gte: start, lt: end },
        eventId: { startsWith: "manual-dec2025-" },
      },
    });
    console.log(`Purged ${result.count} manual-dec2025 events for ${d}.`);
  }
  const missing: MissingCandidate[] = [];

  // Used as a final safety check during APPLY to prevent duplicates.
  // This is the same matching logic used to compute `missing`.
  const existingKeysByDay = new Map<string, Set<string>>();

  for (const day of dayKeys) {
    const fromXlsx = rowsByDay.get(day) || [];
    const existingKeys = await getExistingMatchKeysForDay(day);
    existingKeysByDay.set(day, existingKeys);

    for (const r of fromXlsx) {
      const strictKey = candidateMatchKey(r);
      const fallbackKey = candidateMatchKeyFallback(r);
      const ultraKey = candidateMatchKeyUltraFallback(r);
      if (!existingKeys.has(strictKey) && !existingKeys.has(fallbackKey) && !existingKeys.has(ultraKey)) {
        missing.push(buildCandidate(r));
      }
    }
  }

  console.log("Backfill Dec 2025");
  console.log("- Directory:", dir);
  if (onlyDay) console.log("- Day:", onlyDay);
  if (file) console.log("- File:", file);
  console.log("- Mode:", apply ? "APPLY" : "DRY-RUN");
  console.log("- Verbose:", verbose ? "yes" : "no");
  console.log("");

  for (const day of dayKeys) {
    const fromXlsx = rowsByDay.get(day) || [];
    const { count: existingCount, manualCount } = await countExistingForDay(day);
    const missingForDay = missing.filter(m => etDay(m.checkoutDate) === day);

    console.log(`${day}:`);
    console.log(`  - XLSX rows: ${fromXlsx.length}`);
    console.log(`  - DB events (day): ${existingCount} (manual-dec2025: ${manualCount})`);
    console.log(`  - Missing (by date+time+service): ${missingForDay.length}`);
  }

  console.log("");
  const totalRowsConsidered = dayKeys.reduce((sum, d) => sum + (rowsByDay.get(d)?.length || 0), 0);
  console.log(`Total XLSX rows: ${totalRowsConsidered}`);
  console.log(`Total missing events to insert: ${missing.length}`);

  if (verbose && missing.length) {
    console.log("\nSample missing rows (first 10):");
    for (const m of missing.slice(0, 10)) {
      const r = m.sourceRow;
      console.log(
        `- ${etDay(r.checkoutDate)} ${timeKeyLocal(r.checkoutDate)} | ${r.itemSold} | due=${moneyKey(r.amountDue)} tip=${moneyKey(r.tip)} | customer=${r.customerName} | provider=${r.providerName}`
      );
    }
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to insert.");
    return;
  }

  let inserted = 0;
  for (const candidate of missing) {
    const key = candidateMatchKey(candidate.sourceRow);
    const day = etDay(candidate.checkoutDate);
    const existingForDay = existingKeysByDay.get(day);
    if (existingForDay && existingForDay.has(key)) {
      if (verbose) {
        console.log("\nSKIP (already exists by date+time+service)", candidate.eventId);
      }
      continue;
    }

    const payload: Prisma.JsonObject = {
      id: candidate.eventId,
      type: "transaction",
      action: "created",
      payload: candidate.payloadBody,
      createdDate: candidate.checkoutDate.toISOString(),
    };

    if (verbose) {
      const r = candidate.sourceRow;
      console.log("\nINSERT", candidate.eventId);
      console.log("  file:", r.file, "row:", r.rowNumber, "day:", etDay(candidate.checkoutDate));
      console.log("  provider:", r.providerName, "(", r.providerId, ")");
      console.log("  tx:", r.transactionId, "item:", r.itemSold);
      console.log(
        "  amounts: due=",
        r.amountDue,
        "tip=",
        r.tip,
        "cashRaw=",
        r.cashTendered,
        "cc=",
        r.ccAmount,
        "gc=",
        r.gcRedemption
      );
      console.log("  payload:", JSON.stringify(payload));
    }

    try {
      await prisma.webhookEvent.create({
        data: {
          eventId: candidate.eventId,
          entityType: "transaction",
          action: "created",
          businessIds: ["manual-dec2025"],
          createdDate: candidate.checkoutDate,
          receivedAt: new Date(),
          rawBody: JSON.stringify(payload),
          headers: { "x-manual-upload": candidate.sourceRow.file } as Prisma.JsonObject,
          payload,
          sourceIp: "manual-dec2025",
          userAgent: "excel-dec2025-backfill",
          // Store day as ET-day midnight (UTC range filtering is ET-aware in queries).
          day: utcRangeForEtDay(etDay(candidate.checkoutDate)).start,
        },
      });
    } catch (err: any) {
      // If a prior run already inserted this exact eventId, skip it.
      if (err?.code === "P2002") {
        if (verbose) console.log("SKIP (eventId already exists)", candidate.eventId);
        continue;
      }
      throw err;
    }

    // Keep the in-memory set updated so repeated keys within the XLSX
    // don't double-insert in the same apply run.
    if (existingForDay) existingForDay.add(key);
    else existingKeysByDay.set(day, new Set([key]));

    inserted += 1;
  }

  console.log(`\nInserted ${inserted} webhook events.`);
}

main()
  .catch(err => {
    console.error("Backfill failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
