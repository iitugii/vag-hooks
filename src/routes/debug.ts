import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

function requireToken(req: express.Request) {
  const headerToken = (req.header("x-auth-token") || "").trim();
  const queryToken = (req.query.auth as string) || (req.query.token as string) || "";
  const token = headerToken || queryToken.trim();
  return !!process.env.DASH_TOKEN && token === process.env.DASH_TOKEN;
}

/**
 * GET /debug-cash-list?date=YYYY-MM-DD
 * Lists ONLY rows where cash != 0 and shows amountCash, discount, tip, amountDue.
 * Works for both top-level and nested payload.payload.
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
    sources: { cashKey: string; discountKey?: string; tipKey?: string; amountDueKey?: string };
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

      /* cash variants, non-zero only */
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

      /* amountDue variants */
      COALESCE(
        (payload->>'amountDue')::numeric,
        (payload->'payload'->>'amountDue')::numeric,
        0
      )::double precision AS amount_due,

      /* quick source hints */
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

router.get("/debug-payload", async (req, res) => {
  if (!requireToken(req)) return res.status(403).json({ ok: false, error: "unauthorized" });

  const timestampParam = ((req.query.timestamp as string) || "").trim();
  const dateParam = ((req.query.date as string) || "").trim();
  const timeParam = ((req.query.time as string) || "").trim();

  const normalizeDate = (input: string): string | null => {
    if (!input) return null;
    const iso = input.match(/^\d{4}-\d{2}-\d{2}$/);
    if (iso) return input;
    const md = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (md) {
      const [ , m, d, y ] = md;
      const pad = (v: string) => v.padStart(2, "0");
      return `${y}-${pad(m)}-${pad(d)}`;
    }
    return null;
  };

  const normalizeTime = (input: string): string | null => {
    if (!input) return null;
    let raw = input.replace(/,/g, " ").trim().toUpperCase();
    let modifier: "AM" | "PM" | null = null;
    if (raw.endsWith("AM")) {
      modifier = "AM";
      raw = raw.slice(0, -2).trim();
    } else if (raw.endsWith("PM")) {
      modifier = "PM";
      raw = raw.slice(0, -2).trim();
    }
    const parts = raw.split(":");
    if (parts.length < 2) return null;
    const [hStr, mStr, sStr = "0"] = parts;
    let hours = Number(hStr);
    const minutes = Number(mStr);
    const seconds = Number(sStr);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }
    if (modifier) {
      hours = hours % 12;
      if (modifier === "PM") hours += 12;
    }
    const pad = (value: number) => String(Math.trunc(value)).padStart(2, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  };

  const resolveInputs = (): { date: string; time: string } | null => {
    if (timestampParam) {
      const cleaned = timestampParam.replace(/T/, " ").replace(/,/g, " ").trim();
      const pieces = cleaned.split(/\s+/);
      if (pieces.length >= 2) {
        const maybeDate = normalizeDate(pieces[0]);
        const maybeTime = normalizeTime(pieces.slice(1).join(" "));
        if (maybeDate && maybeTime) return { date: maybeDate, time: maybeTime };
      }
    }
    const maybeDate = normalizeDate(dateParam);
    const maybeTime = normalizeTime(timeParam);
    if (maybeDate && maybeTime) return { date: maybeDate, time: maybeTime };
    return null;
  };

  const normalized = resolveInputs();
  if (!normalized) {
    return res.status(400).json({
      ok: false,
      error: "Provide timestamp=, or date=YYYY-MM-DD and time=HH:MM:SS (24h or include AM/PM).",
    });
  }

  const tsLocal = `${normalized.date} ${normalized.time}`;

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      event_id: string | null;
      ts_local: string;
      payload: unknown;
    }>
  >`
    WITH base AS (
      SELECT
        id,
        "eventId",
        payload,
        COALESCE("createdDate","receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local
      FROM "WebhookEvent"
    )
    SELECT
      id,
      "eventId" AS event_id,
      to_char(ts_local, 'YYYY-MM-DD HH24:MI:SS') AS ts_local,
      payload
    FROM base
    WHERE to_char(ts_local, 'YYYY-MM-DD HH24:MI:SS') = ${tsLocal}
    ORDER BY ts_local
    LIMIT 20;
  `;

  res.json({ ok: true, query: tsLocal, count: rows.length, rows });
});

export default router;
