import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL no está definido (revisa tu .env)");
  }

  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");

  const pool = new Pool({ connectionString });
  try {
    await pool.query(schema);
    console.log("Esquema aplicado correctamente.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Error aplicando el esquema:", err);
  process.exit(1);
});
