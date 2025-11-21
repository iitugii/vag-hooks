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

type Row = {
  day_local: string;
  cash_total: number;
  sold_total: number;
  client_count: number;
  service_count: number;
};

// GET /cashout/data -> monthly cash summary for the calendar widget.
router.get("/data", async (req: Request, res: Response) => {
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
          COALESCE("createdDate", "receivedAt")
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
            (payload->>'ccAmount')::numeric,
            (payload->'payload'->>'ccAmount')::numeric,
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
            (payload->>'changeDue')::numeric,
            (payload->'payload'->>'changeDue')::numeric,
            (payload->>'change')::numeric,
            (payload->'payload'->>'change')::numeric,
            0
          )::double precision AS change_due,

          /* sum over tender arrays if present */
          COALESCE(
            (SELECT SUM(
              COALESCE(
                (t->>'amount')::numeric,
                (t->>'amountPaid')::numeric,
                (t->>'tenderAmount')::numeric,
                (t->>'total')::numeric,
                0
              )
            ) FROM jsonb_array_elements(payload->'tenders') t),
            0
          )::double precision AS tender_array_total,

          /* same for nested payload.tenders */
          COALESCE(
            (SELECT SUM(
              COALESCE(
                (t->>'amount')::numeric,
                (t->>'amountPaid')::numeric,
                (t->>'tenderAmount')::numeric,
                (t->>'total')::numeric,
                0
              )
            ) FROM jsonb_array_elements(payload->'payload'->'tenders') t),
            0
          )::double precision AS nested_tender_array_total,

          /* payments array variants */
          COALESCE(
            (SELECT SUM(
              COALESCE(
                (p->>'amount')::numeric,
                (p->>'amountPaid')::numeric,
                (p->>'tenderAmount')::numeric,
                (p->>'total')::numeric,
                0
              )
            ) FROM jsonb_array_elements(payload->'payments') p),
            0
          )::double precision AS payments_array_total,

          COALESCE(
            (SELECT SUM(
              COALESCE(
                (p->>'amount')::numeric,
                (p->>'amountPaid')::numeric,
                (p->>'tenderAmount')::numeric,
                (p->>'total')::numeric,
                0
              )
            ) FROM jsonb_array_elements(payload->'payload'->'payments') p),
            0
          )::double precision AS nested_payments_array_total,

          COALESCE(
            NULLIF((payload->>'transactionId')::text, ''),
            NULLIF((payload->'payload'->>'transactionId')::text, ''),
            NULLIF((payload->>'userPaymentsMstId')::text, ''),
            NULLIF((payload->'payload'->>'userPaymentsMstId')::text, '')
          ) AS transaction_id,

          COALESCE(
            (payload->>'quantity')::numeric,
            (payload->'payload'->>'quantity')::numeric,
            1
          )::double precision AS service_qty
        FROM month_scope
      ),
      normalized AS (
        SELECT
          ts_local,
          cash_tender,
          card_tender,
          change_due,
          transaction_id,
          service_qty,
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
            NULLIF(tender_array_total, 0),
            NULLIF(nested_tender_array_total, 0),
            NULLIF(payments_array_total, 0),
            NULLIF(nested_payments_array_total, 0),
            cash_tender + card_tender
          )::double precision AS tender_total
        FROM base_amounts
      )
      SELECT
        to_char(ts_local::date, 'YYYY-MM-DD') AS day_local,
        /* green: cash collected (cash tendered minus change due) */
        SUM(GREATEST(cash_tender - change_due, 0))::double precision AS cash_total,

        /* blue: total sold (all tendered minus change) */
        SUM(GREATEST(tender_total - change_due, 0))::double precision AS sold_total,

        COUNT(DISTINCT transaction_id) AS client_count,
        SUM(service_qty)::double precision AS service_count
      FROM normalized
      GROUP BY ts_local::date
      ORDER BY ts_local::date;
    `;

    const data = rows.map((r: Row) => ({
      day: r.day_local,
      cashTotal: Number(r.cash_total || 0),
      soldTotal: Number(r.sold_total || 0),
      clientCount: Number(r.client_count || 0),
      serviceCount: Number(r.service_count || 0)
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
