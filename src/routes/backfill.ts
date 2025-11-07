import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// POST /backfill  (run once; protected by DASH_TOKEN)
router.post("/", async (req, res) => {
  try {
    const token = req.header("x-auth-token") || "";
    if (!process.env.DASH_TOKEN || token !== process.env.DASH_TOKEN) {
      return res.status(403).json({ ok: false, error: "unauthorized" });
    }

    const rows = await prisma.webhookEvent.findMany({
      where: { cash_collected: null },
      select: { id: true, payload: true, createdDate: true, receivedAt: true },
    });

    let updated = 0;

    for (const e of rows) {
      const p: any = e.payload || {};
      const inner = p?.payload || {};

      const cashAmount = Number(p?.cashAmount ?? inner?.cashAmount ?? 0);
      const amountDue  = Number(p?.amountDue  ?? inner?.amountDue  ?? 0);
      const cash_collected =
        (Number.isFinite(cashAmount) ? cashAmount : 0) -
        (Number.isFinite(amountDue) ? amountDue : 0);

      const src = e.createdDate ?? e.receivedAt ?? new Date();
      const day = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));

      await prisma.webhookEvent.update({
        where: { id: e.id },
        data: { cash_collected, day },
      });
      updated++;
    }

    return res.json({ ok: true, updated });
  } catch (err) {
    console.error("backfill error:", err);
    return res.status(500).json({ ok: false, error: "backfill_failed" });
  }
});

export default router;
