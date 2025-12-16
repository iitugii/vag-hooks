import path from "path";
import Excel from "exceljs";

type RowSnapshot = {
  rowNumber: number;
  checkout: string;
  txId: string;
  appt: string;
  customer: string;
  itemSold: string;
  provider: string;
  amountDue: string;
  cash: string;
  cc: string;
};

function snap(ws: Excel.Worksheet, rowNumber: number): RowSnapshot {
  const row = ws.getRow(rowNumber);
  return {
    rowNumber,
    checkout: String(row.getCell(1).text || "").trim(),
    txId: String(row.getCell(3).text || "").trim(),
    appt: String(row.getCell(4).text || "").trim(),
    customer: String(row.getCell(5).text || "").trim(),
    itemSold: String(row.getCell(6).text || "").trim(),
    provider: String(row.getCell(9).text || "").trim(),
    amountDue: String(row.getCell(12).text || "").trim(),
    cash: String(row.getCell(17).text || "").trim(),
    cc: String(row.getCell(22).text || "").trim(),
  };
}

function toNumber(value: string): number {
  const cleaned = (value || "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cellToNumber(value: Excel.CellValue | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return toNumber(value);
  if (value instanceof Date) return 0;
  if (typeof value === "object") {
    const candidate: any = value;
    if (typeof candidate.result === "number") return candidate.result;
    if (typeof candidate.result === "string") return toNumber(candidate.result);
    if (typeof candidate.text === "string") return toNumber(candidate.text);
    if (Array.isArray(candidate.richText)) {
      const joined = candidate.richText.map((p: { text: string }) => p.text).join("");
      return toNumber(joined);
    }
  }
  return toNumber(String(value));
}

async function main() {
  const file = path.join(process.cwd(), "src", "csv", "dec2025", "12-12-2025.xlsx");
  const wb = new Excel.Workbook();
  await wb.xlsx.readFile(file);

  console.log("Workbook:", path.basename(file));
  console.log("Sheets:", wb.worksheets.map(w => w.name));

  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheet found");

  console.log(
    "Sheet:",
    ws.name,
    "rowCount:",
    ws.rowCount,
    "actualRowCount:",
    ws.actualRowCount
  );

  // Dump the bottom rows where Excel shows totals (user reports row 205).
  const dumpStart = 203;
  const dumpEnd = Math.min(209, ws.rowCount);
  console.log("");
  console.log(`Bottom row dump (rows ${dumpStart}-${dumpEnd}):`);
  for (let rn = dumpStart; rn <= dumpEnd; rn++) {
    const row = ws.getRow(rn);
    const c1 = String(row.getCell(1).text || "").trim();
    const c3 = String(row.getCell(3).text || "").trim();
    const c5 = String(row.getCell(5).text || "").trim();
    const c6 = String(row.getCell(6).text || "").trim();
    const tip = cellToNumber(row.getCell(14).value);
    const amountDue = cellToNumber(row.getCell(12).value);
    const cash = cellToNumber(row.getCell(17).value);
    const cc = cellToNumber(row.getCell(22).value);
    const hasAny = [c1, c3, c5, c6].some(Boolean) || tip !== 0 || amountDue !== 0 || cash !== 0 || cc !== 0;
    if (!hasAny) continue;
    console.log(
      JSON.stringify({
        rowNumber: rn,
        c1,
        c3,
        customer: c5,
        itemSold: c6,
        amountDue,
        tip,
        cash,
        cc,
      })
    );
  }

  // Find the column where the header says "Tip" (sanity-check our assumed col 14).
  let tipHeader: { row: number; col: number } | null = null;
  for (let rn = 1; rn <= Math.min(ws.actualRowCount, 60); rn++) {
    const row = ws.getRow(rn);
    for (let c = 1; c <= 40; c++) {
      const text = String(row.getCell(c).text || "")
        .trim()
        .toLowerCase();
      if (text === "tip") {
        tipHeader = { row: rn, col: c };
        break;
      }
    }
    if (tipHeader) break;
  }
  console.log("Tip header found at:", tipHeader ? `row ${tipHeader.row} col ${tipHeader.col}` : "NOT FOUND");

  let countedCurrentRule = 0;
  let countedHeuristic = 0;
  let rangeServiceRows = 0;
  let rangeBlankItemSold = 0;
  let allServiceRows = 0;
  let allServiceTipTotal = 0;
  const rangeMissingRequired: RowSnapshot[] = [];
  const blankItemSoldButHasOtherData: RowSnapshot[] = [];
  const totalLikeRows: RowSnapshot[] = [];

  for (let rn = 2; rn <= ws.actualRowCount; rn++) {
    const s = snap(ws, rn);

    const anyOther = [s.checkout, s.txId, s.customer, s.provider, s.amountDue, s.cash, s.cc].some(
      Boolean
    );
    if (!s.itemSold && anyOther) blankItemSoldButHasOtherData.push(s);

    if (s.itemSold.toLowerCase() === "total") {
      totalLikeRows.push(s);
      continue;
    }

    // Mirror the current parser gates (minus provider mapping):
    if (!s.itemSold) continue;
    if (!s.txId) continue;
    if (!s.provider) continue;
    if (!s.checkout) continue;

    countedCurrentRule += 1;
  }

  for (let rn = 2; rn <= ws.actualRowCount; rn++) {
    const s = snap(ws, rn);
    const looksServiceRow =
      Boolean(s.itemSold) &&
      s.itemSold.toLowerCase() !== "total" &&
      Boolean(s.customer) &&
      Boolean(s.provider) &&
      Boolean(s.checkout);
    if (looksServiceRow) {
      countedHeuristic += 1;
      allServiceRows += 1;
      allServiceTipTotal += cellToNumber(ws.getRow(rn).getCell(14).value);
    }
  }

  // Analyze the row range the UI is showing.
  const rangeStart = 24;
  const rangeEnd = Math.min(208, ws.actualRowCount);
  let rangeTipTotal = 0;
  for (let rn = rangeStart; rn <= rangeEnd; rn++) {
    const s = snap(ws, rn);
    if (!s.itemSold) {
      rangeBlankItemSold += 1;
      continue;
    }

    // Tip column in this export is col 14 (matches backfill script).
    rangeTipTotal += cellToNumber(ws.getRow(rn).getCell(14).value);

    const looksServiceRow =
      Boolean(s.itemSold) &&
      s.itemSold.toLowerCase() !== "total" &&
      Boolean(s.customer) &&
      Boolean(s.provider) &&
      Boolean(s.checkout);
    if (looksServiceRow) {
      rangeServiceRows += 1;
    } else {
      rangeMissingRequired.push(s);
    }
  }

  console.log("");
  console.log("Current parser would count:", countedCurrentRule);
  console.log("Heuristic service rows would count:", countedHeuristic);
  console.log("All service rows tip total:", allServiceTipTotal);
  console.log(`Rows ${rangeStart}-${rangeEnd} service rows:`, rangeServiceRows);
  console.log(`Rows ${rangeStart}-${rangeEnd} blank itemSold:`, rangeBlankItemSold);
  console.log(`Rows ${rangeStart}-${rangeEnd} non-service anomalies:`, rangeMissingRequired.length);
  console.log(`Rows ${rangeStart}-${rangeEnd} tip total:`, rangeTipTotal);
  console.log("Rows with itemSold='Total':", totalLikeRows.length);
  console.log(
    "Rows with blank itemSold but other data present:",
    blankItemSoldButHasOtherData.length
  );

  if (rangeMissingRequired.length) {
    console.log("");
    console.log("First 10 anomalies in rows 24-208:");
    for (const s of rangeMissingRequired.slice(0, 10)) {
      console.log(JSON.stringify(s));
    }
  }

  if (blankItemSoldButHasOtherData.length) {
    console.log("");
    console.log("First 10 rows with blank itemSold but other data:");
    for (const s of blankItemSoldButHasOtherData.slice(0, 10)) {
      console.log(JSON.stringify(s));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
