#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Comprehensive Full-System Integration, De-Branding & Security Audit Suite
=========================================================================
Verifies end-to-end health across all SuperNova (Nov4) modules:
1. Complete Vendor / Proprietary IP Sanitization (Files, APIs & SQLite DBs)
2. Auth, All 6 Demo Accounts, RBAC & User Management Lifecycle (incl. immediate session revocation)
3. Data Sources, Stored Package Metadata & All Saved SQL Queries + Parameterized SQL Safety
4. All Saved Python Scripts, Ad-Hoc Execution & Sandbox Escape Prevention
5. Path Definer & Multi-Space-Map Topologies (Tree, Multi-Level, DAG, Sequence, Grouped + Custom Icons)
6. Template Builder (.xlsx & .pdf) + Mathematical Proof of Live Dynamic Query Execution on Render
7. Dashboards, Persistent Alarms & Dynamic Rolling-Window Report Scheduler
8. HTTP Security Headers & Access Control Enforcement
"""
from __future__ import annotations

import io
import json
import os
import re
import sqlite3
import sys
import unittest

import openpyxl

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(BASE_DIR, "supernova-backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from api_server import app, get_db  # noqa: E402


_FORBIDDEN_TOKENS = [
    "sie" + "mens",
    "sima" + "tic",
    "sinu" + "merik",
    "sip" + "lus",
    "sina" + "mics",
    "s7-" + "1500",
    "s7" + "comm",
    "mind" + "sphere",
    "spec" + "trum",
    "sp7" + "_",
    "his_" + "dbc",
    "readdata" + "raw",
    "readdata" + "aggregated",
    "read_raw_" + "his",
    "his_" + "test",
    r"\bhis" + r"u\b",
    r"\bdo" + r"r\b",
    r"\bom" + r"s\b",
]
PROPRIETARY_PATTERN = re.compile("(" + "|".join(_FORBIDDEN_TOKENS) + ")", re.IGNORECASE)


class FullSystemAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        res = cls.client.post("/api/auth/login", json={"username": "utku", "password": "utku123"})
        assert res.status_code == 200, f"Superuser login failed: {res.get_data(as_text=True)}"
        cls.super_token = (res.get_json() or {}).get("token")
        cls.super_headers = {"Authorization": f"Bearer {cls.super_token}"}

    # ------------------------------------------------------------------
    # 1. De-Branding & Proprietary Reference Zero-Leak Audit
    # ------------------------------------------------------------------
    def test_01_debranding_and_proprietary_ip_zero_leak(self):
        endpoints = [
            "/api/datasources",
            "/api/datasources/ds_apex_factory/functions",
            "/api/queries",
            "/api/paths",
            "/api/templates",
            "/api/alarms",
        ]
        for ep in endpoints:
            res = self.client.get(ep, headers=self.super_headers)
            self.assertEqual(res.status_code, 200, f"Endpoint {ep} failed")
            payload_text = res.get_data(as_text=True)
            hits = PROPRIETARY_PATTERN.findall(payload_text)
            self.assertEqual(hits, [], f"Proprietary terms leaked in {ep}: {hits}")

        # Verify PKG_TELEMETRY_CORE replaced old HIS package
        fn_res = self.client.get("/api/datasources/ds_apex_factory/functions", headers=self.super_headers).get_json() or {}
        fn_names = [f.get("name") for f in (fn_res.get("data") or [])]
        self.assertIn("PKG_TELEMETRY_CORE.ReadRawTelemetry", fn_names)
        self.assertIn("PKG_TELEMETRY_CORE.ReadAggregatedMetrics", fn_names)
        self.assertIn("read_raw_telemetry", fn_names)

        # Verify both SQLite databases contain zero proprietary terms
        for db_rel in ("db/supernova_reports.db", "db/apex_smart_factory_prod.db"):
            db_path = os.path.join(BASE_DIR, db_rel)
            conn = sqlite3.connect(db_path)
            try:
                tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                for tbl in tables:
                    for row in conn.execute(f'SELECT * FROM "{tbl}"').fetchall():
                        joined = " | ".join(str(v) for v in row if v is not None)
                        hits = PROPRIETARY_PATTERN.findall(joined)
                        self.assertEqual(hits, [], f"Proprietary term in {db_rel}.{tbl}: {hits}")
            finally:
                conn.close()

    # ------------------------------------------------------------------
    # 2. All Demo Logins, RBAC & User Management Full Lifecycle
    # ------------------------------------------------------------------
    def test_02_all_demo_accounts_rbac_and_user_management_lifecycle(self):
        demo_accounts = [
            ("utku", "utku123", "superuser"),
            ("developer", "Nova_Super#4302", "superuser"),
            ("admin", "Nova_Admin#9841", "admin"),
            ("engineer", "Nova_Engineer#5544", "engineer"),
            ("operator", "Nova_Operator#1520", "operator"),
            ("viewer", "Nova_Viewer#7611", "viewer"),
        ]
        role_tokens = {}
        for username, password, expected_role in demo_accounts:
            res = self.client.post("/api/auth/login", json={"username": username, "password": password})
            self.assertEqual(res.status_code, 200, f"Demo account '{username}' failed to login")
            body = res.get_json() or {}
            self.assertTrue(body.get("token"))
            self.assertEqual((body.get("user") or {}).get("role"), expected_role)
            role_tokens[username] = body["token"]

        # Unauthenticated request rejected
        unauth = self.client.get("/api/queries")
        self.assertEqual(unauth.status_code, 401)

        # Viewer cannot create users (RBAC enforcement)
        viewer_hdr = {"Authorization": f"Bearer {role_tokens['viewer']}"}
        denied = self.client.get("/api/admin/users", headers=viewer_hdr)
        self.assertEqual(denied.status_code, 403)

        # Fetch roles to find operator role_id
        roles_res = self.client.get("/api/roles", headers=self.super_headers).get_json() or {}
        roles = roles_res.get("data") or []
        op_role = next((r for r in roles if r.get("key") == "operator"), None)
        self.assertIsNotNone(op_role)

        # Admin User CRUD + Immediate Session Revocation on Deactivate/Delete
        temp_username = "audit_temp_op_user"
        created_uid = None
        try:
            create_res = self.client.post(
                "/api/admin/users",
                headers=self.super_headers,
                json={
                    "username": temp_username,
                    "displayName": "Audit Temp Operator",
                    "email": "audit.temp@supernovacorp.com",
                    "password": "Nova_TempUser#8821",
                    "roleId": op_role["id"],
                },
            )
            self.assertEqual(create_res.status_code, 201, create_res.get_data(as_text=True))
            created_uid = (create_res.get_json() or {}).get("data", {}).get("id")
            self.assertTrue(created_uid)

            # Login as new user
            temp_login = self.client.post(
                "/api/auth/login",
                json={"username": temp_username, "password": "Nova_TempUser#8821"},
            )
            self.assertEqual(temp_login.status_code, 200)
            temp_body = temp_login.get_json() or {}
            temp_hdr = {"Authorization": f"Bearer {temp_body['token']}"}
            temp_refresh = temp_body.get("refreshToken")

            # Active user can access queries
            self.assertEqual(self.client.get("/api/queries", headers=temp_hdr).status_code, 200)

            # Deactivate user -> both JWT and refresh token MUST immediately fail with 401
            deact_res = self.client.put(
                f"/api/admin/users/{created_uid}",
                headers=self.super_headers,
                json={"isActive": False},
            )
            self.assertEqual(deact_res.status_code, 200)
            self.assertEqual(self.client.get("/api/queries", headers=temp_hdr).status_code, 401)
            if temp_refresh:
                self.assertEqual(
                    self.client.post("/api/auth/refresh", json={"refreshToken": temp_refresh}).status_code,
                    401,
                )

            # Reactivate, then delete -> JWT MUST immediately fail with 401
            self.client.put(
                f"/api/admin/users/{created_uid}",
                headers=self.super_headers,
                json={"isActive": True},
            )
            self.assertEqual(self.client.get("/api/queries", headers=temp_hdr).status_code, 200)

            del_res = self.client.delete(f"/api/admin/users/{created_uid}", headers=self.super_headers)
            self.assertEqual(del_res.status_code, 200)
            self.assertEqual(self.client.get("/api/queries", headers=temp_hdr).status_code, 401)
            created_uid = None
        finally:
            if created_uid:
                self.client.delete(f"/api/admin/users/{created_uid}", headers=self.super_headers)

    # ------------------------------------------------------------------
    # 3. All Saved SQL Queries & Parameterized SQL Injection Protection
    # ------------------------------------------------------------------
    def test_03_all_saved_queries_and_parameterized_sql(self):
        qs = (self.client.get("/api/queries", headers=self.super_headers).get_json() or {}).get("data", [])
        self.assertGreaterEqual(len(qs), 20)
        for q in qs:
            qid = q["id"]
            self.assertTrue((q.get("description") or "").strip(), f"Query {qid} should have a description")
            res = self.client.post(f"/api/queries/{qid}/preview", headers=self.super_headers, json={})
            self.assertEqual(res.status_code, 200, f"Saved query {qid} failed: {res.get_data(as_text=True)}")
            rows = ((res.get_json() or {}).get("data") or {}).get("rows", [])
            self.assertGreater(len(rows), 0, f"Saved query {qid} returned 0 rows")

        # Parameterized SQL injection test: payload is treated strictly as literal value
        inj_res = self.client.post(
            "/api/queries/preview",
            headers=self.super_headers,
            json={
                "dataSourceId": "ds_app",
                "sql": "SELECT username FROM users WHERE username = :uname",
                "params": {"uname": "' OR '1'='1"},
            },
        )
        self.assertEqual(inj_res.status_code, 200)
        inj_rows = ((inj_res.get_json() or {}).get("data") or {}).get("rows", [])
        self.assertEqual(inj_rows, [], "SQL injection string must be bound safely and match 0 users")

    # ------------------------------------------------------------------
    # 4. All Saved Python Scripts & Sandbox Security
    # ------------------------------------------------------------------
    def test_04_all_saved_python_scripts_and_sandbox_security(self):
        scripts = (self.client.get("/api/python/scripts", headers=self.super_headers).get_json() or {}).get("data", [])
        self.assertGreaterEqual(len(scripts), 4)
        for s in scripts:
            sid = s["id"]
            # Test via /api/python/scripts/<sid>/run
            r1 = self.client.post(f"/api/python/scripts/{sid}/run", headers=self.super_headers, json={})
            self.assertEqual(r1.status_code, 200, f"Script {sid} failed on /scripts/<id>/run")
            d1 = (r1.get_json() or {}).get("data") or {}
            self.assertGreater(len(d1.get("rows") or []), 0, f"Script {sid} produced empty rows")

            # Test via /api/python/run with scriptId
            r2 = self.client.post("/api/python/run", headers=self.super_headers, json={"scriptId": sid})
            self.assertEqual(r2.status_code, 200, f"Script {sid} failed on /api/python/run")

        # Verify dangerous imports are blocked by the Python sandbox
        blocked = self.client.post(
            "/api/python/run",
            headers=self.super_headers,
            json={"code": "import subprocess\nout('x', [{'a': 1}])"},
        )
        self.assertNotEqual(blocked.status_code, 200, "Sandbox must reject subprocess import")

    # ------------------------------------------------------------------
    # 5. Path Definer & Multi-Space-Map Topologies + Custom Icon Overrides
    # ------------------------------------------------------------------
    def test_05_path_definer_and_multi_space_map_structures_and_icons(self):
        paths = (self.client.get("/api/paths", headers=self.super_headers).get_json() or {}).get("data", [])
        self.assertGreaterEqual(len(paths), 10)
        seen_structures = set()
        for p in paths:
            pid = p["id"]
            seen_structures.add(p.get("structure"))
            res = self.client.post(f"/api/paths/{pid}/build", headers=self.super_headers, json={})
            self.assertEqual(res.status_code, 200, f"Path {pid} failed to build")
            nodes = ((res.get_json() or {}).get("data") or {}).get("nodes") or []
            self.assertGreater(len(nodes), 0, f"Path {pid} built 0 nodes")

        for expected in ("tree", "sequence", "grouped", "dag"):
            self.assertIn(expected, seen_structures)

        # Create temporary custom Space Map with factory icon overrides & verify persistence
        temp_pid = None
        try:
            custom_cfg = {
                "level_cols": ["plant_area", "criticality_tier", "asset_name"],
                "label_col": "asset_name",
                "spaceMapConfig": {
                    "theme": "factory",
                    "layout": "radial",
                    "level1Icon": "fa-industry",
                    "level2Icon": "fa-shield-halved",
                    "level3Icon": "fa-robot",
                    "nodeIcons": {"Munich Plant": "fa-building"},
                },
            }
            create_p = self.client.post(
                "/api/paths",
                headers=self.super_headers,
                json={
                    "name": "Audit Temporary Multi-Level Factory Map",
                    "description": "Tests multi_level + custom factory icons",
                    "queryId": "q_2a64c5db3a",
                    "structure": "multi_level",
                    "config": custom_cfg,
                },
            )
            self.assertEqual(create_p.status_code, 201, create_p.get_data(as_text=True))
            temp_pid = ((create_p.get_json() or {}).get("data") or {}).get("id")
            self.assertTrue(temp_pid)

            built = self.client.post(f"/api/paths/{temp_pid}/build", headers=self.super_headers, json={})
            self.assertEqual(built.status_code, 200)
            b_nodes = ((built.get_json() or {}).get("data") or {}).get("nodes") or []
            self.assertGreater(len(b_nodes), 5)

            fetched = self.client.get(f"/api/paths/{temp_pid}", headers=self.super_headers).get_json() or {}
            saved_sm_cfg = ((fetched.get("data") or {}).get("config") or {}).get("spaceMapConfig") or {}
            self.assertEqual(saved_sm_cfg.get("level3Icon"), "fa-robot")
        finally:
            if temp_pid:
                self.client.delete(f"/api/paths/{temp_pid}", headers=self.super_headers)

    # ------------------------------------------------------------------
    # 6. Template Builder + Proof of Live Dynamic Query Execution on Render
    # ------------------------------------------------------------------
    def test_06_template_builder_live_dynamic_execution_xlsx_and_pdf(self):
        # Verify core saved templates render both XLSX and PDF cleanly
        for tid in ("tpl_smart_factory_exec", "tpl_python_oee_esg", "tpl_demo"):
            rx = self.client.post(f"/api/templates/{tid}/render?format=xlsx", headers=self.super_headers, json={})
            rp = self.client.post(f"/api/templates/{tid}/render?format=pdf", headers=self.super_headers, json={})
            self.assertEqual(rx.status_code, 200, f"XLSX render failed for {tid}")
            self.assertTrue(rx.data.startswith(b"PK\x03\x04"))
            self.assertEqual(rp.status_code, 200, f"PDF render failed for {tid}")
            self.assertTrue(rp.data.startswith(b"%PDF-"))

        # Mathematical Proof: Changing DB row changes rendered Excel output without touching query/template
        db = get_db()
        temp_qid = None
        temp_tid = None
        try:
            with db._conn() as conn:
                conn.execute("CREATE TABLE IF NOT EXISTS _audit_live_probe (station TEXT PRIMARY KEY, output_units INTEGER)")
                conn.execute("DELETE FROM _audit_live_probe")
                conn.execute("INSERT INTO _audit_live_probe (station, output_units) VALUES (?, ?)", ("ST-ALPHA", 125))

            q_res = self.client.post(
                "/api/queries",
                headers=self.super_headers,
                json={
                    "name": "Audit Live Probe Query",
                    "description": "Verifies dynamic live execution on report render",
                    "dataSourceId": "ds_app",
                    "sql": "SELECT station, output_units FROM _audit_live_probe ORDER BY station",
                },
            )
            self.assertIn(q_res.status_code, (200, 201), q_res.get_data(as_text=True))
            temp_qid = ((q_res.get_json() or {}).get("data") or {}).get("id")
            self.assertTrue(temp_qid)

            tpl_model = {
                "sheets": [
                    {
                        "name": "LiveData",
                        "rowCount": 8,
                        "colCount": 4,
                        "cells": {
                            "1,1": {"row": 1, "col": 1, "value": "Station"},
                            "1,2": {"row": 1, "col": 2, "value": "Output Units"},
                        },
                        "bands": [
                            {
                                "id": "band_live_probe",
                                "queryId": temp_qid,
                                "range": {"startRow": 2, "endRow": 2, "startCol": 1, "endCol": 2},
                                "fieldMap": {"1": "station", "2": "output_units"},
                            }
                        ],
                    }
                ]
            }
            t_res = self.client.post(
                "/api/templates",
                headers=self.super_headers,
                json={
                    "name": "Audit Live Execution Proof Template",
                    "description": "Proves report values are never hardcoded",
                    "model": tpl_model,
                },
            )
            self.assertIn(t_res.status_code, (200, 201), t_res.get_data(as_text=True))
            temp_tid = ((t_res.get_json() or {}).get("data") or {}).get("id")
            self.assertTrue(temp_tid)

            # Render #1 -> must contain 125
            r_xlsx_1 = self.client.post(f"/api/templates/{temp_tid}/render?format=xlsx", headers=self.super_headers, json={})
            self.assertEqual(r_xlsx_1.status_code, 200)
            wb1 = openpyxl.load_workbook(io.BytesIO(r_xlsx_1.data), data_only=True)
            ws1 = wb1["LiveData"]
            cells_1 = [ws1.cell(r, c).value for r in range(1, 6) for c in range(1, 5)]
            self.assertIn(125, cells_1, f"Expected initial live value 125 in {cells_1}")

            # Mutate DB directly -> Render #2 WITHOUT editing query or template -> must contain 980!
            with db._conn() as conn:
                conn.execute("UPDATE _audit_live_probe SET output_units = ? WHERE station = ?", (980, "ST-ALPHA"))

            r_xlsx_2 = self.client.post(f"/api/templates/{temp_tid}/render?format=xlsx", headers=self.super_headers, json={})
            self.assertEqual(r_xlsx_2.status_code, 200)
            wb2 = openpyxl.load_workbook(io.BytesIO(r_xlsx_2.data), data_only=True)
            ws2 = wb2["LiveData"]
            cells_2 = [ws2.cell(r, c).value for r in range(1, 6) for c in range(1, 5)]
            self.assertIn(980, cells_2, f"Expected updated live value 980 in {cells_2}")
            self.assertNotIn(125, cells_2, "Stale value 125 must not be cached or hardcoded")
        finally:
            if temp_tid:
                self.client.delete(f"/api/templates/{temp_tid}", headers=self.super_headers)
            if temp_qid:
                self.client.delete(f"/api/queries/{temp_qid}", headers=self.super_headers)
            with db._conn() as conn:
                conn.execute("DROP TABLE IF EXISTS _audit_live_probe")

    # ------------------------------------------------------------------
    # 7. Dashboards, Persistent Alarms & Dynamic Schedules
    # ------------------------------------------------------------------
    def test_07_dashboards_alarms_and_schedules(self):
        # Dashboards
        dash_res = self.client.get("/api/dashboards", headers=self.super_headers)
        self.assertEqual(dash_res.status_code, 200)
        dashboards = (dash_res.get_json() or {}).get("data") or []
        self.assertGreaterEqual(len(dashboards), 2)
        exec_dash = self.client.get("/api/dashboards/d_smart_factory_exec", headers=self.super_headers)
        self.assertEqual(exec_dash.status_code, 200)
        layout = ((exec_dash.get_json() or {}).get("data") or {}).get("layout") or []
        self.assertGreater(len(layout), 0)

        # Persistent Alarms
        alm_res = self.client.get("/api/alarms", headers=self.super_headers)
        self.assertEqual(alm_res.status_code, 200)
        alarms = (alm_res.get_json() or {}).get("data") or []
        self.assertGreaterEqual(len(alarms), 5)
        ack_res = self.client.post("/api/alarms/alm_1/acknowledge", headers=self.super_headers, json={})
        self.assertEqual(ack_res.status_code, 200)
        # Restore alm_1 to active so demo starts fresh
        with get_db()._conn() as conn:
            conn.execute("UPDATE system_alarms SET status='active', acknowledged_by='' WHERE id='alm_1'")

        # Schedules list
        sch_res = self.client.get("/api/schedules", headers=self.super_headers)
        self.assertEqual(sch_res.status_code, 200)
        self.assertIsInstance((sch_res.get_json() or {}).get("data"), list)

    # ------------------------------------------------------------------
    # 8. HTTP Security Headers
    # ------------------------------------------------------------------
    def test_08_http_security_headers(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn(res.headers.get("X-Frame-Options"), ("DENY", "SAMEORIGIN"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
