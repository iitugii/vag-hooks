@'
import { Request, Response, NextFunction } from "express";
import getRawBody from "raw-body";

export async function rawBody(req: Request, res: Response, next: NextFunction) {
  try {
    if (!["POST","PUT","PATCH"].includes(req.method)) return next();
    const encoding = (req.headers["content-encoding"] as string) || "utf-8";
    const len = req.headers["content-length"] ? parseInt(req.headers["content-length"] as string, 10) : undefined;
    const raw = await getRawBody(req, { length: len, encoding });
    (req as any).rawBody = raw;
    if ((req.headers["content-type"] || "").includes("application/json")) {
      try { (req as any).body = JSON.parse(raw); } catch {}
    }
    next();
  } catch (e) { next(e); }
}
'@ | Set-Content src\middleware\rawBody.ts
