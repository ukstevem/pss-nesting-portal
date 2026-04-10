import crypto from "crypto";
import type { TaskInfo, NestingResult, SolverProgress } from "../types/nesting.js";

interface ManagedTask extends TaskInfo {
  abortController?: AbortController;
}

/**
 * In-memory async job queue.
 *
 * Unlike the Python version (ThreadPoolExecutor), Node.js doesn't need threads
 * because the solver runs as a child process. We just track concurrency with a
 * counter and queue jobs that exceed MAX_CONCURRENT_JOBS.
 */
export class TaskManager {
  private tasks = new Map<string, ManagedTask>();
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrent: number = 2) {}

  /** Generate a 12-char hex task ID (matches Python: secrets.token_hex(6)). */
  private generateId(): string {
    return crypto.randomBytes(6).toString("hex");
  }

  /**
   * Register a task and schedule `fn` for execution.
   * `fn` receives the task_id and a progress callback.
   */
  submit(
    fn: (
      taskId: string,
      updateProgress: (p: SolverProgress) => void,
    ) => Promise<NestingResult>,
  ): string {
    const taskId = this.generateId();
    this.tasks.set(taskId, {
      status: "pending",
      progress: {},
      result: null,
      error: null,
    });

    const execute = async () => {
      this.running++;
      const task = this.tasks.get(taskId)!;
      task.status = "running";

      try {
        const result = await fn(taskId, (p) => this.updateProgress(taskId, p));
        task.status = "completed";
        task.result = result;
      } catch (err) {
        console.error(`[task-manager] Task ${taskId} failed:`, err);
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.running--;
        this.drainQueue();
      }
    };

    if (this.running < this.maxConcurrent) {
      execute();
    } else {
      this.queue.push(execute);
    }

    return taskId;
  }

  private drainQueue(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }

  updateProgress(taskId: string, progress: SolverProgress): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.progress = progress;
    }
  }

  getTask(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  shutdown(): void {
    // Nothing to clean up — child processes are managed per-task
  }
}

/** Module-level singleton, initialised at startup. */
export let taskManager: TaskManager | null = null;

export function initTaskManager(maxConcurrentJobs: number): TaskManager {
  taskManager = new TaskManager(maxConcurrentJobs);
  return taskManager;
}
