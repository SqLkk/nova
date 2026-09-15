#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Supernova Universal Report Scheduler CLI & Automation Runner.

Kullanım:
  # Belirli bir zamanlayıcıyı bugünün tarihiyle çalıştır:
  python scripts/report_scheduler.py --schedule-id sched_daily_factory

  # Belirli bir zamanlayıcıyı geçmiş bir tarih referansıyla geriye dönük (backfill) çalıştır:
  python scripts/report_scheduler.py --schedule-id sched_daily_factory --as-of 2026-09-14

  # Tüm aktif zamanlayıcıları listele:
  python scripts/report_scheduler.py --list

  # Tüm aktif zamanlayıcıları çalıştır:
  python scripts/report_scheduler.py --run-all-active
"""
from __future__ import annotations

import os
import sys
import argparse
import logging
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(REPO_ROOT, "supernova-backend")
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from db.database import get_db
from scheduler_engine import execute_schedule_run, resolve_time_window

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("report_scheduler")


def list_schedules():
    db = get_db()
    with db._conn() as conn:
        rows = conn.execute(
            """SELECT s.id, s.name, s.frequency, s.window_type, s.output_format,
                      s.is_active, s.last_run_at, s.last_run_status, t.name as template_name
               FROM report_schedules s
               LEFT JOIN report_templates t ON s.template_id = t.id
               ORDER BY s.id"""
        ).fetchall()

    print("\n" + "=" * 90)
    print("  SUPERNOVA UNIVERSAL REPORT SCHEDULES")
    print("=" * 90)
    if not rows:
        print("  No schedules found.")
        print("=" * 90 + "\n")
        return

    fmt = "  {:<24} {:<32} {:<10} {:<12} {:<6} {:<6} {:<10}"
    print(fmt.format("SCHEDULE ID", "NAME", "FREQ", "WINDOW", "FMT", "ACTIVE", "LAST STATUS"))
    print("  " + "-" * 88)
    for r in rows:
        act = "YES" if r["is_active"] else "NO"
        st = r["last_run_status"] or "-"
        print(fmt.format(r["id"][:23], r["name"][:30], r["frequency"], r["window_type"], r["output_format"], act, st))
    print("=" * 90 + "\n")


def run_single_schedule(schedule_id: str, as_of: str | None = None):
    logger.info(f"Triggering schedule run for '{schedule_id}' (as-of: {as_of or 'NOW'})...")
    result = execute_schedule_run(schedule_id, reference_date_str=as_of, executed_by="cli_runner")
    if result.get("success"):
        logger.info(f"✅ Success! Generated {result.get('outputFormat').upper()}: {result.get('outputFilePath')}")
        logger.info(f"   Period: {result.get('periodLabel')} ({result.get('startTime')} to {result.get('endTime')})")
        logger.info(f"   Size: {result.get('fileSizeBytes'):,} bytes | Duration: {result.get('durationMs')}ms")
    else:
        logger.error(f"❌ Failed! Error: {result.get('error')}")


def run_all_active(as_of: str | None = None):
    db = get_db()
    with db._conn() as conn:
        rows = conn.execute("SELECT id, name FROM report_schedules WHERE is_active=1").fetchall()
    if not rows:
        logger.info("No active schedules found.")
        return
    logger.info(f"Found {len(rows)} active schedule(s). Executing...")
    for r in rows:
        run_single_schedule(r["id"], as_of)


def main():
    parser = argparse.ArgumentParser(description="Supernova Universal Report Scheduler CLI")
    parser.add_argument("--list", action="store_true", help="List all configured schedules")
    parser.add_argument("--schedule-id", type=str, help="Specific schedule ID to run")
    parser.add_argument("--as-of", type=str, help="Reference date/time (e.g. 2026-09-14 or '2026-09-14 08:00')")
    parser.add_argument("--run-all-active", action="store_true", help="Run all active schedules")
    parser.add_argument("--test-window", type=str, help="Test a window type (e.g. yesterday, last_7d, this_month)")

    args = parser.parse_args()

    if args.test_window:
        res = resolve_time_window(args.test_window)
        print(f"\nWindow '{args.test_window}' resolved:")
        for k, v in res.items():
            print(f"  {k:<20}: {v}")
        print()
        return

    if args.list:
        list_schedules()
    elif args.schedule_id:
        run_single_schedule(args.schedule_id, args.as_of)
    elif args.run_all_active:
        run_all_active(args.as_of)
    else:
        list_schedules()
        parser.print_help()


if __name__ == "__main__":
    main()
