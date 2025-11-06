@'
import { prisma } from "../lib/prisma";

export async function storeEvent(input: any) {
  const existing = await prisma.webhookEvent.findUnique({ where: { eventId: input.eventId } });
  if (existing) return existing;
  return prisma.webhookEvent.create({
    data: {
      eventId: input.eventId,
      entityType: input.entityType,
      action: input.action,
      businessIds: input.businessIds,
      createdDate: new Date(input.createdDate),
      rawBody: input.rawBody,
      headers: input.headers,
      payload: input.payload,
      sourceIp: input.sourceIp,
      userAgent: input.userAgent,
      day: new Date(),
    },
  });
}
'@ | Set-Content src\services\eventService.ts
