import { Router, Request, Response, NextFunction } from "express";
import { getVagaroAccessToken } from "../services/vagaroClient";
import { logger } from "../utils/logger";

const router = Router();

/**
 * Simple DASH_TOKEN gate for historical API routes.
 * All protected routes in this project use x-auth-token or ?auth=
 */
function requireDashToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = process.env.DASH_TOKEN;

  if (!expected) {
    res.status(500).json({
      error: "DASH_TOKEN not configured on server",
    });
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

/**
 * GET /historical/test
 *
 * Uses the Vagaro generate-access-token endpoint to verify:
 * - We can reach the Vagaro API from Railway
 * - Credentials are valid
 *
 * Does NOT return the full token, just a short preview.
 */
router.get(
  "/test",
  requireDashToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tokenInfo = await getVagaroAccessToken();

      res.json({
        ok: true,
        message: "Successfully connected to Vagaro API",
        tokenPreview: tokenInfo.token.slice(0, 8) + "...",
        tokenType: tokenInfo.tokenType ?? null,
        expiresIn: tokenInfo.expiresIn ?? null,
        scope: tokenInfo.scope ?? null,
      });
    } catch (err: any) {
      logger.error("[historical] Vagaro connection test failed", {
        error: err?.message ?? String(err),
      });

      res.status(500).json({
        ok: false,
        error: "Failed to connect to Vagaro API",
        details: err?.message ?? String(err),
      });
    }
  }
);

export default router;
