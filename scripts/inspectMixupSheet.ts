import path from "path";
import Excel from "exceljs";

async function main() {
  const filePath = path.resolve(__dirname, "../src/csv/mixup.xlsx");
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("mixup.xlsx has no sheets");

  const rowsToShow = 120;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      console.log("Header row:");
    }
    if (rowNumber <= rowsToShow) {
      const values = row.values
        .slice(1)
        .map((value, idx) => `${idx + 1}:${value}`)
        .join(" | ");
      console.log(`row ${rowNumber}: ${values}`);
    }
  });
}

main().catch(err => {
  console.error("Failed to inspect mixup.xlsx", err);
  process.exit(1);
});
