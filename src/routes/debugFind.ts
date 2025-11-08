import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /debug-find-cash?date=YYYY-MM-DD&amount=25
 * Token-protected via x-auth-token == DASH_TOKEN
 */
router.get("/debug-find-cash", async (req, res) => {
  const token = (req.header("x-auth-token") || "").trim();
  if (!process.env.DASH_TOKEN || token !== process.env.DASH_TOKEN) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const date = (req.query.date as string) || new Date().toISOString().slice(0,10);
  const amount = parseFloat((req.query.amount as string) || "25");
  if (!Number.isFinite(amount)) return res.status(400).json({ ok:false, error:"bad amount" });

  const rows = await prisma.$queryRaw<any[]>`
    WITH base AS (
      SELECT
        id, "eventId", payload,
        COALESCE("createdDate","receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local
      FROM "WebhookEvent"
    )
    SELECT
      id,
      "eventId",
      to_char(ts_local, 'YYYY-MM-DD HH24:MI:SS') AS ts_local,
      CASE
        WHEN (payload->>'amountCash')::numeric = ${amount} THEN 'amountCash'
        WHEN (payload->'payload'->>'amountCash')::numeric = ${amount} THEN 'payload.amountCash'
        WHEN (payload->>'cashAmount')::numeric = ${amount} THEN 'cashAmount'
        WHEN (payload->'payload'->>'cashAmount')::numeric = ${amount} THEN 'payload.cashAmount'
        WHEN (payload->>'cash')::numeric = ${amount} THEN 'cash'
        WHEN (payload->'payload'->>'cash')::numeric = ${amount} THEN 'payload.cash'
        WHEN (payload->>'cash_in')::numeric = ${amount} THEN 'cash_in'
        WHEN (payload->'payload'->>'cash_in')::numeric = ${amount} THEN 'payload.cash_in'
        WHEN (payload->>'tenderAmount')::numeric = ${amount} THEN 'tenderAmount'
        WHEN (payload->'payload'->>'tenderAmount')::numeric = ${amount} THEN 'payload.tenderAmount'
        ELSE 'none'
      END AS matchedKey
    FROM base
    WHERE ts_local::date = ${date}::date
      AND (
        (payload->>'amountCash')::numeric = ${amount} OR
        (payload->'payload'->>'amountCash')::numeric = ${amount} OR
        (payload->>'cashAmount')::numeric = ${amount} OR
        (payload->'payload'->>'cashAmount')::numeric = ${amount} OR
        (payload->>'cash')::numeric = ${amount} OR
        (payload->'payload'->>'cash')::numeric = ${amount} OR
        (payload->>'cash_in')::numeric = ${amount} OR
        (payload->'payload'->>'cash_in')::numeric = ${amount} OR
        (payload->>'tenderAmount')::numeric = ${amount} OR
        (payload->'payload'->>'tenderAmount')::numeric = ${amount}
      )
    ORDER BY ts_local;
  `;

  res.json({ ok:true, date, amount, count: rows.length, rows });
});

export default router;
