import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://agentbox:agentbox@localhost:5432/agentbox",
});

export const db = drizzle(pool, { schema });
