import express from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/cashout.html'));
});

type CashRow = { day_local: string; total: number };

router.get('/data', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');

    // cash: cashAmount | cash | cash_in | tenderAmount
    // change: changeDue | change | change_out | changeGiven
    const rows = await prisma.$queryRaw<CashRow[]>`
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
        SUM(
          COALESCE( (payload->>'cashAmount')::numeric,
                    (payload->'payload'->>'cashAmount')::numeric,
                    (payload->>'cash')::numeric,
                    (payload->'payload'->>'cash')::numeric,
                    (payload->>'cash_in')::numeric,
                    (payload->'payload'->>'cash_in')::numeric,
                    (payload->>'tenderAmount')::numeric,
                    (payload->'payload'->>'tenderAmount')::numeric,
                    0)
          -
          COALESCE( (payload->>'changeDue')::numeric,
                    (payload->'payload'->>'changeDue')::numeric,
                    (payload->>'change')::numeric,
                    (payload->'payload'->>'change')::numeric,
                    (payload->>'change_out')::numeric,
                    (payload->'payload'->>'change_out')::numeric,
                    (payload->>'changeGiven')::numeric,
                    (payload->'payload'->>'changeGiven')::numeric,
                    0)
        )::double precision AS total
      FROM month_scope
      WHERE (
        (payload ? 'cashAmount') OR (payload ? 'cash') OR (payload ? 'cash_in') OR (payload ? 'tenderAmount')
        OR (payload ? 'payload' AND (
          (payload->'payload' ? 'cashAmount') OR (payload->'payload' ? 'cash') OR (payload->'payload' ? 'cash_in') OR (payload->'payload' ? 'tenderAmount')
        ))
      )
      GROUP BY day_local
      ORDER BY day_local;
    `;

    const data = rows.map(r => ({ day: r.day_local, total: Number(r.total || 0) }));
    res.json({ year, month, data });
  } catch (err) {
    console.error('Error fetching cashout data:', err);
    res.status(500).json({ error: 'Failed to load cashout data' });
  }
});

export default router;
