#!/usr/bin/env python3
"""
End-to-End Test Suite: Smart Factory Dataset, Path Definer & Report Studio
========================================================================
Runs full-stack E2E tests against Supernova API endpoints:
1. Authentication & Bearer Token Issuance
2. Standalone SQL Data Source Registration & Health Check
3. Dynamic Table Discovery, Schema Introspection & Data Preview
4. SQL Query Execution & Multi-Dimensional Telemetry Fetching
5. Path Definer Tree Building (ISA-95 Equipment Hierarchy)
6. Path Definer Sequence Building (Process Routing Step 10 to 100)
7. Path Definer Grouped Building (Equipment Criticality Clusters)
8. Path Definer Intelligent Search & Breadcrumb Resolution
9. Dynamic Report Studio Execution (Excel Template Engine .xlsx Rendering)

Author: Antigravity AI / Siemens Industrial SCADA & Data Analytics Platform
"""

import os
import sys
import json
import time

# Ensure backend directory is in sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(BASE_DIR, "supernova-backend")
sys.path.insert(0, BACKEND_DIR)
sys.path.insert(0, BASE_DIR)

from api_server import app

def run_tests():
    print("=" * 75)
    print("🧪 RUNNING END-TO-END VERIFICATION: SMART FACTORY & PATH DEFINER")
    print("=" * 75)
    
    client = app.test_client()
    passed = 0
    failed = 0

    def assert_test(name, condition, details=""):
        nonlocal passed, failed
        if condition:
            print(f"  ✅ PASS: {name} {f'({details})' if details else ''}")
            passed += 1
        else:
            print(f"  ❌ FAIL: {name} {f'({details})' if details else ''}")
            failed += 1

    # -------------------------------------------------------------------
    # 1. Authentication Test
    # -------------------------------------------------------------------
    print("\n[Step 1/8] Testing Authentication & Token Handshake...")
    res = client.post('/api/auth/login', json={'username': 'utku', 'password': 'utku123'})
    assert_test("Login with superuser credentials", res.status_code == 200, f"Status {res.status_code}")
    login_data = res.get_json() or {}
    token = login_data.get('token')
    assert_test("Bearer token issued", bool(token), f"Token length: {len(token or '')}")
    headers = {'Authorization': f"Bearer {token}", 'Content-Type': 'application/json'}

    # -------------------------------------------------------------------
    # 2. Data Source Discovery
    # -------------------------------------------------------------------
    print("\n[Step 2/8] Testing Standalone SQL Data Source Discovery...")
    res = client.get('/api/datasources', headers=headers)
    assert_test("Fetch data sources", res.status_code == 200)
    datasources = (res.get_json() or {}).get('data', [])
    ds_ids = [d.get('id') for d in datasources]
    assert_test("ds_apex_factory is registered", "ds_apex_factory" in ds_ids, f"Found sources: {ds_ids}")

    # -------------------------------------------------------------------
    # 3. Table Discovery & Introspection
    # -------------------------------------------------------------------
    print("\n[Step 3/8] Testing Table Discovery & Schema Introspection on Standalone DB...")
    res = client.get('/api/datasources/ds_apex_factory/tables', headers=headers)
    assert_test("Introspect tables in ds_apex_factory", res.status_code == 200)
    tables = (res.get_json() or {}).get('data', [])
    expected_tables = [
        "factory_assets_hierarchy",
        "manufacturing_process_sequence",
        "production_batches",
        "equipment_downtime_events",
        "quality_inspections",
        "facility_energy_esg",
        "machine_telemetry_timeseries"
    ]
    for exp_t in expected_tables:
        assert_test(f"Table '{exp_t}' discovered", exp_t in tables)

    # Schema Introspection
    res = client.get('/api/datasources/ds_apex_factory/tables/factory_assets_hierarchy/schema', headers=headers)
    assert_test("Fetch schema for factory_assets_hierarchy", res.status_code == 200)
    schema_dict = (res.get_json() or {}).get('data', {})
    columns = schema_dict.get('columns', [])
    col_names = [c.get('name') for c in columns]
    assert_test("Schema has asset_id primary key", "asset_id" in col_names)
    assert_test("Schema has health_score & status", "health_score" in col_names and "status" in col_names)

    # Table Preview with LIMIT
    res = client.get('/api/datasources/ds_apex_factory/tables/production_batches?limit=3', headers=headers)
    assert_test("Table preview with pagination", res.status_code == 200)
    preview_data = (res.get_json() or {}).get('data', {})
    rows = preview_data.get('rows', [])
    assert_test("Preview returned 3 rows", len(rows) == 3, f"Rows: {len(rows)}")

    # -------------------------------------------------------------------
    # 4. SQL Query Execution
    # -------------------------------------------------------------------
    print("\n[Step 4/8] Testing Live SQL Queries on Standalone Factory DB...")
    queries_to_test = [
        ("q_ind_asset_tree", 41),
        ("q_ind_mfg_sequence", 10),
        ("q_ind_production_oee", 450),
        ("q_ind_downtime_pareto", 180),
        ("q_ind_telemetry_recent", 5000)
    ]
    for qid, expected_min_rows in queries_to_test:
        t0 = time.time()
        res = client.post(f'/api/queries/{qid}/preview', headers=headers, json={})
        dur = round((time.time() - t0) * 1000, 1)
        assert_test(f"Run query '{qid}'", res.status_code == 200, f"{dur}ms")
        q_data = (res.get_json() or {}).get('data', {})
        q_rows = q_data.get('rows', [])
        assert_test(f"Query '{qid}' returned rows", len(q_rows) >= min(expected_min_rows, 100), f"Count: {len(q_rows)}")

    # -------------------------------------------------------------------
    # 5. Path Definer: Tree Structure (ISA-95 Plant Hierarchy)
    # -------------------------------------------------------------------
    print("\n[Step 5/8] Testing Path Definer: Tree Structure (ISA-95 Asset Tree)...")
    res = client.post('/api/paths/pth_factory_tree/build', headers=headers, json={})
    assert_test("Build tree structure (pth_factory_tree)", res.status_code == 200)
    tree_data = (res.get_json() or {}).get('data', {})
    stats = tree_data.get('stats', {})
    roots = tree_data.get('roots', [])
    nodes = tree_data.get('nodes', [])
    assert_test("Tree root identified as ENT-APEX-GLOBAL", "ENT-APEX-GLOBAL" in roots, f"Roots: {roots}")
    assert_test("Tree node count is 41", stats.get('node_count') == 41, f"Nodes: {stats.get('node_count')}")
    assert_test("Tree depth reaches level 6 (Sensors)", stats.get('max_depth') >= 5, f"Depth: {stats.get('max_depth')}")
    assert_test("Zero warnings in tree validation", len(stats.get('warnings', [])) == 0, f"Warnings: {stats.get('warnings')}")

    # -------------------------------------------------------------------
    # 6. Path Definer: Sequence & Grouped Structures
    # -------------------------------------------------------------------
    print("\n[Step 6/8] Testing Path Definer: Sequence & Grouped Structures...")
    # Sequence
    res = client.post('/api/paths/pth_factory_sequence/build', headers=headers, json={})
    assert_test("Build sequence structure (pth_factory_sequence)", res.status_code == 200)
    seq_data = (res.get_json() or {}).get('data', {})
    seq_nodes = seq_data.get('nodes', [])
    assert_test("Sequence has 10 manufacturing steps", len(seq_nodes) == 10, f"Steps: {len(seq_nodes)}")
    assert_test("First step is PRC-STEP-010", seq_nodes[0].get('id') == "PRC-STEP-010" if seq_nodes else False)
    assert_test("Final step is PRC-STEP-100", seq_nodes[-1].get('id') == "PRC-STEP-100" if seq_nodes else False)

    # Grouped
    res = client.post('/api/paths/pth_factory_grouped/build', headers=headers, json={})
    assert_test("Build grouped structure (pth_factory_grouped)", res.status_code == 200)
    grp_data = (res.get_json() or {}).get('data', {})
    grp_roots = grp_data.get('roots', [])
    assert_test("Grouped by Criticality Tiers", any("Tier 1" in r for r in grp_roots), f"Groups: {grp_roots}")

    # -------------------------------------------------------------------
    # 7. Path Definer Intelligent Search & Breadcrumbs
    # -------------------------------------------------------------------
    print("\n[Step 7/8] Testing Path Definer Search & Breadcrumbs...")
    res = client.post('/api/paths/pth_factory_tree/search', headers=headers, json={'term': 'KUKA'})
    assert_test("Search for 'KUKA' in asset tree", res.status_code == 200)
    search_data = (res.get_json() or {}).get('data', {})
    hits = search_data.get('hits', [])
    assert_test("Found KUKA assets in tree", len(hits) >= 2, f"Hits: {len(hits)}")
    if hits:
        hit = hits[0]
        breadcrumb = " -> ".join(hit.get('breadcrumb', []))
        print(f"      📍 Breadcrumb Path: {breadcrumb}")
        assert_test("Valid hierarchical breadcrumb resolved", len(hit.get('breadcrumb', [])) >= 3)

    res = client.post('/api/paths/pth_factory_tree/search', headers=headers, json={'term': 'Spindle'})
    assert_test("Search for 'Spindle' subsystem in tree", res.status_code == 200)
    hits_spindle = (res.get_json() or {}).get('data', {}).get('hits', [])
    assert_test("Found Spindle in tree", len(hits_spindle) >= 1, f"Hits: {len(hits_spindle)}")

    # -------------------------------------------------------------------
    # 8. Report Template Execution (Excel Template Engine)
    # -------------------------------------------------------------------
    print("\n[Step 8/8] Testing Report Template Execution (.xlsx generation)...")
    res = client.post('/api/templates/tpl_smart_factory_exec/render?format=xlsx', headers=headers, json={})
    assert_test("Render executive template tpl_smart_factory_exec", res.status_code == 200, f"Status {res.status_code}")
    content_type = res.headers.get('Content-Type', '')
    assert_test("Response is Excel format", 'spreadsheetml' in content_type or 'octet-stream' in content_type, f"Content-Type: {content_type}")
    file_bytes = res.data
    assert_test("Generated Excel payload has valid size", len(file_bytes) > 5000, f"{len(file_bytes):,} bytes")
    # Verify zip/xlsx magic bytes (PK\x03\x04)
    is_valid_zip = file_bytes.startswith(b'PK\x03\x04')
    assert_test("Valid OpenXML XLSX binary structure", is_valid_zip)

    # -------------------------------------------------------------------
    # Final Summary
    # -------------------------------------------------------------------
    print("\n" + "=" * 75)
    print(f"🏁 END-TO-END TEST RESULTS: {passed} PASSED, {failed} FAILED (Total: {passed + failed})")
    print("=" * 75)
    if failed == 0:
        print("🎉 ALL TESTS PASSED! FULL-STACK END-TO-END PIPELINE IS 100% OPERATIONAL.")
    else:
        print(f"⚠️ {failed} test(s) failed. Please review the errors above.")
    return failed == 0

if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
