import express from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  try {
    res.sendFile(path.join(__dirname, '../../public/cashout.html'));
  } catch (error) {
    console.error('Error serving cashout.html:', error);
    res.status(500).send('Error loading Cashout Calendar');
  }
});

router.get('/data', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    const grouped = await prisma.webhookEvent.groupBy({
      by: ['day'],
      _sum: { cash_collected: true },
      where: {
        day: { gte: start, lt: end },
        cash_collected: { not: null },
      },
      orderBy: { day: 'asc' },
    });

    res.json(
      grouped.map((g) => ({
        day: g.day,
        total: g._sum.cash_collected ?? 0,
      }))
    );
  } catch (error) {
    console.error('Error fetching cashout data:', error);
    res.status(500).json({ error: 'Failed to load cashout data' });
  }
});

export default router;
