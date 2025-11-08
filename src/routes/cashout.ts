import express from "express";
import { PrismaClient } from "@prisma/client";
import path from "path";

const router = express.Router();
const prisma = new PrismaClient();

router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/cashout.html"));
});

type DayRow = {
  day_local: string;
  cash_collected: number;
  change_given: number;
  other_outflows: number;
};

router.get("/data", async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt((req.query.year as string) || `${now.getFullYear()}`, 10);
    const month = parseInt((req.query.month as string) || `${now.getMonth() + 1}`, 10);
    const monthStr = String(month).padStart(2, "0");

    // Optional opening balance (ENV or query); default 0 if not provided
    const openingFromEnv = process.env.INITIAL_OPENING_CASH ? Number(process.env.INITIAL_OPENING_CASH) : 0;
    const openingParam = req.query.opening ? Number(req.query.opening) : undefined;
    const initialOpening = Number.isFinite(openingParam!) ? (openingParam as number) : openingFromEnv;

    // Aggregate by LOCAL day (America/New_York)
    const rows = await prisma.$queryRaw<DayRow[]>`
      WITH base AS (
        SELECT
          payload,
          COALESCE("createdDate","receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local
        FROM "WebhookEvent"
      ),
      month_scope AS (
        SELECT *
        FROM base
        WHERE date_trunc('month', ts_local)::date = (${year} || '-' || ${monthStr} || '-01')::date
      )
      SELECT
        to_char(ts_local::date, 'YYYY-MM-DD') AS day_local,

        /* CASH COLLECTED (money into drawer) */
        SUM(
          COALESCE( (payload->>'amountCash')::numeric,
                    (payload->'payload'->>'amountCash')::numeric,
                    (payload->>'cashAmount')::numeric,
                    (payload->'payload'->>'cashAmount')::numeric,
                    (payload->>'cash')::numeric,
                    (payload->'payload'->>'cash')::numeric,
                    (payload->>'cash_in')::numeric,
                    (payload->'payload'->>'cash_in')::numeric,
                    (payload->>'tenderAmount')::numeric,
                    (payload->'payload'->>'tenderAmount')::numeric,
                    0)
        )::double precision AS cash_collected,

        /* CHANGE GIVEN (cash out of drawer to customer) */
        SUM(
          COALESCE( (payload->>'changeDue')::numeric,
                    (payload->'payload'->>'changeDue')::numeric,
                    (payload->>'change')::numeric,
                    (payload->'payload'->>'change')::numeric,
                    (payload->>'change_out')::numeric,
                    (payload->'payload'->>'change_out')::numeric,
                    (payload->>'changeGiven')::numeric,
                    (payload->'payload'->>'changeGiven')::numeric,
                    0)
        )::double precision AS change_given,

        /* OTHER CASH OUTFLOWS (payouts/refunds/adjustments) */
        SUM(
          COALESCE( (payload->>'cashOut')::numeric,
                    (payload->'payload'->>'cashOut')::numeric,
                    (payload->>'payout')::numeric,
                    (payload->'payload'->>'payout')::numeric,
                    (payload->>'paidOut')::numeric,
                    (payload->'payload'->>'paidOut')::numeric,
                    (payload->>'drawerAdjustment')::numeric,
                    (payload->'payload'->>'drawerAdjustment')::numeric,
                    (payload->>'pettyCash')::numeric,
                    (payload->'payload'->>'pettyCash')::numeric,
                    (payload->>'cashWithdrawal')::numeric,
                    (payload->'payload'->>'cashWithdrawal')::numeric,
                    (payload->>'withdrawal')::numeric,
                    (payload->'payload'->>'withdrawal')::numeric,
                    (payload->>'refundCash')::numeric,
                    (payload->'payload'->>'refundCash')::numeric,
                    0)
        )::double precision AS other_outflows

      FROM month_scope
      GROUP BY ts_local::date
      ORDER BY ts_local::date ASC;
    `;

    // Build a continuous calendar for the month (fill missing days with zeros)
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayMap: Record<string, DayRow> = {};
    for (const r of rows) dayMap[r.day_local] = r;

    const daily = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const r = dayMap[key];
      daily.push({
        day: key,
        cashCollected: r ? r.cash_collected || 0 : 0,
        changeGiven: r ? r.change_given || 0 : 0,
        otherOutflows: r ? r.other_outflows || 0 : 0,
      });
    }

    // Compute opening/closing as a running balance per day
    let running = initialOpening;
    const out = daily.map((d) => {
      const opening = running;
      const closing = opening + d.cashCollected - d.changeGiven - d.otherOutflows;
      running = closing;
      return {
        day: d.day,
        opening: Number(opening.toFixed(2)),
        cashCollected: Number(d.cashCollected.toFixed(2)),
        changeGiven: Number(d.changeGiven.toFixed(2)),
        otherOutflows: Number(d.otherOutflows.toFixed(2)),
        closing: Number(closing.toFixed(2)),
        netDelta: Number((d.cashCollected - d.changeGiven - d.otherOutflows).toFixed(2)),
      };
    });

    res.json({
      year,
      month,
      openingStart: Number(initialOpening.toFixed(2)),
      data: out,
    });
  } catch (err) {
    console.error("Error fetching cashout data:", err);
    res.status(500).json({ error: "Failed to load cashout data" });
  }
});

export default router;
