import { Router, Request, Response, NextFunction } from "express";
import { getVagaroAccessToken } from "../services/vagaroClient";
import {
  listDataLakePaths,
  downloadDataLakeFile,
} from "../services/vagaroDataLake";
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
 * Returns a short token preview if successful.
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
        rawResponse: err?.rawResponse ?? null,
        rawBody: err?.rawBody ?? null,
      });

      res.status(500).json({
        ok: false,
        error: "Failed to connect to Vagaro API",
        details: err?.message ?? String(err),
        vagaroRaw: err?.rawResponse ?? err?.rawBody ?? null,
      });
    }
  }
);

/**
 * GET /historical/files
 *
 * Lists paths in the Data Lake filesystem.
 * Query params:
 *   - directory (optional): subfolder under 'reports' filesystem
 *   - recursive (optional): "true" or "false" (default: true)
 */
router.get(
  "/files",
  requireDashToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const directory =
        typeof req.query.directory === "string"
          ? req.query.directory
          : undefined;

      const recursive =
        typeof req.query.recursive === "string"
          ? req.query.recursive.toLowerCase() === "true"
          : true;

      const paths = await listDataLakePaths(directory, recursive);

      res.json({
        ok: true,
        directory: directory ?? null,
        recursive,
        count: paths.length,
        paths,
      });
    } catch (err: any) {
      logger.error("[historical] Failed to list Data Lake files", {
        error: err?.message ?? String(err),
      });

      res.status(500).json({
        ok: false,
        error: "Failed to list Data Lake files",
        details: err?.message ?? String(err),
      });
    }
  }
);

/**
 * GET /historical/file-preview
 *
 * Downloads a single file from Data Lake and returns a truncated preview.
 * Query params:
 *   - path (required): path relative to the 'reports' filesystem root
 *   - maxChars (optional): default 2000
 */
router.get(
  "/file-preview",
  requireDashToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pathParam = req.query.path;
      if (typeof pathParam !== "string" || !pathParam.trim()) {
        res.status(400).json({
          ok: false,
          error: "Missing required 'path' query parameter",
        });
        return;
      }

      const maxChars =
        typeof req.query.maxChars === "string"
          ? Number(req.query.maxChars)
          : 2000;

      const fileText = await downloadDataLakeFile(pathParam.trim());
      const preview =
        fileText.length > maxChars
          ? fileText.slice(0, maxChars) + "\n\n[TRUNCATED]"
          : fileText;

      res.json({
        ok: true,
        path: pathParam.trim(),
        length: fileText.length,
        preview,
      });
    } catch (err: any) {
      logger.error("[historical] Failed to preview Data Lake file", {
        error: err?.message ?? String(err),
      });

      res.status(500).json({
        ok: false,
        error: "Failed to preview Data Lake file",
        details: err?.message ?? String(err),
      });
    }
  }
);

export default router;
