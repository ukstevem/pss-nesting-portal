import ExcelJS from "exceljs";
import type {
  NestingResult,
  CuttingList,
  CuttingListSection,
  CuttingListBar,
  StockConsumption,
  StockConsumptionGroup,
  OverallStockConsumption,
  LayoutData,
  LayoutSection,
  LayoutBar,
  LayoutCut,
  BinItem,
} from "../types/nesting.js";

// ---------------------------------------------------------------------------
// Stock-bar consumption roll-up (grouped by length, longest first)
// ---------------------------------------------------------------------------

function toStockConsumption(counts: Map<number, number>): StockConsumption {
  const groups = [...counts.entries()]
    .map(([length_mm, qty]) => ({ length_mm, qty }))
    .sort((a, b) => b.length_mm - a.length_mm);
  const total_bars = groups.reduce((sum, g) => sum + g.qty, 0);
  return { total_bars, groups };
}

/** "12@12200, 12@6000" — the length groups of one section, longest first. */
export function formatConsumptionGroups(groups: StockConsumptionGroup[]): string {
  return groups.map((g) => `${g.qty}@${g.length_mm}`).join(", ");
}

/** One section's summary, e.g. "24 bars: 12@12200, 12@6000". */
export function formatStockConsumption(sc: StockConsumption): string {
  if (sc.total_bars === 0) return "0 bars";
  return `${sc.total_bars} bars: ${formatConsumptionGroups(sc.groups)}`;
}

// ---------------------------------------------------------------------------
// JSON cutting list (matches Python _to_cutting_list exactly)
// ---------------------------------------------------------------------------

export function toCuttingList(result: NestingResult): CuttingList {
  const sections: CuttingListSection[] = [];

  for (const [designation, sec] of Object.entries(result.sections)) {
    const bars: CuttingListBar[] = (sec.result_bins ?? []).map((bin, idx) => ({
      bar_label: `Bar ${idx + 1}`,
      stock_id: bin.stock_id,
      stock_length_mm: bin.stock_length_mm,
      used_length_mm: bin.used_length_mm,
      waste_mm: bin.waste_mm,
      cuts: (bin.items ?? []).map((item, cutIdx) => ({
        cut_no: cutIdx + 1,
        ref_id: item.ref_id ?? null,
        member: item.member_name ?? null,
        parent: item.parent ?? null,
        length_mm: item.length,
      })),
    }));

    const sectionCounts = new Map<number, number>();
    for (const bar of bars) {
      sectionCounts.set(
        bar.stock_length_mm,
        (sectionCounts.get(bar.stock_length_mm) ?? 0) + 1,
      );
    }

    sections.push({
      designation,
      comments: sec.comments ?? null,
      items_placed: sec.summary.items_placed,
      items_unassigned: sec.summary.items_unassigned,
      phase1_status: sec.phase1_status,
      phase2_status: sec.phase2_status,
      summary: sec.summary,
      stock_consumption: toStockConsumption(sectionCounts),
      bars,
      unassigned: sec.unassigned ?? [],
    });
  }

  // Overall roll-up: section-major so distinct profiles at the same stock
  // length are never conflated. Only sections that actually used stock appear.
  const overall: OverallStockConsumption = {
    total_bars: sections.reduce((sum, s) => sum + s.stock_consumption.total_bars, 0),
    by_section: sections
      .filter((s) => s.stock_consumption.total_bars > 0)
      .map((s) => ({
        designation: s.designation,
        consumption: s.stock_consumption,
      })),
  };

  return {
    job_label: result.job_label,
    run_at: result.run_at,
    totals: result.totals,
    stock_consumption: overall,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Graphical layout data (for frontend UI rendering)
// ---------------------------------------------------------------------------

export function toLayoutData(result: NestingResult): LayoutData {
  const sections: LayoutSection[] = [];

  for (const [designation, sec] of Object.entries(result.sections)) {
    const bars: LayoutBar[] = (sec.result_bins ?? []).map((bin, idx) => {
      const cuts: LayoutCut[] = [];
      const kerfPositions: number[] = [];
      let offset = 0;

      for (let i = 0; i < (bin.items ?? []).length; i++) {
        const item = bin.items[i];
        cuts.push({
          ref_id: item.ref_id ?? null,
          member: item.member_name ?? null,
          parent: item.parent ?? null,
          length_mm: item.length,
          offset_mm: offset,
        });
        offset += item.length;
        // Add kerf between cuts (not after the last one)
        if (i < bin.items.length - 1) {
          kerfPositions.push(offset);
          offset += result.kerf_mm;
        }
      }

      const utilisation =
        bin.stock_length_mm > 0
          ? Math.round((bin.used_length_mm / bin.stock_length_mm) * 1000) / 10
          : 0;

      return {
        bar_label: `Bar ${idx + 1}`,
        stock_id: bin.stock_id,
        stock_length_mm: bin.stock_length_mm,
        used_length_mm: bin.used_length_mm,
        waste_mm: bin.waste_mm,
        utilisation_pct: utilisation,
        cuts,
        kerf_positions_mm: kerfPositions,
      };
    });

    sections.push({
      designation,
      summary: sec.summary,
      bars,
      unassigned: sec.unassigned ?? [],
    });
  }

  return {
    job_label: result.job_label,
    run_at: result.run_at,
    kerf_mm: result.kerf_mm,
    totals: result.totals,
    sections,
  };
}

// ---------------------------------------------------------------------------
// CSV export (matches Python _cutting_list_to_csv exactly)
// ---------------------------------------------------------------------------

function escapeCsv(val: unknown): string {
  const s = val == null ? "" : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(escapeCsv).join(",") + "\r\n";
}

export function cuttingListToCsv(cuttingList: CuttingList): string {
  let out = "";

  out += csvRow([
    "OVERALL STOCK CONSUMED",
    `${cuttingList.stock_consumption.total_bars} bars total`,
  ]);
  for (const s of cuttingList.stock_consumption.by_section) {
    out += csvRow(["", s.designation, formatConsumptionGroups(s.consumption.groups)]);
  }

  for (const sec of cuttingList.sections) {
    out += csvRow([]);
    out += csvRow(["Section", sec.designation]);
    if (sec.comments) {
      out += csvRow(["Comments", sec.comments]);
    }
    out += csvRow(["Stock consumed", formatStockConsumption(sec.stock_consumption)]);
    out += csvRow([
      "Bar",
      "Stock ID",
      "Stock Length (mm)",
      "Used (mm)",
      "Waste (mm)",
      "Cut No",
      "Ref ID",
      "Member",
      "Parent",
      "Length (mm)",
    ]);

    for (const bar of sec.bars) {
      if (bar.cuts.length === 0) {
        out += csvRow([
          bar.bar_label,
          bar.stock_id,
          bar.stock_length_mm,
          bar.used_length_mm,
          bar.waste_mm,
          "",
          "",
          "",
          "",
          "",
        ]);
      }
      for (const cut of bar.cuts) {
        out += csvRow([
          bar.bar_label,
          bar.stock_id,
          bar.stock_length_mm,
          bar.used_length_mm,
          bar.waste_mm,
          cut.cut_no,
          cut.ref_id ?? "",
          cut.member ?? "",
          cut.parent ?? "",
          cut.length_mm,
        ]);
      }
    }

    if (sec.unassigned.length > 0) {
      out += csvRow([]);
      out += csvRow(["UNASSIGNED ITEMS"]);
      out += csvRow([
        "item_index",
        "ref_id",
        "member_name",
        "parent",
        "length_mm",
      ]);
      for (const it of sec.unassigned) {
        out += csvRow([
          it.item_index,
          it.ref_id ?? "",
          it.member_name ?? "",
          it.parent ?? "",
          it.length,
        ]);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// XLSX export
// ---------------------------------------------------------------------------

export async function cuttingListToXlsx(
  cuttingList: CuttingList,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PSS Nesting Service";

  // Header style
  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2B579A" },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 10,
  };

  // Summary sheet
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 25 },
    { header: "Value", key: "value", width: 40 },
  ];
  summary.getRow(1).font = headerFont;
  summary.getRow(1).fill = headerFill;

  if (cuttingList.job_label) {
    summary.addRow({ metric: "Job Label", value: cuttingList.job_label });
  }
  summary.addRow({ metric: "Run At", value: cuttingList.run_at });
  summary.addRow({
    metric: "Sections Processed",
    value: cuttingList.totals.sections_processed,
  });
  summary.addRow({
    metric: "Total Stocks Used",
    value: cuttingList.totals.total_stocks_used,
  });
  summary.addRow({
    metric: "Total Waste (mm)",
    value: cuttingList.totals.total_waste_mm,
  });
  summary.addRow({
    metric: "Total Items Placed",
    value: cuttingList.totals.total_items_placed,
  });
  summary.addRow({
    metric: "Total Items Unassigned",
    value: cuttingList.totals.total_items_unassigned,
  });

  // Stock-bar consumption roll-up — section-major (one row per section that
  // used stock, so distinct profiles at the same length stay separate).
  summary.addRow({});
  const scTitle = summary.addRow({
    metric: "STOCK CONSUMED",
    value: `${cuttingList.stock_consumption.total_bars} bars total`,
  });
  scTitle.font = { bold: true };
  for (const s of cuttingList.stock_consumption.by_section) {
    summary.addRow({
      metric: s.designation,
      value: formatStockConsumption(s.consumption),
    });
  }

  // One sheet per section
  for (const sec of cuttingList.sections) {
    const name = sec.designation.substring(0, 31); // Excel 31-char limit
    const ws = workbook.addWorksheet(name);

    ws.columns = [
      { header: "Bar", key: "bar", width: 10 },
      { header: "Stock ID", key: "stock_id", width: 12 },
      { header: "Stock Length (mm)", key: "stock_length", width: 18 },
      { header: "Used (mm)", key: "used", width: 12 },
      { header: "Waste (mm)", key: "waste", width: 12 },
      { header: "Cut No", key: "cut_no", width: 8 },
      { header: "Ref ID", key: "ref_id", width: 15 },
      { header: "Member", key: "member", width: 20 },
      { header: "Parent", key: "parent", width: 20 },
      { header: "Length (mm)", key: "length", width: 14 },
    ];
    ws.getRow(1).font = headerFont;
    ws.getRow(1).fill = headerFill;

    for (const bar of sec.bars) {
      for (const cut of bar.cuts) {
        ws.addRow({
          bar: bar.bar_label,
          stock_id: bar.stock_id,
          stock_length: bar.stock_length_mm,
          used: bar.used_length_mm,
          waste: bar.waste_mm,
          cut_no: cut.cut_no,
          ref_id: cut.ref_id ?? "",
          member: cut.member ?? "",
          parent: cut.parent ?? "",
          length: cut.length_mm,
        });
      }
    }

    if (sec.unassigned.length > 0) {
      ws.addRow({}); // blank row
      const uaHeader = ws.addRow({
        bar: "UNASSIGNED",
        stock_id: "",
        stock_length: "",
        used: "",
        waste: "",
        cut_no: "",
        ref_id: "Ref ID",
        member: "Member",
        parent: "Parent",
        length: "Length (mm)",
      });
      uaHeader.font = { bold: true };

      for (const it of sec.unassigned) {
        ws.addRow({
          bar: it.item_index,
          ref_id: it.ref_id ?? "",
          member: it.member_name ?? "",
          parent: it.parent ?? "",
          length: it.length,
        });
      }
    }

    // Surface the operator comment as a banner row above the table.
    if (sec.comments) {
      ws.insertRow(1, [`Comments: ${sec.comments}`]);
      ws.mergeCells(1, 1, 1, 10);
      const commentRow = ws.getRow(1);
      commentRow.font = { italic: true, bold: true };
    }

    // Stock-bar consumption roll-up at the foot of the section sheet.
    ws.addRow([]);
    const scRow = ws.addRow([
      `Stock consumed — ${formatStockConsumption(sec.stock_consumption)}`,
    ]);
    ws.mergeCells(scRow.number, 1, scRow.number, 10);
    scRow.font = { bold: true };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
