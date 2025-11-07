import express from "express";
import morgan from "morgan";
import cors from "cors";
import { rawBody } from "./middleware/rawBody";
import healthRouter from "./routes/health";
import eventsRouter from "./routes/events";
import vagaroRouter from "./routes/vagaro";
import { logger } from "./utils/logger";
import { prisma } from "./lib/prisma";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Raw body for webhook route
app.use("/webhooks/vagaro", rawBody);

app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

// ROUTES
app.use("/health", healthRouter);
app.use("/events", eventsRouter);
app.use("/webhooks/vagaro", vagaroRouter);

// Inline DB check to avoid any routing issues
app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const rows = await prisma.webhookEvent.count();
    res.status(200).json({ ok: true, table: "WebhookEvent", rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

app.get("/", (_req, res) =>
  res.json({ ok: true, name: "vag-hooks", version: "1.0.0" })
);

app.listen(PORT, () => logger.info(`Server listening on :${PORT}`));
