import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// Simple liveness
router.get("/", (_req, res) => res.status(200).send("ok"));

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

export default router;
