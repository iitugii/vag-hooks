import path from "path";
import Excel from "exceljs";

async function main() {
  const [, , relativePath = "../src/csv/isa.xlsx"] = process.argv;
  const filePath = path.resolve(__dirname, relativePath);
  console.log("Loading", filePath);

  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error("No worksheet found in", relativePath);
    process.exit(1);
  }

  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value || "").trim();
  });
  console.log("Headers:", headers);

  let count = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const entry: Record<string, unknown> = { rowNumber };
    row.eachCell((cell, colNumber) => {
      const key = headers[colNumber - 1] || `col_${colNumber}`;
      entry[key] = cell.value;
    });
    console.log(entry);
    count += 1;
  });

  console.log(`Total data rows: ${count}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
