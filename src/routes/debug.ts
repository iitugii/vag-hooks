import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

function requireToken(req: express.Request) {
  const token = (req.header("x-auth-token") || "").trim();
  if (!process.env.DASH_TOKEN || token !== process.env.DASH_TOKEN) {
    return false;
  }
  return true;
}

/**
 * GET /debug-cash?date=YYYY-MM-DD  (existing audit; keeps working)
 */
router.get("/debug-cash", async (req, res) => {
  if (!requireToken(req)) return res.status(403).json({ ok: false, error: "unauthorized" });

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
      cash_alt: cash
    };
  });

  res.json({ ok: true, date, count: audit.length, totals: { cash_only: +cashOnly.toFixed(2) }, audit });
});

/**
 * GET /debug-cash-list?date=YYYY-MM-DD
 * Lists ONLY rows where cash != 0 and shows amountCash, discount, tip, amountDue.
 * Pulls from both top-level payload and payload.payload.
 */
router.get("/debug-cash-list", async (req, res) => {
  if (!requireToken(req)) return res.status(403).json({ ok: false, error: "unauthorized" });

  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

  type Row = {
    id: string;
    ts_local: string;
    amount_cash: number;
    discount: number;
    tip: number;
    amount_due: number;
    sources: {
      cashKey: string;
      discountKey?: string;
      tipKey?: string;
      amountDueKey?: string;
    };
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH base AS (
      SELECT
        id,
        payload,
        COALESCE("createdDate","receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local
      FROM "WebhookEvent"
    ),
    day_rows AS (
      SELECT id, payload, ts_local
      FROM base
      WHERE ts_local::date = ${date}::date
    )
    SELECT
      id,
      to_char(ts_local, 'YYYY-MM-DD HH24:MI:SS') AS ts_local,

      /* cash variants */
      COALESCE(
        NULLIF((payload->>'amountCash')::numeric, 0),
        NULLIF((payload->'payload'->>'amountCash')::numeric, 0),
        NULLIF((payload->>'cashAmount')::numeric, 0),
        NULLIF((payload->'payload'->>'cashAmount')::numeric, 0),
        NULLIF((payload->>'cash')::numeric, 0),
        NULLIF((payload->'payload'->>'cash')::numeric, 0),
        NULLIF((payload->>'cash_in')::numeric, 0),
        NULLIF((payload->'payload'->>'cash_in')::numeric, 0),
        NULLIF((payload->>'tenderAmount')::numeric, 0),
        NULLIF((payload->'payload'->>'tenderAmount')::numeric, 0),
        0
      )::double precision AS amount_cash,

      /* discount variants */
      COALESCE(
        (payload->>'discount')::numeric,
        (payload->'payload'->>'discount')::numeric,
        (payload->>'discountAmount')::numeric,
        (payload->'payload'->>'discountAmount')::numeric,
        0
      )::double precision AS discount,

      /* tip variants */
      COALESCE(
        (payload->>'tip')::numeric,
        (payload->'payload'->>'tip')::numeric,
        (payload->>'tipAmount')::numeric,
        (payload->'payload'->>'tipAmount')::numeric,
        (payload->>'gratuity')::numeric,
        (payload->'payload'->>'gratuity')::numeric,
        0
      )::double precision AS tip,

      /* amountDue */
      COALESCE(
        (payload->>'amountDue')::numeric,
        (payload->'payload'->>'amountDue')::numeric,
        0
      )::double precision AS amount_due,

      /* quick source hints (strings) */
      jsonb_build_object(
        'cashKey',
        CASE
          WHEN (payload ? 'amountCash') THEN 'amountCash'
          WHEN (payload ? 'cashAmount') THEN 'cashAmount'
          WHEN (payload ? 'cash') THEN 'cash'
          WHEN (payload ? 'cash_in') THEN 'cash_in'
          WHEN (payload ? 'tenderAmount') THEN 'tenderAmount'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'amountCash') THEN 'payload.amountCash'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'cashAmount') THEN 'payload.cashAmount'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'cash') THEN 'payload.cash'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'cash_in') THEN 'payload.cash_in'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'tenderAmount') THEN 'payload.tenderAmount'
          ELSE 'unknown'
        END,
        'discountKey',
        CASE
          WHEN (payload ? 'discount') THEN 'discount'
          WHEN (payload ? 'discountAmount') THEN 'discountAmount'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'discount') THEN 'payload.discount'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'discountAmount') THEN 'payload.discountAmount'
          ELSE NULL
        END,
        'tipKey',
        CASE
          WHEN (payload ? 'tip') THEN 'tip'
          WHEN (payload ? 'tipAmount') THEN 'tipAmount'
          WHEN (payload ? 'gratuity') THEN 'gratuity'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'tip') THEN 'payload.tip'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'tipAmount') THEN 'payload.tipAmount'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'gratuity') THEN 'payload.gratuity'
          ELSE NULL
        END,
        'amountDueKey',
        CASE
          WHEN (payload ? 'amountDue') THEN 'amountDue'
          WHEN (payload ? 'payload') AND (payload->'payload' ? 'amountDue') THEN 'payload.amountDue'
          ELSE NULL
        END
      ) AS sources

    FROM day_rows
    WHERE COALESCE(
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
    ) <> 0
    ORDER BY ts_local ASC;
  `;

  res.json({ ok: true, date, count: rows.length, rows });
});

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

export default router;
