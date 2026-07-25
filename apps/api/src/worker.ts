import "./tracing.js";
import "./instrument.js";
import { createTxSubmitWorker } from "./queue.js";
import { pool } from "./db.js";

const worker = createTxSubmitWorker();

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed: ${job.data.method} for importer ${job.data.importerId}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});

process.on("SIGTERM", async () => {
  console.log("[worker] SIGTERM received, shutting down gracefully...");
  await worker.close();
  await pool.end();
  process.exit(0);
});

console.log("[worker] started, waiting for jobs...");
