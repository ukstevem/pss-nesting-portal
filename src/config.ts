import os from "os";

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

export const config = {
  API_TITLE: env("NESTING_API_TITLE", "Beam Nesting Service"),
  API_VERSION: env("NESTING_API_VERSION", "1.0.0"),

  PORT: envInt("PORT", 8001),

  OUTPUT_DIR: env("NESTING_OUTPUT_DIR", "/app/outputs"),
  RESULTS_DIR: env("NESTING_RESULTS_DIR", "/app/outputs/results"),

  /** Max concurrent CP-SAT solves running simultaneously. */
  MAX_CONCURRENT_JOBS: envInt("NESTING_MAX_CONCURRENT_JOBS", 2),

  /** URL of pss-document-service for PDF generation. */
  DOCUMENT_SERVICE_URL: env("DOCUMENT_SERVICE_URL", "http://localhost:3000"),

  /** Path to the Python solver script. */
  SOLVER_SCRIPT: env("NESTING_SOLVER_SCRIPT", "solver/solve.py"),

  /** Python binary name (python3 on Linux, may be python on Windows). */
  PYTHON_BIN: env("NESTING_PYTHON_BIN", "python3"),

  get workersPerJob(): number {
    const cpus = os.cpus().length || 2;
    return Math.max(1, Math.floor(cpus / this.MAX_CONCURRENT_JOBS));
  },
} as const;
