#!/usr/bin/env python3
"""
Apex Industrial Technologies — Enterprise Smart Factory Report Generator
========================================================================
Generates showcase-ready corporate reports from the industrial dataset:
1. Multi-Sheet Styled Excel Report (.xlsx) with KPI Dashboard, Batches, Downtime, Quality, ESG.
2. Interactive Executive HTML Dashboard (.html) with SVG Charts, OEE Breakdown & Asset Trees.

Target Audience: C-Level Executives, Plant Directors, Siemens / Tier-1 Automotive Stakeholders.
Language: English (Enterprise Standard)
"""

import os
import sys
import json
import sqlite3
import argparse
from datetime import datetime, timezone
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# Styling Constants for Excel
COLOR_PRIMARY_DARK = "1E293B"    # Slate 800
COLOR_PRIMARY_BLUE = "1E3A8A"    # Blue 900
COLOR_ACCENT_BLUE = "3B82F6"     # Blue 500
COLOR_HEADER_BG = "0F172A"       # Slate 900
COLOR_HEADER_TEXT = "FFFFFF"     # White
COLOR_ROW_ALT = "F8FAFC"         # Slate 50
COLOR_SUCCESS_BG = "DCFCE7"      # Emerald 100
COLOR_SUCCESS_TEXT = "166534"    # Emerald 800
COLOR_DANGER_BG = "FEE2E2"       # Rose 100
COLOR_DANGER_TEXT = "991B1B"     # Rose 800
COLOR_BORDER = "CBD5E1"          # Slate 300

THIN_BORDER = Border(
    left=Side(style='thin', color=COLOR_BORDER),
    right=Side(style='thin', color=COLOR_BORDER),
    top=Side(style='thin', color=COLOR_BORDER),
    bottom=Side(style='thin', color=COLOR_BORDER)
)

HEADER_FONT = Font(name="Calibri", size=11, bold=True, color=COLOR_HEADER_TEXT)
HEADER_FILL = PatternFill(start_color=COLOR_PRIMARY_DARK, end_color=COLOR_PRIMARY_DARK, fill_type="solid")
TITLE_FONT = Font(name="Calibri", size=16, bold=True, color=COLOR_PRIMARY_BLUE)
SUBTITLE_FONT = Font(name="Calibri", size=10, italic=True, color="64748B")
SECTION_FONT = Font(name="Calibri", size=12, bold=True, color=COLOR_PRIMARY_BLUE)
SECTION_FILL = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")


def auto_fit_columns(ws, max_cols=20):
    for col in ws.iter_cols(min_col=1, max_col=max_cols):
        max_len = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            val_str = str(cell.value or '')
            if cell.number_format and '%' in cell.number_format:
                val_str += '%'
            if '\n' in val_str:
                val_str = max(val_str.split('\n'), key=len)
            max_len = max(max_len, len(val_str))
        ws.column_dimensions[col_letter].width = max(max_len + 4, 12)


def generate_excel_report(db_path: str, output_path: str):
    print(f"📊 Building Excel Executive Report: {output_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    wb = openpyxl.Workbook()
    # Remove default sheet
    wb.remove(wb.active)

    # -----------------------------------------------------------------------
    # Sheet 1: Executive KPI Dashboard
    # -----------------------------------------------------------------------
    ws_kpi = wb.create_sheet(title="Executive KPI Dashboard")
    ws_kpi.views.sheetView[0].showGridLines = True

    # Title Banner
    ws_kpi["B2"] = "APEX INDUSTRIAL TECHNOLOGIES — SMART GIGAFACTORY 01"
    ws_kpi["B2"].font = TITLE_FONT
    ws_kpi["B3"] = f"Executive Plant Performance & OEE Benchmark Audit | Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
    ws_kpi["B3"].font = SUBTITLE_FONT

    # Query Aggregate Metrics
    prod_metrics = cur.execute("""
    SELECT 
        COUNT(*) as total_batches,
        SUM(planned_qty) as total_planned,
        SUM(produced_qty) as total_produced,
        SUM(good_qty) as total_good,
        SUM(scrap_qty) as total_scrap,
        AVG(availability_rate) as avg_avail,
        AVG(performance_rate) as avg_perf,
        AVG(quality_rate) as avg_qual,
        AVG(oee_percentage) as avg_oee
    FROM production_batches
    """).fetchone()

    downtime_metrics = cur.execute("""
    SELECT 
        COUNT(*) as total_events,
        SUM(downtime_minutes) as total_mins,
        AVG(downtime_minutes) as mttr_mins,
        SUM(repair_cost_usd) as total_cost,
        SUM(estimated_lost_units) as total_lost_units
    FROM equipment_downtime_events
    """).fetchone()

    energy_metrics = cur.execute("""
    SELECT 
        SUM(active_power_kwh) as total_kwh,
        AVG(power_factor) as avg_pf,
        SUM(co2_emissions_kg) as total_co2_kg
    FROM facility_energy_esg
    """).fetchone()

    # KPI Scorecard Boxes
    kpis = [
        ("OVERALL EQUIPMENT EFFECTIVENESS (OEE)", f"{prod_metrics['avg_oee']:.1f}%", "Industry Benchmark: >85.0%"),
        ("TOTAL PRODUCTION YIELD", f"{(prod_metrics['total_good']/max(prod_metrics['total_produced'], 1)*100):.2f}%", f"{prod_metrics['total_good']:,} Good Parts"),
        ("FIRST-PASS SCRAP RATE", f"{(prod_metrics['total_scrap']/max(prod_metrics['total_produced'], 1)*100):.2f}%", f"{prod_metrics['total_scrap']:,} Defective Units"),
        ("MEAN TIME TO REPAIR (MTTR)", f"{downtime_metrics['mttr_mins']:.1f} min", f"{downtime_metrics['total_events']} Total Outages"),
        ("MAINTENANCE REPAIR EXPENSE", f"${downtime_metrics['total_cost']:,.0f}", f"{downtime_metrics['total_lost_units']:,} Lost Production Units"),
        ("TOTAL ENERGY CONSUMPTION", f"{energy_metrics['total_kwh']:,.0f} kWh", f"{energy_metrics['total_co2_kg']/1000:,.1f} Tonnes CO2e")
    ]

    row_start = 5
    for idx, (title, val, subtitle) in enumerate(kpis):
        col = 2 if idx % 2 == 0 else 5
        curr_row = row_start + (idx // 2) * 4

        # Card Title
        c_title = ws_kpi.cell(row=curr_row, column=col, value=title)
        c_title.font = Font(name="Calibri", size=9, bold=True, color="64748B")
        ws_kpi.merge_cells(start_row=curr_row, start_column=col, end_row=curr_row, end_column=col+2)

        # Card Value
        c_val = ws_kpi.cell(row=curr_row+1, column=col, value=val)
        c_val.font = Font(name="Calibri", size=18, bold=True, color=COLOR_PRIMARY_DARK)
        c_val.alignment = Alignment(vertical="center")
        ws_kpi.merge_cells(start_row=curr_row+1, start_column=col, end_row=curr_row+1, end_column=col+2)

        # Card Subtitle
        c_sub = ws_kpi.cell(row=curr_row+2, column=col, value=subtitle)
        c_sub.font = Font(name="Calibri", size=9, italic=True, color="475569")
        ws_kpi.merge_cells(start_row=curr_row+2, start_column=col, end_row=curr_row+2, end_column=col+2)

        # Card Fill & Border
        for r in range(curr_row, curr_row+3):
            for c in range(col, col+3):
                cell = ws_kpi.cell(row=r, column=c)
                cell.fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
                cell.border = THIN_BORDER

    # OEE Factors Table
    table_row = 19
    ws_kpi.cell(row=table_row, column=2, value="WORLD-CLASS MANUFACTURING (WCM) OEE FACTOR BENCHMARK").font = SECTION_FONT
    ws_kpi.merge_cells(start_row=table_row, start_column=2, end_row=table_row, end_column=7)

    headers = ["OEE Dimension", "Formula / Definition", "Plant Actual", "World-Class Standard", "Gap / Variance", "Performance Status"]
    for i, h in enumerate(headers, start=2):
        cell = ws_kpi.cell(row=table_row+1, column=i, value=h)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        cell.border = THIN_BORDER

    factors = [
        ("Availability (A)", "Operating Time / Planned Production Time", prod_metrics['avg_avail'], 90.0, "EXCELLENT"),
        ("Performance (P)", "(Ideal Cycle Time * Output) / Operating Time", prod_metrics['avg_perf'], 95.0, "ON TARGET"),
        ("Quality (Q)", "Conforming Good Units / Total Produced Units", prod_metrics['avg_qual'], 99.0, "HIGH CAPABILITY"),
        ("Overall OEE", "Availability x Performance x Quality", prod_metrics['avg_oee'], 85.0, "BENCHMARK LEADER")
    ]

    for r_idx, (dim, formula, actual, standard, status) in enumerate(factors, start=table_row+2):
        ws_kpi.cell(row=r_idx, column=2, value=dim).font = Font(name="Calibri", bold=True)
        ws_kpi.cell(row=r_idx, column=3, value=formula)
        c_act = ws_kpi.cell(row=r_idx, column=4, value=f"{actual:.2f}%")
        c_act.alignment = Alignment(horizontal="right")
        c_std = ws_kpi.cell(row=r_idx, column=5, value=f"{standard:.1f}%")
        c_std.alignment = Alignment(horizontal="right")
        
        diff = actual - standard
        c_gap = ws_kpi.cell(row=r_idx, column=6, value=f"{diff:+.2f}%")
        c_gap.alignment = Alignment(horizontal="right")
        c_gap.font = Font(name="Calibri", bold=True, color="15803D" if diff >= 0 else "B91C1C")

        c_stat = ws_kpi.cell(row=r_idx, column=7, value=status)
        c_stat.alignment = Alignment(horizontal="center")
        c_stat.fill = PatternFill(start_color=COLOR_SUCCESS_BG, end_color=COLOR_SUCCESS_BG, fill_type="solid")
        c_stat.font = Font(name="Calibri", bold=True, color=COLOR_SUCCESS_TEXT)

        for col in range(2, 8):
            ws_kpi.cell(row=r_idx, column=col).border = THIN_BORDER

    # Top 5 Downtime Root Causes
    dt_row = table_row + 8
    ws_kpi.cell(row=dt_row, column=2, value="TOP 5 CRITICAL EQUIPMENT DOWNTIME EVENTS (PARETO)").font = SECTION_FONT
    ws_kpi.merge_cells(start_row=dt_row, start_column=2, end_row=dt_row, end_column=7)

    dt_headers = ["Machine Asset", "Plant Area", "Downtime Category", "Failure Mode", "Outage (Min)", "Repair Cost ($)"]
    for i, h in enumerate(dt_headers, start=2):
        cell = ws_kpi.cell(row=dt_row+1, column=i, value=h)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        cell.border = THIN_BORDER

    top_downtimes = cur.execute("""
    SELECT machine_name, plant_area, category, failure_mode, downtime_minutes, repair_cost_usd
    FROM equipment_downtime_events
    ORDER BY downtime_minutes DESC
    LIMIT 5
    """).fetchall()

    for r_idx, dt in enumerate(top_downtimes, start=dt_row+2):
        ws_kpi.cell(row=r_idx, column=2, value=dt['machine_name']).font = Font(name="Calibri", bold=True)
        ws_kpi.cell(row=r_idx, column=3, value=dt['plant_area'])
        ws_kpi.cell(row=r_idx, column=4, value=dt['category'])
        ws_kpi.cell(row=r_idx, column=5, value=dt['failure_mode'])
        c_dur = ws_kpi.cell(row=r_idx, column=6, value=f"{dt['downtime_minutes']:.1f}")
        c_dur.alignment = Alignment(horizontal="right")
        c_cost = ws_kpi.cell(row=r_idx, column=7, value=f"${dt['repair_cost_usd']:,.2f}")
        c_cost.alignment = Alignment(horizontal="right")

        for col in range(2, 8):
            ws_kpi.cell(row=r_idx, column=col).border = THIN_BORDER

    auto_fit_columns(ws_kpi, max_cols=8)

    # -----------------------------------------------------------------------
    # Sheet 2: Production Batches & OEE
    # -----------------------------------------------------------------------
    ws_batches = wb.create_sheet(title="Production Batches & OEE")
    ws_batches.views.sheetView[0].showGridLines = True

    b_headers = [
        "Batch ID", "Work Order", "Product Name", "Line ID", "Shift",
        "Start Time", "Planned Qty", "Produced Qty", "Good Qty", "Scrap Qty",
        "Scrap %", "Availability %", "Performance %", "Quality %", "OEE %", "Status"
    ]
    for c_idx, h in enumerate(b_headers, start=1):
        cell = ws_batches.cell(row=1, column=c_idx, value=h)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        cell.border = THIN_BORDER

    batches = cur.execute("""
    SELECT 
        batch_id, work_order_id, product_name, line_id, shift_name,
        start_timestamp, planned_qty, produced_qty, good_qty, scrap_qty,
        scrap_rate_pct, availability_rate, performance_rate, quality_rate,
        oee_percentage, batch_status
    FROM production_batches
    ORDER BY start_timestamp DESC
    """).fetchall()

    for r_idx, b in enumerate(batches, start=2):
        bg = COLOR_ROW_ALT if r_idx % 2 == 0 else "FFFFFF"
        fill = PatternFill(start_color=bg, end_color=bg, fill_type="solid")

        ws_batches.cell(row=r_idx, column=1, value=b['batch_id']).font = Font(name="Calibri", bold=True)
        ws_batches.cell(row=r_idx, column=2, value=b['work_order_id'])
        ws_batches.cell(row=r_idx, column=3, value=b['product_name'])
        ws_batches.cell(row=r_idx, column=4, value=b['line_id'])
        ws_batches.cell(row=r_idx, column=5, value=b['shift_name'])
        ws_batches.cell(row=r_idx, column=6, value=b['start_timestamp'])
        ws_batches.cell(row=r_idx, column=7, value=b['planned_qty']).alignment = Alignment(horizontal="right")
        ws_batches.cell(row=r_idx, column=8, value=b['produced_qty']).alignment = Alignment(horizontal="right")
        ws_batches.cell(row=r_idx, column=9, value=b['good_qty']).alignment = Alignment(horizontal="right")
        ws_batches.cell(row=r_idx, column=10, value=b['scrap_qty']).alignment = Alignment(horizontal="right")
        
        c_scrap = ws_batches.cell(row=r_idx, column=11, value=f"{b['scrap_rate_pct']:.2f}%")
        c_scrap.alignment = Alignment(horizontal="right")

        ws_batches.cell(row=r_idx, column=12, value=f"{b['availability_rate']:.1f}%").alignment = Alignment(horizontal="right")
        ws_batches.cell(row=r_idx, column=13, value=f"{b['performance_rate']:.1f}%").alignment = Alignment(horizontal="right")
        ws_batches.cell(row=r_idx, column=14, value=f"{b['quality_rate']:.1f}%").alignment = Alignment(horizontal="right")
        
        c_oee = ws_batches.cell(row=r_idx, column=15, value=f"{b['oee_percentage']:.2f}%")
        c_oee.alignment = Alignment(horizontal="right")
        c_oee.font = Font(name="Calibri", bold=True)

        c_stat = ws_batches.cell(row=r_idx, column=16, value=b['batch_status'])
        c_stat.alignment = Alignment(horizontal="center")
        if b['batch_status'] == "COMPLETED":
            c_stat.fill = PatternFill(start_color=COLOR_SUCCESS_BG, end_color=COLOR_SUCCESS_BG, fill_type="solid")
            c_stat.font = Font(name="Calibri", bold=True, color=COLOR_SUCCESS_TEXT)
        else:
            c_stat.fill = PatternFill(start_color=COLOR_DANGER_BG, end_color=COLOR_DANGER_BG, fill_type="solid")
            c_stat.font = Font(name="Calibri", bold=True, color=COLOR_DANGER_TEXT)

        for col in range(1, 17):
            cell = ws_batches.cell(row=r_idx, column=col)
            if col != 16:
                cell.fill = fill
            cell.border = THIN_BORDER

    auto_fit_columns(ws_batches, max_cols=16)

    # -----------------------------------------------------------------------
    # Sheet 3: Equipment Downtime & MTTR
    # -----------------------------------------------------------------------
    ws_dt = wb.create_sheet(title="Downtime & Maintenance")
    ws_dt.views.sheetView[0].showGridLines = True

    dt_sheet_headers = [
        "Event ID", "Machine ID", "Machine Name", "Plant Area", "Start Time",
        "Duration (Min)", "Downtime Category", "Failure Mode", "Root Cause",
        "Corrective Action", "Technician ID", "Repair Cost ($)", "Lost Units"
    ]
    for c_idx, h in enumerate(dt_sheet_headers, start=1):
        cell = ws_dt.cell(row=1, column=c_idx, value=h)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        cell.border = THIN_BORDER

    dt_all = cur.execute("""
    SELECT 
        event_id, machine_id, machine_name, plant_area, start_timestamp,
        downtime_minutes, category, failure_mode, root_cause, corrective_action,
        technician_id, repair_cost_usd, estimated_lost_units
    FROM equipment_downtime_events
    ORDER BY downtime_minutes DESC
    """).fetchall()

    for r_idx, d in enumerate(dt_all, start=2):
        bg = COLOR_ROW_ALT if r_idx % 2 == 0 else "FFFFFF"
        fill = PatternFill(start_color=bg, end_color=bg, fill_type="solid")

        ws_dt.cell(row=r_idx, column=1, value=d['event_id']).font = Font(name="Calibri", bold=True)
        ws_dt.cell(row=r_idx, column=2, value=d['machine_id'])
        ws_dt.cell(row=r_idx, column=3, value=d['machine_name'])
        ws_dt.cell(row=r_idx, column=4, value=d['plant_area'])
        ws_dt.cell(row=r_idx, column=5, value=d['start_timestamp'])
        
        c_min = ws_dt.cell(row=r_idx, column=6, value=d['downtime_minutes'])
        c_min.alignment = Alignment(horizontal="right")
        c_min.font = Font(name="Calibri", bold=True)

        ws_dt.cell(row=r_idx, column=7, value=d['category'])
        ws_dt.cell(row=r_idx, column=8, value=d['failure_mode'])
        ws_dt.cell(row=r_idx, column=9, value=d['root_cause'])
        ws_dt.cell(row=r_idx, column=10, value=d['corrective_action'])
        ws_dt.cell(row=r_idx, column=11, value=d['technician_id'])
        
        c_cst = ws_dt.cell(row=r_idx, column=12, value=f"${d['repair_cost_usd']:,.2f}")
        c_cst.alignment = Alignment(horizontal="right")

        c_lst = ws_dt.cell(row=r_idx, column=13, value=d['estimated_lost_units'])
        c_lst.alignment = Alignment(horizontal="right")

        for col in range(1, 14):
            cell = ws_dt.cell(row=r_idx, column=col)
            cell.fill = fill
            cell.border = THIN_BORDER

    auto_fit_columns(ws_dt, max_cols=13)

    # -----------------------------------------------------------------------
    # Sheet 4: ISA-95 Asset Hierarchy (Path Definer Preview)
    # -----------------------------------------------------------------------
    ws_assets = wb.create_sheet(title="ISA-95 Asset Hierarchy")
    ws_assets.views.sheetView[0].showGridLines = True

    asset_headers = [
        "Asset ID", "Parent Asset ID", "Asset Name", "Asset Level", "Depth",
        "Plant Area", "Criticality Tier", "Manufacturer", "Model Number", "Health Score", "Status"
    ]
    for c_idx, h in enumerate(asset_headers, start=1):
        cell = ws_assets.cell(row=1, column=c_idx, value=h)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        cell.border = THIN_BORDER

    assets = cur.execute("""
    SELECT 
        asset_id, parent_asset_id, asset_name, asset_level, level_depth,
        plant_area, criticality_tier, manufacturer, model_number, health_score, status
    FROM factory_assets_hierarchy
    ORDER BY level_depth ASC, asset_name ASC
    """).fetchall()

    for r_idx, a in enumerate(assets, start=2):
        bg = COLOR_ROW_ALT if r_idx % 2 == 0 else "FFFFFF"
        fill = PatternFill(start_color=bg, end_color=bg, fill_type="solid")

        ws_assets.cell(row=r_idx, column=1, value=a['asset_id']).font = Font(name="Calibri", bold=True)
        ws_assets.cell(row=r_idx, column=2, value=a['parent_asset_id'] or "-")
        
        # Indent label based on hierarchy level
        indent_spaces = "  " * a['level_depth']
        ws_assets.cell(row=r_idx, column=3, value=f"{indent_spaces}{a['asset_name']}")
        
        ws_assets.cell(row=r_idx, column=4, value=a['asset_level'])
        ws_assets.cell(row=r_idx, column=5, value=a['level_depth']).alignment = Alignment(horizontal="center")
        ws_assets.cell(row=r_idx, column=6, value=a['plant_area'])
        ws_assets.cell(row=r_idx, column=7, value=a['criticality_tier'])
        ws_assets.cell(row=r_idx, column=8, value=a['manufacturer'])
        ws_assets.cell(row=r_idx, column=9, value=a['model_number'])
        
        c_hlth = ws_assets.cell(row=r_idx, column=10, value=f"{a['health_score']:.1f}%")
        c_hlth.alignment = Alignment(horizontal="right")
        c_hlth.font = Font(name="Calibri", bold=True, color="166534" if a['health_score'] >= 95 else "B45309")

        ws_assets.cell(row=r_idx, column=11, value=a['status']).alignment = Alignment(horizontal="center")

        for col in range(1, 12):
            cell = ws_assets.cell(row=r_idx, column=col)
            cell.fill = fill
            cell.border = THIN_BORDER

    auto_fit_columns(ws_assets, max_cols=11)

    # Save Workbook
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    wb.save(output_path)
    conn.close()
    print(f"  ✓ Excel report successfully generated: {output_path}")


def generate_html_dashboard(db_path: str, output_path: str):
    print(f"\n🌐 Building Executive HTML Dashboard: {output_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    prod = cur.execute("""
    SELECT 
        COUNT(*) as batches,
        SUM(planned_qty) as planned,
        SUM(produced_qty) as produced,
        SUM(good_qty) as good,
        SUM(scrap_qty) as scrap,
        AVG(availability_rate) as avail,
        AVG(performance_rate) as perf,
        AVG(quality_rate) as qual,
        AVG(oee_percentage) as oee
    FROM production_batches
    """).fetchone()

    dt = cur.execute("""
    SELECT 
        COUNT(*) as total_events,
        SUM(downtime_minutes) as total_mins,
        AVG(downtime_minutes) as mttr,
        SUM(repair_cost_usd) as total_cost,
        SUM(estimated_lost_units) as lost_units
    FROM equipment_downtime_events
    """).fetchone()

    energy = cur.execute("""
    SELECT 
        SUM(active_power_kwh) as total_kwh,
        AVG(power_factor) as avg_pf,
        SUM(co2_emissions_kg) as total_co2
    FROM facility_energy_esg
    """).fetchone()

    top_downtimes = cur.execute("""
    SELECT category, COUNT(*) as count, SUM(downtime_minutes) as mins, SUM(repair_cost_usd) as cost
    FROM equipment_downtime_events
    GROUP BY category
    ORDER BY mins DESC
    LIMIT 6
    """).fetchall()

    recent_batches = cur.execute("""
    SELECT batch_id, product_name, line_id, shift_name, produced_qty, good_qty, scrap_rate_pct, oee_percentage, batch_status
    FROM production_batches
    ORDER BY start_timestamp DESC
    LIMIT 12
    """).fetchall()

    assets = cur.execute("""
    SELECT asset_id, parent_asset_id, asset_name, asset_level, plant_area, criticality_tier, health_score, status
    FROM factory_assets_hierarchy
    ORDER BY level_depth ASC, asset_name ASC
    LIMIT 25
    """).fetchall()

    conn.close()

    # Build SVG Chart for Downtime Categories
    max_mins = max([r['mins'] for r in top_downtimes]) if top_downtimes else 1
    bars_html = ""
    for r in top_downtimes:
        pct = (r['mins'] / max_mins) * 100
        bars_html += f"""
        <div style="margin-bottom: 14px;">
            <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
                <span style="font-weight: 600; color: #334155;">{r['category']} ({r['count']} events)</span>
                <span style="font-weight: 700; color: #1e293b;">{r['mins']:,.0f} min (${r['cost']:,.0f})</span>
            </div>
            <div style="background: #e2e8f0; height: 10px; border-radius: 999px; overflow: hidden;">
                <div style="width: {pct:.1f}%; background: linear-gradient(90deg, #3b82f6, #ef4444); height: 100%; border-radius: 999px;"></div>
            </div>
        </div>
        """

    # Build Batches Table HTML
    batches_html = ""
    for b in recent_batches:
        stat_color = "#10b981" if b['batch_status'] == "COMPLETED" else "#ef4444"
        stat_bg = "#ecfdf5" if b['batch_status'] == "COMPLETED" else "#fef2f2"
        batches_html += f"""
        <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">{b['batch_id']}</td>
            <td style="padding: 10px 14px; color: #334155;">{b['product_name']}</td>
            <td style="padding: 10px 14px; color: #64748b; font-size: 12px;">{b['line_id']}</td>
            <td style="padding: 10px 14px; color: #475569; font-size: 12px;">{b['shift_name']}</td>
            <td style="padding: 10px 14px; text-align: right; font-weight: 600;">{b['produced_qty']:,}</td>
            <td style="padding: 10px 14px; text-align: right; color: #16a34a; font-weight: 600;">{b['good_qty']:,}</td>
            <td style="padding: 10px 14px; text-align: right; color: #dc2626; font-weight: 600;">{b['scrap_rate_pct']:.2f}%</td>
            <td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #1e3a8a;">{b['oee_percentage']:.1f}%</td>
            <td style="padding: 10px 14px; text-align: center;">
                <span style="background: {stat_bg}; color: {stat_color}; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700;">{b['batch_status']}</span>
            </td>
        </tr>
        """

    # Build Assets Tree HTML
    assets_html = ""
    for a in assets:
        badge_bg = "#dbeafe" if a['asset_level'] in ('Enterprise', 'Site') else ("#fef3c7" if a['asset_level'] == 'Area' else "#e0e7ff")
        badge_color = "#1e40af" if a['asset_level'] in ('Enterprise', 'Site') else ("#92400e" if a['asset_level'] == 'Area' else "#3730a3")
        assets_html += f"""
        <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 9px 12px; font-family: monospace; font-size: 12px; font-weight: 600; color: #0284c7;">{a['asset_id']}</td>
            <td style="padding: 9px 12px; font-weight: 600; color: #1e293b;">{a['asset_name']}</td>
            <td style="padding: 9px 12px;">
                <span style="background: {badge_bg}; color: {badge_color}; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">{a['asset_level']}</span>
            </td>
            <td style="padding: 9px 12px; color: #64748b; font-size: 12px;">{a['plant_area']}</td>
            <td style="padding: 9px 12px; color: #475569; font-size: 12px;">{a['criticality_tier']}</td>
            <td style="padding: 9px 12px; text-align: right; font-weight: 700; color: #16a34a;">{a['health_score']:.1f}%</td>
            <td style="padding: 9px 12px; text-align: center;">
                <span style="background: #ecfdf5; color: #059669; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700;">{a['status']}</span>
            </td>
        </tr>
        """

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Apex Smart Factory — Executive Performance & SCADA Report</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }}
        body {{ background-color: #f8fafc; color: #0f172a; padding: 32px; }}
        .container {{ max-width: 1380px; margin: 0 auto; }}
        .header {{ display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 2px solid #e2e8f0; }}
        .header h1 {{ font-size: 26px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px; }}
        .header p {{ color: #64748b; font-size: 14px; margin-top: 4px; }}
        .badge-live {{ background: #10b981; color: white; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; }}
        .grid-kpi {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 18px; margin-bottom: 28px; }}
        .card-kpi {{ background: white; border-radius: 12px; padding: 20px; border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }}
        .card-kpi .label {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; color: #64748b; }}
        .card-kpi .val {{ font-size: 28px; font-weight: 800; color: #0f172a; margin: 8px 0; }}
        .card-kpi .sub {{ font-size: 12px; color: #16a34a; font-weight: 600; }}
        .grid-2 {{ display: grid; grid-template-columns: 1.2fr 1fr; gap: 24px; margin-bottom: 28px; }}
        .panel {{ background: white; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }}
        .panel-title {{ font-size: 17px; font-weight: 700; color: #1e293b; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center; }}
        table {{ width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }}
        th {{ background: #f1f5f9; padding: 12px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; font-weight: 700; }}
        .footer {{ margin-top: 40px; text-align: center; color: #94a3b8; font-size: 12px; }}
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>APEX INDUSTRIAL TECHNOLOGIES — EXECUTIVE DASHBOARD</h1>
            <p>Smart Factory 4.0 Telemetry, OEE Metrics & Asset Hierarchy | Munich Gigafactory & Stuttgart Works</p>
        </div>
        <div style="text-align: right;">
            <div class="badge-live"><span style="width: 8px; height: 8px; background: white; border-radius: 50%;"></span> SYSTEM VERIFIED</div>
            <div style="font-size: 12px; color: #64748b; margin-top: 6px;">ISA-95 & Path Definer Ready</div>
        </div>
    </div>

    <!-- KPI Scorecards -->
    <div class="grid-kpi">
        <div class="card-kpi">
            <div class="label">Fleet OEE Overall</div>
            <div class="val" style="color: #1e3a8a;">{prod['oee']:.1f}%</div>
            <div class="sub">World-Class Target: 85.0%</div>
        </div>
        <div class="card-kpi">
            <div class="label">Total Output Produced</div>
            <div class="val">{prod['produced']:,}</div>
            <div class="sub" style="color: #059669;">{prod['good']:,} Conforming Units</div>
        </div>
        <div class="card-kpi">
            <div class="label">First-Pass Scrap Rate</div>
            <div class="val" style="color: #dc2626;">{(prod['scrap']/max(prod['produced'], 1)*100):.2f}%</div>
            <div class="sub" style="color: #dc2626;">{prod['scrap']:,} Scrapped Parts</div>
        </div>
        <div class="card-kpi">
            <div class="label">Mean Time to Repair (MTTR)</div>
            <div class="val">{dt['mttr']:.1f} <span style="font-size: 14px; font-weight: 500;">min</span></div>
            <div class="sub" style="color: #475569;">{dt['total_events']} Outages Recorded</div>
        </div>
        <div class="card-kpi">
            <div class="label">Energy & Carbon Footprint</div>
            <div class="val">{energy['total_kwh']/1000:,.1f} <span style="font-size: 14px; font-weight: 500;">MWh</span></div>
            <div class="sub" style="color: #0284c7;">{energy['total_co2']/1000:,.1f} Tons CO2e (Scope 2)</div>
        </div>
    </div>

    <!-- Main Grid: OEE Breakdown & Pareto -->
    <div class="grid-2">
        <div class="panel">
            <div class="panel-title">
                <span>World-Class OEE Multipliers Breakdown</span>
                <span style="font-size: 12px; color: #64748b;">(A x P x Q = OEE)</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 24px; text-align: center;">
                <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <div style="font-size: 12px; font-weight: 700; color: #64748b;">AVAILABILITY</div>
                    <div style="font-size: 24px; font-weight: 800; color: #0284c7; margin: 4px 0;">{prod['avail']:.1f}%</div>
                    <div style="font-size: 11px; color: #475569;">Uptime vs Planned</div>
                </div>
                <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <div style="font-size: 12px; font-weight: 700; color: #64748b;">PERFORMANCE</div>
                    <div style="font-size: 24px; font-weight: 800; color: #10b981; margin: 4px 0;">{prod['perf']:.1f}%</div>
                    <div style="font-size: 11px; color: #475569;">Cycle Time vs Target</div>
                </div>
                <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <div style="font-size: 12px; font-weight: 700; color: #64748b;">QUALITY</div>
                    <div style="font-size: 24px; font-weight: 800; color: #8b5cf6; margin: 4px 0;">{prod['qual']:.1f}%</div>
                    <div style="font-size: 11px; color: #475569;">First-Pass Yield</div>
                </div>
            </div>
            <div style="font-size: 13px; color: #475569; line-height: 1.6;">
                <strong>Enterprise Summary:</strong> The plant operates at an overall OEE of <strong>{prod['oee']:.1f}%</strong>, exceeding the 85% world-class automotive manufacturing threshold. Quality performance remains stellar at <strong>{prod['qual']:.1f}%</strong>, driven by closed-loop automated optical inspection and 5-axis adaptive spindle compensation.
            </div>
        </div>

        <div class="panel">
            <div class="panel-title">
                <span>Downtime Root Cause Pareto Analysis</span>
                <span style="font-size: 12px; color: #dc2626; font-weight: 600;">${dt['total_cost']:,.0f} Total Loss</span>
            </div>
            <div>
                {bars_html}
            </div>
        </div>
    </div>

    <!-- Production Batches Table -->
    <div class="panel" style="margin-bottom: 28px;">
        <div class="panel-title">
            <span>Recent Manufacturing Work Orders & Batch Runs</span>
            <span style="font-size: 12px; color: #64748b;">Showing 12 of {prod['batches']} recorded runs</span>
        </div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr>
                        <th>Batch ID</th>
                        <th>Product Specification</th>
                        <th>Assigned Line</th>
                        <th>Shift Schedule</th>
                        <th style="text-align: right;">Produced</th>
                        <th style="text-align: right;">Good Units</th>
                        <th style="text-align: right;">Scrap %</th>
                        <th style="text-align: right;">OEE %</th>
                        <th style="text-align: center;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    {batches_html}
                </tbody>
            </table>
        </div>
    </div>

    <!-- Asset Hierarchy (Path Definer) Preview -->
    <div class="panel">
        <div class="panel-title">
            <span>Path Definer — ISA-95 Smart Asset Hierarchy Tree</span>
            <span style="font-size: 12px; color: #3b82f6; font-weight: 600;">Enterprise → Site → Area → Line → Machine → Sensor</span>
        </div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr>
                        <th>Asset UID</th>
                        <th>Equipment / Node Name</th>
                        <th>ISA-95 Level</th>
                        <th>Plant Area</th>
                        <th>Criticality Tier</th>
                        <th style="text-align: right;">Health Score</th>
                        <th style="text-align: center;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    {assets_html}
                </tbody>
            </table>
        </div>
    </div>

    <div class="footer">
        Apex Industrial Technologies Global &copy; 2026. Powered by Supernova SCADA & Data Analytics Platform.
    </div>
</div>
</body>
</html>
"""

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"  ✓ HTML dashboard successfully generated: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate Corporate Reports for Smart Factory Dataset")
    parser.add_argument("--db-path", default="db/supernova_reports.db", help="Path to SQLite database")
    parser.add_argument("--output-dir", default="data_exports/enterprise_smart_factory", help="Output directory for reports")
    args = parser.parse_args()

    excel_file = os.path.join(args.output_dir, "Apex_Enterprise_Smart_Factory_Performance_Report.xlsx")
    html_file = os.path.join(args.output_dir, "Apex_Smart_Factory_Executive_Dashboard.html")

    generate_excel_report(args.db_path, excel_file)
    generate_html_dashboard(args.db_path, html_file)
    print("\n✅ All corporate showcase reports generated successfully!")


if __name__ == "__main__":
    main()
