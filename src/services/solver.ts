import { spawn } from "child_process";
import path from "path";
import { config } from "../config.js";
import type {
  NestingItem,
  StockEntry,
  SectionStock,
  NestingResult,
  SolverProgress,
} from "../types/nesting.js";

export interface SolverRequest {
  job_label?: string | null;
  items: NestingItem[];
  stock_per_section: SectionStock[];
  default_stock?: StockEntry[] | null;
  kerf: number;
  time_limit: number;
  num_search_workers: number;
  pack_tight: boolean;
}

/**
 * Spawn the Python CP-SAT solver as a child process.
 *
 * Protocol:
 *   stdin  ← JSON request
 *   stderr ← JSON-line progress updates (one per improving solution)
 *   stdout → JSON result
 */
export function runSolver(
  request: SolverRequest,
  onProgress: (progress: SolverProgress) => void,
): Promise<NestingResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(config.SOLVER_SCRIPT);
    const proc = spawn(config.PYTHON_BIN, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderrBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      // Parse complete JSON lines from stderr (progress updates)
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop()!; // keep incomplete trailing line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onProgress(JSON.parse(trimmed));
        } catch {
          // Not a JSON progress line — log it
          console.log(`[solver] ${trimmed}`);
        }
      }
    });

    proc.on("close", (code) => {
      // Process any remaining stderr
      if (stderrBuffer.trim()) {
        try {
          onProgress(JSON.parse(stderrBuffer.trim()));
        } catch {
          console.log(`[solver] ${stderrBuffer.trim()}`);
        }
      }

      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`Failed to parse solver output: ${err}`));
        }
      } else {
        reject(
          new Error(`Solver exited with code ${code}: ${stderrBuffer}`),
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn solver: ${err.message}`));
    });

    // Write request JSON to stdin and close
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}
