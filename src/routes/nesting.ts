import { Router, type Request, type Response } from "express";
import fs from "fs/promises";
import path from "path";
import { config } from "../config.js";
import { taskManager } from "../services/task-manager.js";
import { runSolver } from "../services/solver.js";
import {
  toCuttingList,
  toLayoutData,
  cuttingListToCsv,
  cuttingListToXlsx,
} from "../services/cutting-list.js";
import type {
  NestingRequest,
  NestingResult,
} from "../types/nesting.js";

export const nestingRouter: Router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resultPath(taskId: string): string {
  return path.join(config.RESULTS_DIR, `${taskId}.json`);
}

async function loadResult(taskId: string): Promise<NestingResult | null> {
  // Try in-memory first
  if (taskManager) {
    const task = taskManager.getTask(taskId);
    if (task?.result) return task.result;
  }
  // Fall back to disk
  try {
    const raw = await fs.readFile(resultPath(taskId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /run — submit a nesting job
// ---------------------------------------------------------------------------

nestingRouter.post("/run", async (req: Request, res: Response) => {
  const body = req.body as NestingRequest;

  if (!body.items || body.items.length === 0) {
    res.status(422).json({ detail: "items list is empty" });
    return;
  }
  if (
    (!body.stock_per_section || body.stock_per_section.length === 0) &&
    !body.default_stock
  ) {
    res
      .status(422)
      .json({ detail: "Provide stock_per_section or default_stock" });
    return;
  }

  if (!taskManager) {
    res.status(500).json({ detail: "TaskManager not initialised" });
    return;
  }

  const kerf = body.kerf ?? 3;
  const timeLimit = body.time_limit ?? 300.0;
  const sectionsQueued = [...new Set(body.items.map((it) => it.section))];

  const taskId = taskManager.submit(async (_taskId, updateProgress) => {
    const result = await runSolver(
      {
        job_label: body.job_label ?? null,
        items: body.items,
        stock_per_section: body.stock_per_section ?? [],
        default_stock: body.default_stock ?? null,
        kerf,
        time_limit: timeLimit,
        num_search_workers: config.workersPerJob,
      },
      updateProgress,
    );

    // Persist to disk
    await fs.mkdir(config.RESULTS_DIR, { recursive: true });
    await fs.writeFile(resultPath(_taskId), JSON.stringify(result, null, 2));

    return result;
  });

  res.status(202).json({
    task_id: taskId,
    status: "pending",
    sections_queued: sectionsQueued,
    items_count: body.items.length,
  });
});

// ---------------------------------------------------------------------------
// GET /status/:taskId — poll job status with live solver progress
// ---------------------------------------------------------------------------

nestingRouter.get("/status/:taskId", (req: Request, res: Response) => {
  if (!taskManager) {
    res.status(500).json({ detail: "TaskManager not initialised" });
    return;
  }

  const task = taskManager.getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ detail: `Task '${req.params.taskId}' not found` });
    return;
  }

  const response: Record<string, unknown> = {
    task_id: req.params.taskId,
    status: task.status,
    progress: task.progress,
  };
  if (task.status === "failed") {
    response.error = task.error;
  }
  if (task.status === "completed" && task.result) {
    response.result = task.result;
  }
  res.json(response);
});

// ---------------------------------------------------------------------------
// GET /result/:taskId — full raw nesting result
// ---------------------------------------------------------------------------

nestingRouter.get(
  "/result/:taskId",
  async (req: Request, res: Response) => {
    const result = await loadResult(req.params.taskId);
    if (!result) {
      if (taskManager) {
        const task = taskManager.getTask(req.params.taskId);
        if (task && (task.status === "pending" || task.status === "running")) {
          res
            .status(202)
            .json({ detail: `Task '${req.params.taskId}' still ${task.status}` });
          return;
        }
      }
      res
        .status(404)
        .json({ detail: `No result found for task '${req.params.taskId}'` });
      return;
    }
    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /cutting-list/:taskId — formatted cutting list (JSON)
// ---------------------------------------------------------------------------

nestingRouter.get(
  "/cutting-list/:taskId",
  async (req: Request, res: Response) => {
    const result = await loadResult(req.params.taskId);
    if (!result) {
      res
        .status(404)
        .json({ detail: `No result found for task '${req.params.taskId}'` });
      return;
    }
    res.json(toCuttingList(result));
  },
);

// ---------------------------------------------------------------------------
// GET /cutting-list/:taskId/csv — download cutting list as CSV
// ---------------------------------------------------------------------------

nestingRouter.get(
  "/cutting-list/:taskId/csv",
  async (req: Request, res: Response) => {
    const result = await loadResult(req.params.taskId);
    if (!result) {
      res
        .status(404)
        .json({ detail: `No result found for task '${req.params.taskId}'` });
      return;
    }
    const cuttingList = toCuttingList(result);
    const csv = cuttingListToCsv(cuttingList);
    const label = (result.job_label ?? req.params.taskId).replace(/\s+/g, "_");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="cutting_list_${label}.csv"`,
    );
    res.send(csv);
  },
);

// ---------------------------------------------------------------------------
// GET /cutting-list/:taskId/xlsx — download cutting list as XLSX
// ---------------------------------------------------------------------------

nestingRouter.get(
  "/cutting-list/:taskId/xlsx",
  async (req: Request, res: Response) => {
    const result = await loadResult(req.params.taskId);
    if (!result) {
      res
        .status(404)
        .json({ detail: `No result found for task '${req.params.taskId}'` });
      return;
    }
    const cuttingList = toCuttingList(result);
    const buffer = await cuttingListToXlsx(cuttingList);
    const label = (result.job_label ?? req.params.taskId).replace(/\s+/g, "_");
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="cutting_list_${label}.xlsx"`,
    );
    res.send(buffer);
  },
);

// ---------------------------------------------------------------------------
// GET /layout/:taskId — graphical layout data (consumed by frontend UI)
// ---------------------------------------------------------------------------

nestingRouter.get(
  "/layout/:taskId",
  async (req: Request, res: Response) => {
    const result = await loadResult(req.params.taskId);
    if (!result) {
      res
        .status(404)
        .json({ detail: `No result found for task '${req.params.taskId}'` });
      return;
    }
    res.json(toLayoutData(result));
  },
);

// ---------------------------------------------------------------------------
// GET /cutting-list/:taskId/pdf — PDF via pss-document-service
// ---------------------------------------------------------------------------

nestingRouter.get(
  "/cutting-list/:taskId/pdf",
  async (req: Request, res: Response) => {
    const result = await loadResult(req.params.taskId);
    if (!result) {
      res
        .status(404)
        .json({ detail: `No result found for task '${req.params.taskId}'` });
      return;
    }

    const cuttingList = toCuttingList(result);

    try {
      const docServiceUrl = `${config.DOCUMENT_SERVICE_URL}/api/nesting/pdf`;
      const response = await fetch(docServiceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuttingList),
      });

      if (!response.ok) {
        const errorText = await response.text();
        res.status(502).json({
          detail: `Document service returned ${response.status}: ${errorText}`,
        });
        return;
      }

      const pdfBuffer = Buffer.from(await response.arrayBuffer());
      const label = (result.job_label ?? req.params.taskId).replace(
        /\s+/g,
        "_",
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="cutting_list_${label}.pdf"`,
      );
      res.send(pdfBuffer);
    } catch (err) {
      res.status(502).json({
        detail: `Failed to reach document service at ${config.DOCUMENT_SERVICE_URL}: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
);
