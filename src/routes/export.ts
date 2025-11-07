import { Router } from "express";
import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma";

const router = Router();

/**
 * GET /export/webhooks.xlsx
 * Optional query params: entityType, action, dateFrom, dateTo, limit
 * If DASH_TOKEN is set, /export is protected by the gate in index.ts (same as /events, /dashboard).
 */
router.get("/webhooks.xlsx", async (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "10000", 10), 100000);
  const entityType = (req.query.entityType as string) || undefined;
  const action = (req.query.action as string) || undefined;
  const dateFrom = (req.query.dateFrom as string) || undefined;
  const dateTo = (req.query.dateTo as string) || undefined;

  const where: any = {};
  if (entityType) where.entityType = entityType;
  if (action) where.action = action;
  if (dateFrom || dateTo) {
    where.receivedAt = {};
    if (dateFrom) where.receivedAt.gte = new Date(dateFrom);
    if (dateTo) where.receivedAt.lte = new Date(dateTo);
  }

  // Pull rows (you can switch to cursor paging later if needed)
  const rows = await prisma.webhookEvent.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: limit,
  });

  // Build workbook
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Webhooks");

  ws.columns = [
    { header: "id", key: "id", width: 28 },
    { header: "eventId", key: "eventId", width: 28 },
    { header: "entityType", key: "entityType", width: 16 },
    { header: "action", key: "action", width: 16 },
    { header: "businessIds", key: "businessIds", width: 24 },
    { header: "createdDate", key: "createdDate", width: 22 },
    { header: "receivedAt", key: "receivedAt", width: 22 },
    { header: "sourceIp", key: "sourceIp", width: 18 },
    { header: "userAgent", key: "userAgent", width: 24 },
    { header: "payload", key: "payload", width: 60 },
  ];

  for (const r of rows) {
    ws.addRow({
      id: r.id,
      eventId: r.eventId,
      entityType: r.entityType,
      action: r.action,
      businessIds: Array.isArray(r.businessIds) ? r.businessIds.join(",") : "",
      createdDate: r.createdDate?.toISOString?.() ?? r.createdDate,
      receivedAt: r.receivedAt?.toISOString?.() ?? r.receivedAt,
      sourceIp: r.sourceIp || "",
      userAgent: r.userAgent || "",
      payload: safeStringify(r.payload),
    });
  }

  // Freeze header
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // Send as download
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="webhooks-${yyyy}${mm}${dd}.xlsx"`);

  await wb.xlsx.write(res);
  res.end();
});

function safeStringify(value: any) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

export default router;
