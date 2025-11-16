import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import {
  listDataLakePaths,
  downloadDataLakeFile,
} from "./vagaroDataLake";

// Simple CSV parsing – good enough for Vagaro exports
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = parts[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

// Handles quoted values with commas; not a full CSV engine but fine for these reports
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result.map((v) => v.trim());
}

function toNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(
  row: Record<string, string>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const val = row[key];
    const n = toNumber(val);
    if (n != null) return n;
  }
  return null;
}

function firstString(
  row: Record<string, string>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const val = row[key];
    if (val && val.trim().length > 0) return val.trim();
  }
  return null;
}

export interface HistoricalImportResult {
  startDate: string;
  endDate: string;
  filesProcessed: number;
  rowsParsed: number;
  rowsImported: number;
  rowsSkipped: number;
  dryRun: boolean;
  fileNames: string[];
}

/**
 * Import historical transaction data *only* for the Cashout Calendar,
 * using the "Transaction details" CSVs in Data Lake.
 */
export async function importTransactionsFromDataLake(options: {
  startDate: string;
  endDate: string;
  dryRun?: boolean;
}): Promise<HistoricalImportResult> {
  const { startDate, endDate } = options;
  const dryRun = Boolean(options.dryRun);

  logger.info("[historicalImport] Starting import from Data Lake", {
    startDate,
    endDate,
    dryRun,
  });

  // 1) List all paths under "Transaction details"
  const paths = await listDataLakePaths("Transaction details", false);

  // 2) Only files like Transaction details-YYYY-MM-DD.csv within range
  const filePattern =
    /^Transaction details\/Transaction details-(\d{4}-\d{2}-\d{2})\.csv$/;

  const selectedFiles = paths
    .map((p) => p.name)
    .filter((name) => {
      const m = filePattern.exec(name);
      if (!m) return false;
      const fileDate = m[1]; // YYYY-MM-DD
      return fileDate >= startDate && fileDate <= endDate;
    })
    .sort();

  logger.info("[historicalImport] Selected files for import", {
    count: selectedFiles.length,
    files: selectedFiles,
  });

  let filesProcessed = 0;
  let rowsParsed = 0;
  let rowsImported = 0;
  let rowsSkipped = 0;

  for (const filePath of selectedFiles) {
    filesProcessed++;

    const fileText = await downloadDataLakeFile(filePath);
    const rows = parseCsv(fileText);
    rowsParsed += rows.length;

    logger.info("[historicalImport] Parsed CSV file", {
      filePath,
      rowCount: rows.length,
    });

    for (const row of rows) {
      // 3) Extract core fields
      const transactionDateStr = firstString(row, [
        "TransactionDate",
        "Transaction Date",
        "TransactionDateTime",
        "Transaction Date/Time",
      ]);
      const transactionId =
        firstString(row, ["TransactionID", "Transaction Id", "Transaction ID"]) ??
        firstString(row, ["UserPaymentMstID", "UserPaymentID"]);

      const businessId =
        firstString(row, ["BusinessID", "Business Id", "LocationID"]) ?? null;

      if (!transactionDateStr || !transactionId) {
        rowsSkipped++;
        continue;
      }

      const createdDate = new Date(transactionDateStr);
      if (Number.isNaN(createdDate.getTime())) {
        rowsSkipped++;
        continue;
      }

      // 4) Extract cash / totals / tip / discount
      const cash = firstNumber(row, [
        "AmountCash",
        "Amount Cash",
        "CashAmount",
        "Cash",
        "Cash Amount",
        "TenderAmount",
        "Tender Amount",
      ]);

      const amountDue = firstNumber(row, [
        "AmountDue",
        "Amount Due",
        "Total",
        "Ticket Total",
        "TicketTotal",
      ]);

      const tip = firstNumber(row, ["Tip", "TipAmount", "Gratuity"]);
      const discount = firstNumber(row, ["Discount", "DiscountAmount"]);

      const netCash =
        cash != null && amountDue != null ? cash - amountDue : null;

      // 5) Compute "day" as UTC calendar date
      const day = new Date(
        Date.UTC(
          createdDate.getUTCFullYear(),
          createdDate.getUTCMonth(),
          createdDate.getUTCDate()
        )
      );

      // 6) Build payload in the same style your cashout code expects
      const payload: any = {
        type: "historical_transaction",
        transactionDate: transactionDateStr,
        businessId,
        transactionId,
        amountCash: cash ?? null,
        amountDue: amountDue ?? null,
        tip: tip ?? null,
        discount: discount ?? null,
        netCash: netCash ?? null,
        originalRow: row,
      };

      // 7) Upsert into WebhookEvent, keyed by a stable eventId
      const eventId = `historical:${transactionId}`;

      const createData: any = {
        eventId,
        entityType: "transaction",
        action: "historical_import",
        businessIds: businessId ? [businessId] : [],
        createdDate,
        receivedAt: new Date(),
        rawBody: JSON.stringify(row),
        headers: {},
        payload,
        sourceIp: "historical-import",
        userAgent: "vag-hooks-historical-import",
        day,
      };

      if (netCash != null) {
        createData.cash_collected = netCash;
      }

      const updateData: any = {
        payload,
        day,
      };

      if (netCash != null) {
        updateData.cash_collected = netCash;
      }

      if (dryRun) {
        rowsImported++;
        continue;
      }

      try {
        await prisma.webhookEvent.upsert({
          where: { eventId },
          create: createData,
          update: updateData,
        });
        rowsImported++;
      } catch (err: any) {
        logger.error("[historicalImport] Failed to upsert WebhookEvent", {
          eventId,
          error: err?.message ?? String(err),
        });
        rowsSkipped++;
      }
    }
  }

  const result: HistoricalImportResult = {
    startDate,
    endDate,
    filesProcessed,
    rowsParsed,
    rowsImported,
    rowsSkipped,
    dryRun,
    fileNames: selectedFiles,
  };

  logger.info("[historicalImport] Completed import from Data Lake", result);

  return result;
}
