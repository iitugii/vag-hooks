import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

/**
 * GET /metrics/cash-daily?month=YYYY-MM
 * Optional: ?auth=... via gate middleware; returns [{ day: 'YYYY-MM-DD', total: number }]
 */
router.get("/cash-daily", async (req, res) => {
  try {
    const monthStr = (req.query.month as string) || currentMonth();
    // monthStr = "YYYY-MM"
    const [year, mon] = monthStr.split("-").map(Number);
    if (!year || !mon || mon < 1 || mon > 12) {
      return res.status(400).json({ error: "Invalid month. Use YYYY-MM." });
    }

    const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, mon, 1, 0, 0, 0)); // next month start (exclusive)

    // Pull events in this createdDate range and compute totals
    const events = await prisma.webhookEvent.findMany({
      where: {
        createdDate: { gte: start, lt: end },
      },
      orderBy: { createdDate: "asc" },
    });

    const totals: Record<string, number> = {};

    for (const e of events) {
      const p: any = e.payload || {};
      // prefer stored cash_collected, else compute from both camel+lower
      let val: number | null = null;
      if (typeof p.cash_collected === "number") {
        val = p.cash_collected;
      } else {
        const ca = toNumber(p.cashAmount ?? p.cashamount);
        const ad = toNumber(p.amountDue ?? p.amountdue);
        if (ca !== null && ad !== null) val = Math.max(0, ca - ad);
      }
      if (val === null) continue;

      const d = e.createdDate;
      const key = isoDateUTC(d); // YYYY-MM-DD in UTC
      totals[key] = (totals[key] || 0) + val;
    }

    const out = Object.keys(totals).sort().map(k => ({
      day: k,
      total: Math.round(totals[k] * 100) / 100,
    }));

    res.json({ month: monthStr, results: out });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Internal error" });
  }
});

function currentMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isoDateUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function toNumber(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export default router;

// Monthly sales summary for a given year, using the same tender logic as cashout.ts (soldTotal).
router.get("/sales/monthly", async (req, res) => {
  try {
    const year = parseInt((req.query.year as string) || "2025", 10);
    if (!year || year < 2000 || year > 2100) {
      return res.status(400).json({ error: "Invalid year." });
    }

    type Row = {
      year: number;
      month: number;
      sold_total: number;
      client_count: number;
    };

    const rows = await prisma.$queryRaw<Row[]>`
      WITH base AS (
        SELECT
          payload,
          COALESCE("createdDate", "receivedAt")
            AT TIME ZONE 'UTC'
            AT TIME ZONE 'America/New_York' AS ts_local
        FROM "WebhookEvent"
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
        FROM base
      ),
      normalized AS (
        SELECT
          ts_local,
          cash_tender,
          card_tender,
          change_due,
          transaction_id,
          service_qty,
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
        EXTRACT(YEAR FROM ts_local) AS year,
        EXTRACT(MONTH FROM ts_local) AS month,
        SUM(GREATEST(tender_total - change_due, 0))::double precision AS sold_total,
        COUNT(DISTINCT transaction_id) AS client_count
      FROM normalized
      WHERE EXTRACT(YEAR FROM ts_local) = ${year}
      GROUP BY year, month
      ORDER BY year, month;
    `;

    const monthlySales = new Array(12).fill(0);
    const monthlyClients = new Array(12).fill(0);

    for (const r of rows) {
      const mi = (r.month || 0) - 1;
      if (mi >= 0 && mi < 12) {
        monthlySales[mi] = Number(r.sold_total || 0);
        monthlyClients[mi] = Number(r.client_count || 0);
      }
    }

    return res.json({ year, monthlySales, monthlyClients });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});
