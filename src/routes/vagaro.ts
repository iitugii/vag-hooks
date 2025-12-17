import express from "express";
import { PrismaClient } from "@prisma/client";
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

  const createdDate = createdIso ? new Date(createdIso) : new Date();
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

/** Normalize a value into a trimmed string or null */
function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null;
}

/** Extract transactionId and itemSold for composite idempotency */
function deriveIds(body: any) {
  const transactionId =
    toStr(body?.transactionId) ||
    toStr(body?.userPaymentsMstId) ||
    toStr(pick(body, ["payload", "transactionId"])) ||
    toStr(pick(body, ["payload", "userPaymentsMstId"]));

  const itemSold =
    toStr(body?.itemSold) ||
    toStr(pick(body, ["payload", "itemSold"]));

  return { transactionId, itemSold };
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

      // ---- 4) Idempotency keys: prefer transactionId + itemSold when present
      const { transactionId, itemSold } = deriveIds(body);

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
        transactionId,
        itemSold,
        entityType,
        action,
        businessIds,
        createdDate,
        receivedAt: now,
        rawBody: JSON.stringify(body),
        headers: req.headers as any,
        payload: body as any,
        sourceIp,
        userAgent,
        day,
        cash_collected,
      };

      // ---- 5) Idempotency strategy: only upsert when both transactionId and itemSold are present
      const saved =
        transactionId && itemSold
          ? await prisma.webhookEvent.upsert({
              where: { transactionId_itemSold: { transactionId, itemSold } },
              create: rowData,
              update: {
                ...rowData,
                receivedAt: new Date(),
              },
            })
          : await prisma.webhookEvent.create({ data: rowData });

      return res.status(200).json({ ok: true, id: saved.id, eventId: saved.eventId });
    } catch (err) {
      console.error("Webhook upsert failed:", err);
      return res.status(500).json({ ok: false, error: "insert_failed" });
    }
  }
);

export default router;
