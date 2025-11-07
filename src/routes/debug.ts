import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

function num(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * GET /debug-cash?date=YYYY-MM-DD
 * Token-protected (x-auth-token == DASH_TOKEN).
 * Shows per-row money fields and totals for multiple key variants.
 */
router.get("/debug-cash", async (req, res) => {
  const token = (req.header("x-auth-token") || "").trim();
  if (!process.env.DASH_TOKEN || token !== process.env.DASH_TOKEN) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

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

  let sumCashA = 0, sumChangeA = 0;
  let sumCashB = 0, sumChangeB = 0;

  const audit = rows.map(r => {
    const p = r.payload || {};
    const inner = p.payload || {};

    // Variant A (what we used): cashAmount - changeDue
    const cashAmountA = num(p.cashAmount ?? inner.cashAmount);
    const changeDueA  = num(p.changeDue  ?? inner.changeDue);

    // Variant B (alt names seen in various systems): cash - change
    const cashB   = num(p.cash ?? inner.cash ?? p.cash_in ?? inner.cash_in ?? p.tenderAmount ?? inner.tenderAmount);
    const changeB = num(p.change ?? inner.change ?? p.change_out ?? inner.change_out ?? p.changeGiven ?? inner.changeGiven);

    sumCashA += cashAmountA;
    sumChangeA += changeDueA;

    sumCashB += cashB;
    sumChangeB += changeB;

    // Collect keys containing "cash" or "change" to see actual naming in payload
    const keysTop = Object.keys(p || {}).filter(k => /cash|change/i.test(k)).slice(0, 12);
    const keysInner = Object.keys(inner || {}).filter(k => /cash|change/i.test(k)).slice(0, 12);

    return {
      id: r.id,
      ts_local: r.ts_local,
      // Show both variants
      A_cashAmount: cashAmountA,
      A_changeDue: changeDueA,
      A_net: +(cashAmountA - changeDueA).toFixed(2),

      B_cash: cashB,
      B_change: changeB,
      B_net: +(cashB - changeB).toFixed(2),

      // quick peek at names present
      keysTop,
      keysInner
    };
  });

  res.json({
    ok: true,
    date,
    count: audit.length,
    totals: {
      variant_A: {
        cash_in: +sumCashA.toFixed(2),
        change_out: +sumChangeA.toFixed(2),
        net: +(sumCashA - sumChangeA).toFixed(2),
      },
      variant_B: {
        cash_in: +sumCashB.toFixed(2),
        change_out: +sumChangeB.toFixed(2),
        net: +(sumCashB - sumChangeB).toFixed(2),
      }
    },
    audit
  });
});

export default router;

export default router;
