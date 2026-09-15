#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Universal Dynamic Report Scheduler Engine — Supernova Raporlama Sistemi.

Bu modül fabrikaya veya vardiyaya özgü DEĞİLDİR; finans, üretim, sunucu günlükleri,
satış veya enerji gibi HERHANGİ bir alan için zaman-göreceli (time-relative)
rapor pencerelerini dinamik olarak çözer ve şablonları periyodik çalıştırır.

Örn: 'yesterday' penceresi seçildiğinde:
  - 14 Eylül'de koşulduğunda: 13 Eylül 00:00:00 - 13 Eylül 23:59:59 verisini çeker.
  - 15 Eylül'de koşulduğunda: 14 Eylül 00:00:00 - 14 Eylül 23:59:59 verisini çeker.
"""
from __future__ import annotations

import io
import os
import re
import sys
import json
import time
import uuid
import logging
from datetime import datetime, timedelta, date
from typing import Any, Dict, List, Optional, Tuple

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_BACKEND_DIR)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from db.database import get_db
from query_executor import execute_query, QueryExecutionError
from excel_template_engine import ExcelTemplateEngine
from pdf_template_renderer import render_template_to_pdf

logger = logging.getLogger(__name__)

# Çıktı raporlarının saklandığı dizin
EXPORTS_DIR = os.path.join(_REPO_ROOT, "data_exports", "scheduled_reports")
os.makedirs(EXPORTS_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# 1. Dinamik Zaman Penceresi Çözümleyici (Time Window Resolver)
# ---------------------------------------------------------------------------

def resolve_time_window(
    window_type: str,
    ref_dt: Optional[datetime] = None,
    custom_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Belirtilen pencere tipine göre dinamik zaman aralığını hesaplar.
    
    Returns:
        {
            'start_time': 'YYYY-MM-DD HH:MM:SS',
            'end_time':   'YYYY-MM-DD HH:MM:SS',
            'start_date': 'YYYY-MM-DD',
            'end_date':   'YYYY-MM-DD',
            'start_iso':  'YYYY-MM-DDTHH:MM:SS',
            'end_iso':    'YYYY-MM-DDTHH:MM:SS',
            'report_date': 'YYYY-MM-DD',
            'reference_date': 'YYYY-MM-DD HH:MM:SS',
            'execution_timestamp': 'YYYY-MM-DD HH:MM:SS',
            'period_label': str
        }
    """
    ref_dt = ref_dt or datetime.now()
    custom_config = custom_config or {}
    wtype = (window_type or "yesterday").lower().strip()

    if wtype == "yesterday":
        target = ref_dt.date() - timedelta(days=1)
        start = datetime(target.year, target.month, target.day, 0, 0, 0)
        end = datetime(target.year, target.month, target.day, 23, 59, 59)
        label = f"Yesterday ({target.strftime('%Y-%m-%d')})"

    elif wtype == "today":
        target = ref_dt.date()
        start = datetime(target.year, target.month, target.day, 0, 0, 0)
        end = datetime(target.year, target.month, target.day, 23, 59, 59)
        label = f"Today ({target.strftime('%Y-%m-%d')})"

    elif wtype == "last_24h":
        end = ref_dt
        start = ref_dt - timedelta(hours=24)
        label = f"Last 24 Hours ({start.strftime('%Y-%m-%d %H:%M')} - {end.strftime('%Y-%m-%d %H:%M')})"

    elif wtype == "last_7d":
        end_date = ref_dt.date() - timedelta(days=1)
        start_date = end_date - timedelta(days=6)
        start = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0)
        end = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59)
        label = f"Last 7 Days ({start_date} to {end_date})"

    elif wtype == "last_30d":
        end_date = ref_dt.date() - timedelta(days=1)
        start_date = end_date - timedelta(days=29)
        start = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0)
        end = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59)
        label = f"Last 30 Days ({start_date} to {end_date})"

    elif wtype == "this_week":
        start_date = ref_dt.date() - timedelta(days=ref_dt.weekday())
        start = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0)
        end = ref_dt
        label = f"This Week ({start_date} to {ref_dt.date()})"

    elif wtype == "last_week":
        this_monday = ref_dt.date() - timedelta(days=ref_dt.weekday())
        last_monday = this_monday - timedelta(days=7)
        last_sunday = this_monday - timedelta(days=1)
        start = datetime(last_monday.year, last_monday.month, last_monday.day, 0, 0, 0)
        end = datetime(last_sunday.year, last_sunday.month, last_sunday.day, 23, 59, 59)
        label = f"Last Week ({last_monday} to {last_sunday})"

    elif wtype == "this_month":
        start = datetime(ref_dt.year, ref_dt.month, 1, 0, 0, 0)
        end = ref_dt
        label = f"This Month ({start.strftime('%Y-%m')} to date)"

    elif wtype == "last_month":
        first_this_month = date(ref_dt.year, ref_dt.month, 1)
        last_day_prev = first_this_month - timedelta(days=1)
        first_day_prev = date(last_day_prev.year, last_day_prev.month, 1)
        start = datetime(first_day_prev.year, first_day_prev.month, 1, 0, 0, 0)
        end = datetime(last_day_prev.year, last_day_prev.month, last_day_prev.day, 23, 59, 59)
        label = f"Last Month ({first_day_prev.strftime('%Y-%m')})"

    elif wtype == "custom":
        off_d = int(custom_config.get("offset_days", 0))
        dur_d = max(1, int(custom_config.get("duration_days", 1)))
        s_date = ref_dt.date() + timedelta(days=off_d)
        e_date = s_date + timedelta(days=dur_d - 1)
        start = datetime(s_date.year, s_date.month, s_date.day, 0, 0, 0)
        end = datetime(e_date.year, e_date.month, e_date.day, 23, 59, 59)
        label = f"Custom Window ({s_date} to {e_date})"

    else:
        # Bilinmeyen modda güvenli varsayılan: yesterday
        return resolve_time_window("yesterday", ref_dt, custom_config)

    return {
        "start_time": start.strftime("%Y-%m-%d %H:%M:%S"),
        "end_time": end.strftime("%Y-%m-%d %H:%M:%S"),
        "start_date": start.strftime("%Y-%m-%d"),
        "end_date": end.strftime("%Y-%m-%d"),
        "start_iso": start.isoformat(),
        "end_iso": end.isoformat(),
        "report_date": ref_dt.strftime("%Y-%m-%d"),
        "reference_date": ref_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "execution_timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "period_label": label,
    }


# ---------------------------------------------------------------------------
# 2. Zamanlanmış Rapor Çalıştırıcısı (Report Schedule Runner)
# ---------------------------------------------------------------------------

_engine = ExcelTemplateEngine()


def execute_schedule_run(
    schedule_id: str,
    reference_date_str: Optional[str] = None,
    executed_by: str = "scheduler",
) -> Dict[str, Any]:
    """
    Kayıtlı bir zamanlayıcı kuralını çalıştırır, dinamik parametreleri çözer,
    şablonu render eder, dosyayı diske kaydeder ve çalıştırma logunu veritabanına yazar.
    """
    db = get_db()
    started_at = time.time()

    # 1. Schedule kaydını yükle
    with db._conn() as conn:
        sched_row = conn.execute("SELECT * FROM report_schedules WHERE id=?", (schedule_id,)).fetchone()
    if not sched_row:
        raise ValueError(f"Schedule with id '{schedule_id}' not found.")

    schedule = dict(sched_row)
    template_id = schedule["template_id"]

    # 2. Template kaydını yükle
    with db._conn() as conn:
        tpl_row = conn.execute("SELECT * FROM report_templates WHERE id=?", (template_id,)).fetchone()
    if not tpl_row:
        raise ValueError(f"Template with id '{template_id}' associated with schedule not found.")

    tpl_dict = dict(tpl_row)
    model = json.loads(tpl_dict.get("model") or "{}")

    # 3. Referans tarihini belirle
    ref_dt = datetime.now()
    if reference_date_str:
        s = reference_date_str.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
            try:
                ref_dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                pass

    # 4. Dinamik parametreleri çöz
    custom_cfg = json.loads(schedule.get("custom_window_config") or "{}")
    window_type = schedule.get("window_type") or "yesterday"
    resolved_time = resolve_time_window(window_type, ref_dt, custom_cfg)

    # Ek override parametreleri birleştir
    params_override = json.loads(schedule.get("params_override") or "{}")
    combined_params = {**resolved_time, **params_override}

    # 5. Şablonda başvurulan sorguları topla ve çalıştır
    query_ids = set()
    for sheet in model.get("sheets", []):
        for cell in (sheet.get("cells") or {}).values():
            b = cell.get("binding") or {}
            if b.get("queryId"):
                query_ids.add(b["queryId"])
        for band in (sheet.get("bands") or []):
            if band.get("queryId"):
                query_ids.add(band["queryId"])
        for chart in (sheet.get("charts") or []):
            if chart.get("queryId"):
                query_ids.add(chart["queryId"])

    sql_ids = {qid for qid in query_ids if not qid.startswith("py:")}
    query_results = {}

    run_id = f"run_{uuid.uuid4().hex[:12]}"

    # İlk olarak 'running' durumunu kaydet
    with db._conn() as conn:
        conn.execute(
            """INSERT INTO report_schedule_runs
               (id, schedule_id, template_id, reference_date, window_type, start_time, end_time,
                resolved_params, output_format, status, executed_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)""",
            (
                run_id,
                schedule_id,
                template_id,
                resolved_time["reference_date"],
                window_type,
                resolved_time["start_time"],
                resolved_time["end_time"],
                json.dumps(combined_params, ensure_ascii=False),
                schedule.get("output_format") or "xlsx",
                executed_by,
            ),
        )

    try:
        # Sorguları çalıştır
        with db._conn() as conn:
            for qid in sql_ids:
                q_row = conn.execute("SELECT * FROM queries WHERE id=?", (qid,)).fetchone()
                if not q_row:
                    query_results[qid] = {"columns": [], "rows": []}
                    continue
                q = dict(q_row)
                ds_row = conn.execute("SELECT * FROM data_sources WHERE id=?", (q["data_source_id"],)).fetchone()
                if not ds_row:
                    query_results[qid] = {"columns": [], "rows": []}
                    continue
                ds = dict(ds_row)
                # execute_query'ye çözümlenen parametreleri aktar
                res = execute_query(ds, q["sql_text"], combined_params, 10000)
                query_results[qid] = res

        # 6. Rapor çıktısını render et
        out_bytes = _engine.render_from_model(model, query_results)
        output_format = (schedule.get("output_format") or "xlsx").lower()

        clean_name = re.sub(r"[^\w\-]", "_", schedule["name"])
        safe_date = resolved_time["start_date"]

        if output_format == "pdf":
            file_bytes = render_template_to_pdf(
                model, query_results, excel_bytes=out_bytes, report_title=f"{schedule['name']} - {resolved_time['period_label']}"
            )
            file_ext = "pdf"
        else:
            file_bytes = out_bytes
            file_ext = "xlsx"

        file_name = f"{clean_name}_{safe_date}_{run_id}.{file_ext}"
        file_path = os.path.join(EXPORTS_DIR, file_name)

        with open(file_path, "wb") as f:
            f.write(file_bytes)

        duration_ms = int((time.time() - started_at) * 1000)
        file_size = len(file_bytes)

        # 7. Başarılı durumu veritabanına kaydet
        with db._conn() as conn:
            conn.execute(
                """UPDATE report_schedule_runs
                   SET status='success', output_file_path=?, output_file_size=?,
                       duration_ms=?, error_message=''
                   WHERE id=?""",
                (file_path, file_size, duration_ms, run_id),
            )
            conn.execute(
                """UPDATE report_schedules
                   SET last_run_at=datetime('now'), last_run_status='success',
                       updated_at=datetime('now')
                   WHERE id=?""",
                (schedule_id,),
            )

        logger.info(
            f"✅ Scheduled run {run_id} completed successfully for '{schedule['name']}' in {duration_ms}ms ({file_size} bytes)."
        )

        return {
            "success": True,
            "runId": run_id,
            "scheduleId": schedule_id,
            "scheduleName": schedule["name"],
            "templateId": template_id,
            "referenceDate": resolved_time["reference_date"],
            "periodLabel": resolved_time["period_label"],
            "startTime": resolved_time["start_time"],
            "endTime": resolved_time["end_time"],
            "outputFormat": output_format,
            "outputFilePath": file_path,
            "outputFileName": file_name,
            "fileSizeBytes": file_size,
            "durationMs": duration_ms,
            "status": "success",
        }

    except Exception as exc:
        duration_ms = int((time.time() - started_at) * 1000)
        err_msg = str(exc)
        logger.exception(f"❌ Scheduled run {run_id} failed: {err_msg}")

        with db._conn() as conn:
            conn.execute(
                """UPDATE report_schedule_runs
                   SET status='failed', duration_ms=?, error_message=?
                   WHERE id=?""",
                (duration_ms, err_msg, run_id),
            )
            conn.execute(
                """UPDATE report_schedules
                   SET last_run_at=datetime('now'), last_run_status='failed',
                       updated_at=datetime('now')
                   WHERE id=?""",
                (schedule_id,),
            )

        return {
            "success": False,
            "runId": run_id,
            "scheduleId": schedule_id,
            "status": "failed",
            "error": err_msg,
            "durationMs": duration_ms,
        }
