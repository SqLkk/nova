#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
End-to-End Verification Test for Supernova Advanced Features:
1. PostgreSQL Driver & Parameterized Queries
2. Path Definer DAG Multi-parent Graph & Live Health Badges
3. Report Template PDF Rendering & Export
4. Universal Dynamic Report Scheduler (Rolling time windows, backfill, run logs, download)
"""
from __future__ import annotations

import os
import sys
import json
import time
import urllib.request
import urllib.parse
import unittest

BASE_URL = "http://127.0.0.1:5001"


def make_request(method: str, path: str, data: dict | None = None, token: str | None = None, return_bytes: bool = False):
    url = f"{BASE_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    body_bytes = None
    if data is not None:
        body_bytes = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read()
            if return_bytes:
                return resp.status, resp.headers, content
            text = content.decode("utf-8")
            return resp.status, resp.headers, json.loads(text) if text else {}
    except urllib.error.HTTPError as err:
        content = err.read()
        if return_bytes:
            return err.code, err.headers, content
        text = content.decode("utf-8")
        try:
            return err.code, err.headers, json.loads(text)
        except Exception:
            return err.code, err.headers, {"raw": text}


class TestSupernovaAdvancedFeatures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 1. Login as superuser
        status, _, res = make_request("POST", "/api/auth/login", {"username": "utku", "password": "utku123"})
        cls.token = res.get("token") or res.get("accessToken")
        assert cls.token, f"Login failed with status {status}: {res}"
        print("Logged in successfully as superuser!")

    # -----------------------------------------------------------------------
    # TEST 1: PostgreSQL Support
    # -----------------------------------------------------------------------
    def test_01_postgres_datasource_and_query(self):
        print("\n--- Testing PostgreSQL Support ---")
        # Test ad-hoc connection to local postgres
        status, _, res = make_request("POST", "/api/datasources/test", {
            "db_type": "postgres",
            "database_name": "postgres"
        }, token=self.token)
        self.assertEqual(status, 200, f"PostgreSQL test connection failed: {res}")
        self.assertTrue(res.get("success"), "Test connection should return success: True")
        print("1.1 PostgreSQL connection test passed.")

        # Execute query against PostgreSQL
        status, _, res = make_request("POST", "/api/queries/preview", {
            "dataSourceId": "ds_postgres_local",
            "sql": "SELECT 100 as score, 'Supernova PG Active' as status, NOW() as cur_time",
            "params": {}
        }, token=self.token)
        self.assertEqual(status, 200, f"PostgreSQL ad-hoc run failed: {res}")
        data = res.get("data", {})
        self.assertEqual(len(data.get("rows", [])), 1)
        self.assertEqual(data["rows"][0]["score"], 100)
        print("1.2 PostgreSQL query execution & JSON serialization passed.")

        # Parameterized query test with :param
        status, _, res = make_request("POST", "/api/queries/preview", {
            "dataSourceId": "ds_postgres_local",
            "sql": "SELECT :metric_name as metric, :threshold::int * 2 as calculated",
            "params": {"metric_name": "OEE_TARGET", "threshold": 45}
        }, token=self.token)
        self.assertEqual(status, 200, f"PostgreSQL parameterized run failed: {res}")
        data = res.get("data", {})
        self.assertEqual(data["rows"][0]["metric"], "OEE_TARGET")
        self.assertEqual(data["rows"][0]["calculated"], 90)
        print("1.3 PostgreSQL :param -> %(param)s conversion passed.")

    # -----------------------------------------------------------------------
    # TEST 2: Path Definer DAG & Live Health Badges
    # -----------------------------------------------------------------------
    def test_02_path_definer_dag_and_health_badges(self):
        print("\n--- Testing Path Definer DAG & Health Badges ---")
        # Preview DAG with multi-parent routing steps
        status, _, res = make_request("POST", "/api/paths/preview", {
            "queryId": "q_ind_routing_dag",
            "structure": "dag",
            "config": {
                "id_col": "step_id",
                "parent_col": "prerequisite_step_ids",
                "label_col": "step_name",
                "type_col": "assigned_line_id",
                "health_col": "health_score",
                "status_col": "status"
            }
        }, token=self.token)
        self.assertEqual(status, 200, f"DAG preview failed: {res}")
        data = res.get("data", {})
        nodes = data.get("structure", {}).get("nodes", [])
        paths = data.get("structure", {}).get("paths", [])
        self.assertGreater(len(nodes), 0, "DAG should contain nodes")
        self.assertGreater(len(paths), 0, "DAG should contain execution paths")

        # Verify multi-parent nodes have parents array and health decorations
        multi_parent_found = False
        health_decorated = False
        for n in nodes:
            if len(n.get("parents", [])) > 1:
                multi_parent_found = True
            if "healthScore" in n and "statusColor" in n:
                health_decorated = True

        self.assertTrue(multi_parent_found, "Should have detected nodes with multiple parents in routing DAG")
        self.assertTrue(health_decorated, "Nodes should have healthScore and statusColor badges")
        print(f"2.1 DAG structure generated {len(nodes)} nodes, {len(paths)} paths. Multi-parent & health badges verified.")

        # Create saved DAG path definition
        status, _, res = make_request("POST", "/api/paths", {
            "name": "E2E Factory Routing DAG",
            "description": "Multi-parent manufacturing DAG with yield health badges",
            "queryId": "q_ind_routing_dag",
            "structure": "dag",
            "config": {
                "id_col": "step_id",
                "parent_col": "prerequisite_step_ids",
                "label_col": "step_name",
                "type_col": "assigned_line_id",
                "health_col": "health_score",
                "status_col": "status"
            }
        }, token=self.token)
        self.assertEqual(status, 201, f"Create DAG path failed: {res}")
        dag_id = res.get("data", {}).get("id")
        self.assertTrue(dag_id)
        print(f"2.2 Saved DAG path definition: {dag_id}")

        # Materialize / fetch saved DAG
        status, _, res = make_request("GET", f"/api/paths/{dag_id}", token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(res["data"]["structure"], "dag")
        print("2.3 Materialized DAG retrieval passed.")

    # -----------------------------------------------------------------------
    # TEST 3: Report Studio PDF Export
    # -----------------------------------------------------------------------
    def test_03_template_pdf_export(self):
        print("\n--- Testing Report Studio PDF Export ---")
        status, headers, content = make_request(
            "POST",
            "/api/templates/tpl_smart_factory_exec/render?format=pdf",
            data={},
            token=self.token,
            return_bytes=True
        )
        self.assertEqual(status, 200, f"PDF export failed with status {status}: {content[:200]}")
        content_type = headers.get("Content-Type", "")
        self.assertIn("application/pdf", content_type, f"Expected application/pdf, got {content_type}")
        self.assertTrue(content.startswith(b"%PDF-"), "Response should be valid PDF binary")
        self.assertGreater(len(content), 1000, "PDF size should be substantial")
        print(f"3.1 PDF rendered and received ({len(content):,} bytes, valid %PDF- header).")

    # -----------------------------------------------------------------------
    # TEST 4: Universal Dynamic Report Scheduler
    # -----------------------------------------------------------------------
    def test_04_universal_dynamic_scheduler(self):
        print("\n--- Testing Universal Dynamic Report Scheduler ---")
        # 4.1 List schedules
        status, _, res = make_request("GET", "/api/schedules", token=self.token)
        self.assertEqual(status, 200)
        schedules = res.get("data", [])
        self.assertIsInstance(schedules, list)
        print(f"4.1 Listed {len(schedules)} existing schedule(s).")

        # 4.2 Create a universal schedule with rolling 'yesterday' window
        status, _, res = make_request("POST", "/api/schedules", {
            "name": "E2E Dynamic Operations Briefing",
            "description": "Universal rolling yesterday performance briefing",
            "template_id": "tpl_smart_factory_exec",
            "frequency": "daily",
            "window_type": "yesterday",
            "output_format": "pdf",
            "recipients": ["management@apex-industrial.com"]
        }, token=self.token)
        self.assertEqual(status, 201, f"Create schedule failed: {res}")
        sched_id = res.get("data", {}).get("id")
        self.assertTrue(sched_id)
        print(f"4.2 Created dynamic schedule: {sched_id}")

        # 4.3 Trigger immediate run with explicit reference_date (testing date relativity)
        # Date 1: 2026-09-14 (Yesterday should be 2026-09-13)
        status, _, res = make_request("POST", f"/api/schedules/{sched_id}/run", {
            "reference_date": "2026-09-14 06:00:00"
        }, token=self.token)
        self.assertEqual(status, 200, f"Trigger schedule run failed: {res}")
        run1 = res.get("data", {})
        self.assertTrue(run1.get("success"), f"Run failed: {run1}")
        self.assertEqual(run1["startTime"], "2026-09-13 00:00:00")
        self.assertEqual(run1["endTime"], "2026-09-13 23:59:59")
        self.assertIn("2026-09-13", run1["periodLabel"])
        print(f"4.3.1 As-of 2026-09-14 resolved yesterday: {run1['startTime']} to {run1['endTime']} ({run1['durationMs']}ms)")

        # Date 2: 2026-09-15 (Yesterday should be 2026-09-14)
        status, _, res = make_request("POST", f"/api/schedules/{sched_id}/run", {
            "reference_date": "2026-09-15 06:00:00"
        }, token=self.token)
        self.assertEqual(status, 200)
        run2 = res.get("data", {})
        self.assertTrue(run2.get("success"))
        self.assertEqual(run2["startTime"], "2026-09-14 00:00:00")
        self.assertEqual(run2["endTime"], "2026-09-14 23:59:59")
        self.assertIn("2026-09-14", run2["periodLabel"])
        print(f"4.3.2 As-of 2026-09-15 resolved yesterday: {run2['startTime']} to {run2['endTime']} ({run2['durationMs']}ms)")

        # 4.4 List run history
        status, _, res = make_request("GET", f"/api/schedules/{sched_id}/runs", token=self.token)
        self.assertEqual(status, 200)
        runs = res.get("data", [])
        self.assertGreaterEqual(len(runs), 2, "Should record at least 2 runs")
        print(f"4.4 Run history verified: {len(runs)} execution logs recorded.")

        # 4.5 Download generated run report
        latest_run_id = runs[0]["id"]
        status, headers, content = make_request("GET", f"/api/schedules/runs/{latest_run_id}/download", token=self.token, return_bytes=True)
        self.assertEqual(status, 200, f"Download failed: {status}")
        self.assertTrue(content.startswith(b"%PDF-"), "Downloaded scheduled report should be valid PDF")
        print(f"4.5 Downloaded scheduled report file successfully ({len(content):,} bytes).")


if __name__ == "__main__":
    unittest.main()
