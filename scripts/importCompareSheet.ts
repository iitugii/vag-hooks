import path from "path";
import Excel from "exceljs";
import { Prisma } from "@prisma/client";

import { prisma } from "../src/lib/prisma";
import { providerDirectory } from "../src/routes/employees";

const TARGET_PROVIDER_NAME = "Isabel Guerrero";
const TARGET_PROVIDER_ID = Object.entries(providerDirectory).find(
  ([, name]) => (name || "").trim().toLowerCase() === TARGET_PROVIDER_NAME.toLowerCase()
)?.[0];

if (!TARGET_PROVIDER_ID) {
  throw new Error(`Provider ID for ${TARGET_PROVIDER_NAME} not found in providerDirectory`);
}

type CellValue = Excel.CellValue | undefined;

type ImportTask = {
  rowNumber: number;
  eventId: string;
  checkoutDate: Date;
  payloadBody: Prisma.JsonObject;
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

function toCustomerId(name: string, rowNumber: number): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `compare-customer-${slug || rowNumber}`;
}

function toAppointmentId(value: CellValue, rowNumber: number): string {
  const raw = cellToString(value);
  if (!raw) return `compare-appt-${rowNumber}`;
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `compare-appt-${slug || rowNumber}`;
}

async function main() {
  const workbook = new Excel.Workbook();
  const filePath = path.resolve(__dirname, "../src/csv/compare.xlsx");
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("compare.xlsx is empty");
  }

  const tasks: ImportTask[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;

    const itemSold = cellToString(row.getCell(6).value);
    const transactionId = cellToString(row.getCell(3).value);
    const providerName = cellToString(row.getCell(9).value);

    if (!itemSold || itemSold.toLowerCase() === "total") return;
    if (!transactionId) return;
    if (!providerName) return;
    if (providerName.trim().toLowerCase() !== TARGET_PROVIDER_NAME.toLowerCase()) return;

    const checkoutDate = parseLocalDate(row.getCell(1).value);
    if (!checkoutDate) {
      console.warn(`Skipping row ${rowNumber}: unable to parse checkout date`);
      return;
    }

    const appointmentDate = parseLocalDate(row.getCell(4).value);
    const customerName = cellToString(row.getCell(5).value) || `Customer ${rowNumber}`;

    const payloadBody = {
      transactionDate: checkoutDate.toISOString(),
      businessId: "compare-import",
      businessAlias: "Compare Import",
      transactionId,
      userPaymentId: `compare-payment-${rowNumber}`,
      userPaymentsMstId: `compare-mst-${rowNumber}`,
      brandName: cellToString(row.getCell(31).value) || null,
      itemSold,
      purchaseType: cellToString(row.getCell(7).value) || "Services",
      quantity: cellToNumber(row.getCell(11).value) || 1,
      ccAmount: cellToNumber(row.getCell(22).value),
      cashAmount: Math.max(
        cellToNumber(row.getCell(17).value) - cellToNumber(row.getCell(32).value),
        0
      ),
      checkAmount: cellToNumber(row.getCell(18).value),
      achAmount: 0,
      packageRedemption: cellToNumber(row.getCell(20).value),
      bankAccountAmount: cellToNumber(row.getCell(23).value),
      vagaroPayLaterAmount: cellToNumber(row.getCell(24).value),
      otherAmount: cellToNumber(row.getCell(25).value),
      points: 0,
      gcRedemption: cellToNumber(row.getCell(19).value),
      tax: cellToNumber(row.getCell(13).value).toString(),
      tip: cellToNumber(row.getCell(14).value),
      discount: cellToNumber(row.getCell(15).value),
      memberShipAmount: cellToNumber(row.getCell(21).value),
      productDiscount: 0,
      ccType: cellToString(row.getCell(31).value) || "Manual",
      ccMode: "Manual",
      customerId: toCustomerId(customerName, rowNumber),
      serviceProviderId: TARGET_PROVIDER_ID,
      serviceProviderName: providerName,
      businessGroupId: "compare-group",
      amountDue: cellToNumber(row.getCell(12).value),
      appointmentId: toAppointmentId(row.getCell(4).value ?? row.getCell(1).value, rowNumber),
      serviceCategory: "CompareImport",
      createdBy: cellToString(row.getCell(2).value) || "compare-upload",
      source: cellToString(row.getCell(8).value) || "Manual",
      changeDue: cellToNumber(row.getCell(32).value),
      customerName,
      appointmentDate: appointmentDate ? appointmentDate.toISOString() : null,
      iouAmount: cellToNumber(row.getCell(26).value),
    } as Prisma.JsonObject;

    const eventId = `manual-compare-${transactionId}-${rowNumber}`;
    tasks.push({ rowNumber, eventId, checkoutDate, payloadBody });
  });

  if (!tasks.length) {
    console.log("No candidate rows found for import.");
    return;
  }

  console.log(`Prepared ${tasks.length} candidate rows. Beginning import…`);
  let inserted = 0;

  for (const task of tasks) {
    const existing = await prisma.webhookEvent.findUnique({ where: { eventId: task.eventId } });
    if (existing) {
      console.log(`Skipping row ${task.rowNumber}; event already exists (${task.eventId}).`);
      continue;
    }

    const payload: Prisma.JsonObject = {
      id: task.eventId,
      type: "transaction",
      action: "created",
      payload: task.payloadBody,
      createdDate: task.checkoutDate.toISOString(),
    };

    await prisma.webhookEvent.create({
      data: {
        eventId: task.eventId,
        entityType: "transaction",
        action: "created",
        businessIds: ["compare-import"],
        createdDate: task.checkoutDate,
        receivedAt: new Date(),
        rawBody: JSON.stringify(payload),
        headers: { "x-manual-upload": "compare.xlsx" } as Prisma.JsonObject,
        payload,
        sourceIp: "compare-import",
        userAgent: "excel-compare-import",
        day: new Date(
          Date.UTC(
            task.checkoutDate.getUTCFullYear(),
            task.checkoutDate.getUTCMonth(),
            task.checkoutDate.getUTCDate()
          )
        ),
      },
    });

    inserted += 1;
    console.log(`Inserted ${task.eventId}`);
  }

  console.log(`Import complete. Inserted ${inserted} new webhook events.`);
}

main()
  .catch(err => {
    console.error("Failed to import compare.xlsx", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
