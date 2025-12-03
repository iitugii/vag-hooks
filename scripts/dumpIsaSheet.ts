import path from "path";
import Excel from "exceljs";

async function main() {
  const filePath = path.resolve(__dirname, "../src/csv/isa.xlsx");
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error("No worksheet found in isa.xlsx");
    process.exit(1);
  }

  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value || "").trim();
  });

  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const entry: Record<string, unknown> = { rowNumber };
    row.eachCell((cell, colNumber) => {
      const key = headers[colNumber - 1] || `col_${colNumber}`;
      entry[key] = cell.value;
    });
    rows.push(entry);
  });

  console.log(`Loaded ${rows.length} rows`);
  for (const row of rows) {
    console.log(row);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
