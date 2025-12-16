import fs from "fs";
import path from "path";
import prompts from "prompts";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import "dotenv/config";

import { prisma } from "../src/lib/prisma";

type CsvRow = Record<string, string | undefined>;

type DayPlan = {
  day: string; // YYYY-MM-DD (America/New_York)
  csvRows: CsvRow[];
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function toIsoDateEt(d: Date): string {
  // Create YYYY-MM-DD in America/New_York without external deps
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !day) throw new Error("Failed to format ET date");
  return `${y}-${m}-${day}`;
}

function parseMoney(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value
    .toString()
    .replace(/[$,\s]/g, "")
    .replace(/^\((.*)\)$/, "-$1"); // (1.23) => -1.23
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function get(row: CsvRow, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

function guessCreatedDate(row: CsvRow): Date {
  // Try common columns; fall back to now
  const dateStr = get(
    row,
    "date",
    "appointment date",
    "transaction date",
    "sale date",
    "created date",
    "createddate",
    "timestamp",
    "datetime",
    "time"
  );

  if (!dateStr) return new Date();

  // Let JS parse; if your CSV is MM/DD/YYYY etc this usually works.
  const d = new Date(dateStr);
  if (!Number.isNaN(d.getTime())) return d;

  // Try splitting MM/DD/YYYY
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yyyy = Number(m[3]);
    const hh = Number(m[4] || 12);
    const min = Number(m[5] || 0);
    const ss = Number(m[6] || 0);
    return new Date(Date.UTC(yyyy, mm - 1, dd, hh, min, ss));
  }

  return new Date();
}

function printDbHelp() {
  console.log("\nDB connection help:");
  console.log("- This script uses Prisma and requires a valid DATABASE_URL.");
  console.log("- If your Railway DB password rotated, update `.env` or Railway env vars.");
  console.log("- Railway CLI option: `railway login` then `railway link` then `railway variables pull`.");
}

function buildVagaroManualWebhook(row: CsvRow, createdDate: Date, eventId: string) {
  // Minimal canonical wrapper we’ve been using:
  // { id, type: 'transaction', action: 'created', payload: {...}, createdDate }

  const cashAmount = parseMoney(get(row, "cash", "cash amount", "amountcash", "cashamount"));
  const ccAmount = parseMoney(get(row, "credit", "credit card", "cc", "cc amount", "ccamount", "card"));
  const totalAmount = parseMoney(get(row, "total", "total amount", "amount", "amounttotal", "totalamount"));
  const changeDue = parseMoney(get(row, "change", "change due", "changedue"));

  // Helpful IDs if present
  const transactionId = get(row, "transaction id", "transactionid", "userpaymentsmstid", "receipt", "invoice");

  return {
    id: eventId,
    type: "transaction",
    action: "created",
    payload: {
      transactionId: transactionId || undefined,
      cashAmount,
      ccAmount,
      totalAmount,
      // IMPORTANT: do not set generic changeDue unless you’re sure.
      // Our cashout logic now ignores generic change due anyway.
      changeDue: changeDue || undefined,
    },
    createdDate: createdDate.toISOString(),
  };
}

async function readCsv(filePath: string): Promise<CsvRow[]> {
  const raw = fs.readFileSync(filePath, "utf8");
  const records = parse(raw, {
    columns: (header: string[]) => header.map((h) => normalizeHeader(h)),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as CsvRow[];

  // Normalize keys to our get() expectations
  return records.map((r) => {
    const out: CsvRow = {};
    for (const [k, v] of Object.entries(r)) out[normalizeHeader(k)] = v;
    return out;
  });
}

async function readXlsx(filePath: string): Promise<CsvRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheets found in XLSX");

  // Learned from Vagaro export: headers at row 23, data until a row starting with 'Total'
  const headerRowNumber = 23;
  const headerRow = ws.getRow(headerRowNumber);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const v = String(cell.value ?? "").trim();
    if (v) headers[col] = normalizeHeader(v);
  });

  const rows: CsvRow[] = [];
  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const first = String(row.getCell(1).value ?? "").trim();
    if (first.toLowerCase() === "total") break;
    if (!first) continue;

    const out: CsvRow = {};
    for (let c = 1; c <= row.cellCount; c++) {
      const key = headers[c];
      if (!key) continue;
      const cell = row.getCell(c).value;
      if (cell === null || cell === undefined) continue;

      // ExcelJS can return rich types; we normalize to string
      if (typeof cell === "object" && cell && "text" in (cell as any)) {
        out[key] = String((cell as any).text);
      } else if (cell instanceof Date) {
        out[key] = cell.toISOString();
      } else {
        out[key] = String(cell);
      }
    }
    rows.push(out);
  }

  return rows;
}

async function readTabular(filePath: string): Promise<CsvRow[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return readCsv(filePath);
  if (ext === ".xlsx") return readXlsx(filePath);
  throw new Error(`Unsupported file type: ${ext}. Use .csv or .xlsx`);
}

function pickDays(month: number, year: number, days: number[]): string[] {
  const mm = String(month).padStart(2, "0");
  return days.map((d) => `${year}-${mm}-${String(d).padStart(2, "0")}`);
}

async function deleteDay(day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(`${day}T23:59:59.999Z`);

  // day column is @db.Date in schema; using gte/lt with ISO works.
  // To avoid timezone surprises, match by day field and createdDate local conversion is done by app.
  const before = await prisma.webhookEvent.count({
    where: { day: new Date(`${day}T00:00:00.000Z`) },
  });

  const del = await prisma.webhookEvent.deleteMany({
    where: { day: new Date(`${day}T00:00:00.000Z`) },
  });

  const after = await prisma.webhookEvent.count({
    where: { day: new Date(`${day}T00:00:00.000Z`) },
  });

  return { before, deleted: del.count, after, rangeHint: { start, end } };
}

async function insertManualEvents(day: string, rows: CsvRow[]) {
  const created = new Date(`${day}T12:00:00.000Z`); // midday UTC, day bucketing uses ET conversions elsewhere

  const data = rows.map((row, i) => {
    const createdDate = guessCreatedDate(row);
    const eventId = `manual-csv-${day}-${String(i + 1).padStart(4, "0")}`;
    const payloadObj = buildVagaroManualWebhook(row, createdDate, eventId);

    return {
      eventId,
      entityType: "transaction",
      action: "created",
      businessIds: [],
      createdDate: createdDate,
      rawBody: JSON.stringify(payloadObj),
      headers: {},
      payload: payloadObj,
      sourceIp: null,
      userAgent: "manual-csv",
      day: created,
    };
  });

  // Use createMany for speed; skip duplicates just in case.
  const res = await prisma.webhookEvent.createMany({ data, skipDuplicates: true });
  return res.count;
}

async function main() {
  // We only require DB for non-dry-run operations.

  const answers = await prompts(
    [
      {
        type: "number",
        name: "year",
        message: "What year are we backfilling?",
        initial: new Date().getFullYear(),
        validate: (v: number) => (v >= 2000 && v <= 2100 ? true : "Enter a valid year"),
      },
      {
        type: "number",
        name: "month",
        message: "What month (1-12)?",
        validate: (v: number) => (v >= 1 && v <= 12 ? true : "Enter month 1-12"),
      },
      {
        type: "list",
        name: "days",
        message: "Which day numbers to process? (e.g. 12,13,14)",
        separator: ",",
      },
      {
        type: "text",
        name: "dir",
        message: "CSV directory path (absolute or relative)?",
        initial: "src/csv",
      },
      {
        type: "text",
        name: "file",
        message: "Filename (.csv or .xlsx)?",
      },
      {
        type: "toggle",
        name: "dryRun",
        message: "Dry run? (no DB required; no deletes/inserts)",
        initial: true,
        active: "yes",
        inactive: "no",
      },
    ],
    {
      onCancel: () => {
        process.exit(1);
      },
    }
  );

  const year = Number(answers.year);
  const month = Number(answers.month);
  const days = (answers.days as unknown[])
    .map((d) => Number(d))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31);

  if (!days.length) throw new Error("No valid days provided");

  const csvPath = path.resolve(process.cwd(), answers.dir, answers.file);
  if (!fs.existsSync(csvPath)) throw new Error(`File not found: ${csvPath}`);

  const allRows = await readTabular(csvPath);

  // Build plans by ET day
  const byDay = new Map<string, CsvRow[]>();
  for (const row of allRows) {
    const createdDate = guessCreatedDate(row);
    const etDay = toIsoDateEt(createdDate);
    const list = byDay.get(etDay) || [];
    list.push(row);
    byDay.set(etDay, list);
  }

  const requestedDays = pickDays(month, year, days);
  const plans: DayPlan[] = requestedDays.map((day) => ({ day, csvRows: byDay.get(day) || [] }));

  console.log("\nPlan summary:");
  for (const p of plans) {
    console.log(`- ${p.day}: ${p.csvRows.length} CSV rows`);
  }

  if (answers.dryRun) {
    console.log("\nDry run enabled. No DB calls, deletes, or inserts will be performed.");

    const totalMatched = plans.reduce((acc, p) => acc + p.csvRows.length, 0);
    if (totalMatched === 0) {
      console.log("\nNo rows matched the requested day(s). This is usually a date-column parsing issue.");
      console.log("Tip: open the export and confirm which column contains the transaction date/time.");
    }
    return;
  }

  try {
    requireEnv("DATABASE_URL");
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    printDbHelp();
    throw e;
  }

  const confirm = await prompts({
    type: "confirm",
    name: "yes",
    message: "Proceed to DELETE existing rows for these days, then INSERT manual webhooks?",
    initial: false,
  });

  if (!confirm.yes) {
    console.log("Cancelled.");
    return;
  }

  for (const p of plans) {
    console.log(`\n=== Day ${p.day} ===`);

    const del = await deleteDay(p.day);
    console.log(`Deleted WebhookEvent rows for day ${p.day}: before=${del.before} deleted=${del.deleted} after=${del.after}`);

    if (p.csvRows.length === 0) {
      console.log("No CSV rows for this day; skipping insert.");
      continue;
    }

    const inserted = await insertManualEvents(p.day, p.csvRows);
    console.log(`Inserted (createMany) rows: ${inserted}`);

    const afterInsert = await prisma.webhookEvent.count({
      where: { day: new Date(`${p.day}T00:00:00.000Z`) },
    });
    console.log(`DB now has ${afterInsert} rows for day.`);
  }

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
