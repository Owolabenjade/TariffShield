import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { pool } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(action: "up" | "rollback" = "up"): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 2. Scan and parse migration files
    const files = await fs.readdir(__dirname);
    const migrationPattern = /^(\d{4})_[\w-]+\.(ts|js)$/;
    
    const migrationFiles = files
      .filter(f => migrationPattern.test(f) && !f.endsWith(".d.ts") && !f.endsWith(".map"))
      .map(f => {
        const match = f.match(migrationPattern)!;
        return {
          version: parseInt(match[1]!, 10),
          filename: f,
          name: f.replace(/\.(ts|js)$/, "")
        };
      })
      .sort((a, b) => a.version - b.version);

    // Validate no duplicate versions
    const seenVersions = new Set<number>();
    for (const m of migrationFiles) {
      if (seenVersions.has(m.version)) {
        throw new Error(`Duplicate migration version detected: ${m.version}`);
      }
      seenVersions.add(m.version);
    }

    if (action === "up") {
      // Get highest applied migration version
      const res = await client.query("SELECT MAX(version) as max_version FROM schema_migrations");
      const highestApplied = res.rows[0]?.max_version ?? 0;

      const pending = migrationFiles.filter(m => m.version > highestApplied);
      if (pending.length === 0) {
        console.log("No pending migrations to run.");
        return;
      }

      console.log(`Running ${pending.length} pending migrations...`);
      await client.query("BEGIN");
      try {
        for (const m of pending) {
          const filePath = path.join(__dirname, m.filename);
          const fileUrl = pathToFileURL(filePath).href;
          const mod = await import(fileUrl);
          if (typeof mod.up !== "function") {
            throw new Error(`Migration ${m.filename} does not export an up function.`);
          }
          await mod.up(client);
          await client.query(
            "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
            [m.version, m.name]
          );
          console.log(`Successfully applied migration: ${m.name}`);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration transaction failed, rolled back changes.");
        throw err;
      }
    } else if (action === "rollback") {
      // Find the highest applied migration
      const res = await client.query("SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1");
      if (res.rows.length === 0) {
        console.log("No migrations to rollback.");
        return;
      }

      const { version, name } = res.rows[0];
      const m = migrationFiles.find(mf => mf.version === version);
      if (!m) {
        throw new Error(`Migration file for version ${version} (${name}) not found in migrations directory.`);
      }

      console.log(`Rolling back migration: ${m.name}...`);
      await client.query("BEGIN");
      try {
        const filePath = path.join(__dirname, m.filename);
        const fileUrl = pathToFileURL(filePath).href;
        const mod = await import(fileUrl);
        if (typeof mod.down !== "function") {
          throw new Error(`Migration ${m.filename} does not export a down function.`);
        }
        await mod.down(client);
        await client.query("DELETE FROM schema_migrations WHERE version = $1", [version]);
        await client.query("COMMIT");
        console.log(`Successfully rolled back migration: ${m.name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Rollback transaction failed, rolled back changes.");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
