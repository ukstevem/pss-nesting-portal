import fs from "fs/promises";
import { config } from "./config.js";
import { initTaskManager } from "./services/task-manager.js";
import { createServer } from "./server.js";

async function main() {
  // Ensure results directory exists
  await fs.mkdir(config.RESULTS_DIR, { recursive: true });

  // Initialise task manager
  initTaskManager(config.MAX_CONCURRENT_JOBS);
  console.log(
    `[nesting] Task manager: max_concurrent=${config.MAX_CONCURRENT_JOBS}, workers_per_job=${config.workersPerJob}`,
  );

  // Start server
  const app = createServer();
  app.listen(config.PORT, "0.0.0.0", () => {
    console.log(
      `[nesting] ${config.API_TITLE} v${config.API_VERSION} listening on http://0.0.0.0:${config.PORT}`,
    );
  });
}

main().catch((err) => {
  console.error("[nesting] Fatal startup error:", err);
  process.exit(1);
});
