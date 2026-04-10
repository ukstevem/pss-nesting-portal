// ---------------------------------------------------------------------------
// Request types (matches Python Pydantic models exactly)
// ---------------------------------------------------------------------------

export interface NestingItem {
  item_index: number;
  ref_id?: string | null;
  section: string;
  length: number; // mm, integer required by CP-SAT
  parent?: string | null;
  member_name?: string | null;
}

export interface StockEntry {
  length: number;
  qty: number;
}

export interface SectionStock {
  section: string;
  stock: StockEntry[];
}

export interface NestingRequest {
  job_label?: string | null;
  items: NestingItem[];
  stock_per_section: SectionStock[];
  default_stock?: StockEntry[] | null;
  kerf: number; // default 3
  time_limit: number; // default 300.0
}

// ---------------------------------------------------------------------------
// Result types (matches Python solver output)
// ---------------------------------------------------------------------------

export interface BinItem {
  item_index: number;
  ref_id?: string | null;
  section: string;
  length: number;
  parent?: string | null;
  member_name?: string | null;
}

export interface ResultBin {
  stock_id: string;
  stock_length_mm: number;
  used_length_mm: number;
  waste_mm: number;
  items: BinItem[];
}

export interface SectionSummary {
  stocks_used: number;
  total_waste_mm: number;
  items_placed: number;
  items_unassigned: number;
}

export type PhaseStatus =
  | "optimal"
  | "feasible"
  | "infeasible"
  | "greedy_fallback"
  | "no_stock";

export interface SectionResult {
  result_bins: ResultBin[];
  unassigned: BinItem[];
  phase1_status: PhaseStatus;
  phase2_status: PhaseStatus | null;
  summary: SectionSummary;
}

export interface NestingTotals {
  sections_processed: number;
  total_stocks_used: number;
  total_waste_mm: number;
  total_items_placed: number;
  total_items_unassigned: number;
}

export interface NestingResult {
  job_label: string | null;
  run_at: string; // ISO8601
  kerf_mm: number;
  sections: Record<string, SectionResult>;
  totals: NestingTotals;
}

// ---------------------------------------------------------------------------
// Cutting list types (reformatted output)
// ---------------------------------------------------------------------------

export interface CuttingListCut {
  cut_no: number;
  ref_id?: string | null;
  member?: string | null;
  parent?: string | null;
  length_mm: number;
}

export interface CuttingListBar {
  bar_label: string;
  stock_id: string;
  stock_length_mm: number;
  used_length_mm: number;
  waste_mm: number;
  cuts: CuttingListCut[];
}

export interface CuttingListSection {
  designation: string;
  items_placed: number;
  items_unassigned: number;
  phase1_status: PhaseStatus;
  phase2_status: PhaseStatus | null;
  summary: SectionSummary;
  bars: CuttingListBar[];
  unassigned: BinItem[];
}

export interface CuttingList {
  job_label: string | null;
  run_at: string;
  totals: NestingTotals;
  sections: CuttingListSection[];
}

// ---------------------------------------------------------------------------
// Layout data types (graphical representation for frontend UI)
// ---------------------------------------------------------------------------

export interface LayoutCut {
  ref_id?: string | null;
  member?: string | null;
  parent?: string | null;
  length_mm: number;
  offset_mm: number; // start position on bar
}

export interface LayoutBar {
  bar_label: string;
  stock_id: string;
  stock_length_mm: number;
  used_length_mm: number;
  waste_mm: number;
  utilisation_pct: number;
  cuts: LayoutCut[];
  kerf_positions_mm: number[]; // positions where kerf cuts occur
}

export interface LayoutSection {
  designation: string;
  summary: SectionSummary;
  bars: LayoutBar[];
  unassigned: BinItem[];
}

export interface LayoutData {
  job_label: string | null;
  run_at: string;
  kerf_mm: number;
  totals: NestingTotals;
  sections: LayoutSection[];
}

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export interface SolverProgress {
  phase: number;
  description: string;
  percent?: number;
  items_placed?: number;
  current_scrap_mm?: number;
  elapsed_s: number;
  section?: string;
  section_index?: number;
  section_count?: number;
}

export interface TaskInfo {
  status: "pending" | "running" | "completed" | "failed";
  progress: SolverProgress | Record<string, never>;
  result: NestingResult | null;
  error: string | null;
}
