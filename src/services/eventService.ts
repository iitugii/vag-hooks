import { prisma } from "../lib/prisma";

function toNumber(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function storeEvent(input: any) {
  // derive day from createdDate (local date part), not "now"
  const created = new Date(input.createdDate);
  // normalize date-only for 'day' column
  const dayOnly = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()));

  // Prepare payload and derive cash_collected
  const payload = input.payload ?? {};
  // Support both camelCase and lowercase from upstream
  const cashAmount = toNumber(payload.cashAmount ?? payload.cashamount);
  const amountDue  = toNumber(payload.amountDue  ?? payload.amountdue);

  if (cashAmount !== null && amountDue !== null) {
    const val = Math.max(0, cashAmount - amountDue);
    // store a rounded value for convenience
    (payload as any).cash_collected = Math.round(val * 100) / 100;
  }

  const existing = await prisma.webhookEvent.findFirst({ where: { eventId: input.eventId as string } });
  if (existing) return existing;

  return prisma.webhookEvent.create({
    data: {
      eventId: input.eventId,
      entityType: input.entityType,
      action: input.action,
      businessIds: input.businessIds,
      createdDate: created,
      rawBody: input.rawBody,
      headers: input.headers,
      payload: payload,
      sourceIp: input.sourceIp,
      userAgent: input.userAgent,
      day: dayOnly, // <-- track the day based on createdDate
    },
  });
}
