#!/usr/bin/env python3
"""
Apex Industrial Technologies — Enterprise Smart Factory & SCADA Dataset Generator
================================================================================
Generates high-fidelity, professional, multi-dimensional manufacturing data for:
- ISA-95 Equipment & Asset Hierarchy (Path Definer: Tree & Grouped)
- Process Routing & Manufacturing Steps (Path Definer: Sequence)
- SCADA Telemetry & Sensor Time-Series (Tens of thousands to 1,000,000+ rows)
- Production Batches, Work Orders & OEE (Availability, Performance, Quality)
- Downtime Events, Root Cause Analysis, MTBF / MTTR
- Quality Inspection Logs, AOI/CMM Metrology & Defect Pareto
- Facility Energy & Sustainability Telemetry (ESG)
- SCADA compatibility tables (C_PATH_ELEMENT, C_POINT, C_POINT_PATH_ELEMENT)

Author: SuperNova Enterprise Industrial Intelligence & Data Analytics Platform
Language of Dataset: English (Enterprise Standard)
"""

import os
import sys
import math
import json
import random
import sqlite3
import argparse
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Master Data: ISA-95 Asset Hierarchy Definitions
# ---------------------------------------------------------------------------

ASSET_HIERARCHY_DATA = [
    # Enterprise Level
    {
        "id": "ENT-APEX-GLOBAL",
        "parent": None,
        "name": "Apex Industrial Technologies Global",
        "type": "Enterprise",
        "level": 0,
        "area": "Corporate",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex Group",
        "model": "HQ-Global-Network",
        "status": "ONLINE",
        "description": "Global Smart Manufacturing & Advanced Powertrain Operations"
    },
    # Site / Plant Level
    {
        "id": "PLANT-MUC-01",
        "parent": "ENT-APEX-GLOBAL",
        "name": "Munich Smart Gigafactory 01",
        "type": "Site",
        "level": 1,
        "area": "Munich Plant",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex Building Systems",
        "model": "Smart-Site-4.0",
        "status": "ONLINE",
        "description": "Next-Gen E-Mobility & Battery Pack Production Facility"
    },
    {
        "id": "PLANT-STG-02",
        "parent": "ENT-APEX-GLOBAL",
        "name": "Stuttgart Precision Powertrain Works",
        "type": "Site",
        "level": 1,
        "area": "Stuttgart Plant",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex Building Systems",
        "model": "Smart-Site-4.0",
        "status": "ONLINE",
        "description": "High-Precision 800V E-Axle & Stator Manufacturing Facility"
    },

    # Munich Areas (Shops)
    {
        "id": "AREA-MUC-STAMP",
        "parent": "PLANT-MUC-01",
        "name": "High-Speed Servo Stamping Shop",
        "type": "Area",
        "level": 2,
        "area": "Stamping Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Schuler AG",
        "model": "PressShop-Automation-v3",
        "status": "ONLINE",
        "description": "Deep drawing and high-speed rotor/stator lamination stamping"
    },
    {
        "id": "AREA-MUC-BODY",
        "parent": "PLANT-MUC-01",
        "name": "Robotic Body-in-White & Chassis Shop",
        "type": "Area",
        "level": 2,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "KUKA Robotics",
        "model": "BiW-Cell-Network",
        "status": "ONLINE",
        "description": "High-precision robotic laser and spot welding cells"
    },
    {
        "id": "AREA-MUC-PAINT",
        "parent": "PLANT-MUC-01",
        "name": "Eco-Smart Automated Paint Shop",
        "type": "Area",
        "level": 2,
        "area": "Paint Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Dürr & ABB",
        "model": "EcoPro-Cleanroom",
        "status": "ONLINE",
        "description": "Electrostatic e-coating, primer, and robotic topcoat lines"
    },
    {
        "id": "AREA-MUC-BATTERY",
        "parent": "PLANT-MUC-01",
        "name": "High-Voltage Battery Pack & Cell Shop",
        "type": "Area",
        "level": 2,
        "area": "Battery Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex & Comau",
        "model": "Giga-Pack-Flex",
        "status": "ONLINE",
        "description": "Prismatic cell stacking, ultrasonic busbar welding, cold plate bonding"
    },
    {
        "id": "AREA-STG-POWERTRAIN",
        "parent": "PLANT-STG-02",
        "name": "E-Drive & Inverter Precision Assembly",
        "type": "Area",
        "level": 2,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex Industrial Automation",
        "model": "MotionPro-Integrated",
        "status": "ONLINE",
        "description": "5-axis CNC machining, stator hairpin winding, dyno testing"
    },
    {
        "id": "AREA-GLOBAL-QC",
        "parent": "PLANT-MUC-01",
        "name": "Central Metrology & Quality Assurance Lab",
        "type": "Area",
        "level": 2,
        "area": "Quality Lab",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Carl Zeiss Industrial Metrology",
        "model": "Metrology-Clean-20C",
        "status": "ONLINE",
        "description": "Sub-micron CMM, computed tomography (CT), ultrasonic testing"
    },

    # Production Lines
    {
        "id": "LINE-MUC-PRESS-01",
        "parent": "AREA-MUC-STAMP",
        "name": "Tandem Servo Press Line Alpha",
        "type": "Line",
        "level": 3,
        "area": "Stamping Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Schuler AG",
        "model": "TS-2500T-Servo",
        "status": "ONLINE",
        "description": "2,500 Metric Ton tandem servo press with automated destacker"
    },
    {
        "id": "LINE-MUC-WELD-04",
        "parent": "AREA-MUC-BODY",
        "name": "Robotic Welding Line 04 (Titan)",
        "type": "Line",
        "level": 3,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "KUKA Systems",
        "model": "KUKA-FlexLine-1000",
        "status": "ONLINE",
        "description": "Multi-robot flexible spot welding and structural seam bonding"
    },
    {
        "id": "LINE-MUC-COAT-02",
        "parent": "AREA-MUC-PAINT",
        "name": "Automated Topcoat Robotic Line 02",
        "type": "Line",
        "level": 3,
        "area": "Paint Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "ABB Robotics",
        "model": "IRB-CleanFlow-Line",
        "status": "ONLINE",
        "description": "Dual 6-axis paint atomizers with computerized paint flow control"
    },
    {
        "id": "LINE-MUC-PACK-01",
        "parent": "AREA-MUC-BATTERY",
        "name": "800V Cell Stacking & Module Assembly Line",
        "type": "Line",
        "level": 3,
        "area": "Battery Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex & Festo",
        "model": "AX-1500-Motion-Line",
        "status": "ONLINE",
        "description": "Automated high-speed prismatic cell picker, gluing, and laser busbar joining"
    },
    {
        "id": "LINE-STG-CNC-01",
        "parent": "AREA-STG-POWERTRAIN",
        "name": "5-Axis Precision Rotor Machining Line",
        "type": "Line",
        "level": 3,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "DMG MORI",
        "model": "DMC-Cell-85FD",
        "status": "ONLINE",
        "description": "Mill-turn center for high-torque electric motor rotor shafts"
    },
    {
        "id": "LINE-STG-DYNO-01",
        "parent": "AREA-STG-POWERTRAIN",
        "name": "End-of-Line Motor Dynamometer Line",
        "type": "Line",
        "level": 3,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "AVL List GmbH",
        "model": "PUMA-Dyno-400kW",
        "status": "ONLINE",
        "description": "Full-speed high-voltage electric motor torque and back-EMF test bench"
    },

    # Machines / Workstations
    {
        "id": "MCH-SCHULER-2500",
        "parent": "LINE-MUC-PRESS-01",
        "name": "Schuler Servo Press 2500T (Station 1)",
        "type": "Machine",
        "level": 4,
        "area": "Stamping Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Schuler AG",
        "model": "MSD2-2500-Servo",
        "status": "ONLINE",
        "description": "Direct drive servo press with programmable stroke kinematic profiles"
    },
    {
        "id": "MCH-KUKA-TITAN-01",
        "parent": "LINE-MUC-WELD-04",
        "name": "KUKA KR-1000 Heavy Titan Welder #1",
        "type": "Machine",
        "level": 4,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "KUKA AG",
        "model": "KR-1000-titan-F",
        "status": "ONLINE",
        "description": "1,000 kg payload 6-axis robot for heavy underbody positioning"
    },
    {
        "id": "MCH-KUKA-QUANT-02",
        "parent": "LINE-MUC-WELD-04",
        "name": "KUKA KR-210 Quantec Spot Gun #2",
        "type": "Machine",
        "level": 4,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "KUKA AG",
        "model": "KR-210-R2700-prime",
        "status": "ONLINE",
        "description": "Medium-duty high-speed servo spot welding robot"
    },
    {
        "id": "MCH-TRUMPF-LASER-01",
        "parent": "LINE-MUC-WELD-04",
        "name": "Trumpf TruDisk 6001 Fiber Laser Station",
        "type": "Machine",
        "level": 4,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "TRUMPF GmbH",
        "model": "TruDisk-6001",
        "status": "ONLINE",
        "description": "6 kW solid-state fiber laser with real-time seam tracking optics"
    },
    {
        "id": "MCH-ABB-IRB-5500",
        "parent": "LINE-MUC-COAT-02",
        "name": "ABB IRB 5500 Paint Atomizer Robot",
        "type": "Machine",
        "level": 4,
        "area": "Paint Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "ABB Robotics",
        "model": "IRB-5500-Flex",
        "status": "ONLINE",
        "description": "High-efficiency bell atomizer with electrostatic charge control"
    },
    {
        "id": "MCH-DMG-DMC-85",
        "parent": "LINE-STG-CNC-01",
        "name": "DMG MORI DMC 85 FD 5-Axis Mill-Turn",
        "type": "Machine",
        "level": 4,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "DMG MORI",
        "model": "DMC-85-FD-duoBLOCK",
        "status": "ONLINE",
        "description": "Simultaneous 5-axis precision machining with Apex MotionPro ONE CNC"
    },
    {
        "id": "MCH-APEX-HAIRPIN",
        "parent": "LINE-STG-CNC-01",
        "name": "Apex Continuous Hairpin Stator Inserter",
        "type": "Machine",
        "level": 4,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex Industrial Automation",
        "model": "ApexFlex-Stator-400",
        "status": "ONLINE",
        "description": "High-speed rectangular copper hairpin bending and stator insertion cell"
    },
    {
        "id": "MCH-AVL-DYNO-400",
        "parent": "LINE-STG-DYNO-01",
        "name": "AVL 400kW High-Speed Dynamometer Stand",
        "type": "Machine",
        "level": 4,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "AVL List GmbH",
        "model": "DynoExact-400kW",
        "status": "ONLINE",
        "description": "High-dynamic 24,000 RPM load simulation stand with regenerative braking"
    },
    {
        "id": "MCH-ZEISS-PRISMO",
        "parent": "AREA-GLOBAL-QC",
        "name": "Carl Zeiss PRISMO Navigator 3D CMM",
        "type": "Machine",
        "level": 4,
        "area": "Quality Lab",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Carl Zeiss Metrology",
        "model": "PRISMO-9/12/7-Ultra",
        "status": "ONLINE",
        "description": "High-speed scanning coordinate measuring machine (0.5µm + L/500)"
    },

    # Subsystems & Critical Components
    {
        "id": "SUB-SCHULER-HYD-01",
        "parent": "MCH-SCHULER-2500",
        "name": "Bosch Rexroth 350-bar Hydraulic Power Unit",
        "type": "Subsystem",
        "level": 5,
        "area": "Stamping Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Bosch Rexroth",
        "model": "CytroPac-350",
        "status": "ONLINE",
        "description": "Variable-speed servo pump drive for die cushion force regulation"
    },
    {
        "id": "SUB-KUKA-TITAN-AXIS3",
        "parent": "MCH-KUKA-TITAN-01",
        "name": "Axis-3 Heavy Cycloidal Gearbox & Servo",
        "type": "Subsystem",
        "level": 5,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Nabtesco / KUKA",
        "model": "RV-E-HighTorque",
        "status": "ONLINE",
        "description": "Precision cycloidal reducer on main arm joint with vibration monitoring"
    },
    {
        "id": "SUB-DMG-SPINDLE-01",
        "parent": "MCH-DMG-DMC-85",
        "name": "20,000 RPM Master Electro-Spindle",
        "type": "Subsystem",
        "level": 5,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Kessler Spindles",
        "model": "DMS-085-HSK-A63",
        "status": "ONLINE",
        "description": "Synchronous motor spindle with hybrid ceramic bearings and sensor sleeve"
    },
    {
        "id": "SUB-TRUMPF-OPTIC-01",
        "parent": "MCH-TRUMPF-LASER-01",
        "name": "BEO D70 High-Power Focusing Optics",
        "type": "Subsystem",
        "level": 5,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "TRUMPF GmbH",
        "model": "BEO-D70-Coaxial",
        "status": "ONLINE",
        "description": "Protective cover glass monitoring with temperature and scattered light sensors"
    },
    {
        "id": "SUB-CHILLER-STG-01",
        "parent": "MCH-AVL-DYNO-400",
        "name": "Rittal Closed-Loop Chiller & Recirculator",
        "type": "Subsystem",
        "level": 5,
        "area": "Powertrain Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Rittal",
        "model": "TopTherm-Chiller-45kW",
        "status": "ONLINE",
        "description": "High-capacity deionized water chiller for dyno stator cooling"
    },

    # Sensors / Measurement Points (Level 6)
    {
        "id": "SNS-SCHULER-HYD-PRESS",
        "parent": "SUB-SCHULER-HYD-01",
        "name": "Hydraulic Main Cushion Pressure (bar)",
        "type": "Sensor",
        "level": 6,
        "area": "Stamping Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "IFM Electronic",
        "model": "PN-7092-IO-Link",
        "status": "ONLINE",
        "description": "Cushion cylinder chamber pressure transmitter (0-400 bar)"
    },
    {
        "id": "SNS-SCHULER-OIL-TEMP",
        "parent": "SUB-SCHULER-HYD-01",
        "name": "Hydraulic Oil Reservoir Temperature (°C)",
        "type": "Sensor",
        "level": 6,
        "area": "Stamping Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Endress+Hauser",
        "model": "Omnigrad-TR10",
        "status": "ONLINE",
        "description": "Pt100 RTD immersion sensor with 4-20mA HART transmitter"
    },
    {
        "id": "SNS-KUKA-AXIS3-VIB",
        "parent": "SUB-KUKA-TITAN-AXIS3",
        "name": "Axis-3 Gearbox Tri-Axial Vibration (mm/s)",
        "type": "Sensor",
        "level": 6,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Apex VibSense CMS",
        "model": "CMS-VIB-1000",
        "status": "ONLINE",
        "description": "Piezoelectric accelerometer measuring velocity RMS on cycloidal gearbox"
    },
    {
        "id": "SNS-KUKA-MOTOR-CURR",
        "parent": "SUB-KUKA-TITAN-AXIS3",
        "name": "Axis-3 Inverter Phase Current (A)",
        "type": "Sensor",
        "level": 6,
        "area": "Body Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Apex DriveTech",
        "model": "AX120-LEM-Sensor",
        "status": "ONLINE",
        "description": "Hall-effect true RMS current transducer on inverter drive bus"
    },
    {
        "id": "SNS-DMG-SPINDLE-VIB",
        "parent": "SUB-DMG-SPINDLE-01",
        "name": "Spindle Front Bearing Vibration Velocity (mm/s)",
        "type": "Sensor",
        "level": 6,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Montronix Inc.",
        "model": "PulsePro-Vib-HF",
        "status": "ONLINE",
        "description": "High-frequency vibration transmitter for tool chatter and bearing spalling"
    },
    {
        "id": "SNS-DMG-SPINDLE-TEMP",
        "parent": "SUB-DMG-SPINDLE-01",
        "name": "Spindle Ceramic Bearing Temperature (°C)",
        "type": "Sensor",
        "level": 6,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Kessler Sensors",
        "model": "PT1000-Embed",
        "status": "ONLINE",
        "description": "Embedded bearing outer ring thermal monitor"
    },
    {
        "id": "SNS-DMG-COOL-FLOW",
        "parent": "SUB-DMG-SPINDLE-01",
        "name": "Through-Spindle Coolant Flow Rate (L/min)",
        "type": "Sensor",
        "level": 6,
        "area": "Powertrain Shop",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Krohne Messtechnik",
        "model": "Optiflux-2100",
        "status": "ONLINE",
        "description": "Electromagnetic flowmeter for high-pressure emulsion delivery"
    },
    {
        "id": "SNS-TRUMPF-LASER-PWR",
        "parent": "SUB-TRUMPF-OPTIC-01",
        "name": "Fiber Laser Delivered Power (kW)",
        "type": "Sensor",
        "level": 6,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Coherent Inc.",
        "model": "PowerMax-Pro",
        "status": "ONLINE",
        "description": "Coaxial optical photodiode array measuring actual weld pool laser energy"
    },
    {
        "id": "SNS-TRUMPF-OPTIC-TEMP",
        "parent": "SUB-TRUMPF-OPTIC-01",
        "name": "Laser Protective Window Temperature (°C)",
        "type": "Sensor",
        "level": 6,
        "area": "Body Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "TRUMPF Sensors",
        "model": "CoverGlass-Guard",
        "status": "ONLINE",
        "description": "Pyrometer detecting spatters and thermal blooming on quartz window"
    },
    {
        "id": "SNS-AVL-DYNO-TORQUE",
        "parent": "MCH-AVL-DYNO-400",
        "name": "Dynamometer Shaft Dynamic Torque (Nm)",
        "type": "Sensor",
        "level": 6,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "HBM Hottinger",
        "model": "T40B-Flange-Torque",
        "status": "ONLINE",
        "description": "Telemetry wireless strain-gauge torque flange rated to 25,000 RPM"
    },
    {
        "id": "SNS-AVL-DYNO-SPEED",
        "parent": "MCH-AVL-DYNO-400",
        "name": "Dynamometer Shaft Angular Speed (RPM)",
        "type": "Sensor",
        "level": 6,
        "area": "Powertrain Shop",
        "criticality": "Tier 1 (Mission-Critical)",
        "manufacturer": "Heidenhain",
        "model": "ERM-2400-Encoder",
        "status": "ONLINE",
        "description": "Optical high-resolution incremental rotary encoder (10,000 pulses/rev)"
    },
    {
        "id": "SNS-ZEISS-PROBE-DEF",
        "parent": "MCH-ZEISS-PRISMO",
        "name": "CMM 3D Stylus Deflection Vector (µm)",
        "type": "Sensor",
        "level": 6,
        "area": "Quality Lab",
        "criticality": "Tier 2 (Core Production)",
        "manufacturer": "Carl Zeiss Metrology",
        "model": "VAST-Gold-Scanning",
        "status": "ONLINE",
        "description": "Active scanning probe measuring 3D micron deviations"
    }
]

# ---------------------------------------------------------------------------
# Manufacturing Process Routing (for Path Definer Sequence)
# ---------------------------------------------------------------------------

MANUFACTURING_PROCESS_SEQUENCE = [
    {
        "step_id": "PRC-STEP-010",
        "step_order": 10,
        "next_step_id": "PRC-STEP-020",
        "step_name": "Raw Coil Laser Profiling & Destacking",
        "assigned_line_id": "LINE-MUC-PRESS-01",
        "workstation": "Schuler Destacker Station",
        "std_cycle_time_sec": 12.5,
        "quality_gate": 0,
        "target_tolerance_um": 50.0,
        "process_description": "Laser thickness measurement of electrical steel sheet coils and robot destack."
    },
    {
        "step_id": "PRC-STEP-020",
        "step_order": 20,
        "next_step_id": "PRC-STEP-030",
        "step_name": "High-Speed Tandem Servo Stamping",
        "assigned_line_id": "LINE-MUC-PRESS-01",
        "workstation": "MCH-SCHULER-2500",
        "std_cycle_time_sec": 4.8,
        "quality_gate": 1,
        "target_tolerance_um": 15.0,
        "process_description": "Progressive die stamping of rotor/stator laminations with interlock embossing."
    },
    {
        "step_id": "PRC-STEP-030",
        "step_order": 30,
        "next_step_id": "PRC-STEP-040",
        "step_name": "5-Axis CNC Precision Shaft Machining",
        "assigned_line_id": "LINE-STG-CNC-01",
        "workstation": "MCH-DMG-DMC-85",
        "std_cycle_time_sec": 65.0,
        "quality_gate": 1,
        "target_tolerance_um": 5.0,
        "process_description": "High-precision turning, spline hobbing, and bearing journal grinding on rotor shaft."
    },
    {
        "step_id": "PRC-STEP-040",
        "step_order": 40,
        "next_step_id": "PRC-STEP-050",
        "step_name": "Multi-Stage Ultrasonic Vapor Degreasing",
        "assigned_line_id": "LINE-STG-CNC-01",
        "workstation": "Ecoclean Solvent Bath Station",
        "std_cycle_time_sec": 45.0,
        "quality_gate": 0,
        "target_tolerance_um": 0.0,
        "process_description": "Acoustic cavitation solvent bath eliminating residual cutting fluids and micro-swarf."
    },
    {
        "step_id": "PRC-STEP-050",
        "step_order": 50,
        "next_step_id": "PRC-STEP-060",
        "step_name": "Robotic Fiber Laser Seam Welding",
        "assigned_line_id": "LINE-MUC-WELD-04",
        "workstation": "MCH-TRUMPF-LASER-01",
        "std_cycle_time_sec": 28.0,
        "quality_gate": 1,
        "target_tolerance_um": 12.0,
        "process_description": "Continuous keyhole laser welding of laminated rotor core stacks under inert argon shield."
    },
    {
        "step_id": "PRC-STEP-060",
        "step_order": 60,
        "next_step_id": "PRC-STEP-070",
        "step_name": "Automated Optical 3D Profilometry (AOI)",
        "assigned_line_id": "LINE-MUC-WELD-04",
        "workstation": "Cognex In-Sight 3D Vision Cell",
        "std_cycle_time_sec": 8.5,
        "quality_gate": 1,
        "target_tolerance_um": 2.5,
        "process_description": "Multi-camera structured light inspection for weld bead geometry and surface flaws."
    },
    {
        "step_id": "PRC-STEP-070",
        "step_order": 70,
        "next_step_id": "PRC-STEP-080",
        "step_name": "Hairpin Copper Winding & Impregnation",
        "assigned_line_id": "LINE-STG-CNC-01",
        "workstation": "MCH-APEX-HAIRPIN",
        "std_cycle_time_sec": 52.0,
        "quality_gate": 1,
        "target_tolerance_um": 8.0,
        "process_description": "Automated rectangular hairpin copper insertion, twisting, laser tip stripping and welding."
    },
    {
        "step_id": "PRC-STEP-080",
        "step_order": 80,
        "next_step_id": "PRC-STEP-090",
        "step_name": "High-Voltage Dielectric & Partial Discharge Test",
        "assigned_line_id": "LINE-STG-CNC-01",
        "workstation": "Schleich E-Mobility HiPot Stand",
        "std_cycle_time_sec": 18.0,
        "quality_gate": 1,
        "target_tolerance_um": 0.0,
        "process_description": "3.5 kV dielectric withstand, surge voltage, and partial discharge inception testing."
    },
    {
        "step_id": "PRC-STEP-090",
        "step_order": 90,
        "next_step_id": "PRC-STEP-100",
        "step_name": "Full-Speed Dynamic Balancing & Dyno Test",
        "assigned_line_id": "LINE-STG-DYNO-01",
        "workstation": "MCH-AVL-DYNO-400",
        "std_cycle_time_sec": 90.0,
        "quality_gate": 1,
        "target_tolerance_um": 1.0,
        "process_description": "24,000 RPM dynamometer run-up, ISO 1940 G1.0 balancing, back-EMF map and vibration check."
    },
    {
        "step_id": "PRC-STEP-100",
        "step_order": 100,
        "next_step_id": None,
        "step_name": "Laser DataMatrix QR Engraving & Final Packaging",
        "assigned_line_id": "LINE-STG-DYNO-01",
        "workstation": "Keyence MD-X Laser Marking Cell",
        "std_cycle_time_sec": 14.0,
        "quality_gate": 0,
        "target_tolerance_um": 0.0,
        "process_description": "Direct part marking of UID/EPC QR code, digital twin cloud sync, and robotic box palletizing."
    }
]

# ---------------------------------------------------------------------------
# Products & Batches
# ---------------------------------------------------------------------------

PRODUCT_CATALOG = [
    {
        "product_code": "PROD-EV-ROTOR-800V",
        "product_name": "800V High-Efficiency Permanent Magnet Rotor V6",
        "family": "E-Mobility Powertrain",
        "unit_price_usd": 1250.0,
        "target_cycle_time_sec": 185.0
    },
    {
        "product_code": "PROD-STATOR-HAIRPIN",
        "product_name": "Dual-Inverter Hairpin Stator Core Assembly 400kW",
        "family": "E-Mobility Powertrain",
        "unit_price_usd": 1850.0,
        "target_cycle_time_sec": 240.0
    },
    {
        "product_code": "PROD-BATTERY-PACK-82K",
        "product_name": "Modular High-Density 82 kWh Prismatic Battery Enclosure",
        "family": "Battery & Energy Storage",
        "unit_price_usd": 6800.0,
        "target_cycle_time_sec": 380.0
    },
    {
        "product_code": "PROD-AERO-BRACKET-TI",
        "product_name": "Aerospace Titanium Structural Engine Support Bracket",
        "family": "Precision Aerostructures",
        "unit_price_usd": 2400.0,
        "target_cycle_time_sec": 320.0
    },
    {
        "product_code": "PROD-INV-SI-MODULE",
        "product_name": "Silicon-Carbide (SiC) Power Inverter Sub-Assembly",
        "family": "Power Electronics",
        "unit_price_usd": 920.0,
        "target_cycle_time_sec": 150.0
    }
]

OPERATORS = [
    {"id": "OP-7014", "name": "Hans Becker", "shift": "Morning Shift (06:00-14:00)", "skill": "Master Machinist"},
    {"id": "OP-7029", "name": "Elena Rostova", "shift": "Morning Shift (06:00-14:00)", "skill": "Senior Automation Eng."},
    {"id": "OP-7033", "name": "Markus Weber", "shift": "Day Shift (14:00-22:00)", "skill": "Certified Welder & QC"},
    {"id": "OP-7048", "name": "Sophia Lindqvist", "shift": "Day Shift (14:00-22:00)", "skill": "Robotics Specialist"},
    {"id": "OP-7055", "name": "Alexander Kovacs", "shift": "Night Shift (22:00-06:00)", "skill": "Industrial Electrician"},
    {"id": "OP-7062", "name": "Fatima Al-Mansoor", "shift": "Night Shift (22:00-06:00)", "skill": "Quality Metrologist"}
]

DOWNTIME_CATEGORIES = [
    ("Unplanned Mechanical Breakdown", "Bearing Spalling & Seizure", "Vibration exceeded 4.5 mm/s limit due to grease degradation", 120, 2400),
    ("Tool Wear & Chipping", "Carbide Endmill Flank Wear Out-of-Spec", "Flank wear breached 0.25mm threshold after 85 cutting cycles", 25, 450),
    ("Robotic Automation Interlock", "Safety Light Curtain Trip / Part Misfeed", "Optical sensor obscured by misalignment during transfer", 18, 150),
    ("Electrical & Inverter Fault", "DC-Bus Overvoltage Spikes on Inverter Drive", "Transient voltage spike from power grid caused IGBT safety clamp", 45, 1200),
    ("Hydraulic Power Unit Leak", "High-Pressure Seal Degradation", "O-ring extrusion on valve manifold under 320 bar pressure", 65, 890),
    ("Laser Optics Contamination", "Laser Protective Window Spatter Build-up", "Weld fumes deposited on quartz cover glass causing 8% beam power drop", 35, 620),
    ("Planned Preventive Maintenance", "PM-02 Monthly Calibration & Fluid Flush", "Scheduled oil sampling, filter replacement, and axis recalibration", 180, 1500),
    ("Product Recipe Changeover", "Tooling & Gripper Quick-Swap", "Scheduled line changeover between 800V Rotor and Stator production", 40, 300)
]

DEFECT_CODES = [
    ("DEF-NONE", "None / Conforming", "NONE", 0.0),
    ("DEF-SURFACE-SCRATCH", "Minor Scratch on Polished Journal", "MINOR", 1.2),
    ("DEF-BURR-EXCESS", "Micro-Burr on Machined Spline Edge", "MINOR", 0.8),
    ("DEF-DIMENSION-OVERSIZE", "Outer Diameter +12µm Beyond Specification", "MAJOR", 12.0),
    ("DEF-DIMENSION-UNDERSIZE", "Bore Diameter -8µm Below Specification", "MAJOR", 8.0),
    ("DEF-WELD-POROSITY", "Internal Gas Porosity in Laser Seam >0.3mm", "CRITICAL", 25.0),
    ("DEF-DIELECTRIC-LEAK", "Insulation Resistance < 100 MOhm at 3.5kV", "CRITICAL", 0.0),
    ("DEF-UNBALANCE-HIGH", "Dynamic Dynamic Imbalance > 1.2 g-mm", "MAJOR", 5.5)
]

# ---------------------------------------------------------------------------
# Generator Implementation
# ---------------------------------------------------------------------------

class IndustrialDatasetGenerator:
    def __init__(self, seed: int = 42):
        self.seed = seed
        random.seed(seed)

    def create_database_schema(self, conn: sqlite3.Connection):
        """Creates all relational tables, foreign keys, and indexes."""
        cur = conn.cursor()

        # 1. Asset Hierarchy (ISA-95)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS factory_assets_hierarchy (
            asset_id TEXT PRIMARY KEY,
            parent_asset_id TEXT,
            asset_name TEXT NOT NULL,
            asset_level TEXT NOT NULL,
            level_depth INTEGER NOT NULL,
            plant_area TEXT NOT NULL,
            criticality_tier TEXT NOT NULL,
            manufacturer TEXT,
            model_number TEXT,
            status TEXT NOT NULL DEFAULT 'ONLINE',
            description TEXT,
            installation_date TEXT,
            last_inspection_date TEXT,
            health_score REAL DEFAULT 98.5
        );
        """)

        # 2. Manufacturing Process Sequence
        cur.execute("""
        CREATE TABLE IF NOT EXISTS manufacturing_process_sequence (
            step_id TEXT PRIMARY KEY,
            step_order INTEGER NOT NULL,
            next_step_id TEXT,
            step_name TEXT NOT NULL,
            assigned_line_id TEXT NOT NULL,
            workstation_name TEXT NOT NULL,
            std_cycle_time_sec REAL NOT NULL,
            quality_gate_required INTEGER NOT NULL DEFAULT 0,
            target_tolerance_um REAL NOT NULL DEFAULT 0.0,
            process_description TEXT
        );
        """)

        # 3. Production Batches and Work Orders
        cur.execute("""
        CREATE TABLE IF NOT EXISTS production_batches (
            batch_id TEXT PRIMARY KEY,
            work_order_id TEXT NOT NULL,
            product_code TEXT NOT NULL,
            product_name TEXT NOT NULL,
            product_family TEXT NOT NULL,
            line_id TEXT NOT NULL,
            shift_name TEXT NOT NULL,
            lead_operator_id TEXT NOT NULL,
            lead_operator_name TEXT NOT NULL,
            start_timestamp TEXT NOT NULL,
            end_timestamp TEXT NOT NULL,
            planned_qty INTEGER NOT NULL,
            produced_qty INTEGER NOT NULL,
            good_qty INTEGER NOT NULL,
            scrap_qty INTEGER NOT NULL,
            rework_qty INTEGER NOT NULL,
            scrap_rate_pct REAL NOT NULL,
            cycle_time_actual_sec REAL NOT NULL,
            cycle_time_target_sec REAL NOT NULL,
            availability_rate REAL NOT NULL,
            performance_rate REAL NOT NULL,
            quality_rate REAL NOT NULL,
            oee_percentage REAL NOT NULL,
            batch_status TEXT NOT NULL
        );
        """)

        # 4. Equipment Downtime and Maintenance Events
        cur.execute("""
        CREATE TABLE IF NOT EXISTS equipment_downtime_events (
            event_id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL,
            machine_name TEXT NOT NULL,
            plant_area TEXT NOT NULL,
            start_timestamp TEXT NOT NULL,
            end_timestamp TEXT NOT NULL,
            downtime_minutes REAL NOT NULL,
            category TEXT NOT NULL,
            failure_mode TEXT NOT NULL,
            root_cause TEXT NOT NULL,
            corrective_action TEXT NOT NULL,
            technician_id TEXT NOT NULL,
            repair_cost_usd REAL NOT NULL,
            impacted_oee_factor TEXT NOT NULL,
            estimated_lost_units INTEGER NOT NULL
        );
        """)

        # 5. Quality Inspection & Defect Log
        cur.execute("""
        CREATE TABLE IF NOT EXISTS quality_inspections (
            inspection_id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL,
            product_code TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            station_name TEXT NOT NULL,
            inspection_mode TEXT NOT NULL,
            status TEXT NOT NULL,
            measured_deviation_um REAL NOT NULL,
            upper_tolerance_um REAL NOT NULL,
            lower_tolerance_um REAL NOT NULL,
            defect_code TEXT NOT NULL,
            defect_description TEXT NOT NULL,
            defect_severity TEXT NOT NULL,
            inspector_name TEXT NOT NULL
        );
        """)

        # 6. Facility Energy & ESG Telemetry
        cur.execute("""
        CREATE TABLE IF NOT EXISTS facility_energy_esg (
            log_id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            facility_id TEXT NOT NULL,
            plant_area TEXT NOT NULL,
            active_power_kwh REAL NOT NULL,
            reactive_power_kvarh REAL NOT NULL,
            power_factor REAL NOT NULL,
            peak_demand_kw REAL NOT NULL,
            compressed_air_m3 REAL NOT NULL,
            co2_emissions_kg REAL NOT NULL
        );
        """)

        # 7. Real-Time Telemetry Time-Series (High density, thousands/millions)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS machine_telemetry_timeseries (
            reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            sensor_id TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            value REAL NOT NULL,
            unit TEXT NOT NULL,
            lsl REAL,
            usl REAL,
            warning_threshold REAL,
            alarm_status TEXT NOT NULL
        );
        """)

        # 8. SCADA Compatibility Tables for Supernova's native SCADA viewers
        cur.execute("""
        CREATE TABLE IF NOT EXISTS C_PATH_ELEMENT (
            PATH_ID TEXT PRIMARY KEY,
            PARENT_PATH_ID TEXT,
            PATH_ELEMENT_NAME TEXT NOT NULL,
            PATH_LEVEL TEXT NOT NULL
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS C_POINT (
            POINT_ID TEXT PRIMARY KEY,
            POINT_NAME TEXT NOT NULL,
            POINT_TYPE TEXT NOT NULL,
            UNIT TEXT,
            MIN_VAL REAL,
            MAX_VAL REAL
        );
        """)

        cur.execute("""
        CREATE TABLE IF NOT EXISTS C_POINT_PATH_ELEMENT (
            PATH_ID TEXT NOT NULL,
            POINT_ID TEXT NOT NULL,
            PRIMARY KEY (PATH_ID, POINT_ID)
        );
        """)

        # Performance Indexes
        cur.execute("CREATE INDEX IF NOT EXISTS idx_asset_parent ON factory_assets_hierarchy(parent_asset_id);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_batch_prod ON production_batches(product_code, start_timestamp);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON machine_telemetry_timeseries(timestamp);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_sensor ON machine_telemetry_timeseries(sensor_id, timestamp);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_downtime_mch ON equipment_downtime_events(machine_id, start_timestamp);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_qc_batch ON quality_inspections(batch_id, status);")

        conn.commit()

    def populate_hierarchy_and_routing(self, conn: sqlite3.Connection):
        """Populates the ISA-95 asset hierarchy and process routing."""
        cur = conn.cursor()

        # Insert Asset Hierarchy
        cur.execute("DELETE FROM factory_assets_hierarchy")
        for a in ASSET_HIERARCHY_DATA:
            cur.execute("""
            INSERT INTO factory_assets_hierarchy (
                asset_id, parent_asset_id, asset_name, asset_level, level_depth,
                plant_area, criticality_tier, manufacturer, model_number, status,
                description, installation_date, last_inspection_date, health_score
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                a["id"],
                a["parent"],
                a["name"],
                a["type"],
                a["level"],
                a["area"],
                a["criticality"],
                a["manufacturer"],
                a["model"],
                a["status"],
                a["description"],
                "2023-04-15",
                "2026-08-20",
                round(random.uniform(92.0, 99.8), 1)
            ))

        # Insert SCADA Compatibility Tables
        cur.execute("DELETE FROM C_PATH_ELEMENT")
        for a in ASSET_HIERARCHY_DATA:
            cur.execute("""
            INSERT INTO C_PATH_ELEMENT (PATH_ID, PARENT_PATH_ID, PATH_ELEMENT_NAME, PATH_LEVEL)
            VALUES (?, ?, ?, ?)
            """, (a["id"], a["parent"] or "", a["name"], a["type"]))

        cur.execute("DELETE FROM C_POINT")
        cur.execute("DELETE FROM C_POINT_PATH_ELEMENT")
        sensors = [a for a in ASSET_HIERARCHY_DATA if a["type"] == "Sensor"]
        for s in sensors:
            cur.execute("""
            INSERT INTO C_POINT (POINT_ID, POINT_NAME, POINT_TYPE, UNIT, MIN_VAL, MAX_VAL)
            VALUES (?, ?, 'ANALOG', '', 0.0, 500.0)
            """, (s["id"], s["name"]))
            cur.execute("""
            INSERT INTO C_POINT_PATH_ELEMENT (PATH_ID, POINT_ID)
            VALUES (?, ?)
            """, (s["parent"], s["id"]))

        # Insert Manufacturing Sequence
        cur.execute("DELETE FROM manufacturing_process_sequence")
        for s in MANUFACTURING_PROCESS_SEQUENCE:
            cur.execute("""
            INSERT INTO manufacturing_process_sequence (
                step_id, step_order, next_step_id, step_name, assigned_line_id,
                workstation_name, std_cycle_time_sec, quality_gate_required,
                target_tolerance_um, process_description
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                s["step_id"],
                s["step_order"],
                s["next_step_id"],
                s["step_name"],
                s["assigned_line_id"],
                s["workstation"],
                s["std_cycle_time_sec"],
                s["quality_gate"],
                s["target_tolerance_um"],
                s["process_description"]
            ))

        conn.commit()

    def generate_batches_and_production(self, conn: sqlite3.Connection, num_batches: int = 450):
        """Generates realistic manufacturing batches with OEE metrics."""
        cur = conn.cursor()
        cur.execute("DELETE FROM production_batches")

        base_time = datetime(2026, 8, 1, 6, 0, 0, tzinfo=timezone.utc)
        current_time = base_time

        lines = [
            ("LINE-MUC-PRESS-01", "PROD-EV-ROTOR-800V"),
            ("LINE-MUC-WELD-04", "PROD-EV-ROTOR-800V"),
            ("LINE-STG-CNC-01", "PROD-STATOR-HAIRPIN"),
            ("LINE-MUC-PACK-01", "PROD-BATTERY-PACK-82K"),
            ("LINE-MUC-COAT-02", "PROD-AERO-BRACKET-TI"),
            ("LINE-STG-DYNO-01", "PROD-INV-SI-MODULE")
        ]

        batch_records = []
        for i in range(1, num_batches + 1):
            line_id, prod_code = random.choice(lines)
            prod_info = next(p for p in PRODUCT_CATALOG if p["product_code"] == prod_code)
            operator = random.choice(OPERATORS)

            batch_id = f"LOT-2026-W{random.randint(31, 37):02d}-{i:04d}"
            wo_id = f"WO-{90000 + i}"

            duration_hrs = round(random.uniform(4.0, 8.0), 2)
            end_time = current_time + timedelta(hours=duration_hrs)

            planned_qty = random.randint(120, 450)
            avail = round(random.uniform(0.86, 0.98), 4)
            perf = round(random.uniform(0.89, 0.99), 4)
            qual = round(random.uniform(0.95, 0.998), 4)
            oee = round(avail * perf * qual * 100.0, 2)

            produced_qty = int(planned_qty * perf * avail)
            scrap_qty = int(produced_qty * (1.0 - qual))
            rework_qty = int(scrap_qty * random.uniform(0.2, 0.5))
            good_qty = produced_qty - scrap_qty
            scrap_rate_pct = round((scrap_qty / max(produced_qty, 1)) * 100.0, 2)

            cycle_target = prod_info["target_cycle_time_sec"]
            cycle_actual = round(cycle_target / max(perf, 0.01), 1)

            batch_status = "COMPLETED" if oee >= 75.0 else "REVIEW_REQUIRED"

            batch_records.append((
                batch_id, wo_id, prod_code, prod_info["product_name"], prod_info["family"],
                line_id, operator["shift"], operator["id"], operator["name"],
                current_time.strftime("%Y-%m-%d %H:%M:%S"),
                end_time.strftime("%Y-%m-%d %H:%M:%S"),
                planned_qty, produced_qty, good_qty, scrap_qty, rework_qty,
                scrap_rate_pct, cycle_actual, cycle_target,
                round(avail * 100.0, 2), round(perf * 100.0, 2), round(qual * 100.0, 2),
                oee, batch_status
            ))

            current_time += timedelta(minutes=random.randint(15, 60))

        cur.executemany("""
        INSERT INTO production_batches (
            batch_id, work_order_id, product_code, product_name, product_family,
            line_id, shift_name, lead_operator_id, lead_operator_name,
            start_timestamp, end_timestamp, planned_qty, produced_qty, good_qty,
            scrap_qty, rework_qty, scrap_rate_pct, cycle_time_actual_sec,
            cycle_time_target_sec, availability_rate, performance_rate, quality_rate,
            oee_percentage, batch_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, batch_records)
        conn.commit()

    def generate_downtime_and_maintenance(self, conn: sqlite3.Connection, num_events: int = 180):
        """Generates realistic downtime events, root causes, and repair metrics."""
        cur = conn.cursor()
        cur.execute("DELETE FROM equipment_downtime_events")

        machines = [a for a in ASSET_HIERARCHY_DATA if a["type"] == "Machine"]
        base_time = datetime(2026, 8, 1, 8, 0, 0, tzinfo=timezone.utc)

        records = []
        for i in range(1, num_events + 1):
            mch = random.choice(machines)
            cat, fail_mode, root_cause, base_dur, base_cost = random.choice(DOWNTIME_CATEGORIES)
            tech = random.choice(OPERATORS)

            event_id = f"DWN-2026-{i:04d}"
            event_start = base_time + timedelta(hours=random.randint(1, 720), minutes=random.randint(0, 59))
            dur_mins = round(max(5.0, random.gauss(base_dur, base_dur * 0.25)), 1)
            event_end = event_start + timedelta(minutes=dur_mins)

            repair_cost = round(max(50.0, random.gauss(base_cost, base_cost * 0.2)), 2)
            lost_units = int(dur_mins / 2.5)

            impacted_factor = "Availability"
            if "Tool" in cat or "Micro" in cat:
                impacted_factor = "Performance"
            elif "Weld" in cat:
                impacted_factor = "Quality"

            records.append((
                event_id, mch["id"], mch["name"], mch["area"],
                event_start.strftime("%Y-%m-%d %H:%M:%S"),
                event_end.strftime("%Y-%m-%d %H:%M:%S"),
                dur_mins, cat, fail_mode, root_cause,
                "Completed corrective maintenance per Standard Operating Procedure (SOP). Replaced worn components, recalibrated zero offsets, and verified normal baseline operation under load.",
                f"TECH-{tech['id']}",
                repair_cost, impacted_factor, lost_units
            ))

        cur.executemany("""
        INSERT INTO equipment_downtime_events (
            event_id, machine_id, machine_name, plant_area, start_timestamp,
            end_timestamp, downtime_minutes, category, failure_mode, root_cause,
            corrective_action, technician_id, repair_cost_usd, impacted_oee_factor,
            estimated_lost_units
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()

    def generate_quality_inspections(self, conn: sqlite3.Connection, num_inspections: int = 800):
        """Generates quality inspection records, CMM metrology, and defect codes."""
        cur = conn.cursor()
        cur.execute("DELETE FROM quality_inspections")

        batches = [r[0] for r in cur.execute("SELECT batch_id FROM production_batches").fetchall()]
        if not batches:
            batches = [f"LOT-2026-W34-{i:04d}" for i in range(1, 100)]

        stations = [
            ("Cognex In-Sight 3D AOI Station", "Automated AI Vision (Cognex 3D Profilometer)"),
            ("Carl Zeiss PRISMO 3D CMM Room", "Certified Metrologist (Sub-Micron Scanning)"),
            ("Schleich High-Voltage Dielectric Stand", "Automated HiPot & Surge Tester"),
            ("AVL Dyno Back-EMF Station", "Automated Dynamic Dynamometer Calibration")
        ]

        records = []
        base_time = datetime(2026, 8, 1, 7, 0, 0, tzinfo=timezone.utc)

        for i in range(1, num_inspections + 1):
            batch_id = random.choice(batches)
            station_name, mode = random.choice(stations)
            ts = base_time + timedelta(hours=random.randint(1, 720), minutes=random.randint(0, 59))
            inspector = random.choice(OPERATORS)
            prod = random.choice(PRODUCT_CATALOG)

            roll = random.random()
            if roll > 0.06:
                status = "PASS"
                defect_code, defect_desc, severity, max_dev = DEFECT_CODES[0]
                dev_um = round(random.gauss(0.5, 1.8), 2)
            elif roll > 0.02:
                status = "REJECT_SCRAP"
                defect_code, defect_desc, severity, max_dev = random.choice(DEFECT_CODES[4:])
                dev_um = round(random.uniform(15.0, 38.0), 2)
            else:
                status = "REWORK_ALLOWED"
                defect_code, defect_desc, severity, max_dev = random.choice(DEFECT_CODES[1:4])
                dev_um = round(random.uniform(6.0, 14.0), 2)

            upper_tol = 10.0
            lower_tol = -10.0

            records.append((
                f"QC-2026-{i:05d}", batch_id, prod["product_code"],
                "MCH-DMG-DMC-85", ts.strftime("%Y-%m-%d %H:%M:%S"),
                station_name, mode, status, dev_um, upper_tol, lower_tol,
                defect_code, defect_desc, severity, inspector["name"]
            ))

        cur.executemany("""
        INSERT INTO quality_inspections (
            inspection_id, batch_id, product_code, machine_id, timestamp,
            station_name, inspection_mode, status, measured_deviation_um,
            upper_tolerance_um, lower_tolerance_um, defect_code,
            defect_description, defect_severity, inspector_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()

    def generate_energy_and_esg(self, conn: sqlite3.Connection, days: int = 30):
        """Generates hourly energy, power factor, and ESG CO2 emissions data."""
        cur = conn.cursor()
        cur.execute("DELETE FROM facility_energy_esg")

        areas = [
            ("AREA-MUC-STAMP", "Stamping Shop", 320.0, 85.0),
            ("AREA-MUC-BODY", "Body Shop", 480.0, 110.0),
            ("AREA-MUC-PAINT", "Paint Shop", 620.0, 140.0),
            ("AREA-MUC-BATTERY", "Battery Shop", 390.0, 95.0),
            ("AREA-STG-POWERTRAIN", "Powertrain Shop", 510.0, 125.0)
        ]

        base_time = datetime(2026, 8, 1, 0, 0, 0, tzinfo=timezone.utc)
        records = []
        log_counter = 1

        total_hours = days * 24
        for h in range(total_hours):
            current_time = base_time + timedelta(hours=h)
            hour_of_day = current_time.hour
            is_weekend = current_time.weekday() >= 5

            load_factor = 0.55 if is_weekend else (0.45 if hour_of_day < 6 else (0.95 if 8 <= hour_of_day <= 18 else 0.75))

            for area_id, area_name, base_pwr, base_air in areas:
                noise = random.gauss(1.0, 0.04)
                active_kwh = round(base_pwr * load_factor * noise, 2)
                pf = round(random.uniform(0.93, 0.985), 3)
                reactive_kvarh = round(active_kwh * math.tan(math.acos(pf)), 2)
                peak_kw = round(active_kwh * 1.35, 1)
                air_m3 = round(base_air * load_factor * random.gauss(1.0, 0.05), 2)
                co2_kg = round(active_kwh * 0.380, 2)

                records.append((
                    f"NRG-2026-{log_counter:06d}",
                    current_time.strftime("%Y-%m-%d %H:%M:%S"),
                    "PLANT-MUC-01",
                    area_name,
                    active_kwh,
                    reactive_kvarh,
                    pf,
                    peak_kw,
                    air_m3,
                    co2_kg
                ))
                log_counter += 1

        cur.executemany("""
        INSERT INTO facility_energy_esg (
            log_id, timestamp, facility_id, plant_area, active_power_kwh,
            reactive_power_kvarh, power_factor, peak_demand_kw,
            compressed_air_m3, co2_emissions_kg
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()

    def generate_telemetry_timeseries(self, conn: sqlite3.Connection, target_records: int = 50000):
        """
        Generates high-density sensor telemetry time-series with realistic physics,
        periodic sine patterns, Gaussian white noise, and injected thermal/vibration anomalies.
        Supports fast batch execution for 50,000, 250,000 or up to 1,000,000 records.
        """
        cur = conn.cursor()
        cur.execute("DELETE FROM machine_telemetry_timeseries")

        sensors_meta = [
            {
                "sensor_id": "SNS-SCHULER-HYD-PRESS",
                "machine_id": "MCH-SCHULER-2500",
                "metric_name": "Hydraulic Cushion Pressure",
                "unit": "bar",
                "base_val": 220.0,
                "amplitude": 25.0,
                "period_mins": 3.0,
                "sigma": 3.5,
                "lsl": 150.0,
                "usl": 280.0,
                "warn_high": 260.0
            },
            {
                "sensor_id": "SNS-SCHULER-OIL-TEMP",
                "machine_id": "MCH-SCHULER-2500",
                "metric_name": "Hydraulic Oil Temp",
                "unit": "°C",
                "base_val": 48.0,
                "amplitude": 6.0,
                "period_mins": 180.0,
                "sigma": 0.8,
                "lsl": 25.0,
                "usl": 75.0,
                "warn_high": 65.0
            },
            {
                "sensor_id": "SNS-KUKA-AXIS3-VIB",
                "machine_id": "MCH-KUKA-TITAN-01",
                "metric_name": "Axis-3 Gearbox Vibration Velocity",
                "unit": "mm/s",
                "base_val": 1.4,
                "amplitude": 0.5,
                "period_mins": 8.0,
                "sigma": 0.15,
                "lsl": 0.1,
                "usl": 4.5,
                "warn_high": 3.2
            },
            {
                "sensor_id": "SNS-DMG-SPINDLE-VIB",
                "machine_id": "MCH-DMG-DMC-85",
                "metric_name": "Spindle Bearing Vibration RMS",
                "unit": "mm/s",
                "base_val": 0.9,
                "amplitude": 0.4,
                "period_mins": 15.0,
                "sigma": 0.12,
                "lsl": 0.05,
                "usl": 3.5,
                "warn_high": 2.6
            },
            {
                "sensor_id": "SNS-DMG-SPINDLE-TEMP",
                "machine_id": "MCH-DMG-DMC-85",
                "metric_name": "Spindle Ceramic Bearing Temp",
                "unit": "°C",
                "base_val": 42.0,
                "amplitude": 8.0,
                "period_mins": 120.0,
                "sigma": 1.1,
                "lsl": 15.0,
                "usl": 72.0,
                "warn_high": 60.0
            },
            {
                "sensor_id": "SNS-TRUMPF-LASER-PWR",
                "machine_id": "MCH-TRUMPF-LASER-01",
                "metric_name": "Fiber Laser Optical Power",
                "unit": "kW",
                "base_val": 5.95,
                "amplitude": 0.25,
                "period_mins": 2.0,
                "sigma": 0.05,
                "lsl": 4.8,
                "usl": 6.3,
                "warn_high": 6.15
            },
            {
                "sensor_id": "SNS-AVL-DYNO-TORQUE",
                "machine_id": "MCH-AVL-DYNO-400",
                "metric_name": "Dynamic Shaft Torque",
                "unit": "Nm",
                "base_val": 350.0,
                "amplitude": 80.0,
                "period_mins": 5.0,
                "sigma": 6.0,
                "lsl": 50.0,
                "usl": 550.0,
                "warn_high": 480.0
            },
            {
                "sensor_id": "SNS-AVL-DYNO-SPEED",
                "machine_id": "MCH-AVL-DYNO-400",
                "metric_name": "Shaft Angular Speed",
                "unit": "RPM",
                "base_val": 12500.0,
                "amplitude": 4500.0,
                "period_mins": 12.0,
                "sigma": 50.0,
                "lsl": 500.0,
                "usl": 24000.0,
                "warn_high": 21000.0
            }
        ]

        num_sensors = len(sensors_meta)
        timesteps = target_records // num_sensors
        if timesteps < 100:
            timesteps = 100

        base_time = datetime(2026, 9, 1, 0, 0, 0, tzinfo=timezone.utc)
        step_seconds = max(10, (30 * 86400) // timesteps)

        batch_buffer = []
        batch_size = 10000

        total_inserted = 0
        for t_idx in range(timesteps):
            t_curr = base_time + timedelta(seconds=t_idx * step_seconds)
            t_str = t_curr.strftime("%Y-%m-%d %H:%M:%S")
            t_mins = (t_idx * step_seconds) / 60.0

            anomaly_spike = 1.0
            if (timesteps * 0.35 <= t_idx <= timesteps * 0.37) or (timesteps * 0.74 <= t_idx <= timesteps * 0.76):
                anomaly_spike = 1.65

            for sm in sensors_meta:
                freq = (2 * math.pi) / sm["period_mins"]
                sine_val = math.sin(t_mins * freq) * sm["amplitude"]
                noise = random.gauss(0, sm["sigma"])

                val = (sm["base_val"] + sine_val + noise) * (anomaly_spike if "VIB" in sm["sensor_id"] or "TEMP" in sm["sensor_id"] else 1.0)
                val = round(val, 2)

                if sm["usl"] and val >= sm["usl"]:
                    status = "CRITICAL_HIGH"
                elif sm["lsl"] and val <= sm["lsl"]:
                    status = "CRITICAL_LOW"
                elif sm["warn_high"] and val >= sm["warn_high"]:
                    status = "WARNING"
                else:
                    status = "NORMAL"

                batch_buffer.append((
                    t_str, sm["machine_id"], sm["sensor_id"], sm["metric_name"],
                    val, sm["unit"], sm["lsl"], sm["usl"], sm["warn_high"], status
                ))

                if len(batch_buffer) >= batch_size:
                    cur.executemany("""
                    INSERT INTO machine_telemetry_timeseries (
                        timestamp, machine_id, sensor_id, metric_name,
                        value, unit, lsl, usl, warning_threshold, alarm_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, batch_buffer)
                    conn.commit()
                    total_inserted += len(batch_buffer)
                    batch_buffer.clear()

        if batch_buffer:
            cur.executemany("""
            INSERT INTO machine_telemetry_timeseries (
                timestamp, machine_id, sensor_id, metric_name,
                value, unit, lsl, usl, warning_threshold, alarm_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, batch_buffer)
            conn.commit()
            total_inserted += len(batch_buffer)
            batch_buffer.clear()

        return total_inserted


def register_supernova_queries_and_paths(data_db_path: str, app_db_path: str = "db/supernova_reports.db"):
    """
    Registers the data source, industrial queries, Path Definer configurations,
    and executive report templates into Supernova's central application database.
    """
    if not os.path.exists(app_db_path):
        print(f"  ⚠️ App database not found at {app_db_path}, skipping Supernova registration.")
        return

    app_conn = sqlite3.connect(app_db_path)
    cur = app_conn.cursor()

    is_same_db = os.path.abspath(data_db_path) == os.path.abspath(app_db_path)
    ds_id = "ds_app" if is_same_db else "ds_apex_factory"

    if not is_same_db:
        # Register new standalone data source in Supernova
        cur.execute("""
        INSERT INTO data_sources (id, name, db_type, host, port, username, password, database_name, is_active)
        VALUES (?, ?, 'sqlite', '', 0, '', '', ?, 1)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            database_name = excluded.database_name,
            updated_at = datetime('now');
        """, (ds_id, "Apex Smart Factory (Standalone SQL DB)", data_db_path))

    queries_to_register = [
        (
            "q_ind_asset_tree",
            "[Smart Factory] ISA-95 Asset Hierarchy (Path Definer Tree)",
            "Hiyerarşik Tesis, Hat, Makine ve Sensör Ağacı (Enterprise -> Plant -> Area -> Line -> Machine -> Sensor)",
            ds_id,
            """SELECT 
    asset_id AS id,
    parent_asset_id AS parent_id,
    asset_name AS label,
    asset_level AS asset_type,
    plant_area,
    criticality_tier,
    manufacturer,
    model_number,
    health_score,
    status
FROM factory_assets_hierarchy
ORDER BY level_depth ASC, asset_name ASC;"""
        ),
        (
            "q_ind_mfg_sequence",
            "[Smart Factory] Manufacturing Process Routing (Path Definer Sequence)",
            "Sıralı Üretim ve Montaj Adımları (Step 10 -> Step 100 zinciri, toleranslar ve çevrim süreleri)",
            ds_id,
            """SELECT 
    step_id AS id,
    step_order,
    next_step_id,
    step_name AS label,
    assigned_line_id,
    workstation_name,
    std_cycle_time_sec,
    quality_gate_required,
    target_tolerance_um,
    process_description
FROM manufacturing_process_sequence
ORDER BY step_order ASC;"""
        ),
        (
            "q_ind_asset_grouped",
            "[Smart Factory] Equipment by Criticality & Area (Path Definer Grouped)",
            "Kritiklik Seviyesi (Tier 1/2/3) ve Tesis Alanına Göre Gruplanmış Ekipman Listesi",
            ds_id,
            """SELECT 
    criticality_tier AS group_id,
    asset_id AS id,
    asset_name AS label,
    asset_level,
    plant_area,
    manufacturer,
    model_number,
    health_score,
    status
FROM factory_assets_hierarchy
WHERE asset_level IN ('Machine', 'Subsystem')
ORDER BY criticality_tier ASC, asset_name ASC;"""
        ),
        (
            "q_ind_telemetry_recent",
            "[Smart Factory] Real-Time Sensor Telemetry Stream (High-Frequency)",
            "Canlı makine titreşim, sıcaklık, basınç ve akım sensör verileri ve alarm durumları",
            ds_id,
            """SELECT 
    reading_id,
    timestamp,
    machine_id,
    sensor_id,
    metric_name,
    value,
    unit,
    lsl,
    usl,
    warning_threshold,
    alarm_status
FROM machine_telemetry_timeseries
ORDER BY reading_id DESC
LIMIT 5000;"""
        ),
        (
            "q_ind_production_oee",
            "[Smart Factory] Batch Production & OEE KPI Performance",
            "Üretim partileri, planlanan/gerçekleşen miktarlar, hurda oranları ve OEE çarpanları",
            ds_id,
            """SELECT 
    batch_id,
    work_order_id,
    product_code,
    product_name,
    product_family,
    line_id,
    shift_name,
    lead_operator_name,
    start_timestamp,
    end_timestamp,
    planned_qty,
    produced_qty,
    good_qty,
    scrap_qty,
    scrap_rate_pct,
    availability_rate,
    performance_rate,
    quality_rate,
    oee_percentage,
    batch_status
FROM production_batches
ORDER BY start_timestamp DESC;"""
        ),
        (
            "q_ind_downtime_pareto",
            "[Smart Factory] Downtime Events & Maintenance Root Causes (MTTR/MTBF)",
            "Plansız duruşlar, kök neden analizi, arıza modları ve bakım onarım maliyetleri",
            ds_id,
            """SELECT 
    event_id,
    machine_id,
    machine_name,
    plant_area,
    start_timestamp,
    end_timestamp,
    downtime_minutes,
    category,
    failure_mode,
    root_cause,
    repair_cost_usd,
    impacted_oee_factor,
    estimated_lost_units
FROM equipment_downtime_events
ORDER BY downtime_minutes DESC;"""
        ),
        (
            "q_ind_quality_pareto",
            "[Smart Factory] Quality Defect Pareto & Tolerances",
            "CMM ve AOI ölçüm sapmaları, mikron tolerans ihlalleri ve hata kodları analizi",
            ds_id,
            """SELECT 
    inspection_id,
    batch_id,
    product_code,
    machine_id,
    timestamp,
    station_name,
    inspection_mode,
    status,
    measured_deviation_um,
    defect_code,
    defect_description,
    defect_severity,
    inspector_name
FROM quality_inspections
ORDER BY timestamp DESC;"""
        ),
        (
            "q_ind_energy_esg",
            "[Smart Factory] Facility Energy Consumption & CO2 Emissions (ESG)",
            "Saatlik aktif/reaktif enerji tüketimi, güç faktörü ve Scope-2 karbon salımları",
            ds_id,
            """SELECT 
    log_id,
    timestamp,
    facility_id,
    plant_area,
    active_power_kwh,
    reactive_power_kvarh,
    power_factor,
    peak_demand_kw,
    compressed_air_m3,
    co2_emissions_kg
FROM facility_energy_esg
ORDER BY timestamp DESC;"""
        )
    ]

    for q_id, q_name, q_desc, q_ds, q_sql in queries_to_register:
        cur.execute("""
        INSERT INTO queries (id, name, description, data_source_id, sql_text, parameters, columns_meta, is_active)
        VALUES (?, ?, ?, ?, ?, '[]', '[]', 1)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            sql_text = excluded.sql_text,
            data_source_id = excluded.data_source_id,
            updated_at = datetime('now');
        """, (q_id, q_name, q_desc, q_ds, q_sql))

    # Register Path Definer Configurations
    paths_to_register = [
        (
            "pth_factory_tree",
            "ISA-95 Smart Factory Asset Hierarchy (Enterprise Tree)",
            "Tree yapısında Akıllı Fabrika ekipman hiyerarşisi: Tesis → Alan → Hat → Makine → Sensör drilldown.",
            "q_ind_asset_tree",
            "tree",
            json.dumps({
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
            })
        ),
        (
            "pth_factory_sequence",
            "Automotive Powertrain Process Routing (Sequence Chain)",
            "Sequence yapısında adım adım üretim zinciri: Lazer kesim → Pres → CNC → Kaynak → Kalite Kontrol → Test.",
            "q_ind_mfg_sequence",
            "sequence",
            json.dumps({
                "id_col": "id",
                "order_col": "step_order",
                "next_col": "next_step_id",
                "label_col": "label",
                "target_col": "step_id"
            })
        ),
        (
            "pth_factory_grouped",
            "Critical Equipment by Criticality & Shop Floor (Grouped View)",
            "Grouped yapısında ekipmanların Tier 1 (Kritik), Tier 2 (Ana Üretim), Tier 3 seviyelerine göre gruplanması.",
            "q_ind_asset_grouped",
            "grouped",
            json.dumps({
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
            })
        )
    ]

    for p_id, p_name, p_desc, p_qid, p_struct, p_cfg in paths_to_register:
        cur.execute("""
        INSERT INTO path_defs (id, name, description, query_id, structure, config, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            query_id = excluded.query_id,
            structure = excluded.structure,
            config = excluded.config,
            updated_at = datetime('now');
        """, (p_id, p_name, p_desc, p_qid, p_struct, p_cfg))

    # Register Executive Report Template
    tpl_model = {
        "id": "tpl_smart_factory_exec",
        "name": "Executive Smart Factory Performance & OEE Report",
        "description": "Enterprise-grade manufacturing performance summary with OEE KPIs, shift yield, and downtime analysis.",
        "version": 1,
        "sheets": [
            {
                "id": "s1",
                "name": "Executive KPI Summary",
                "rowCount": 30,
                "columnCount": 10,
                "cells": {
                    "1,1": {"row": 1, "col": 1, "value": "APEX SMART FACTORY — EXECUTIVE PERFORMANCE REPORT", "style": {"bold": True, "fontSize": 16, "color": "#1E3A8A"}},
                    "2,1": {"row": 2, "col": 1, "value": "Generated Date: {{report_date}} | Facility: Munich Gigafactory & Stuttgart Precision Works", "style": {"italic": True, "color": "#64748B"}},
                    "4,1": {"row": 4, "col": 1, "value": "Batch ID", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,2": {"row": 4, "col": 2, "value": "Product Name", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,3": {"row": 4, "col": 3, "value": "Line", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,4": {"row": 4, "col": 4, "value": "Shift", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,5": {"row": 4, "col": 5, "value": "Produced Qty", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,6": {"row": 4, "col": 6, "value": "Good Qty", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,7": {"row": 4, "col": 7, "value": "Scrap Qty", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,8": {"row": 4, "col": 8, "value": "Scrap %", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,9": {"row": 4, "col": 9, "value": "OEE %", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}},
                    "4,10": {"row": 4, "col": 10, "value": "Status", "style": {"bold": True, "bg": "#1E293B", "color": "#FFFFFF"}}
                },
                "bands": [
                    {
                        "id": "b_oee",
                        "queryId": "q_ind_production_oee",
                        "range": {"startRow": 5, "startCol": 1, "endRow": 5, "endCol": 10},
                        "fieldMap": {
                            "1": "batch_id",
                            "2": "product_name",
                            "3": "line_id",
                            "4": "shift_name",
                            "5": "produced_qty",
                            "6": "good_qty",
                            "7": "scrap_qty",
                            "8": "scrap_rate_pct",
                            "9": "oee_percentage",
                            "10": "batch_status"
                        }
                    }
                ],
                "charts": []
            }
        ]
    }

    cur.execute("""
    INSERT INTO report_templates (id, name, description, model, is_active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        model = excluded.model,
        updated_at = datetime('now');
    """, (
        "tpl_smart_factory_exec",
        "Executive Smart Factory Performance & OEE Report",
        "Apex Gigafactory OEE KPIs, Batch Yield & Downtime Pareto Analysis",
        json.dumps(tpl_model)
    ))

    app_conn.commit()
    app_conn.close()


def export_dataset_files(conn: sqlite3.Connection, output_dir: str, export_formats: list):
    """Exports the generated datasets to CSV, JSON, and manifest files with memory-safe streaming."""
    os.makedirs(output_dir, exist_ok=True)
    cur = conn.cursor()

    tables = [
        "factory_assets_hierarchy",
        "manufacturing_process_sequence",
        "production_batches",
        "equipment_downtime_events",
        "quality_inspections",
        "facility_energy_esg",
        "machine_telemetry_timeseries"
    ]

    manifest = {
        "dataset_name": "Apex Enterprise Smart Factory & Industrial SCADA Dataset",
        "version": "2.4.0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tables": {}
    }

    print(f"\n📂 Exporting datasets to destination: {output_dir}")

    for tbl in tables:
        cur.execute(f"SELECT COUNT(*) FROM {tbl}")
        count = cur.fetchone()[0]

        cur.execute(f"SELECT * FROM {tbl} LIMIT 1")
        col_names = [desc[0] for desc in cur.description]

        manifest["tables"][tbl] = {
            "record_count": count,
            "columns": col_names
        }

        # Memory-safe streaming CSV Export
        if "csv" in export_formats:
            csv_path = os.path.join(output_dir, f"{tbl}.csv")
            import csv
            cur.execute(f"SELECT * FROM {tbl}")
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(col_names)
                while True:
                    chunk = cur.fetchmany(50000)
                    if not chunk:
                        break
                    writer.writerows(chunk)
            print(f"  ✓ CSV: {csv_path} ({count:,} rows)")

        # JSON Export (sample if telemetry is large to keep file size reasonable)
        if "json" in export_formats:
            json_path = os.path.join(output_dir, f"{tbl}.json")
            limit = 10000 if count > 10000 else count
            cur.execute(f"SELECT * FROM {tbl} LIMIT {limit}")
            rows = cur.fetchall()
            dict_rows = [dict(zip(col_names, r)) for r in rows]
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(dict_rows, f, indent=2 if count <= 500 else None)
            print(f"  ✓ JSON: {json_path} ({len(dict_rows):,} rows{' - sampled' if count > 10000 else ''})")

    # Export Manifest
    manifest_path = os.path.join(output_dir, "dataset_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"  ✓ Manifest: {manifest_path}")

    return manifest


def main():
    parser = argparse.ArgumentParser(description="Generate Enterprise Smart Factory Dataset for Supernova")
    parser.add_argument("--db-path", default="db/supernova_reports.db", help="Path to SQLite database for data tables")
    parser.add_argument("--app-db-path", default="db/supernova_reports.db", help="Path to Supernova central application database")
    parser.add_argument("--output-dir", default="data_exports/enterprise_smart_factory", help="Custom output directory for files (Path Definer)")
    parser.add_argument("--scale", default="standard", choices=["small", "standard", "large", "million"], help="Scale of telemetry dataset")
    parser.add_argument("--formats", default="sqlite,csv,json", help="Comma-separated export formats (sqlite,csv,json)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for deterministic generation")

    args = parser.parse_args()

    scale_map = {
        "small": {"telemetry": 5000, "batches": 100, "downtime": 50, "qc": 200},
        "standard": {"telemetry": 60000, "batches": 450, "downtime": 180, "qc": 800},
        "large": {"telemetry": 250000, "batches": 1500, "downtime": 600, "qc": 3000},
        "million": {"telemetry": 1000000, "batches": 5000, "downtime": 2000, "qc": 10000}
    }
    cfg = scale_map[args.scale]

    print("=" * 70)
    print("🏭 APEX ENTERPRISE SMART FACTORY & INDUSTRIAL SCADA DATASET BUILDER")
    print("=" * 70)
    print(f"Database Target : {args.db_path}")
    print(f"Output Directory: {args.output_dir}")
    print(f"Selected Scale  : {args.scale} (~{cfg['telemetry']:,} telemetry readings)")
    print(f"Formats         : {args.formats}")
    print("-" * 70)

    os.makedirs(os.path.dirname(os.path.abspath(args.db_path)), exist_ok=True)
    conn = sqlite3.connect(args.db_path)

    gen = IndustrialDatasetGenerator(seed=args.seed)

    print("\n[1/6] Initializing relational schema...")
    gen.create_database_schema(conn)

    print("[2/6] Populating ISA-95 Asset Hierarchy & Process Routing (for Path Definer)...")
    gen.populate_hierarchy_and_routing(conn)

    print(f"[3/6] Generating {cfg['batches']} Production Batches with OEE KPIs...")
    gen.generate_batches_and_production(conn, num_batches=cfg["batches"])

    print(f"[4/6] Generating {cfg['downtime']} Maintenance Downtime Events & {cfg['qc']} QC inspections...")
    gen.generate_downtime_and_maintenance(conn, num_events=cfg["downtime"])
    gen.generate_quality_inspections(conn, num_inspections=cfg["qc"])
    gen.generate_energy_and_esg(conn, days=30)

    print(f"[5/6] Generating {cfg['telemetry']:,} High-Density Sensor Telemetry Readings...")
    total_telemetry = gen.generate_telemetry_timeseries(conn, target_records=cfg["telemetry"])
    print(f"      ✓ Inserted {total_telemetry:,} telemetry time-series points.")

    print("[6/6] Registering Queries, Path Definer & Report Templates into Supernova...")
    register_supernova_queries_and_paths(args.db_path, args.app_db_path)

    formats = [f.strip().lower() for f in args.formats.split(",")]
    export_dataset_files(conn, args.output_dir, formats)

    conn.close()
    print("\n" + "=" * 70)
    print("✅ DATASET GENERATION & SUPERNOVA INTEGRATION COMPLETE!")
    print("=" * 70)


if __name__ == "__main__":
    main()
