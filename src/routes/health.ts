import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

function pickFirstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

// Simple liveness + version stamp (helps verify what Railway is running)
router.get("/", (_req, res) => {
  const gitSha = pickFirstEnv(
    "RAILWAY_GIT_COMMIT_SHA",
    "GIT_COMMIT_SHA",
    "COMMIT_SHA",
    "SOURCE_VERSION",
    "VERCEL_GIT_COMMIT_SHA",
    "RENDER_GIT_COMMIT"
  );

  res.status(200).json({
    ok: true,
    service: "vag-hooks",
    gitSha: gitSha || null,
    node: process.version,
    env: {
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
      railwayServiceId: process.env.RAILWAY_SERVICE_ID || null,
      railwayProjectId: process.env.RAILWAY_PROJECT_ID || null,
    },
    now: new Date().toISOString(),
  });
});

// DB connectivity + table existence
router.get("/db", async (_req, res) => {
  try {
    // DB reachable?
    await prisma.$queryRaw`SELECT 1`;
    // Table exists?
    const count = await prisma.webhookEvent.count();
    res.status(200).json({ ok: true, table: "WebhookEvent", rows: count });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

export default router;
