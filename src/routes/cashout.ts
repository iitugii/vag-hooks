import express from "express";
import { PrismaClient } from "@prisma/client";
import path from "path";

const router = express.Router();
const prisma = new PrismaClient();

router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/cashout.html"));
});

type Row = { day_local: string; cash_total: number; sold_total: number };

router.get("/data", async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt((req.query.year as string) || `${now.getFullYear()}`, 10);
    const month = parseInt((req.query.month as string) || `${now.getMonth() + 1}`, 10);
    const monthStr = String(month).padStart(2, "0");

    // Aggregate per local day
    const rows = await prisma.$queryRaw<Row[]>`
      WITH base AS (
        SELECT
          payload,
          COALESCE("createdDate","receivedAt")
            AT TIME ZONE 'UTC'
            AT TIME ZONE 'America/New_York' AS ts_local
        FROM "WebhookEvent"
      ),
      month_scope AS (
        SELECT *
        FROM base
        WHERE date_trunc('month', ts_local)::date = (${year} || '-' || ${monthStr} || '-01')::date
      ),
      base_amounts AS (
        SELECT
          payload,
          ts_local,
          /* cash tendered */
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
          )::double precision AS cash_tender,

          /* credit-card tendered */
          COALESCE(
            (payload->>'creditCardAmount')::numeric,
            (payload->'payload'->>'creditCardAmount')::numeric,
            (payload->>'creditAmount')::numeric,
            (payload->'payload'->>'creditAmount')::numeric,
            (payload->>'cardAmount')::numeric,
            (payload->'payload'->>'cardAmount')::numeric,
            (payload->>'amountCredit')::numeric,
            (payload->'payload'->>'amountCredit')::numeric,
            (payload->>'amountCard')::numeric,
            (payload->'payload'->>'amountCard')::numeric,
            0
          )::double precision AS card_tender,

          /* change due back to customer */
          COALESCE(
            (payload->>'amountDue')::numeric,
            (payload->'payload'->>'amountDue')::numeric,
            0
          )::double precision AS change_due
        FROM month_scope
      ),
      normalized AS (
        SELECT
          ts_local,
          cash_tender,
          card_tender,
          change_due,
          /* total tendered (cash + card) */
          COALESCE(
            (payload->>'totalAmount')::numeric,
            (payload->'payload'->>'totalAmount')::numeric,
            (payload->>'amountTotal')::numeric,
            (payload->'payload'->>'amountTotal')::numeric,
            (payload->>'amount')::numeric,
            (payload->'payload'->>'amount')::numeric,
            (payload->>'total')::numeric,
            (payload->'payload'->>'total')::numeric,
            (payload->>'tenderAmount')::numeric,
            (payload->'payload'->>'tenderAmount')::numeric,
            (payload->>'amountTendered')::numeric,
            (payload->'payload'->>'amountTendered')::numeric,
            cash_tender + card_tender
          )::double precision AS tender_total
        FROM base_amounts
      )
      SELECT
        to_char(ts_local::date, 'YYYY-MM-DD') AS day_local,
        /* green: cash collected (cash tendered minus change due) */
        SUM(GREATEST(cash_tender - change_due, 0))::double precision AS cash_total,

        /* blue: total sold (all tendered minus change) */
        SUM(GREATEST(tender_total - change_due, 0))::double precision AS sold_total
      FROM normalized
      GROUP BY ts_local::date
      ORDER BY ts_local::date;
    `;

    const data = rows.map(r => ({
      day: r.day_local,
      cashTotal: Number(r.cash_total || 0),
      soldTotal: Number(r.sold_total || 0)
    }));

    res.json({ year, month, data });
  } catch (err) {
    console.error("Error fetching cashout data:", err);
    res.status(500).json({ error: "Failed to load cashout data" });
  }
});

export default router;
