import { Router, Request, Response, NextFunction } from "express";
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
 * Directly calls the Vagaro token endpoint and returns:
 * - HTTP status + statusText
 * - request body we sent
 * - raw response text
 * - parsed JSON (if any)
 *
 * This is a pure debug endpoint so we can see exactly what Vagaro returns.
 */
router.get(
  "/test",
  requireDashToken,
  async (req: Request, res: Response): Promise<void> => {
    const VAGARO_API_BASE =
      process.env.VAGARO_API_BASE ?? "https://api.vagaro.com/us03/api/v2";

    const VAGARO_CLIENT_ID = process.env.VAGARO_CLIENT_ID;
    const VAGARO_CLIENT_SECRET = process.env.VAGARO_CLIENT_SECRET;
    const VAGARO_SCOPE = process.env.VAGARO_SCOPE ?? "read";

    if (!VAGARO_CLIENT_ID || !VAGARO_CLIENT_SECRET) {
      res.status(500).json({
        ok: false,
        error:
          "VAGARO_CLIENT_ID and VAGARO_CLIENT_SECRET must be set in environment variables.",
      });
      return;
    }

    const url = `${VAGARO_API_BASE}/merchants/generate-access-token`;

    const requestBody = {
      clientId: VAGARO_CLIENT_ID,
      clientSecretKey: VAGARO_CLIENT_SECRET,
      scope: VAGARO_SCOPE,
    };

    try {
      logger.info("[historical/test] Calling Vagaro token endpoint", {
        url,
        scope: VAGARO_SCOPE,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const status = response.status;
      const statusText = response.statusText;
      const rawBody = await response.text();

      let parsed: unknown = null;
      if (rawBody) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = null;
        }
      }

      logger.info("[historical/test] Vagaro token endpoint response", {
        status,
        statusText,
        rawBody,
      });

      res.status(response.ok ? 200 : 500).json({
        ok: response.ok,
        status,
        statusText,
        url,
        requestBody,
        rawBody: rawBody || null,
        parsed,
      });
    } catch (err: any) {
      logger.error("[historical/test] Error calling Vagaro token endpoint", {
        error: err?.message ?? String(err),
      });

      res.status(500).json({
        ok: false,
        error: "Exception when calling Vagaro token endpoint",
        details: err?.message ?? String(err),
      });
    }
  }
);

export default router;
