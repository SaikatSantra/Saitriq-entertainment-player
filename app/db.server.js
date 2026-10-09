import { PrismaClient } from "@prisma/client";

const globalForPrisma = global;

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

const prisma = globalForPrisma.prisma;

export default prisma;

