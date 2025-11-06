@'
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient({ log: ["error", "warn"] });
'@ | Set-Content src\lib\prisma.ts
