import express, { Request, Response, NextFunction } from "express";
import path from "path";

import vagaroRouter from "./routes/vagaro";
import eventsRouter from "./routes/events";
import cashoutRouter from "./routes/cashout";
import debugRouter from "./routes/debug";
import debugFindRouter from "./routes/debugFind";
import historicalRouter from "./routes/historical";
import healthRouter from "./routes/health";
import dashboardRouter from "./routes/dashboard";
import exportRouter from "./routes/export";
import metricsRouter from "./routes/metrics";

import { logger } from "./utils/logger";
import { rawBody } from "./middleware/rawBody";

const app = express();

// Normal JSON body parsing
app.use(express.json({ limit: "10mb" }));

// Static assets
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: "1h",
  })
);

// Webhook endpoint (needs raw body)
app.use("/webhooks/vagaro", rawBody, vagaroRouter);

// Protected + core routes
app.use("/events", eventsRouter);
app.use("/cashout", cashoutRouter);
app.use("/debug-cash-list", debugRouter);
app.use("/debug-find-cash", debugFindRouter);
app.use("/historical", historicalRouter);
app.use("/health", healthRouter);
app.use("/dashboard", dashboardRouter);
app.use("/export", exportRouter);
app.use("/metrics", metricsRouter);

// Root health/info
app.get("/", (req: Request, res: Response) => {
  res.json({
    ok: true,
    message: "vag-hooks service running",
  });
});

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  logger.error("[app] Unhandled error", {
    error: err?.message ?? String(err),
    stack: err?.stack,
  });

  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`vag-hooks server listening on port ${PORT}`);
});

export default app;
