# PSS Nesting Service (Node.js/TypeScript)

A Node.js/TypeScript microservice that solves 1D bin-packing for structural steel beams using Google OR-Tools CP-SAT solver. Drop-in replacement for the Python `nesting-service` — same API contract, same async workflow, same solver.

The solver itself remains Python (OR-Tools CP-SAT has no JS binding). Node.js calls it via subprocess.

## Project structure

```
pss-nesting-service/
  package.json
  tsconfig.json
  Dockerfile
  docker-compose.yml
  src/
    index.ts              # Entry point — starts Express server
    server.ts             # Express app factory, CORS, routes
    config.ts             # Environment-based config (NESTING_ prefix)
    routes/
      nesting.ts          # All /api/v1/nesting/ endpoints
    services/
      task-manager.ts     # In-memory async job queue
      solver.ts           # Spawns Python CP-SAT solver as child process
      cutting-list.ts     # Cutting list formatting (JSON, CSV, XLSX, layout)
    types/
      nesting.ts          # TypeScript interfaces (matches Python Pydantic models)
  solver/
    beam_nesting.py       # CP-SAT two-phase solver + greedy fallback (from original)
    solve.py              # CLI bridge: JSON stdin → progress stderr → JSON stdout
    requirements.txt      # Python deps (ortools)
  outputs/
    results/              # Persisted result JSON files
```

## How to run

### Docker (recommended)

```bash
docker compose up --build
```

Service starts on port **8001**.

### Local (without Docker)

```bash
# Install Node dependencies
pnpm install

# Install Python solver deps
pip install -r solver/requirements.txt

# Set local paths (defaults assume Docker /app/outputs)
export NESTING_OUTPUT_DIR=./outputs
export NESTING_RESULTS_DIR=./outputs/results
export NESTING_PYTHON_BIN=python3
export NESTING_SOLVER_SCRIPT=solver/solve.py

# Dev mode with hot-reload
pnpm dev

# OR build and run
pnpm build && pnpm start
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8001` | HTTP server port |
| `NESTING_API_TITLE` | `Beam Nesting Service` | Service title |
| `NESTING_API_VERSION` | `1.0.0` | API version |
| `NESTING_OUTPUT_DIR` | `/app/outputs` | Base output directory |
| `NESTING_RESULTS_DIR` | `/app/outputs/results` | Where result JSON files are persisted |
| `NESTING_MAX_CONCURRENT_JOBS` | `2` | Max simultaneous CP-SAT solves |
| `NESTING_PYTHON_BIN` | `python3` | Python binary for solver subprocess |
| `NESTING_SOLVER_SCRIPT` | `solver/solve.py` | Path to solver CLI bridge |
| `DOCUMENT_SERVICE_URL` | `http://localhost:3000` | pss-document-service URL for PDF generation |

`workersPerJob` is auto-calculated as `os.cpus().length / MAX_CONCURRENT_JOBS`.

## API endpoints

All nesting endpoints are under `/api/v1/nesting/`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Service info |
| GET | `/health` | Health check (`{"status": "ok"}`) |
| POST | `/api/v1/nesting/run` | Submit a nesting job (returns 202 with `task_id`) |
| GET | `/api/v1/nesting/status/{task_id}` | Poll job status with live solver progress |
| GET | `/api/v1/nesting/result/{task_id}` | Full raw nesting result (JSON) |
| GET | `/api/v1/nesting/cutting-list/{task_id}` | Formatted cutting list (JSON) |
| GET | `/api/v1/nesting/cutting-list/{task_id}/csv` | Download cutting list as CSV |
| GET | `/api/v1/nesting/cutting-list/{task_id}/xlsx` | Download cutting list as XLSX |
| GET | `/api/v1/nesting/cutting-list/{task_id}/pdf` | Download cutting list as PDF (via document service) |
| GET | `/api/v1/nesting/layout/{task_id}` | Graphical layout data (consumed by frontend UI) |

### Request format (POST /run)

```json
{
  "job_label": "optional name",
  "items": [
    { "item_index": 0, "section": "UB254x102x25", "length": 5000,
      "ref_id": "B001", "parent": "Frame 1", "member_name": "Beam A" }
  ],
  "stock_per_section": [
    { "section": "UB254x102x25", "stock": [{ "length": 6000, "qty": 10 }] }
  ],
  "default_stock": [{ "length": 6000, "qty": 5 }],
  "kerf": 3,
  "time_limit": 300.0
}
```

### Async workflow

1. POST `/run` returns immediately with `{ "task_id": "...", "status": "pending" }`.
2. Poll `GET /status/{task_id}` for live progress (phase, items placed, elapsed time).
3. When status is `"completed"`, result is embedded in the status response.
4. Use `/result/{task_id}`, `/cutting-list/{task_id}`, or `/layout/{task_id}` for formatted output.

### New endpoints (beyond original Python service)

- **GET /cutting-list/{task_id}/xlsx** — XLSX export with summary sheet + one sheet per section.
- **GET /cutting-list/{task_id}/pdf** — Delegates to pss-document-service for branded PDF.
- **GET /layout/{task_id}** — Graphical layout data with `offset_mm` per cut and `kerf_positions_mm` for frontend bar visualisation.

## Architecture: Node.js ↔ Python solver bridge

The CP-SAT solver remains in Python (`solver/beam_nesting.py`, unchanged from the original service). Node.js communicates via child process:

```
Node.js                          Python subprocess
────────                         ─────────────────
spawn(python3 solve.py)  ───→    reads JSON from stdin
                                 calls run_nesting(...)
            ←── stderr ←─        streams JSON-line progress
            ←── stdout ←─        writes result JSON
```

- **stdin**: full NestingRequest + `num_search_workers`
- **stderr**: one JSON object per line for each improving CP-SAT solution (progress)
- **stdout**: final NestingResult JSON on completion

This allows the solver to use all OR-Tools features (warm-start, callbacks, multi-threaded search) while the API layer is pure Node.js/TypeScript.

## Solver algorithm (beam_nesting.py)

Two-phase CP-SAT approach per section:

**Phase 1 — Maximise placement**: maximise the number of items assigned to bins. Identifies items that genuinely cannot fit in any available stock.

**Phase 2 — Minimise waste**: fix the assigned count from Phase 1, then minimise total scrap across all used bins.

Key details:
- Stock is expanded into individual bins and sorted **shortest-first**.
- **Warm-start**: greedy first-fit-decreasing provides initial hints.
- **Symmetry breaking**: for identical stock lengths, prefer lower-index bins.
- **Fallback**: if CP-SAT returns a corrupted feasible solution, falls back to greedy.
- Phase statuses: `optimal`, `feasible`, `infeasible`, `greedy_fallback`, `no_stock`.

## Result persistence

Completed results are saved to `{RESULTS_DIR}/{task_id}.json`. All read endpoints check in-memory cache first, then fall back to disk.

## PDF generation

PDF is delegated to pss-document-service (default `http://localhost:3000`). The nesting service POSTs the cutting list JSON to `POST /api/nesting/pdf` and streams back the PDF response. The document service endpoint must be implemented separately.

## Docker setup

- **Multi-stage build**: Node.js compile → slim production image with Python 3 + ortools venv
- **Base**: `node:20-slim` with Python 3 installed via apt
- **Port**: 8001
- **Volumes**: `./outputs:/app/outputs` — persist results
- **Restart policy**: `unless-stopped`

## Deployment (Jetson Orin Nano — 10.0.0.74)

```bash
docker compose up --build -d
```

Set `NESTING_MAX_CONCURRENT_JOBS` based on Orin's CPU count (6 cores → `MAX_CONCURRENT_JOBS=2` gives 3 solver threads each).

### CUDA acceleration (investigation notes)

The OR-Tools CP-SAT solver is CPU-only — it does not support GPU/CUDA acceleration. The solver uses multi-threaded search with `num_search_workers` but has no GPU code path. The Jetson Orin Nano's CUDA cores **cannot** accelerate CP-SAT.

Potential CUDA use cases (if ever needed):
- Pre-processing large datasets (sorting, grouping) with custom CUDA kernels — unlikely to be a bottleneck
- Training an ML model to predict good initial solutions — significant effort, marginal gain for 1D bin-packing
- Alternative GPU-based solvers exist for some optimisation problems but not for the constrained bin-packing variant used here

**Recommendation**: Stick with CPU-based CP-SAT. The Orin's 6 ARM Cortex-A78AE cores are sufficient. Tune `MAX_CONCURRENT_JOBS` and `time_limit` instead.

## Notes

- CORS is wide open (`*`). Lock down for production.
- No authentication. Add API key/token auth before exposing publicly.
- No database required — all state is in-memory + JSON files on disk.
- Aligns with pss-document-service patterns: ESM, strict TypeScript, Express factory, pnpm.
