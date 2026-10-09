import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig, Pool } from "@neondatabase/serverless";

function createPrismaClient() {
  if (process.env.NODE_ENV === "production") {
    try {
      const connectionString =
        process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;

      if (!connectionString) {
        console.error("DATABASE_URL is missing in environment variables!");
      }

      neonConfig.webSocketConstructor =
        typeof WebSocket !== "undefined" ? WebSocket : undefined;

      const pool = new Pool({ connectionString });
      const adapter = new PrismaNeon(pool);
      return new PrismaClient({ adapter });
    } catch (err) {
      console.error("Failed to initialize PrismaNeon adapter, falling back to standard client:", err);
      return new PrismaClient();
    }
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
