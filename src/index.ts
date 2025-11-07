import express from "express";
import morgan from "morgan";
import cors from "cors";
import path from "path";
import exportRouter from "./routes/export";

import { rawBody } from "./middleware/rawBody";
import healthRouter from "./routes/health";
import eventsRouter from "./routes/events";
import vagaroRouter from "./routes/vagaro";
import { logger } from "./utils/logger";
import { prisma } from "./lib/prisma";
import dashboardRouter from "./routes/dashboard"; // requires you already created src/routes/dashboard.ts
import metricsRouter from "./routes/metrics";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---------- optional token gate for /events and /dashboard ----------
const DASH_TOKEN = process.env.DASH_TOKEN || "";
// Let the frontend know if auth is required
app.get("/config", (_req, res) => {
  res.json({ protected: !!DASH_TOKEN });
});

function gate(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!DASH_TOKEN) return next(); // open access when no token set
  const token = (req.query.auth as string) || (req.headers["x-auth-token"] as string) || "";
  if (token === DASH_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
// --------------------------------------------------------------------

// Raw body must run before JSON parser on the webhook path
app.use("/webhooks/vagaro", rawBody);

app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

// Serve static assets (dashboard.html lives in /public)
app.use(express.static("public"));

// Mount routes
app.use("/health", healthRouter);
app.use("/events", gate, eventsRouter);        // gated if DASH_TOKEN is set
app.use("/dashboard", gate, dashboardRouter);  // gated if DASH_TOKEN is set
app.use("/export", gate, exportRouter);        // gated if DASH_TOKEN is set
app.use("/metrics", gate, metricsRouter);      // gated if DASH_TOKEN is set
app.use("/webhooks/vagaro", vagaroRouter);

// Inline DB check (kept for easy verification)
app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const rows = await prisma.webhookEvent.count();
    res.status(200).json({ ok: true, table: "WebhookEvent", rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// Root
app.get("/", (_req, res) => {
  res.json({ ok: true, name: "vag-hooks", version: "1.0.0" });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => logger.info(`Server listening on :${PORT}`));
