// src/routes/vagaro.ts
import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Helper: pull number from possible json paths
function num(val: unknown): number {
  const n = typeof val === 'string' ? Number(val) : (typeof val === 'number' ? val : 0);
  return Number.isFinite(n) ? n : 0;
}

function pick<T = any>(obj: any, path: string[]): T | undefined {
  return path.reduce<any>((acc, key) => (acc && acc[key] != null ? acc[key] : undefined), obj);
}

function deriveCashCollected(payload: any): number {
  // Support either payload.cashAmount or payload.payload.cashAmount (same for amountDue)
  const cashAmount = num(pick(payload, ['cashAmount']) ?? pick(payload, ['payload','cashAmount']));
  const amountDue  = num(pick(payload, ['amountDue'])  ?? pick(payload, ['payload','amountDue']));
  return cashAmount - amountDue;
}

function deriveDay(createdDateIso?: string): Date {
  const d = createdDateIso ? new Date(createdDateIso) : new Date();
  // force pure UTC date (YYYY-MM-DD 00:00:00Z)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const createdDate: string | undefined =
      (body.createdDate as string) ??
      (body.payload && body.payload.createdDate as string);

    const record = await prisma.webhookEvent.create({
      data: {
        eventId: String(body.id ?? ''),
        entityType: String(body.type ?? ''),
        action: String(body.action ?? ''),
        businessIds: Array.isArray(body.businessIds)
          ? body.businessIds.map(String)
          : (Array.isArray(body.payload?.businessIds) ? body.payload.businessIds.map(String) : []),
        createdDate: createdDate ? new Date(createdDate) : new Date(),
        receivedAt: new Date(),
        rawBody: JSON.stringify(body),
        headers: req.headers as any,
        payload: body as any,
        sourceIp: (req.headers['x-forwarded-for'] as string) || req.ip || '',
        userAgent: req.get('user-agent') || '',

        // Cash + day fields
        cash_collected: deriveCashCollected(body),
        day: deriveDay(createdDate),
      },
    });

    res.status(200).json({ ok: true, id: record.id });
  } catch (err) {
    console.error('Webhook insert failed:', err);
    res.status(500).json({ ok: false, error: 'insert_failed' });
  }
});

export default router;
