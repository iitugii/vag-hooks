import path from "path";
import fs from "fs";
import Excel from "exceljs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { providerDirectory } from "../src/routes/employees";

const PROVIDERS = [
  "Isabel Guerrero",
  "Marielbys Miranda",
] as const;

const providerMap = PROVIDERS.map(name => {
  const entry = Object.entries(providerDirectory).find(([, value]) => value === name);
  if (!entry) {
    throw new Error(`Provider ${name} not found in directory`);
  }
  return { id: entry[0], name };
});

const RANGE_START = new Date("2025-11-23T00:00:00-05:00");
const RANGE_END = new Date("2025-11-30T00:00:00-05:00");
const MATCH_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const MATCH_PRICE_TOLERANCE = 7; // dollars
const MATCH_TIP_TOLERANCE = 1.5; // dollars

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "short",
  timeStyle: "short",
});

function cellToString(value: Excel.CellValue | undefined): string {
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

function cellToNumber(value: Excel.CellValue | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(cellToString(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMixupDate(raw: string): Date | null {
  if (!raw) return null;
  const normalized = raw.replace(/\s*-\s*/g, " ");
  const attempt = new Date(`${normalized} GMT-0500`);
  return Number.isNaN(attempt.getTime()) ? null : attempt;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function normalizeService(value: string): string {
  return value.trim().toLowerCase();
}

type MixupRow = {
  rowNumber: number;
  providerName: string;
  providerId: string;
  transactionId: string;
  service: string;
  serviceKey: string;
  checkoutDate: Date | null;
  price: number;
  tip: number;
};

type WebhookRow = {
  eventId: string;
  providerId: string;
  providerName: string;
  transactionId: string;
  service: string;
  serviceKey: string;
  tip: number;
  tenderAmount: number;
  netAmount: number;
  createdUtc: Date | null;
};

async function loadMixupRows(): Promise<MixupRow[]> {
  const filePath = path.resolve(__dirname, "../src/csv/mixup.xlsx");
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("mixup.xlsx missing first worksheet");

  const rows: MixupRow[] = [];
  let dataSection = false;
  sheet.eachRow((row, rowNumber) => {
    if (!dataSection) {
      const header = cellToString(row.getCell(1).value);
      if (header.toLowerCase() === "checkout date") {
        dataSection = true;
      }
      return;
    }

    const transactionId = cellToString(row.getCell(3).value);
    if (!transactionId) return;

    const providerName = cellToString(row.getCell(9).value);
    const provider = providerMap.find(p => p.name.toLowerCase() === providerName.toLowerCase());
    if (!provider) return;

    const service = cellToString(row.getCell(6).value);
    const checkout = cellToString(row.getCell(1).value);
    const price = cellToNumber(row.getCell(12).value);
    const tip = cellToNumber(row.getCell(14).value);

    rows.push({
      rowNumber,
      providerName: provider.name,
      providerId: provider.id,
      transactionId,
      service,
      serviceKey: normalizeService(service),
      checkoutDate: parseMixupDate(checkout),
      price,
      tip,
    });
  });

  return rows.filter(r => r.checkoutDate && r.checkoutDate >= RANGE_START && r.checkoutDate < RANGE_END);
}

async function loadWebhookRows(): Promise<WebhookRow[]> {
  const providerIds = providerMap.map(p => p.id);

  const rows = await prisma.$queryRaw<{
    event_id: string;
    provider_id: string | null;
    transaction_id: string | null;
    payload: any;
    ts_utc: Date | null;
  }[]>`
    SELECT
      "eventId" AS event_id,
      COALESCE(payload->'payload'->>'serviceProviderId', payload->>'serviceProviderId') AS provider_id,
      COALESCE(payload->'payload'->>'transactionId', payload->>'transactionId') AS transaction_id,
      payload,
      COALESCE("createdDate", "receivedAt") AS ts_utc
    FROM "WebhookEvent"
    WHERE COALESCE(payload->'payload'->>'serviceProviderId', payload->>'serviceProviderId') IN (${Prisma.join(providerIds)})
      AND COALESCE("createdDate", "receivedAt") >= ${RANGE_START}
      AND COALESCE("createdDate", "receivedAt") < ${RANGE_END}
    ORDER BY ts_utc;
  `;

  return rows.map(row => {
    const payload = row.payload?.payload ?? row.payload ?? {};
    const providerId = (payload.serviceProviderId || row.provider_id || "").toString();
    const providerName = providerMap.find(p => p.id === providerId)?.name ?? providerId;
    const tip = Number(payload.tip ?? 0) || 0;
    const tenderFields = [
      "cashAmount",
      "ccAmount",
      "checkAmount",
      "achAmount",
      "otherAmount",
      "gcRedemption",
      "packageRedemption",
      "memberShipAmount",
      "bankAccountAmount",
      "vagaroPayLaterAmount",
    ];
    const tenderAmount = tenderFields.reduce((sum, key) => sum + (Number(payload[key] ?? 0) || 0), 0);
    const netAmount = tenderAmount - tip;

    return {
      eventId: row.event_id,
      providerId,
      providerName,
      transactionId: (payload.transactionId || row.transaction_id || "").toString(),
      service: (payload.itemSold || "").toString(),
      serviceKey: normalizeService(payload.itemSold || ""),
      tip,
      tenderAmount,
      netAmount,
      createdUtc: row.ts_utc ? new Date(row.ts_utc) : null,
    } as WebhookRow;
  });
}

function findMatch(
  event: WebhookRow,
  candidates: MixupRow[]
): { row: MixupRow; score: number; timeDiff: number; priceDiff: number; tipDiff: number } | null {
  let best: { row: MixupRow; score: number; timeDiff: number; priceDiff: number; tipDiff: number } | null = null;

  for (const row of candidates) {
    if (row.serviceKey !== event.serviceKey) continue;
    if (!row.checkoutDate || !event.createdUtc) continue;
    const timeDiff = Math.abs(row.checkoutDate.getTime() - event.createdUtc.getTime());
    if (timeDiff > MATCH_WINDOW_MS) continue;

    const priceDiff = Math.abs(row.price - event.netAmount);
    if (row.price > 0 && event.netAmount > 0 && priceDiff > MATCH_PRICE_TOLERANCE) continue;

    const tipDiff = Math.abs(row.tip - event.tip);
    if (row.tip > 0 || event.tip > 0) {
      if (tipDiff > MATCH_TIP_TOLERANCE) continue;
    }

    const score = timeDiff + priceDiff * 1000 + tipDiff * 1000;
    if (!best || score < best.score) {
      best = { row, score, timeDiff, priceDiff, tipDiff };
    }
  }

  return best;
}

type ComparisonEntry = {
  event: WebhookRow;
  match: MixupRow | null;
  deltas?: {
    timeDiffMs: number;
    priceDiff: number;
    tipDiff: number;
  };
};

type CsvComparisonEntry = {
  row: MixupRow;
  event: WebhookRow | null;
  deltas?: ComparisonEntry["deltas"];
};

function toEt(dateUtc: Date | null): string {
  if (!dateUtc) return "(no timestamp)";
  return etFormatter.format(dateUtc);
}

async function buildComparison(): Promise<{ entries: ComparisonEntry[]; csvRows: CsvComparisonEntry[]; unmatchedCsv: MixupRow[] }> {
  const [mixupRows, webhookRows] = await Promise.all([loadMixupRows(), loadWebhookRows()]);
  const remainingCsv = new Set(mixupRows.map(r => r.rowNumber));
  const entries: ComparisonEntry[] = [];
  const csvMatchDetail = new Map<number, { event: WebhookRow; deltas: ComparisonEntry["deltas"] }>();

  for (const event of webhookRows) {
    const availableRows = mixupRows.filter(row => remainingCsv.has(row.rowNumber));
    const match = findMatch(event, availableRows);
    if (match) {
      remainingCsv.delete(match.row.rowNumber);
      const deltas = {
        timeDiffMs: match.timeDiff,
        priceDiff: match.priceDiff,
        tipDiff: match.tipDiff,
      };
      entries.push({
        event,
        match: match.row,
        deltas,
      });
      csvMatchDetail.set(match.row.rowNumber, { event, deltas });
    } else {
      entries.push({ event, match: null });
    }
  }

  const unmatchedCsv = mixupRows.filter(row => !csvMatchDetail.has(row.rowNumber));
  const csvRows: CsvComparisonEntry[] = mixupRows.map(row => {
    const detail = csvMatchDetail.get(row.rowNumber);
    return {
      row,
      event: detail?.event ?? null,
      deltas: detail?.deltas,
    };
  });

  return { entries, csvRows, unmatchedCsv };
}

function renderMarkdown(data: { entries: ComparisonEntry[]; csvRows: CsvComparisonEntry[]; unmatchedCsv: MixupRow[] }): string {
  const lines: string[] = [];
  lines.push(`# Mixup vs Webhook Comparison (Nov 23-29, 2025)`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push("");

  const totalWebhooks = data.entries.length;
  const matchedWebhooks = data.entries.filter(e => e.match).length;
  const providerMismatches = data.entries.filter(
    e => e.match && e.event.providerId !== e.match.providerId
  ).length;
  const totalCsvRows = data.csvRows.length;
  const csvLinked = data.csvRows.filter(row => row.event).length;

  const formatStatus = (event: WebhookRow | null, row: MixupRow | null, deltas?: ComparisonEntry["deltas"]): string => {
    if (!event && !row) return "(n/a)";
    if (event && !row) return "No CSV match";
    if (!event && row) return "No webhook";
    if (!event || !row) return "—";

    const parts: string[] = [];
    parts.push(event.providerId === row.providerId ? "Linked" : "Linked (provider mismatch)");
    if (deltas) {
      if (Math.abs(deltas.priceDiff) > 1) parts.push(`Price diff $${deltas.priceDiff.toFixed(2)}`);
      if (Math.abs(deltas.tipDiff) > 0.5) parts.push(`Tip diff $${deltas.tipDiff.toFixed(2)}`);
      const minutes = Math.round(Math.abs(deltas.timeDiffMs) / 60000);
      if (minutes > 5) parts.push(`Time diff ${minutes} min`);
    }
    return parts.join("; ");
  };

  lines.push(
    `**Summary:** ${totalWebhooks} webhooks in range → ${matchedWebhooks} linked (${providerMismatches} provider mismatch); ${
      totalWebhooks - matchedWebhooks
    } without CSV rows. ${totalCsvRows} CSV rows → ${csvLinked} linked, ${totalCsvRows - csvLinked} without webhooks.`
  );
  lines.push("");

  lines.push("## Webhooks matched to CSV rows");
  lines.push(
    "| WH Date/Time (ET) | WH Provider | WH Service | WH Amount (ex tip) | WH Tip | WH Tx ID | ↔︎ | CSV Date/Time (ET) | CSV Provider | CSV Service | CSV Price | CSV Tip | CSV Tx ID | Status |"
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );

  const sortedEntries = [...data.entries].sort((a, b) => {
    const at = a.event.createdUtc?.getTime() ?? 0;
    const bt = b.event.createdUtc?.getTime() ?? 0;
    return at - bt;
  });

  if (!sortedEntries.length) {
    lines.push("| — | — | — | — | — | — | — | — | — | — | — | — | — | — |");
  } else {
    for (const entry of sortedEntries) {
      const { event, match, deltas } = entry;
      const status = formatStatus(event, match, deltas);
      lines.push(
        `| ${toEt(event.createdUtc)} | ${event.providerName} | ${event.service || "(none)"} | ${formatCurrency(event.netAmount)} | ${formatCurrency(
          event.tip
        )} | ${event.transactionId || "(none)"} | ${match ? "↔︎" : ""} | ${match && match.checkoutDate ? etFormatter.format(match.checkoutDate) : "—"} | ${
          match?.providerName || "—"
        } | ${match?.service || "—"} | ${match ? formatCurrency(match.price) : "—"} | ${
          match ? formatCurrency(match.tip) : "—"
        } | ${match?.transactionId || "—"} | ${status} |`
      );
    }
  }

  lines.push("");
  lines.push("## CSV rows and webhook status");
  lines.push(
    "| CSV Row | CSV Date/Time (ET) | CSV Provider | Service | Price | Tip | Transaction ID | Linked WH Time (ET) | Linked Provider | Linked Service | Linked Amount (ex tip) | Linked Tip | Linked Tx ID | Status |"
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );

  const sortedCsvRows = [...data.csvRows].sort((a, b) => a.row.rowNumber - b.row.rowNumber);
  if (!sortedCsvRows.length) {
    lines.push("| — | — | — | — | — | — | — | — | — | — | — | — | — | — |");
  } else {
    for (const entry of sortedCsvRows) {
      const { row, event, deltas } = entry;
      const status = formatStatus(event, row, deltas);
      lines.push(
        `| ${row.rowNumber} | ${row.checkoutDate ? etFormatter.format(row.checkoutDate) : "(no time)"} | ${row.providerName} | ${row.service} | ${formatCurrency(
          row.price
        )} | ${formatCurrency(row.tip)} | ${row.transactionId} | ${event ? toEt(event.createdUtc) : "—"} | ${
          event?.providerName || "—"
        } | ${event?.service || "—"} | ${event ? formatCurrency(event.netAmount) : "—"} | ${
          event ? formatCurrency(event.tip) : "—"
        } | ${event?.transactionId || "—"} | ${status} |`
      );
    }
  }

  lines.push("");
  lines.push(
    `Webhooks unmatched: ${data.entries.filter(e => !e.match).length}. CSV rows without webhook: ${data.unmatchedCsv.length}.`
  );

  return lines.join("\n");
}

async function main() {
  const results = await buildComparison();
  const markdown = renderMarkdown(results);
  const outputPath = path.resolve(__dirname, "../docs/mixup-webhook-comparison.md");
  fs.writeFileSync(outputPath, markdown, "utf8");
  console.log(`Comparison written to ${outputPath}`);
}

main()
  .catch(err => {
    console.error("Failed to compare mixup CSV to webhooks", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
