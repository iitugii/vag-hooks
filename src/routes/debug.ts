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

/** GET /debug-cash?date=YYYY-MM-DD  (x-auth-token == DASH_TOKEN) */
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

  let cashOnly = 0;

  const audit = rows.map(r => {
    const p = r.payload || {};
    const inner = p.payload || {};

    const cash =
      num(p.cashAmount ?? inner.cashAmount) ||
      num(p.cash ?? inner.cash) ||
      num(p.cash_in ?? inner.cash_in) ||
      num(p.tenderAmount ?? inner.tenderAmount);

    cashOnly += cash;

    return {
      id: r.id,
      ts_local: r.ts_local,
      cashAmount: num(p.cashAmount ?? inner.cashAmount),
      cash_alt: cash, // what we actually sum
    };
  });

  res.json({
    ok: true,
    date,
    count: audit.length,
    totals: {
      cash_only: +cashOnly.toFixed(2)
    },
    audit
  });
});

export default router;
