import path from "path";
import Excel from "exceljs";
import { prisma } from "../src/lib/prisma";
import { providerDirectory } from "../src/routes/employees";

type ManualTransaction = {
  rowNumber: number;
  transactionId: string;
  checkoutDate: Date;
  appointmentDate: Date | null;
  customerName: string;
  serviceProviderName: string;
  serviceProviderId: string;
  itemSold: string;
  purchaseType: string;
  quantity: number;
  price: number;
  tax: number;
  tip: number;
  discount: number;
  amountPaid: number;
  cash: number;
  changeDue: number;
  check: number;
  gcRedemption: number;
  packageRedemption: number;
  membership: number;
  cc: number;
  bankAccount: number;
  buyNowPayLater: number;
  otherAmount: number;
  iouAmount: number;
  source: string;
  chargeMethod: string;
  checkedOutBy: string;
};

type CellValue = Excel.CellValue | undefined;

function cellToString(value: CellValue): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const maybeRich = value as Excel.CellRichTextValue;
    if (Array.isArray((maybeRich as any).richText)) {
      return ((maybeRich as any).richText as { text: string }[])
        .map(part => part.text)
        .join("")
        .trim();
    }
    if ("text" in (value as any)) {
      return String((value as any).text || "").trim();
    }
    if ("result" in (value as any)) {
      return String((value as any).result || "").trim();
    }
    return String(value).trim();
  }
  return String(value).trim();
}

function cellToNumber(value: CellValue): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  const str = cellToString(value);
  if (!str) return 0;
  const cleaned = str.replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
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
  return `manual-customer-${slug || rowNumber}`;
}

function toAppointmentId(value: CellValue, rowNumber: number): string {
  const raw = cellToString(value);
  if (!raw) return `manual-appt-${rowNumber}`;
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `manual-appt-${slug || rowNumber}`;
}

async function main() {
  const workbook = new Excel.Workbook();
  const filePath = path.resolve(__dirname, "../src/csv/isa.xlsx");
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("isa.xlsx is empty");
  }

  const transactions: ManualTransaction[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 24) return;
    const itemSold = cellToString(row.getCell(6).value);
    const transactionId = cellToString(row.getCell(3).value);
    const providerName = cellToString(row.getCell(9).value);
    if (!itemSold || itemSold.toLowerCase() === "total") return;
    if (!transactionId) return;
    if (!providerName) return;

    const providerIdEntry = Object.entries(providerDirectory).find(
      ([, name]) => name.trim().toLowerCase() === providerName.trim().toLowerCase()
    );
    if (!providerIdEntry) {
      throw new Error(`No provider ID mapping found for ${providerName} (row ${rowNumber})`);
    }
    const [providerId] = providerIdEntry;

    const checkoutDate = parseLocalDate(row.getCell(1).value);
    if (!checkoutDate) {
      throw new Error(`Could not parse checkout date for row ${rowNumber}`);
    }

    const appointmentDate = parseLocalDate(row.getCell(4).value);

    const transaction: ManualTransaction = {
      rowNumber,
      transactionId,
      checkoutDate,
      appointmentDate,
      customerName: cellToString(row.getCell(5).value) || `Customer ${rowNumber}`,
      serviceProviderName: providerName,
      serviceProviderId: providerId,
      itemSold,
      purchaseType: cellToString(row.getCell(7).value) || "Services",
      quantity: cellToNumber(row.getCell(11).value) || 1,
      price: cellToNumber(row.getCell(12).value),
      tax: cellToNumber(row.getCell(13).value),
      tip: cellToNumber(row.getCell(14).value),
      discount: cellToNumber(row.getCell(15).value),
      amountPaid: cellToNumber(row.getCell(16).value),
      cash: cellToNumber(row.getCell(17).value),
      changeDue: cellToNumber(row.getCell(32).value),
      check: cellToNumber(row.getCell(18).value),
      gcRedemption: cellToNumber(row.getCell(19).value),
      packageRedemption: cellToNumber(row.getCell(20).value),
      membership: cellToNumber(row.getCell(21).value),
      cc: cellToNumber(row.getCell(22).value),
      bankAccount: cellToNumber(row.getCell(23).value),
      buyNowPayLater: cellToNumber(row.getCell(24).value),
      otherAmount: cellToNumber(row.getCell(25).value),
      iouAmount: cellToNumber(row.getCell(26).value),
      source: cellToString(row.getCell(8).value),
      chargeMethod: cellToString(row.getCell(31).value),
      checkedOutBy: cellToString(row.getCell(2).value),
    };

    transactions.push(transaction);
  });

  if (!transactions.length) {
    console.log("No transaction rows detected; nothing to import.");
    return;
  }

  console.log(`Prepared ${transactions.length} transactions for import.`);

  let inserted = 0;
  for (const tx of transactions) {
    const eventId = `manual-${tx.transactionId}-${tx.rowNumber}`;
    const existing = await prisma.webhookEvent.findUnique({ where: { eventId } });
    if (existing) {
      console.log(`Skipping existing event ${eventId}`);
      continue;
    }

    const netCash = Math.max(tx.cash - tx.changeDue, 0);
    const createdDateIso = tx.checkoutDate.toISOString();
    const transactionDateIso = tx.checkoutDate.toISOString();
    const payloadBody = {
      transactionDate: transactionDateIso,
      businessId: "manual-import",
      businessAlias: "Manual Import",
      transactionId: tx.transactionId,
      userPaymentId: `manual-payment-${tx.rowNumber}`,
      userPaymentsMstId: `manual-mst-${tx.rowNumber}`,
      brandName: tx.chargeMethod || null,
      itemSold: tx.itemSold,
      purchaseType: tx.purchaseType || "Services",
      quantity: tx.quantity,
      ccAmount: tx.cc,
      cashAmount: netCash,
      checkAmount: tx.check,
      achAmount: 0,
      packageRedemption: tx.packageRedemption,
      bankAccountAmount: tx.bankAccount,
      vagaroPayLaterAmount: tx.buyNowPayLater,
      otherAmount: tx.otherAmount,
      points: 0,
      gcRedemption: tx.gcRedemption,
      tax: tx.tax.toString(),
      tip: tx.tip,
      discount: tx.discount,
      memberShipAmount: tx.membership,
      productDiscount: 0,
      ccType: tx.chargeMethod || "Manual",
      ccMode: "Manual",
      customerId: toCustomerId(tx.customerName, tx.rowNumber),
      serviceProviderId: tx.serviceProviderId,
      serviceProviderName: tx.serviceProviderName,
      businessGroupId: "manual-group",
      amountDue: tx.amountPaid,
      appointmentId: toAppointmentId(tx.appointmentDate ?? tx.checkoutDate, tx.rowNumber),
      serviceCategory: "ManualImport",
      createdBy: tx.checkedOutBy || "manual-upload",
      source: tx.source || "Manual",
      changeDue: tx.changeDue,
      customerName: tx.customerName,
      appointmentDate: tx.appointmentDate ? tx.appointmentDate.toISOString() : null,
      iouAmount: tx.iouAmount,
    };

    const payload = {
      id: eventId,
      type: "transaction",
      action: "created",
      payload: payloadBody,
      createdDate: createdDateIso,
    };

    await prisma.webhookEvent.create({
      data: {
        eventId,
        entityType: "transaction",
        action: "created",
        businessIds: ["manual-import"],
        createdDate: tx.checkoutDate,
        receivedAt: new Date(),
        rawBody: JSON.stringify({ id: eventId, createdDate: createdDateIso, type: "transaction", action: "created", payload: payloadBody }),
        headers: { "x-manual-upload": "isa.xlsx" },
        payload,
        sourceIp: "manual-import",
        userAgent: "excel-import-script",
        day: new Date(Date.UTC(tx.checkoutDate.getUTCFullYear(), tx.checkoutDate.getUTCMonth(), tx.checkoutDate.getUTCDate())),
      },
    });

    inserted += 1;
    console.log(`Inserted ${eventId}`);
  }

  console.log(`Import complete. Inserted ${inserted} events.`);
}

main()
  .catch(err => {
    console.error("Failed to import isa.xlsx", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
