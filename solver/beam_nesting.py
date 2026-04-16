"""
1D bin-packing nesting service using OR-Tools CP-SAT.

Ported from: C:\\Dev\\PSS\\ifc British Sugar\\Refined Nesting.ipynb
Two-phase strategy:
  Phase 1 — maximise items placed (identifies items that genuinely won't fit in given stock)
  Phase 2 — fix assigned count, minimise total scrap
Greedy first-fit warm-start provides initial hints to speed up the solver.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import logging
from ortools.sat.python import cp_model

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Progress callback
# ---------------------------------------------------------------------------

class _NestingProgressCallback(cp_model.CpSolverSolutionCallback):
    """Fires on each improving CP-SAT solution and streams progress to caller."""

    def __init__(self, phase: int, n_items: int, update_fn: Callable[[Dict], None]):
        super().__init__()
        self._phase = phase
        self._n = n_items
        self._update = update_fn

    def on_solution_callback(self) -> None:  # noqa: N802 (OR-Tools naming convention)
        if self._phase == 1:
            placed = int(self.objective_value)
            self._update({
                "phase": 1,
                "description": f"Maximising placement: {placed}/{self._n} items placed",
                "percent": round(placed / self._n * 100, 1) if self._n else 0,
                "items_placed": placed,
                "elapsed_s": round(self.wall_time, 1),
            })
        else:
            scrap = int(self.objective_value)
            self._update({
                "phase": 2,
                "description": f"Minimising waste: current best {scrap} mm scrap",
                "current_scrap_mm": scrap,
                "elapsed_s": round(self.wall_time, 1),
            })


# ---------------------------------------------------------------------------
# Greedy warm-start
# ---------------------------------------------------------------------------

def _build_first_fit_hint(
    bins: List[Dict],
    lengths: List[int],
    kerf: int,
) -> tuple[Dict, Dict]:
    """Return hint dicts hint_x[(i,j)] and hint_y[j] from a greedy first-fit pass."""
    n_bins = len(bins)
    rem = {j: bins[j]["length"] for j in range(n_bins)}

    hint_x = {(i, j): 0 for i in range(len(lengths)) for j in range(n_bins)}
    hint_y = {j: 0 for j in range(n_bins)}

    for i, L in enumerate(lengths):
        for j in range(n_bins):
            extra = kerf if rem[j] != bins[j]["length"] else 0
            if rem[j] >= L + extra:
                hint_x[(i, j)] = 1
                hint_y[j] = 1
                rem[j] -= (L + extra)
                break

    return hint_x, hint_y


def _greedy_fallback(
    items: List[Dict],
    bins: List[Dict],
    kerf: int,
) -> tuple[List[Dict], set]:
    """First-fit-decreasing greedy packing.  Used when the CP-SAT solver
    returns a corrupted feasible solution."""
    log.warning("greedy_fallback_used: using first-fit-decreasing")
    sorted_items = sorted(enumerate(items), key=lambda t: -int(t[1]["length"]))
    n_bins = len(bins)
    rem = {j: bins[j]["length"] for j in range(n_bins)}
    bin_contents: Dict[int, list] = {j: [] for j in range(n_bins)}

    assigned_idx: set = set()
    for i, it in sorted_items:
        L = int(it["length"])
        for j in range(n_bins):
            extra = kerf if bin_contents[j] else 0
            if rem[j] >= L + extra:
                bin_contents[j].append(it)
                assigned_idx.add(it["item_index"])
                rem[j] -= (L + extra)
                break

    result_bins = []
    for j in range(n_bins):
        if bin_contents[j]:
            stock_len = bins[j]["length"]
            used_len = sum(int(it["length"]) for it in bin_contents[j])
            n_cuts = len(bin_contents[j])
            kerf_total = kerf * (n_cuts - 1) if n_cuts > 1 else 0
            waste = max(0, stock_len - used_len - kerf_total)
            result_bins.append({
                "stock_id": bins[j]["id"],
                "stock_length_mm": stock_len,
                "used_length_mm": used_len,
                "waste_mm": waste,
                "items": bin_contents[j],
            })

    return result_bins, assigned_idx


# ---------------------------------------------------------------------------
# Single-section CP-SAT solve
# ---------------------------------------------------------------------------

def _run_single_section(
    section: str,
    items: List[Dict],
    stock_inventory: List[Dict],
    kerf: int,
    time_limit: float,
    num_search_workers: int,
    update_progress_fn: Callable[[Dict], None],
    pack_tight: bool = True,
) -> Dict[str, Any]:
    """
    Run CP-SAT nesting for a single section profile.

    items: list of dicts with keys item_index, length (and optionally ref_id, parent, member_name)
    stock_inventory: list of {length, qty}
    pack_tight: when True, Phase 2 minimises bar count first, then waste within that count.
                When False, Phase 2 minimises total waste only (original behaviour).
    Returns a dict with result_bins, unassigned, phase1_status, phase2_status, summary.
    """
    max_stock = max(s["length"] for s in stock_inventory)
    too_long = [it for it in items if int(it["length"]) > max_stock]
    if too_long:
        log.warning("items_exceed_stock section=%s count=%d", section, len(too_long))
        return {
            "result_bins": [],
            "unassigned": too_long,
            "phase1_status": "infeasible",
            "phase2_status": None,
            "summary": {
                "stocks_used": 0,
                "total_waste_mm": 0,
                "items_placed": 0,
                "items_unassigned": len(too_long),
            },
        }

    # Expand stock into individual bins, sorted shortest-first so the
    # solver and greedy fallback prefer shorter (scrap/offcut) stock
    # before cutting into full-length bars.
    sorted_inventory = sorted(stock_inventory, key=lambda s: int(s["length"]))
    bins: List[Dict] = []
    for idx, stock in enumerate(sorted_inventory):
        for copy in range(stock["qty"]):
            bins.append({"id": f"S{idx}_{copy}", "length": int(stock["length"])})

    num_bins = len(bins)
    n = len(items)
    lengths = [int(it["length"]) for it in items]

    model = cp_model.CpModel()
    x = {(i, j): model.new_bool_var(f"x[{i},{j}]") for i in range(n) for j in range(num_bins)}
    y = {j: model.new_bool_var(f"y[{j}]") for j in range(num_bins)}
    assign = [model.new_bool_var(f"assign[{i}]") for i in range(n)]

    # Each item assigned to at most one bin
    for i in range(n):
        model.add(sum(x[(i, j)] for j in range(num_bins)) == assign[i])
        for j in range(num_bins):
            model.add(x[(i, j)] <= y[j])

    # Bin capacity + scrap tracking
    scrap = []
    for j in range(num_bins):
        stock_len = bins[j]["length"]
        usage = sum(x[(i, j)] * (lengths[i] + kerf) for i in range(n))
        s = model.new_int_var(0, stock_len, f"scrap[{j}]")
        scrap.append(s)
        model.add(s + usage - kerf * y[j] == stock_len).only_enforce_if(y[j])
        model.add(usage == 0).only_enforce_if(y[j].negated())
        model.add(s == 0).only_enforce_if(y[j].negated())

    # Symmetry breaking: prefer lower-index bins for identical stock lengths
    for j in range(num_bins - 1):
        if bins[j]["length"] == bins[j + 1]["length"]:
            model.add(y[j] >= y[j + 1])

    # Warm-start hints
    hint_x, hint_y = _build_first_fit_hint(bins, lengths, kerf)
    for (i, j), var in x.items():
        model.add_hint(var, hint_x[(i, j)])
    for j, var in y.items():
        model.add_hint(var, hint_y[j])
    for i, var in enumerate(assign):
        model.add_hint(var, 1 if any(hint_x[(i, jj)] for jj in range(num_bins)) else 0)

    def _make_solver() -> cp_model.CpSolver:
        s = cp_model.CpSolver()
        s.parameters.max_time_in_seconds = time_limit
        s.parameters.num_search_workers = num_search_workers
        return s

    # --- Phase 1: maximise items placed ---
    model.maximize(sum(assign))
    cb1 = _NestingProgressCallback(phase=1, n_items=n, update_fn=update_progress_fn)
    solver = _make_solver()
    status1 = solver.solve(model, cb1)

    if status1 == cp_model.OPTIMAL:
        phase1_status = "optimal"
    elif status1 == cp_model.FEASIBLE:
        phase1_status = "feasible"
    else:
        return {
            "result_bins": [],
            "unassigned": items,
            "phase1_status": "infeasible",
            "phase2_status": None,
            "summary": {
                "stocks_used": 0,
                "total_waste_mm": 0,
                "items_placed": 0,
                "items_unassigned": n,
            },
        }

    best_assigned = int(solver.objective_value)
    log.info("nesting_phase1 section=%s placed=%d total=%d status=%s", section, best_assigned, n, phase1_status)

    # --- Phase 2: fix count, minimise bars+scrap or just scrap ---
    model.add(sum(assign) == best_assigned)
    if pack_tight:
        # Lexicographic: minimise bar count first, then waste.
        # Weight bins_used by (total stock length + 1) — the theoretical max
        # total scrap — so one fewer bar always dominates any scrap change.
        big_m = sum(b["length"] for b in bins) + 1
        model.minimize(
            sum(y[j] for j in range(num_bins)) * big_m + sum(scrap)
        )
    else:
        model.minimize(sum(scrap))
    cb2 = _NestingProgressCallback(phase=2, n_items=n, update_fn=update_progress_fn)
    solver2 = _make_solver()
    status2 = solver2.solve(model, cb2)
    phase2_status = "optimal" if status2 == cp_model.OPTIMAL else "feasible"
    total_scrap = int(solver2.objective_value)
    log.info("nesting_phase2 section=%s scrap_mm=%d status=%s", section, total_scrap, phase2_status)

    # --- Extract solution ---
    result_bins = []
    assigned_idx: set = set()
    item_bin_count = [0] * n  # track how many bins each item is in
    for j in range(num_bins):
        if solver2.value(y[j]):
            bin_items = []
            for i in range(n):
                if solver2.value(x[(i, j)]):
                    bin_items.append(items[i])
                    assigned_idx.add(items[i]["item_index"])
                    item_bin_count[i] += 1
            stock_len = bins[j]["length"]
            used_len = sum(int(it["length"]) for it in bin_items)
            # Compute waste from stock and usage rather than trusting the
            # solver variable, which can return garbage on feasible (non-
            # optimal) solutions.
            n_cuts = len(bin_items)
            kerf_total = kerf * (n_cuts - 1) if n_cuts > 1 else 0
            waste = max(0, stock_len - used_len - kerf_total)
            result_bins.append({
                "stock_id": bins[j]["id"],
                "stock_length_mm": stock_len,
                "used_length_mm": used_len,
                "waste_mm": waste,
                "items": bin_items,
            })

    # Sanity check: no item should be in more than one bin, and no bin
    # should exceed its stock length.  If the solver returned a corrupted
    # feasible solution (can happen on timeout with large models), fall
    # back to the greedy first-fit result.
    multi = sum(1 for c in item_bin_count if c > 1)
    overloaded = any(
        b["used_length_mm"] > b["stock_length_mm"] for b in result_bins
    )
    if multi or overloaded:
        log.warning("nesting_invalid_solution section=%s multi_assigned=%d overloaded=%s phase2_status=%s",
                    section, multi, overloaded, phase2_status)
        result_bins, assigned_idx = _greedy_fallback(items, bins, kerf)
        phase2_status = "greedy_fallback"

    unassigned = [it for it in items if it["item_index"] not in assigned_idx]

    return {
        "result_bins": result_bins,
        "unassigned": unassigned,
        "phase1_status": phase1_status,
        "phase2_status": phase2_status,
        "summary": {
            "stocks_used": len(result_bins),
            "total_waste_mm": sum(b["waste_mm"] for b in result_bins),
            "items_placed": best_assigned,
            "items_unassigned": len(unassigned),
        },
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_nesting(
    job_label: Optional[str],
    items: List[Dict],
    stock_per_section: List[Dict],
    default_stock: Optional[List[Dict]],
    kerf: int,
    time_limit: float,
    num_search_workers: int,
    update_progress_fn: Callable[[Dict], None],
    pack_tight: bool = True,
) -> Dict[str, Any]:
    """
    Group items by section and run CP-SAT nesting for each group.

    items: list of dicts (NestingItem serialised)
    stock_per_section: list of {section, stock: [{length, qty}]}
    default_stock: fallback stock when section not found in stock_per_section
    pack_tight: minimise bar count first, then waste (default True)
    """
    # Build stock lookup
    stock_map: Dict[str, List[Dict]] = {s["section"]: s["stock"] for s in stock_per_section}

    # Group items by section
    groups: Dict[str, List[Dict]] = {}
    for item in items:
        groups.setdefault(item["section"], []).append(item)

    section_names = list(groups.keys())
    section_count = len(section_names)
    sections_result: Dict[str, Any] = {}

    for idx, section in enumerate(section_names):
        stock = stock_map.get(section) or default_stock
        if not stock:
            log.warning("no_stock_for_section section=%s", section)
            sections_result[section] = {
                "result_bins": [],
                "unassigned": groups[section],
                "phase1_status": "no_stock",
                "phase2_status": None,
                "summary": {
                    "stocks_used": 0,
                    "total_waste_mm": 0,
                    "items_placed": 0,
                    "items_unassigned": len(groups[section]),
                },
            }
            continue

        # Wrap progress to include section context
        def _section_progress(p: Dict, _section=section, _idx=idx) -> None:
            update_progress_fn({
                **p,
                "section": _section,
                "section_index": _idx + 1,
                "section_count": section_count,
            })

        sections_result[section] = _run_single_section(
            section=section,
            items=groups[section],
            stock_inventory=stock,
            kerf=kerf,
            time_limit=time_limit,
            num_search_workers=num_search_workers,
            update_progress_fn=_section_progress,
            pack_tight=pack_tight,
        )

    totals = {
        "sections_processed": section_count,
        "total_stocks_used": sum(s["summary"]["stocks_used"] for s in sections_result.values()),
        "total_waste_mm": sum(s["summary"]["total_waste_mm"] for s in sections_result.values()),
        "total_items_placed": sum(s["summary"]["items_placed"] for s in sections_result.values()),
        "total_items_unassigned": sum(s["summary"]["items_unassigned"] for s in sections_result.values()),
    }

    return {
        "job_label": job_label,
        "run_at": datetime.now(timezone.utc).isoformat(),
        "kerf_mm": kerf,
        "sections": sections_result,
        "totals": totals,
    }
