# Apex Industrial Technologies — Enterprise Smart Factory Dataset Specification
> **Domain**: Industrial IoT / Industry 4.0 / SCADA / Discrete & Process Manufacturing  
> **Target Audience**: Corporate Clients, Enterprise Architects, Plant Directors, Industrial & Automotive Tier-1 Stakeholders  
> **Language**: 100% English (ISA-95 Standard)  
> **Platform Integration**: Supernova SCADA, Path Definer & Dynamic Report Studio  

---

## 1. Executive Summary & Context

The **Apex Enterprise Smart Factory Dataset** simulates an advanced, high-precision industrial manufacturing ecosystem operating across two flagship European facilities:
1. **Munich Smart Gigafactory 01 (`PLANT-MUC-01`)**: High-voltage 800V EV battery pack assembly, high-speed servo stamping (Schuler 2,500T), robotic welding cells (KUKA KR-1000 Titan), and automated paint application.
2. **Stuttgart Precision Powertrain Works (`PLANT-STG-02`)**: 5-axis CNC machining (DMG MORI DMC 85 FD), automated hairpin stator winding (Apex Industrial Automation), and end-of-line high-voltage dynamometer test cells (AVL 400kW, 24,000 RPM).

The dataset features realistic statistical distributions, physics-grounded telemetry with harmonic sine loads and Gaussian white noise, realistic anomaly injection, standard manufacturing KPIs (**OEE, Availability, Performance, Quality, MTTR, MTBF, Scrap Rate, Cpk**), and full compliance with **ISA-95 equipment hierarchy models**.

---

## 2. Dataset Architecture & Relational Entities

```
                                  [ENT-APEX-GLOBAL]
                                          │
                  ┌───────────────────────┴───────────────────────┐
           [PLANT-MUC-01]                                  [PLANT-STG-02]
         (Munich Gigafactory)                          (Stuttgart Powertrain)
                  │                                               │
   ┌──────────────┼──────────────┐                                │
[STAMPING]     [BODY]         [PAINT]                     [POWERTRAIN SHOP]
   │              │              │                                │
[PRESS-2500] [KUKA-TITAN]   [ABB-IRB-5500]                 [DMG-5AXIS-CNC]
   │              │              │                                │
[HYD-UNIT]    [AXIS-3-GEAR]  [ATOMIZER]                      [SPINDLE-DRIVE]
   │              │              │                                │
[SNS-PRESS]   [SNS-VIB]      [SNS-FLOW]                      [SNS-TEMP / VIB]
```

### Key Tables & Data Dictionaries

| Table Name | Description | Key Fields & Metrics |
| :--- | :--- | :--- |
| `factory_assets_hierarchy` | ISA-95 Asset Tree (Levels 0 to 6) | `asset_id`, `parent_asset_id`, `asset_name`, `asset_level`, `plant_area`, `criticality_tier`, `manufacturer`, `model_number`, `health_score`, `status` |
| `manufacturing_process_sequence` | Manufacturing execution sequence routing | `step_id`, `step_order` (10-100), `next_step_id`, `step_name`, `assigned_line_id`, `workstation_name`, `std_cycle_time_sec`, `quality_gate_required`, `target_tolerance_um` |
| `production_batches` | Work orders, shift performance & OEE | `batch_id`, `work_order_id`, `product_name`, `line_id`, `shift_name`, `lead_operator_name`, `planned_qty`, `produced_qty`, `good_qty`, `scrap_qty`, `scrap_rate_pct`, `availability_rate`, `performance_rate`, `quality_rate`, `oee_percentage`, `batch_status` |
| `equipment_downtime_events` | Outage logs, root causes & MTTR | `event_id`, `machine_id`, `machine_name`, `plant_area`, `downtime_minutes`, `category`, `failure_mode`, `root_cause`, `corrective_action`, `repair_cost_usd`, `impacted_oee_factor`, `estimated_lost_units` |
| `quality_inspections` | Sub-micron CMM & 3D AOI metrology | `inspection_id`, `batch_id`, `product_code`, `station_name`, `inspection_mode`, `status` (PASS/REJECT/REWORK), `measured_deviation_um`, `defect_code`, `defect_severity`, `inspector_name` |
| `facility_energy_esg` | Hourly smart meter & ESG tracking | `log_id`, `timestamp`, `plant_area`, `active_power_kwh`, `reactive_power_kvarh`, `power_factor`, `peak_demand_kw`, `compressed_air_m3`, `co2_emissions_kg` |
| `machine_telemetry_timeseries` | High-frequency telemetry stream | `reading_id`, `timestamp`, `machine_id`, `sensor_id`, `metric_name`, `value`, `unit`, `lsl`, `usl`, `warning_threshold`, `alarm_status` (NORMAL, WARNING, CRITICAL_HIGH, CRITICAL_LOW) |
| `C_PATH_ELEMENT`, `C_POINT`, `C_POINT_PATH_ELEMENT` | SCADA native tables for Path Selector | Direct compatibility with Supernova SCADA real-time and historical point selectors |

---

## 3. Native Integration with Supernova "Path Definer"

Supernova's **Path Definer** converts flat relational queries into rich navigation graphs, drill-down trees, sequence chains, and grouped asset clusters.

The dataset includes three pre-configured Path Definitions:

### A. Tree Structure: ISA-95 Smart Asset Drilldown (`pth_factory_tree`)
- **Query**: `[Smart Factory] ISA-95 Asset Hierarchy (Path Definer Tree)` (`q_ind_asset_tree`)
- **Structure**: `tree`
- **Config**:
  ```json
  {
    "id_col": "id",
    "parent_col": "parent_id",
    "label_col": "label",
    "type_col": "asset_type",
    "root_value": "",
    "spaceMapConfig": {
      "theme": "factory",
      "layout": "radial",
      "level1Icon": "fa-building",
      "level2Icon": "fa-industry",
      "level3Icon": "fa-cogs",
      "color1": "#3B82F6",
      "color2": "#10B981",
      "color3": "#F59E0B"
    }
  }
  ```
- **Experience**: Enterprise → Plant → Shop Area → Production Line → Machine → Subsystem → Sensor.

### B. Sequence Structure: Manufacturing Routing Chain (`pth_factory_sequence`)
- **Query**: `[Smart Factory] Manufacturing Process Routing (Path Definer Sequence)` (`q_ind_mfg_sequence`)
- **Structure**: `sequence`
- **Config**:
  ```json
  {
    "id_col": "id",
    "order_col": "step_order",
    "next_col": "next_step_id",
    "label_col": "label",
    "target_col": "step_id"
  }
  ```
- **Flow**: Step 010 (Raw Coil Destacking) → Step 020 (Stamping) → Step 030 (CNC 5-Axis) → Step 040 (Degreasing) → Step 050 (Laser Welding) → Step 060 (AOI Inspection) → Step 070 (Hairpin Winding) → Step 080 (Dielectric HiPot) → Step 090 (Dyno Full-Speed Balancing) → Step 100 (Packaging).

### C. Grouped Structure: Equipment Criticality Clusters (`pth_factory_grouped`)
- **Query**: `[Smart Factory] Equipment by Criticality & Area (Path Definer Grouped)` (`q_ind_asset_grouped`)
- **Structure**: `grouped`
- **Config**:
  ```json
  {
    "group_col": "group_id",
    "id_col": "id",
    "label_col": "label",
    "spaceMapConfig": {
      "theme": "factory",
      "layout": "grid",
      "color1": "#EF4444",
      "color2": "#F59E0B",
      "color3": "#10B981"
    }
  }
  ```
- **Grouping**: Groups assets by criticality (`Tier 1 (Mission-Critical)`, `Tier 2 (Core Production)`, `Tier 3 (Auxiliary)`).

---

## 4. How to Generate & Scale Data (Path Definer CLI)

You can generate and export the dataset to any custom directory or file format, scaling from standard demonstrations to 1,000,000+ records.

### Basic Generation (Standard ~60,000 telemetry readings):
```bash
python3 scripts/industrial_dataset_generator.py \
    --output-dir data_exports/enterprise_smart_factory \
    --scale standard \
    --formats sqlite,csv,json
```

### Million-Scale Generation (1,000,000+ records):
Uses memory-efficient chunked batch streaming with SQLite transactions:
```bash
python3 scripts/industrial_dataset_generator.py \
    --scale million \
    --output-dir /Users/username/Desktop/Industrial_Dataset_1M \
    --formats sqlite,csv
```

### CLI Arguments Reference:
- `--output-dir <path>`: Destination path where CSVs, JSONs, and manifest files are saved.
- `--db-path <path>`: SQLite database file (default: `db/supernova_reports.db`).
- `--scale <small|standard|large|million>`:
  - `small`: 5,000 telemetry rows, 100 batches, 50 downtime events.
  - `standard`: 60,000 telemetry rows, 450 batches, 180 downtime events, 800 QC logs.
  - `large`: 250,000 telemetry rows, 1,500 batches, 600 downtime events.
  - `million`: 1,000,000 telemetry rows, 5,000 batches, 2,000 downtime events.
- `--formats <csv,json,sqlite>`: Comma-separated export formats.
- `--seed <int>`: Deterministic seed for reproducible testing.

---

## 5. Executive Corporate Reports

### A. Multi-Tab Formatted Excel Report (`.xlsx`)
File: `data_exports/enterprise_smart_factory/Apex_Enterprise_Smart_Factory_Performance_Report.xlsx`
- **Tab 1: Executive KPI Dashboard**: Card scorecards for Fleet OEE, Yield, Scrap, MTTR, Repair Expense, Carbon Footprint, World-Class benchmark variance analysis, and Top 5 Downtime Pareto.
- **Tab 2: Production Batches & OEE**: Detailed batch log with conditional formatting for `COMPLETED` vs `REVIEW_REQUIRED`.
- **Tab 3: Downtime & Maintenance**: Root causes, failure modes, technician assignments, repair costs.
- **Tab 4: ISA-95 Asset Hierarchy**: Equipment breakdown with health scores and manufacturer details.

To regenerate:
```bash
./supernova-backend/venv/bin/python scripts/generate_factory_report.py --output-dir data_exports/enterprise_smart_factory
```

### B. Interactive Executive HTML Dashboard (`.html`)
File: `data_exports/enterprise_smart_factory/Apex_Smart_Factory_Executive_Dashboard.html`
- Standalone HTML5 dashboard ready to open in Safari, Chrome, Edge, or tablet displays.
- Visual KPI cards, Availability/Performance/Quality gauge panels, downtime Pareto bars, production table, and ISA-95 tree explorer.

---

## 6. Guide for Presenting to Corporate Clients

When demonstrating Supernova to enterprise clients (e.g. manufacturing groups, automotive OEMs, aerospace suppliers):
1. **Open the HTML Executive Dashboard**: Walk through the C-level KPIs, Fleet OEE (85%+ benchmark), MTTR, and downtime cost savings.
2. **Open Supernova UI -> Query Studio**: Show the pre-registered `[Smart Factory]` queries. Run `q_ind_telemetry_recent` to demonstrate high-frequency sensor streams and instant query performance.
3. **Open Supernova UI -> Path Definer**:
   - Select `pth_factory_tree`: Click **Preview** or **Build** to visualize the full ISA-95 plant hierarchy tree.
   - Select `pth_factory_sequence`: Demonstrate the step-by-step production routing chain.
   - Select `pth_factory_grouped`: Show how assets are organized by operational criticality.
4. **Open Supernova UI -> Report Studio**: Run `tpl_smart_factory_exec` to generate on-demand Excel reports dynamically bound to live database queries.
