@'
import express from "express";
import morgan from "morgan";
import cors from "cors";
import { rawBody } from "./middleware/rawBody";
import healthRouter from "./routes/health";
import eventsRouter from "./routes/events";
import vagaroRouter from "./routes/vagaro";
import { logger } from "./utils/logger";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use("/webhooks/vagaro", rawBody);

app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

app.use("/health", healthRouter);
app.use("/events", eventsRouter);
app.use("/webhooks/vagaro", vagaroRouter);

app.get("/", (_req, res) => res.json({ ok: true, name: "vag-hooks", version: "1.0.0" }));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err);
  res.status(500).json({ error: "Internal Server Error", details: err?.message });
});

app.listen(PORT, () => logger.info(`Server listening on :${PORT}`));
'@ | Set-Content src\index.ts
