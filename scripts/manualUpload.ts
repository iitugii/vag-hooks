// Manual Upload helper script.
// Run with: npx tsx scripts/manualUpload.ts

import fs from "fs";
import path from "path";
import { Workbook } from "exceljs";
import { createInterface } from "readline/promises";
import { randomUUID } from "crypto";

const instructions = `
Manual Upload Helper
====================

Railway: Connect to Postgres
----------------------------
1) railway connect
2) Select the Postgres service

Preview webhook counts for Dec 12–13 (local ET):
------------------------------------------------
WITH base AS (
  SELECT COALESCE("createdDate", "receivedAt")
           AT TIME ZONE 'UTC'
           AT TIME ZONE 'America/New_York' AS ts_local
  FROM "WebhookEvent"
)
SELECT to_char(ts_local::date, 'YYYY-MM-DD') AS day_local, COUNT(*) AS rows
FROM base
WHERE ts_local::date BETWEEN '2025-12-12' AND '2025-12-13'
GROUP BY ts_local::date
ORDER BY ts_local::date;

Delete webhook events for Dec 12–13 (local ET):
-----------------------------------------------
DELETE FROM "WebhookEvent"
WHERE (
  COALESCE("createdDate", "receivedAt")
    AT TIME ZONE 'UTC'
    AT TIME ZONE 'America/New_York'
)::date BETWEEN '2025-12-12' AND '2025-12-13';

Optional: clear counted cash overrides for those days:
------------------------------------------------------
DELETE FROM "CashoutCounted"
WHERE day BETWEEN '2025-12-12'::date AND '2025-12-13'::date;

Notes
-----
- Paste the SQL inside psql (railway connect), not in PowerShell.
- Adjust dates as needed for other ranges.
`;

type ParsedRow = {
  rowNumber: number;
  checkoutUtc: Date | null;
  checkoutLocalDay: string | null;
  transactionId: string | null;
  itemSold: string | null;
  appointmentUtc: Date | null;
  purchaseType: string | null;
  quantity: number | null;
  price: number | null;
  tax: number | null;
  tip: number | null;
  discount: number | null;
  amountPaid: number | null;
  cashAmount: number | null;
  checkAmount: number | null;
  gcRedemption: number | null;
  packageRedemption: number | null;
  membership: number | null;
  ccAmount: number | null;
  bankAccountAmount: number | null;
  buyNowPayLater: number | null;
  otherAmount: number | null;
  iouAmount: number | null;
  changeDue: number | null;
  serviceProviderId: string | null;
  createdBy: string | null;
  brandName: string | null;
};

type FetchLike = (input: any, init?: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toISODateNY(d: Date | null): string | null {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  const y = get("year");
  const m = get("month");
  const da = get("day");
  return y && m && da ? `${y}-${m}-${da}` : null;
}

function excelDateToDate(value: any): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "number" && !Number.isNaN(value)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(epoch.getTime() + value * 86400000);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+-\s+/, " ");
    const parsed = new Date(cleaned);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseNumber(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function promptDirectory(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Enter directory path (default: ${process.cwd()}): `);
  await rl.close();
  const dir = answer.trim() || process.cwd();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Directory not found: ${dir}`);
  }
  return dir;
}

async function promptYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message} `);
  await rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function probeTarget(target: string, fetchFn: FetchLike | undefined) {
  if (!fetchFn) return { ok: false, error: "fetch is not available in this Node runtime. Use Node 18+." };
  try {
    const u = new URL(target);
    const healthUrl = `${u.origin}/health`;
    const res = await fetchFn(healthUrl, { method: "GET" });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `health check non-200 (${res.status})` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function sendPayloads(payloads: any[], target: string, fetchFn: FetchLike | undefined) {
  if (!fetchFn) {
    throw new Error("fetch is not available in this Node runtime. Use Node 18+.");
  }

  console.log(`\nSending ${payloads.length} webhook(s) to ${target}`);
  const maxRetries = 2;
  let success = 0;
  let failed = 0;

  const formatError = (err: any) => {
    if (err instanceof AggregateError) {
      const parts = (err as any).errors?.map((e: any) => e?.message || String(e)) ?? [];
      return `AggregateError: ${err.message}${parts.length ? ` | inner: ${parts.join(" | ")}` : ""}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  };

  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    const label = p?.payload?.transactionId || p?.id || `row-${i + 1}`;
    let attempt = 0;
    let lastError: any = null;

    for (; attempt <= maxRetries; attempt++) {
      process.stdout.write(`[${i + 1}/${payloads.length}] ${label} (try ${attempt + 1}/${maxRetries + 1}) ... `);
      try {
        const res = await fetchFn(target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p),
        });
        const text = await res.text();
        console.log(`${res.status} ${res.ok ? "ok" : "fail"} ${text.slice(0, 1000)}`);
        if (res.ok) {
          success++;
          break;
        } else {
          lastError = text;
          if (attempt < maxRetries) {
            await delay(200 * (attempt + 1));
            continue;
          }
          failed++;
        }
      } catch (err) {
        lastError = formatError(err);
        console.log(`error ${lastError}`);
        if (attempt < maxRetries) {
          await delay(200 * (attempt + 1));
          continue;
        }
        failed++;
      }
      break;
    }

    if (attempt > maxRetries && lastError) {
      console.log(`  final error: ${lastError}`);
    }
  }

  console.log(`\nSend complete. Success: ${success}, Failed: ${failed}`);
}

async function promptFile(dir: string): Promise<string> {
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".xlsx"));
  if (!files.length) throw new Error(`No .xlsx files found in ${dir}`);
  console.log("Found .xlsx files:");
  files.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = await rl.question(`Select file number (1-${files.length}): `);
  await rl.close();
  const idx = Number(choice.trim());
  if (!Number.isInteger(idx) || idx < 1 || idx > files.length) {
    throw new Error(`Invalid selection: ${choice}`);
  }
  return path.join(dir, files[idx - 1]);
}

async function parseTransactions(filePath: string) {
  const workbook = new Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("No worksheet found in file");

  const headerRowIndex = 23;
  const dataStart = headerRowIndex + 1;
  let rows: ParsedRow[] = [];

  const headerRow = sheet.getRow(headerRowIndex);
  const normalize = (v: any) =>
    String((v as any)?.text ?? v ?? "")
      .trim()
      .toLowerCase();
  const clean = (s: string) => s.replace(/[^a-z0-9]+/g, "");
  const findColumn = (labels: string[], fallback?: number) => {
    const labelKeys = labels.map(l => clean(l.toLowerCase()));
    for (let c = 1; c <= headerRow.actualCellCount; c++) {
      const text = normalize(headerRow.getCell(c).value);
      if (!text) continue;
      const key = clean(text);
      if (labelKeys.includes(key)) return c;
    }
    return fallback;
  };

   const columns = {
    checkout: findColumn(["checkout date", "check out date", "checkout date/time"], 2),
    transactionId: findColumn(["transaction id", "transaction id #", "tran id"], 4),
    appointment: findColumn(["appointment date", "appt date", "appointment"], 5),
    itemSold: findColumn(["service/product", "service / product", "service", "product"], 7),
    purchaseType: findColumn(["transaction type", "type"], 8),
    provider: findColumn(["service provider", "provider"], 10),
    quantity: findColumn(["qty", "quantity"], 12),
    price: findColumn(["price"], 13),
    tax: findColumn(["tax"], 14),
    tip: findColumn(["tip"], 15),
    discount: findColumn(["disc", "discount"], 16),
    amountPaid: findColumn(["amt paid", "amount paid", "total"], 17),
    cash: findColumn(["cash"], 18),
    check: findColumn(["check"], 19),
    gc: findColumn(["gc redeem", "gift card", "gift certificate"], 20),
    pkg: findColumn(["pkg", "package"], 21),
    membership: findColumn(["mbsp", "membership"], 22),
    cc: findColumn(["cc", "credit card"], 23),
    bank: findColumn(["bankaccount", "bank account", "ach"], 24),
    bnpl: findColumn(["buy now pay later", "bnpl", "afterpay", "klarna"], 25),
    other: findColumn(["other"], 26),
    iou: findColumn(["iou", "invoice"], 27),
    changeDue: findColumn(["change due", "change"], 33),
    createdBy: findColumn(["checkedout by", "checked out by", "created by"], 3),
    brandName: findColumn(["charge method", "merchant account", "brand"], 31),
   } as const;

   console.log("Column mapping (col -> field):");
   Object.entries(columns).forEach(([field, col]) => {
     console.log(`  ${field}: ${col ?? "(not found)"}`);
   });
  if (!columns.transactionId) {
    console.warn("Warning: Transaction ID column not found; valid row count may be zero.");
  }

  for (let r = dataStart; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const rowVals = Array.isArray(row.values) ? row.values : [];
    const hasTotal = rowVals.some((v: any) => typeof v === "string" && v.trim().toUpperCase() === "TOTAL");
    if (hasTotal) break;

    const checkoutVal = columns.checkout ? row.getCell(columns.checkout).value : null;
    const txnVal = columns.transactionId ? row.getCell(columns.transactionId).value : null;
    const apptVal = columns.appointment ? row.getCell(columns.appointment).value : null;
    const itemVal = columns.itemSold ? row.getCell(columns.itemSold).value : null;
    const purchaseType = columns.purchaseType ? row.getCell(columns.purchaseType).value : null;
    const providerVal = columns.provider ? row.getCell(columns.provider).value : null;
    const qtyVal = columns.quantity ? row.getCell(columns.quantity).value : null;
    const priceVal = columns.price ? row.getCell(columns.price).value : null;
    const taxVal = columns.tax ? row.getCell(columns.tax).value : null;
    const tipVal = columns.tip ? row.getCell(columns.tip).value : null;
    const discVal = columns.discount ? row.getCell(columns.discount).value : null;
    const amtPaidVal = columns.amountPaid ? row.getCell(columns.amountPaid).value : null;
    const cashVal = columns.cash ? row.getCell(columns.cash).value : null;
    const checkVal = columns.check ? row.getCell(columns.check).value : null;
    const gcVal = columns.gc ? row.getCell(columns.gc).value : null;
    const pkgVal = columns.pkg ? row.getCell(columns.pkg).value : null;
    const mbspVal = columns.membership ? row.getCell(columns.membership).value : null;
    const ccVal = columns.cc ? row.getCell(columns.cc).value : null;
    const bankVal = columns.bank ? row.getCell(columns.bank).value : null;
    const bnplVal = columns.bnpl ? row.getCell(columns.bnpl).value : null;
    const otherVal = columns.other ? row.getCell(columns.other).value : null;
    const iouVal = columns.iou ? row.getCell(columns.iou).value : null;
    const changeVal = columns.changeDue ? row.getCell(columns.changeDue).value : null;
    const createdByVal = columns.createdBy ? row.getCell(columns.createdBy).value : null;
    const brandVal = columns.brandName ? row.getCell(columns.brandName).value : null;

    const checkoutUtc = excelDateToDate(checkoutVal);
    const dayLocal = toISODateNY(checkoutUtc);

    rows.push({
      rowNumber: r,
      checkoutUtc,
      checkoutLocalDay: dayLocal,
      transactionId: txnVal ? String(txnVal).trim() : null,
      itemSold: itemVal ? String(itemVal).trim() : null,
      appointmentUtc: excelDateToDate(apptVal),
      purchaseType: purchaseType ? String(purchaseType).trim() : null,
      quantity: parseNumber(qtyVal),
      price: parseNumber(priceVal),
      tax: parseNumber(taxVal),
      tip: parseNumber(tipVal),
      discount: parseNumber(discVal),
      amountPaid: parseNumber(amtPaidVal),
      cashAmount: parseNumber(cashVal),
      checkAmount: parseNumber(checkVal),
      gcRedemption: parseNumber(gcVal),
      packageRedemption: parseNumber(pkgVal),
      membership: parseNumber(mbspVal),
      ccAmount: parseNumber(ccVal),
      bankAccountAmount: parseNumber(bankVal),
      buyNowPayLater: parseNumber(bnplVal),
      otherAmount: parseNumber(otherVal),
      iouAmount: parseNumber(iouVal),
      changeDue: parseNumber(changeVal),
      serviceProviderId: providerVal ? String(providerVal).trim() : null,
      createdBy: createdByVal ? String(createdByVal).trim() : null,
      brandName: brandVal ? String(brandVal).trim() : null,
    });
  }

  const valid = rows.filter(r => r.transactionId && r.checkoutLocalDay);
  const byDay: Record<string, number> = {};
  const txnSet = new Set<string>();
  for (const r of valid) {
    if (r.checkoutLocalDay) {
      byDay[r.checkoutLocalDay] = (byDay[r.checkoutLocalDay] || 0) + 1;
    }
    if (r.transactionId) txnSet.add(r.transactionId);
  }

  console.log(`\nParsed file: ${path.basename(filePath)}`);
  console.log(`  Total data rows (before validation): ${rows.length}`);
  console.log(`  Valid rows (with date + txnId): ${valid.length}`);
  console.log(`  Distinct transaction IDs: ${txnSet.size}`);
  console.log(`  By local day (America/New_York):`);
  Object.keys(byDay).sort().forEach(day => {
    console.log(`    ${day}: ${byDay[day]} rows`);
  });

  return valid;
}

async function main() {
  console.log(instructions);
  console.log("\n=== Transaction List Inspect ===");
  try {
    const dir = process.env.MANUAL_UPLOAD_DIR || (await promptDirectory());
    const filePath = process.env.MANUAL_UPLOAD_FILE || (await promptFile(dir));
    const rows = await parseTransactions(filePath);
    // Build webhook payloads that mirror Vagaro transactions exactly
    const payloads = rows.map(r => {
      const transactionId = r.transactionId || `manual-tx-${r.rowNumber}`;
      const eventId = randomUUID();
      const createdDate = r.checkoutUtc?.toISOString() || new Date().toISOString();
      const transactionDate = createdDate;
      const quantity = r.quantity ?? 1;

      const tax = r.tax ?? 0;
      const tip = r.tip ?? 0;
      const cashAmount = r.cashAmount ?? 0;
      const checkAmount = r.checkAmount ?? 0;
      const ccAmount = r.ccAmount ?? 0;
      const gcRedemption = r.gcRedemption ?? 0;
      const bankAccountAmount = r.bankAccountAmount ?? 0;
      const vagaroPayLaterAmount = r.buyNowPayLater ?? 0;
      const packageRedemption = r.packageRedemption ?? 0;
      const membershipAmount = r.membership ?? 0;
      const otherAmount = r.otherAmount ?? 0;
      const changeDue = r.changeDue ?? 0;
      const discount = r.discount ?? 0;
      // amountDue comes directly from the Change Due column per guidance
      const amountDue = changeDue;

      const itemSold = r.itemSold ? String(r.itemSold).trim() : "";
      const serviceCategory = itemSold;
      const purchaseType = r.purchaseType || "Service";

      const payload = {
        tax: tax.toString(),
        tip,
        ccMode: ccAmount > 0 ? "C" : "Manual",
        ccType: r.brandName || "Manual",
        points: 0,
        ccAmount,
        discount,
        itemSold,
        quantity,
        achAmount: 0,
        amountDue,
        brandName: r.brandName ?? null,
        createdBy: r.createdBy || "manual-upload",
        businessId: "manual-import",
        cashAmount,
        customerId: `manual-customer-${r.rowNumber}`,
        checkAmount,
        otherAmount,
        gcRedemption,
        purchaseType,
        appointmentId: r.appointmentUtc?.toISOString() || `manual-appt-${r.rowNumber}`,
        businessAlias: "",
        transactionId,
        userPaymentId: `manual-payment-${r.rowNumber}`,
        businessGroupId: "manual-group",
        productDiscount: 0,
        serviceCategory,
        transactionDate,
        memberShipAmount: membershipAmount,
        bankAccountAmount,
        packageRedemption,
        serviceProviderId: r.serviceProviderId || "",
        userPaymentsMstId: `manual-mst-${r.rowNumber}`,
        vagaroPayLaterAmount,
      };

      return {
        id: eventId,
        type: "transaction",
        action: "created",
        payload,
        createdDate,
      };
    });

    console.log(`\nWebhook-ready payloads: ${payloads.length}`);
    if (payloads.length) {
      console.log("Sample payload (first):\n", JSON.stringify(payloads[0], null, 2));
      const target =
        process.env.MANUAL_WEBHOOK_URL || "https://web-production-68a4e.up.railway.app/webhooks/vagaro";
      const autoSend = process.env.MANUAL_UPLOAD_SEND === "1";
      const fetchFn = (globalThis as any).fetch as FetchLike | undefined;

      let doSend = autoSend;
      if (!autoSend) {
        doSend = await promptYesNo(`Send ${payloads.length} webhooks to ${target}? y/n`);
      }

      if (doSend) {
        const probe = await probeTarget(target, fetchFn);
        if (!probe.ok) {
          console.warn(`Health check failed: ${probe.error || "unknown"}${probe.status ? ` (status ${probe.status})` : ""}`);
          const proceed = await promptYesNo("Target looks unreachable. Continue anyway? y/n");
          if (!proceed) return;
        }

        await sendPayloads(payloads, target, fetchFn);
      }
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main();
