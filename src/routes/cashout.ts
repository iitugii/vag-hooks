import express from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/cashout.html'));
});

type Row = { day_local: string; total: number };

router.get('/data', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');

    // CASH variants (same as your list) MINUS DISCOUNT variants (discount/discountAmount)
    const rows = await prisma.$queryRaw<Row[]>`
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
      ),
      cash_per_row AS (
        SELECT
          ts_local::date AS d,
          /* cash */
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
                    0) AS cash_val,
          /* discount */
          COALESCE( (payload->>'discount')::numeric,
                    (payload->'payload'->>'discount')::numeric,
                    (payload->>'discountAmount')::numeric,
                    (payload->'payload'->>'discountAmount')::numeric,
                    0) AS discount_val
        FROM month_scope
      )
      SELECT
        to_char(d, 'YYYY-MM-DD') AS day_local,
        (SUM(cash_val) - SUM(discount_val))::double precision AS total
      FROM cash_per_row
      GROUP BY d
      ORDER BY d;
    `;

    const data = rows.map(r => ({ day: r.day_local, total: Number(r.total || 0) }));
    res.json({ year, month, data });
  } catch (err) {
    console.error('Error fetching cashout data:', err);
    res.status(500).json({ error: 'Failed to load cashout data' });
  }
});

export default router;
