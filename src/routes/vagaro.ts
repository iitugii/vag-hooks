import express from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

const router = express.Router();
const prisma = new PrismaClient();

/** Safe number coercion */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Pull nested safely: pick(payload, ['payload','cashAmount']) */
function pick(obj: any, path: string[]) {
  return path.reduce<any>((acc, k) => (acc != null ? acc[k] : undefined), obj);
}

/** UTC calendar date from createdDate/receivedAt */
function toUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Derive a stable createdAt + day from payload or now */
function deriveTimestamps(body: any) {
  const createdIso =
    (body?.createdDate as string) ??
    (body?.payload?.createdDate as string) ??
    null;

  const parsed = createdIso ? new Date(createdIso) : new Date();
  const createdDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const day = toUtcDay(createdDate);
  return { createdDate, day };
}

/** Optional: compute cash_collected if you want it stored (not required for the calendar) */
function deriveCashCollected(body: any) {
  // prefer cashAmount, but support common alternates
  const cash =
    num(body?.cashAmount) ??
    num(body?.amountCash) ??
    num(body?.cash) ??
    num(body?.cash_in) ??
    num(body?.tenderAmount) ??
    num(pick(body, ["payload", "cashAmount"])) ??
    num(pick(body, ["payload", "amountCash"])) ??
    num(pick(body, ["payload", "cash"])) ??
    num(pick(body, ["payload", "cash_in"])) ??
    num(pick(body, ["payload", "tenderAmount"])) ??
    0;

  // do NOT subtract amountDue/change here; reporting logic handles that
  return cash || null;
}

function cleanJson(value: any): any {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(cleanJson);
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = cleanJson(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return String(value);
}


router.post(
  "/",
  // body is already parsed earlier in your app; keep a local parser as a fallback
  express.json({ limit: "2mb" }),
  async (req, res) => {
    try {
      const body = req.body ?? {};

      // ---- 1) Harden eventId: never blank; de-dupe via upsert
      const rawId = (body?.id ?? "").toString().trim();
      const eventId = rawId || randomUUID();

      // ---- 2) Basic fields
      const entityType = (body?.type ?? "").toString();
      const action = (body?.action ?? "").toString();

      const businessIds: string[] =
        Array.isArray(body?.businessIds)
          ? body.businessIds.map(String)
          : Array.isArray(body?.payload?.businessIds)
          ? body.payload.businessIds.map(String)
          : [];

      const { createdDate, day } = deriveTimestamps(body);

      // ---- 3) Optional derived money snapshot (nullable)
      const cash_collected = deriveCashCollected(body);

      const cleanedPayload = cleanJson(body) ?? {};
      const cleanedHeaders = cleanJson(req.headers) ?? {};
      const rawBodyString = (() => {
        try {
          return JSON.stringify(body);
        } catch (e) {
          return "[unserializable]";
        }
      })();

      // ---- 4) Common meta
      const sourceIp =
        (req.headers["x-forwarded-for"] as string) ||
        req.ip ||
        "";
      const userAgent = req.get("user-agent") || "";

      const now = new Date();

      // Base row payload for create/update
      const rowData = {
        eventId,
        entityType,
        action,
        businessIds,
        createdDate,
        receivedAt: now,
        rawBody: rawBodyString,
        headers: cleanedHeaders,
        payload: cleanedPayload,
        sourceIp,
        userAgent,
        day,
        cash_collected,
      };

      // ---- 5) Simple insert (eventId no longer unique in DB, so allow duplicates for now)
      const saved = await prisma.webhookEvent.create({ data: rowData });

      return res.status(200).json({ ok: true, id: saved.id, eventId: saved.eventId });
    } catch (err) {
      console.error("Webhook upsert failed:", err);
      if (err instanceof Prisma.PrismaClientValidationError) {
        return res.status(400).json({ ok: false, error: "validation_error", message: err.message });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        return res
          .status(500)
          .json({ ok: false, error: "prisma_error", code: err.code, meta: err.meta });
      }
      return res.status(500).json({ ok: false, error: "insert_failed" });
    }
  }
);

export default router;
