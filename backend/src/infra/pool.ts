import { Pool } from "pg";

let pool: Pool | null = null;

/** Pool de conexiones a Postgres, creado perezosamente a partir de DATABASE_URL. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL no está definido (revisa tu .env)");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
