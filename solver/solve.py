#!/usr/bin/env python3
"""
CLI bridge between Node.js and the CP-SAT solver.

Protocol:
  stdin  ← JSON request (NestingRequest + num_search_workers)
  stderr ← JSON-line progress updates (one per improving solution)
  stdout → JSON result
"""

import json
import sys

from beam_nesting import run_nesting


def main() -> None:
    request = json.load(sys.stdin)

    def progress_callback(progress: dict) -> None:
        sys.stderr.write(json.dumps(progress) + "\n")
        sys.stderr.flush()

    result = run_nesting(
        job_label=request.get("job_label"),
        items=request["items"],
        stock_per_section=request.get("stock_per_section", []),
        default_stock=request.get("default_stock"),
        kerf=request.get("kerf", 3),
        time_limit=request.get("time_limit", 300.0),
        num_search_workers=request.get("num_search_workers", 2),
        update_progress_fn=progress_callback,
        pack_tight=request.get("pack_tight", True),
    )

    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
