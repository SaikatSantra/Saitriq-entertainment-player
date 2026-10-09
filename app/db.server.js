import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig, Pool } from "@neondatabase/serverless";

function createPrismaClient() {
  if (process.env.NODE_ENV === "production") {
    // Vercel serverless — use Neon WebSocket pool with the pooled connection URL
    const connectionString =
      process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;

    neonConfig.webSocketConstructor =
      typeof WebSocket !== "undefined" ? WebSocket : undefined;

    const pool = new Pool({ connectionString });
    const adapter = new PrismaNeon(pool);
    return new PrismaClient({ adapter });
  }

  // Local dev — standard TCP via DATABASE_URL
  return new PrismaClient();
}

const globalForPrisma = global;

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = createPrismaClient();
}

const prisma = globalForPrisma.prisma;

export default prisma;
