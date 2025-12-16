import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

function pickFirstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

// Simple liveness + version stamp (helps verify what Railway is running)
router.get("/", (_req, res) => {
  const gitSha = pickFirstEnv(
    "RAILWAY_GIT_COMMIT_SHA",
    "GIT_COMMIT_SHA",
    "COMMIT_SHA",
    "SOURCE_VERSION",
    "VERCEL_GIT_COMMIT_SHA",
    "RENDER_GIT_COMMIT"
  );

  res.status(200).json({
    ok: true,
    service: "vag-hooks",
    gitSha: gitSha || null,
    node: process.version,
    env: {
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
      railwayServiceId: process.env.RAILWAY_SERVICE_ID || null,
      railwayProjectId: process.env.RAILWAY_PROJECT_ID || null,
    },
    now: new Date().toISOString(),
  });
});

// DB connectivity + table existence
router.get("/db", async (_req, res) => {
  try {
    // DB reachable?
    await prisma.$queryRaw`SELECT 1`;
    // Table exists?
    const count = await prisma.webhookEvent.count();
    res.status(200).json({ ok: true, table: "WebhookEvent", rows: count });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// Debug: inspect which cashout fields are contributing for a given ET day.
// Protected by the same `auth` query param used elsewhere.
router.get("/cashout-debug", async (req, res) => {
  try {
    const auth = (req.query.auth as string) || "";
    if (auth !== "bloombar!!!") {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const day = (req.query.day as string) || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ ok: false, error: "day must be YYYY-MM-DD" });
    }

    const rows = await prisma.$queryRaw<
      Array<{
        event_count: number;
        sum_cash_tender: number;
        sum_card_tender: number;
        sum_change_due: number;
        sum_tender_total: number;
        cash_total: number;
        sold_total: number;
      }>
    >`
      WITH base AS (
        SELECT
          payload,
          COALESCE("createdDate", "receivedAt")
            AT TIME ZONE 'UTC'
            AT TIME ZONE 'America/New_York' AS ts_local
        FROM "WebhookEvent"
      ),
      day_scope AS (
        SELECT *
        FROM base
        WHERE ts_local::date = (${day})::date
      ),
      base_amounts AS (
        SELECT
          payload,
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
            (payload->>'cashChangeDue')::numeric,
            (payload->'payload'->>'cashChangeDue')::numeric,
            (payload->>'cashChange')::numeric,
            (payload->'payload'->>'cashChange')::numeric,
            (payload->>'changeDue')::numeric,
            (payload->'payload'->>'changeDue')::numeric,
            (payload->>'change')::numeric,
            (payload->'payload'->>'change')::numeric,
            (SELECT SUM(
              COALESCE(
                (t->>'change')::numeric,
                (t->>'changeDue')::numeric,
                0
              )
            )
            FROM jsonb_array_elements(payload->'tenders') t
            WHERE LOWER(COALESCE(t->>'tenderType', t->>'type', t->>'method', '')) IN (
              'cash', 'cash payment', 'cashpayment'
            )),
            (SELECT SUM(
              COALESCE(
                (t->>'change')::numeric,
                (t->>'changeDue')::numeric,
                0
              )
            )
            FROM jsonb_array_elements(payload->'payload'->'tenders') t
            WHERE LOWER(COALESCE(t->>'tenderType', t->>'type', t->>'method', '')) IN (
              'cash', 'cash payment', 'cashpayment'
            )),
            (SELECT SUM(
              COALESCE(
                (p->>'change')::numeric,
                (p->>'changeDue')::numeric,
                0
              )
            )
            FROM jsonb_array_elements(payload->'payments') p
            WHERE LOWER(COALESCE(p->>'tenderType', p->>'type', p->>'method', '')) IN (
              'cash', 'cash payment', 'cashpayment'
            )),
            (SELECT SUM(
              COALESCE(
                (p->>'change')::numeric,
                (p->>'changeDue')::numeric,
                0
              )
            )
            FROM jsonb_array_elements(payload->'payload'->'payments') p
            WHERE LOWER(COALESCE(p->>'tenderType', p->>'type', p->>'method', '')) IN (
              'cash', 'cash payment', 'cashpayment'
            )),
            0
          )::double precision AS change_due,

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
          )::double precision AS nested_payments_array_total
        FROM day_scope
      ),
      normalized AS (
        SELECT
          cash_tender,
          card_tender,
          change_due,
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
        COUNT(*)::int AS event_count,
        SUM(cash_tender)::double precision AS sum_cash_tender,
        SUM(card_tender)::double precision AS sum_card_tender,
        SUM(change_due)::double precision AS sum_change_due,
        SUM(tender_total)::double precision AS sum_tender_total,
            SUM(GREATEST(cash_tender, 0))::double precision AS cash_total,
            SUM(GREATEST(tender_total - change_due, 0))::double precision AS sold_total
      FROM normalized;
    `;

    res.json({ ok: true, day, debug: rows[0] || null });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

export default router;
