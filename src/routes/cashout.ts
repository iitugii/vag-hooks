import express from "express";
import { PrismaClient } from "@prisma/client";
import path from "path";

const router = express.Router();
const prisma = new PrismaClient();

router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/cashout.html"));
});

type Row = { day_local: string; total: number };

router.get("/data", async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt((req.query.year as string) || `${now.getFullYear()}`, 10);
    const month = parseInt((req.query.month as string) || `${now.getMonth() + 1}`, 10);
    const monthStr = String(month).padStart(2, "0");

    // Aggregate (amountCash - amountDue) per local day
    const rows = await prisma.$queryRaw<Row[]>`
      WITH base AS (
        SELECT
          payload,
          COALESCE("createdDate","receivedAt")
            AT TIME ZONE 'UTC'
            AT TIME ZONE 'America/New_York' AS ts_local
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
          COALESCE(
            (payload->>'amountCash')::numeric,
            (payload->'payload'->>'amountCash')::numeric,
            (payload->>'cashAmount')::numeric,
            (payload->'payload'->>'cashAmount')::numeric,
            0
          )
          -
          COALESCE(
            (payload->>'amountDue')::numeric,
            (payload->'payload'->>'amountDue')::numeric,
            0
          )
        )::double precision AS total
      FROM month_scope
      GROUP BY ts_local::date
      ORDER BY ts_local::date;
    `;

    const data = rows.map(r => ({
      day: r.day_local,
      total: Number(r.total || 0)
    }));

    res.json({ year, month, data });
  } catch (err) {
    console.error("Error fetching cashout data:", err);
    res.status(500).json({ error: "Failed to load cashout data" });
  }
});

export default router;
s