import express from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const router = express.Router();
const prisma = new PrismaClient();

// GET /cashout — serve the HTML
router.get('/', async (_req, res) => {
  try {
    res.sendFile(path.join(__dirname, '../../public/cashout.html'));
  } catch (err) {
    console.error('Error serving cashout.html:', err);
    res.status(500).send('Error loading Cashout Calendar');
  }
});

// Type for raw query result
type CashRow = { day: Date; total: number };

// GET /cashout/data?year=YYYY&month=MM — JSON totals per day
router.get('/data', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;

    // month boundaries in UTC
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    // Use SQL to sum (cashAmount - amountDue) from payload JSON (handles both shapes)
    const rows = await prisma.$queryRaw<CashRow[]>`
      SELECT
        "day",
        SUM(
          COALESCE( (payload->>'cashAmount')::numeric,
                    (payload->'payload'->>'cashAmount')::numeric,
                    0)
        -
          COALESCE( (payload->>'amountDue')::numeric,
                    (payload->'payload'->>'amountDue')::numeric,
                    0)
        )::double precision AS total
      FROM "WebhookEvent"
      WHERE "day" >= ${start}::timestamptz
        AND "day"  < ${end}::timestamptz
      GROUP BY "day"
      ORDER BY "day" ASC
    `;

    // normalize response for frontend
    const data = rows.map(r => ({
      day: r.day,                 // Date object is fine; frontend handles it
      total: Number(r.total || 0)
    }));

    res.json({ year, month, data });
  } catch (err) {
    console.error('Error fetching cashout data:', err);
    res.status(500).json({ error: 'Failed to load cashout data' });
  }
});

export default router;
