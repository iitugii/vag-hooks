import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import path from "path";

// Expose `/cashout` routes via an isolated router instance.
const router = Router();
// Local Prisma client keeps the handler self-contained; consider reusing the shared client if needed.
const prisma = new PrismaClient();

// GET /cashout -> serve the calendar UI from /public.
router.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, "../../public/cashout.html"));
});

// Shape returned by the aggregation query.
type Row = { day_local: string; total: number };

// GET /cashout/data -> monthly cash summary for the calendar widget.
router.get("/data", async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const year = parseInt((req.query.year as string) || `${now.getFullYear()}`, 10);
    const month = parseInt((req.query.month as string) || `${now.getMonth() + 1}`, 10);
    const monthStr = String(month).padStart(2, "0");

    // Pull rows grouped by local trading day (America/New_York) based on cashAmount minus amountDue.
    const rows = await prisma.$queryRaw<Row[]>`
      WITH base AS (
        SELECT
          payload,
          COALESCE("createdDate", "receivedAt")
            AT TIME ZONE 'UTC'
            AT TIME ZONE 'America/New_York' AS ts_local
        FROM "WebhookEvent"
      ),
      month_scope AS (
        SELECT *
        FROM base
        WHERE date_trunc('month', ts_local)::date = (${year} || '-' || ${monthStr} || '-01')::date
      )
      SELECT
        to_char(ts_local::date, 'YYYY-MM-DD') AS day_local,
        SUM(
          COALESCE(
            (payload->>'amountCash')::numeric,
            (payload->'payload'->>'amountCash')::numeric,
            (payload->>'cashAmount')::numeric,
            (payload->'payload'->>'cashAmount')::numeric,
            (payload->>'cash')::numeric,
            (payload->'payload'->>'cash')::numeric,
            (payload->>'cash_in')::numeric,
            (payload->'payload'->>'cash_in')::numeric,
            (payload->>'tenderAmount')::numeric,
            (payload->'payload'->>'tenderAmount')::numeric,
            0
          )
          -
          COALESCE(
            (payload->>'amountDue')::numeric,
            (payload->'payload'->>'amountDue')::numeric,
            0
          )
        )::double precision AS total
      FROM month_scope
      GROUP BY ts_local::date
      ORDER BY ts_local::date;
    `;

    const data = rows.map((r: Row) => ({
      day: r.day_local,
      total: Number(r.total || 0),
    }));

    res.json({ year, month, data });
  } catch (err) {
    console.error("Error fetching cashout data:", err);
    res.status(500).json({ error: "Failed to load cashout data" });
  }
});

/*
 * Future enhancement: capture credit card tender and total sales alongside cash.
 * Uncomment and adapt this block if you need both figures in the calendar UI.
 *
 * type EnhancedRow = { day_local: string; cash_total: number; sold_total: number };
 * const rows = await prisma.$queryRaw<EnhancedRow[]>(`... normalized AS (...) SELECT ...`);
 * const data = rows.map(r => ({
 *   day: r.day_local,
 *   cashTotal: Number(r.cash_total || 0),
 *   soldTotal: Number(r.sold_total || 0),
 * }));
 */

export default router;
