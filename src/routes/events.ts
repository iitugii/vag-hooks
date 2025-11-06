@'
import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/", async (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 200);
  const events = await prisma.webhookEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: limit,
  });
  res.json(events);
});

router.get("/:id", async (req, res) => {
  const event = await prisma.webhookEvent.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: "Not found" });
  res.json(event);
});

export default router;
'@ | Set-Content src\routes\events.ts
