import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /debug-cash?date=YYYY-MM-DD
 * Token-protected (x-auth-token must equal DASH_TOKEN).
 * Returns each row's cashAmount, changeDue, amountDue, and computed nets for the local day.
 */
router.get("/debug-cash", async (req, res) => {
  const token = (req.header("x-auth-token") || "").trim();
  if (!process.env.DASH_TOKEN || token !== process.env.DASH_TOKEN) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

  // Pull rows for the LOCAL (America/New_York) calendar day
  const rows = await prisma.$queryRaw<any[]>`
    WITH base AS (
      SELECT
        id,
        payload,
        COALESCE("createdDate","receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local
      FROM "WebhookEvent"
    )
    SELECT
      id,
      to_char(ts_local, 'YYYY-MM-DD HH24:MI:SS') AS ts_local,
      payload
    FROM base
    WHERE ts_local::date = ${date}::date
    ORDER BY ts_local ASC;
  `;

  let sumCash = 0, sumChange = 0, sumOldChange = 0;

  const audit = rows.map(r => {
    const p = r.payload || {};
    const inner = p.payload || {};
    const cashAmount = Number(p.cashAmount ?? inner.cashAmount ?? 0);
    const changeDue  = Number(p.changeDue  ?? inner.changeDue  ?? 0);
    const amountDue  = Number(p.amountDue  ?? inner.amountDue  ?? 0);

    sumCash   += cashAmount;
    sumChange += changeDue;

    return {
      id: r.id,
      ts_local: r.ts_local,
      cashAmount,
      changeDue,
      amountDue,
      computed_current_logic: +(cashAmount - changeDue).toFixed(2),
      computed_old_logic:     +(cashAmount - amountDue).toFixed(2),
    };
  });

  res.json({
    ok: true,
    date,
    count: audit.length,
    totals: {
      cash_in: +sumCash.toFixed(2),
      change_out: +sumChange.toFixed(2),
      net_current_logic: +(sumCash - sumChange).toFixed(2),
    },
    audit,
  });
});

export default router;
