import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

/**
 * GET /metrics/cash-daily?month=YYYY-MM
 * Optional: ?auth=... via gate middleware; returns [{ day: 'YYYY-MM-DD', total: number }]
 */
router.get("/cash-daily", async (req, res) => {
  try {
    const monthStr = (req.query.month as string) || currentMonth();
    // monthStr = "YYYY-MM"
    const [year, mon] = monthStr.split("-").map(Number);
    if (!year || !mon || mon < 1 || mon > 12) {
      return res.status(400).json({ error: "Invalid month. Use YYYY-MM." });
    }

    const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, mon, 1, 0, 0, 0)); // next month start (exclusive)

    // Pull events in this createdDate range and compute totals
    const events = await prisma.webhookEvent.findMany({
      where: {
        createdDate: { gte: start, lt: end },
      },
      orderBy: { createdDate: "asc" },
    });

    const totals: Record<string, number> = {};

    for (const e of events) {
      const p: any = e.payload || {};
      // prefer stored cash_collected, else compute from both camel+lower
      let val: number | null = null;
      if (typeof p.cash_collected === "number") {
        val = p.cash_collected;
      } else {
        const ca = toNumber(p.cashAmount ?? p.cashamount);
        const ad = toNumber(p.amountDue ?? p.amountdue);
        if (ca !== null && ad !== null) val = Math.max(0, ca - ad);
      }
      if (val === null) continue;

      const d = e.createdDate;
      const key = isoDateUTC(d); // YYYY-MM-DD in UTC
      totals[key] = (totals[key] || 0) + val;
    }

    const out = Object.keys(totals).sort().map(k => ({
      day: k,
      total: Math.round(totals[k] * 100) / 100,
    }));

    res.json({ month: monthStr, results: out });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Internal error" });
  }
});

function currentMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isoDateUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function toNumber(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export default router;
