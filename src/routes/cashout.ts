import { Router, Request, Response, NextFunction } from "express";
import path from "path";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

const router = Router();

function requireDashToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = process.env.DASH_TOKEN;

  if (!expected) {
    logger.error("[cashout] DASH_TOKEN not configured on server");
    res.status(500).json({ error: "DASH_TOKEN not configured on server" });
    return;
  }

  const headerToken = (req.headers["x-auth-token"] as string | undefined) ?? "";
  const queryToken = (req.query.auth as string | undefined) ?? "";

  const provided = headerToken || queryToken;

  if (!provided || provided !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

// Cash aliases
const CASH_KEYS = [
  "amountCash",
  "cashAmount",
  "cash",
  "cash_in",
  "tenderAmount",
];

// Amount due aliases
const AMOUNT_DUE_KEYS = ["amountDue"];

function getNumberFromPayload(payload: unknown, keys: string[]): number | null {
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;

  for (const key of keys) {
    // Top-level
    if (typeof obj[key] === "number") {
      return obj[key] as number;
    }

    // Nested under payload.payload
    const nested = obj["payload"];
    if (
      nested &&
      typeof nested === "object" &&
      typeof (nested as Record<string, unknown>)[key] === "number"
    ) {
      return (nested as Record<string, unknown>)[key] as number;
    }
  }

  return null;
}

/**
 * GET /cashout
 * Serves the cashout calendar HTML.
 */
router.get(
  "/",
  requireDashToken,
  (req: Request, res: Response): void => {
    const cashoutPath = path.join(
      __dirname,
      "..",
      "..",
      "public",
      "cashout.html"
    );

    res.sendFile(cashoutPath, (err) => {
      if (err) {
        logger.error("[cashout] Failed to send cashout.html", {
          error: err.message,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to load cashout calendar" });
        }
      }
    });
  }
);

/**
 * GET /cashout/data
 *
 * Returns:
 * {
 *   year: 2025,
 *   month: 11,
 *   data: [{ day: "2025-11-07", total: 431.02 }, ...]
 * }
 */
router.get(
  "/data",
  requireDashToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();

      const year =
        typeof req.query.year === "string"
          ? Number(req.query.year)
          : now.getUTCFullYear();

      const month =
        typeof req.query.month === "string"
          ? Number(req.query.month)
          : now.getUTCMonth() + 1; // 1–12

      if (!Number.isFinite(year) || !Number.isFinite(month)) {
        res.status(400).json({ error: "Invalid year or month" });
        return;
      }

      // Use UTC month bounds; "day" is stored as UTC calendar date in DB.
      const monthStart = new Date(Date.UTC(year, month - 1, 1));
      const monthEnd = new Date(Date.UTC(year, month, 1));

      const events = await prisma.webhookEvent.findMany({
        where: {
          day: {
            gte: monthStart,
            lt: monthEnd,
          },
        },
        select: {
          day: true,
          payload: true,
        },
      });

      const totalsByDay = new Map<string, number>();

      for (const ev of events) {
        if (!ev.day) continue;

        const dayKey = ev.day.toISOString().slice(0, 10); // YYYY-MM-DD
        const payload = ev.payload as unknown;

        const cash = getNumberFromPayload(payload, CASH_KEYS);
        const amountDue = getNumberFromPayload(payload, AMOUNT_DUE_KEYS);

        if (cash == null || amountDue == null) continue;

        const net = cash - amountDue;
        if (!Number.isFinite(net) || net === 0) continue;

        const prev = totalsByDay.get(dayKey) ?? 0;
        totalsByDay.set(dayKey, prev + net);
      }

      const data = Array.from(totalsByDay.entries())
        .map(([day, total]) => ({
          day,
          total: Number(total.toFixed(2)),
        }))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

      res.json({
        year,
        month,
        data,
      });
    } catch (err: any) {
      logger.error("[cashout] Failed to compute cashout data", {
        error: err?.message ?? String(err),
      });
      res.status(500).json({ error: "Failed to load cashout data" });
    }
  }
);

export default router;
