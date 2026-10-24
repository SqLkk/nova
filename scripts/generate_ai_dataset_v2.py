#!/usr/bin/env python3
"""Generate diverse, verified SuperNova v2 instruction dataset (3,000 examples).

Categories (3,000 total):
- 1,000 Python:
    250 basic sandbox tasks (filter, group, aggregations, transform)
    300 weighted ratio, quality, OEE components & unit conversions
    300 multi-query key-based merging (production + scrap, target vs actual)
    150 faulty script corrections (unbound variable, division by zero, dict get)
- 500 SQL: JOIN, date/range parameters, NULL / COALESCE, missing event handling
- 400 Path: tree, binary_tree, sequence, grouped, multi-parent DAG
- 400 Template: line/bar/pie/area charts + SUM/AVG/COUNT summary cells
- 250 Forbidden operations: short explanation + safe alternative, ZERO forbidden code
- 250 Missing information: asks for required columns, ZERO hallucinated code
- 200 Schema / Tool calling:
    100 ending with assistant tool_call (triggering tool_get_database_schema)
    100 ending with final assistant response after tool response

Strict Validation:
- Python: validate_python + SafeASTInterpreter on normal, NULL, empty [], zero denominator
- SQL: SQLite execution with parameters, checking returned rows
- Path: validate_path + build_structure validation
- Template: validate_template + schema check
- Refusal / Missing info: assert no executable code blocks
"""
import argparse
import ast
from contextlib import closing
import hashlib
import json
from pathlib import Path
import random
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'supernova-backend'))

from ai_prompts import BASE_PROMPT, PYTHON_PROMPT, SQL_PROMPT, PATH_PROMPT, TEMPLATE_PROMPT
from ai_service import TOOL_DEFINITIONS
from ai_tools import validate_python, validate_path, validate_template
from path_engine import build_structure
from safe_interpreter.interpreter import SafeASTInterpreter, OutHelper, _safe_builtins

AREAS = [
    'Assembly', 'Stamping', 'Welding', 'Painting', 'Packaging',
    'Machining', 'Casting', 'Extrusion', 'Inspection', 'Logistics',
    'Boiler', 'Compressor', 'Chiller', 'Transformer', 'HVAC'
]


# ==============================================================================
# 1. PYTHON GENERATORS (1,000 Total)
# ==============================================================================

def gen_python_basic(i, rng):
    area = AREAS[i % len(AREAS)]
    qid = f"q_{area.lower()}_{i:03d}"
    field = f"val_{i % 13}"
    op_type = i % 5

    if op_type == 0:
        # Sum
        user = f"Kayıtlı sorgu '{qid}', kolonlar: machine_id, {field}. '{qid}' içindeki {field} değerlerinin toplamını hesaplayan sandbox scripti yaz. Boş ve NULL satırları yönet."
        code = f"rows = sql_data.get('{qid}', [])\ntotal = 0\nfor row in rows:\n    total = total + (row.get('{field}', 0) or 0)\nout('summary').append({{'total': total}})"
        target_ds = 'summary'
    elif op_type == 1:
        # Count & Average
        user = f"Kayıtlı sorgu '{qid}', kolonlar: sensor_id, {field}. {field} için ortalama ve geçerli kayıt adedini hesapla. Boş veri gelirse ortalamayı 0 dön."
        code = f"rows = sql_data.get('{qid}', [])\ntotal = 0\ncount = 0\nfor row in rows:\n    val = row.get('{field}')\n    if val != None:\n        total = total + val\n        count = count + 1\navg = 0\nif count > 0:\n    avg = total / count\nout('metrics').append({{'average': avg, 'count': count}})"
        target_ds = 'metrics'
    elif op_type == 2:
        # Grouped sum
        user = f"Kayıtlı sorgu '{qid}', kolonlar: line_code, {field}. line_code bazında {field} toplamını hesapla. NULL değerleri 0 say."
        code = f"rows = sql_data.get('{qid}', [])\ngroups = {{}}\nfor row in rows:\n    k = row.get('line_code', 'unknown')\n    groups[k] = groups.get(k, 0) + (row.get('{field}', 0) or 0)\nfor k, total in groups.items():\n    out('grouped').append({{'line_code': k, 'total': total}})"
        target_ds = 'grouped'
    elif op_type == 3:
        # Threshold filter
        thresh = (i * 7) % 50 + 10
        user = f"Kayıtlı sorgu '{qid}', kolonlar: part_no, {field}. {field} değeri {thresh} üzerinde olan kayıtları 'filtered' tablosuna aktar."
        code = f"rows = sql_data.get('{qid}', [])\nfor row in rows:\n    val = row.get('{field}', 0) or 0\n    if val > {thresh}:\n        out('filtered').append({{'part_no': row.get('part_no'), 'value': val}})"
        target_ds = 'filtered'
    else:
        # Min and Max
        user = f"Kayıtlı sorgu '{qid}', kolonlar: station_id, {field}. {field} için minimum ve maksimum değerleri bul. Liste boşsa min=0, max=0 üret."
        code = f"rows = sql_data.get('{qid}', [])\nmin_v = None\nmax_v = None\nfor row in rows:\n    val = row.get('{field}')\n    if val != None:\n        if min_v == None or val < min_v:\n            min_v = val\n        if max_v == None or val > max_v:\n            max_v = val\nout('min_max').append({{'min': min_v or 0, 'max': max_v or 0}})"
        target_ds = 'min_max'

    # Verify code
    validate_python(code)
    for test_rows in [
        [{field: 100, 'machine_id': 'M1', 'sensor_id': 'S1', 'line_code': 'L1', 'station_id': 'ST1', 'part_no': 'P1'},
         {field: 15, 'machine_id': 'M2', 'sensor_id': 'S2', 'line_code': 'L1', 'station_id': 'ST2', 'part_no': 'P2'},
         {field: None, 'machine_id': 'M1', 'sensor_id': 'S1', 'line_code': 'L2', 'station_id': 'ST1', 'part_no': 'P3'}],
        []
    ]:
        out_h = OutHelper()
        SafeASTInterpreter(_safe_builtins(out_h), {'sql_data': {qid: test_rows}}).evaluate(ast.parse(code))
        res = out_h.get_results()
        if len(test_rows) > 0 and op_type != 3:
            assert target_ds in res

    return (
        BASE_PROMPT + PYTHON_PROMPT,
        user,
        f"```python\n{code}\n```"
    )


def gen_python_weighted(i, rng):
    area = AREAS[i % len(AREAS)]
    qid = f"q_{area.lower()}_perf_{i:03d}"
    mode = i % 3

    if mode == 0:
        # Weighted quality percentage
        user = f"Kayıtlı sorgu '{qid}', kolonlar: good_parts, total_produced. Genel ağırlıklı kalite oranını (toplam sağlam / toplam üretim * 100) hesaplayan script yaz. Satır yüzdelerinin aritmetik ortalamasını alma, sıfır veya boş veri gelirse %0 dön."
        code = f"rows = sql_data.get('{qid}', [])\ntotal_good = 0\ntotal_all = 0\nfor row in rows:\n    total_good = total_good + (row.get('good_parts', 0) or 0)\n    total_all = total_all + (row.get('total_produced', 0) or 0)\nrate = 0.0\nif total_all > 0:\n    rate = (total_good / total_all) * 100.0\nout('quality').append({{'quality_rate': rate, 'total_good': total_good, 'total_produced': total_all}})"
        fixture = [{'good_parts': 80, 'total_produced': 100}, {'good_parts': 10, 'total_produced': 20}] # 90/120 = 75%
        expected_val = 75.0
        val_key = 'quality_rate'
    elif mode == 1:
        # Energy specific consumption (kWh / ton)
        user = f"Kayıtlı sorgu '{qid}', kolonlar: total_kwh, tonnage. Toplam ağırlıklı enerji yoğunluğunu (toplam kWh / toplam tonaj) hesapla. Tonaj 0 ise yoğunluğu 0 dön."
        code = f"rows = sql_data.get('{qid}', [])\nsum_kwh = 0.0\nsum_tons = 0.0\nfor row in rows:\n    sum_kwh = sum_kwh + (row.get('total_kwh', 0.0) or 0.0)\n    sum_tons = sum_tons + (row.get('tonnage', 0.0) or 0.0)\nintensity = 0.0\nif sum_tons > 0:\n    intensity = sum_kwh / sum_tons\nout('intensity').append({{'kwh_per_ton': intensity}})"
        fixture = [{'total_kwh': 500.0, 'tonnage': 10.0}, {'total_kwh': 300.0, 'tonnage': 30.0}] # 800/40 = 20.0
        expected_val = 20.0
        val_key = 'kwh_per_ton'
    else:
        # Availability / OEE component
        user = f"Kayıtlı sorgu '{qid}', kolonlar: operating_min, planned_min. Toplam kullanılabilirlik oranını (operating_min / planned_min * 100) hesaplayan sandbox scripti yaz. Sıfır paydada 0.0 dön."
        code = f"rows = sql_data.get('{qid}', [])\nsum_op = 0.0\nsum_plan = 0.0\nfor row in rows:\n    sum_op = sum_op + (row.get('operating_min', 0.0) or 0.0)\n    sum_plan = sum_plan + (row.get('planned_min', 0.0) or 0.0)\navailability = 0.0\nif sum_plan > 0:\n    availability = (sum_op / sum_plan) * 100.0\nout('oee_availability').append({{'availability': availability}})"
        fixture = [{'operating_min': 400.0, 'planned_min': 450.0}, {'operating_min': 50.0, 'planned_min': 50.0}] # 450/500 = 90.0
        expected_val = 90.0
        val_key = 'availability'

    validate_python(code)
    for test_rows in [fixture, [{'good_parts': 0, 'total_produced': 0, 'total_kwh': 0, 'tonnage': 0, 'operating_min': 0, 'planned_min': 0}], []]:
        out_h = OutHelper()
        SafeASTInterpreter(_safe_builtins(out_h), {'sql_data': {qid: test_rows}}).evaluate(ast.parse(code))
        res = out_h.get_results()
        if test_rows == fixture:
            ds_val = list(res.values())[0][0][val_key]
            assert abs(ds_val - expected_val) < 0.01

    return (
        BASE_PROMPT + PYTHON_PROMPT,
        user,
        f"```python\n{code}\n```"
    )


def gen_python_merge(i, rng):
    area = AREAS[i % len(AREAS)]
    q1 = f"q_{area.lower()}_primary_{i:03d}"
    q2 = f"q_{area.lower()}_secondary_{i:03d}"
    mode = i % 2

    if mode == 0:
        # Production and Defects/Scrap
        user = f"Kayıtlı iki sorgu: '{q1}' (kolonlar: unit_id, total_qty) ve '{q2}' (kolonlar: unit_id, reject_qty). unit_id bazında net sağlam üretimi (total_qty - reject_qty) hesaplayan script yaz. İkinci tabloda eşleşmeyen birim için fireyi 0 kabul et."
        code = (
            f"prod_rows = sql_data.get('{q1}', [])\n"
            f"scrap_rows = sql_data.get('{q2}', [])\n"
            f"scraps = {{}}\n"
            f"for s in scrap_rows:\n"
            f"    uid = s.get('unit_id')\n"
            f"    if uid != None:\n"
            f"        scraps[uid] = scraps.get(uid, 0) + (s.get('reject_qty', 0) or 0)\n"
            f"for p in prod_rows:\n"
            f"    uid = p.get('unit_id')\n"
            f"    if uid != None:\n"
            f"        produced = p.get('total_qty', 0) or 0\n"
            f"        rejected = scraps.get(uid, 0)\n"
            f"        net = produced - rejected\n"
            f"        out('net_production').append({{'unit_id': uid, 'net_qty': net, 'produced': produced, 'rejected': rejected}})"
        )
    else:
        # Target vs Actual
        user = f"Kayıtlı iki sorgu: '{q1}' (kolonlar: line, target) ve '{q2}' (kolonlar: line, actual). Her hat (line) için hedef gerçekleştirme farkını (actual - target) hesaplayan sandbox scripti yaz."
        code = (
            f"target_rows = sql_data.get('{q1}', [])\n"
            f"actual_rows = sql_data.get('{q2}', [])\n"
            f"targets = {{}}\n"
            f"for t in target_rows:\n"
            f"    ln = t.get('line')\n"
            f"    if ln != None:\n"
            f"        targets[ln] = t.get('target', 0) or 0\n"
            f"for a in actual_rows:\n"
            f"    ln = a.get('line')\n"
            f"    if ln != None:\n"
            f"        tgt = targets.get(ln, 0)\n"
            f"        act = a.get('actual', 0) or 0\n"
            f"        out('comparison').append({{'line': ln, 'diff': act - tgt, 'actual': act, 'target': tgt}})"
        )

    validate_python(code)
    test_q1 = [{'unit_id': 'U1', 'total_qty': 100, 'line': 'L1', 'target': 80}, {'unit_id': 'U2', 'total_qty': 50, 'line': 'L2', 'target': 40}]
    test_q2 = [{'unit_id': 'U1', 'reject_qty': 10, 'line': 'L1', 'actual': 85}]
    out_h = OutHelper()
    SafeASTInterpreter(_safe_builtins(out_h), {'sql_data': {q1: test_q1, q2: test_q2}}).evaluate(ast.parse(code))
    res = out_h.get_results()
    assert len(res) > 0

    return (
        BASE_PROMPT + PYTHON_PROMPT,
        user,
        f"```python\n{code}\n```"
    )


def gen_python_faulty_fix(i, rng):
    area = AREAS[i % len(AREAS)]
    qid = f"q_{area.lower()}_fix_{i:03d}"
    err_type = i % 3

    if err_type == 0:
        # Fixing ZeroDivisionError
        user = f"Şu script boş veya sıfır toplamda ZeroDivisionError veriyor:\n```python\nrows = sql_data.get('{qid}', [])\ntotal = sum([r['val'] for r in rows])\navg = total / len(rows)\nout('res').append({{'avg': avg}})\n```\nSuperNova sandbox kurallarına uygun, sıfır bölme korumalı ve döngü kullanan çalışan versiyonunu yaz."
        code = f"rows = sql_data.get('{qid}', [])\ntotal = 0\ncount = 0\nfor row in rows:\n    total = total + (row.get('val', 0) or 0)\n    count = count + 1\navg = 0\nif count > 0:\n    avg = total / count\nout('res').append({{'avg': avg}})"
    elif err_type == 1:
        # Fixing UnboundLocalError / missing get
        user = f"Şu script boş liste gelirse UnboundLocalError veriyor ve sözlük yerine int kullanılmış:\n```python\ntotals = 0\nfor row in sql_data.get('{qid}', []):\n    cat = row.get('category')\n    totals[cat] = totals[cat] + row.get('val', 0)\nout('res').append({{'cat': cat, 'total': totals.get(cat, 0)}})\n```\nKodu hatasız, gruplu ve güvenli hale getir."
        code = f"rows = sql_data.get('{qid}', [])\ntotals = {{}}\nfor row in rows:\n    cat = row.get('category', 'unknown')\n    totals[cat] = totals.get(cat, 0) + (row.get('val', 0) or 0)\nfor cat, total in totals.items():\n    out('res').append({{'category': cat, 'total': total}})"
    else:
        # Fixing list.get() / forbidden comprehension
        user = f"Şu kod listede .get() çağırıp çöküyor:\n```python\ndata = sql_data.get('{qid}', [])\nval = data.get('val')\nout('res').append({{'val': val}})\n```\nDoğru döngülü ve AST uyumlu halini yaz."
        code = f"rows = sql_data.get('{qid}', [])\nfor row in rows:\n    val = row.get('val', 0) or 0\n    out('res').append({{'val': val}})"

    validate_python(code)
    for test_data in [[{'val': 10, 'category': 'C1'}], []]:
        out_h = OutHelper()
        SafeASTInterpreter(_safe_builtins(out_h), {'sql_data': {qid: test_data}}).evaluate(ast.parse(code))

    return (
        BASE_PROMPT + PYTHON_PROMPT,
        user,
        f"```python\n{code}\n```"
    )


# ==============================================================================
# 2. SQL GENERATORS (500 Total)
# ==============================================================================

def gen_sql_query(i, rng):
    area = AREAS[i % len(AREAS)]
    tbl_main = f"{area.lower()}_units_{i:03d}"
    tbl_events = f"{area.lower()}_logs_{i:03d}"
    variant = i % 4

    if variant == 0:
        # LEFT JOIN with date range parameters and zero coalesce
        user = f"SQLite şeması: {tbl_main}(id TEXT, name TEXT), {tbl_events}(unit_id TEXT, log_time TEXT, duration REAL). :start_date ve :end_date aralığında birim bazında toplam duration süresini topla. Olayı olmayan birimler de duration=0 olarak listelenmelidir."
        sql = (
            f"SELECT\n"
            f"  m.id AS unit_id,\n"
            f"  m.name AS unit_name,\n"
            f"  COALESCE(SUM(e.duration), 0.0) AS total_duration\n"
            f"FROM {tbl_main} AS m\n"
            f"LEFT JOIN {tbl_events} AS e ON m.id = e.unit_id\n"
            f"  AND e.log_time BETWEEN :start_date AND :end_date\n"
            f"GROUP BY m.id, m.name"
        )
        params = {'start_date': '2026-01-01', 'end_date': '2026-01-31'}
    elif variant == 1:
        # Threshold filter with parameter
        user = f"SQLite tablosu {tbl_main}(id TEXT, category TEXT, score REAL). :min_score parametresinden yüksek puana sahip kayıtları kategoriye göre azalan puanda sıralayan salt okunur SQL yaz."
        sql = f"SELECT id, category, score FROM {tbl_main} WHERE score > :min_score ORDER BY score DESC"
        params = {'min_score': 50.0}
    elif variant == 2:
        # Category aggregation with MIN, MAX, AVG
        user = f"SQLite tablosu {tbl_main}(category TEXT, metric REAL). Kategori bazında ortalama, en küçük ve en büyük metric değerini hesaplayan salt okunur SQL yaz."
        sql = f"SELECT category, AVG(metric) AS avg_metric, MIN(metric) AS min_metric, MAX(metric) AS max_metric FROM {tbl_main} GROUP BY category"
        params = {}
    else:
        # INNER JOIN on active items
        user = f"SQLite şeması: {tbl_main}(id TEXT, name TEXT, is_active INTEGER), {tbl_events}(unit_id TEXT, alarm_code TEXT). Sadece is_active = 1 olan birimlerin alarmlarını eşleştirerek birim adı ve alarm kodunu getir."
        sql = f"SELECT m.name, e.alarm_code FROM {tbl_main} AS m JOIN {tbl_events} AS e ON m.id = e.unit_id WHERE m.is_active = 1"
        params = {}

    # Verify SQL on memory SQLite
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute(f"CREATE TABLE {tbl_main} (id TEXT, name TEXT, category TEXT, score REAL, metric REAL, is_active INTEGER)")
        conn.execute(f"CREATE TABLE {tbl_events} (unit_id TEXT, log_time TEXT, duration REAL, alarm_code TEXT)")
        conn.execute(f"INSERT INTO {tbl_main} VALUES ('u1', 'Unit 1', 'CatA', 75.0, 10.0, 1)")
        conn.execute(f"INSERT INTO {tbl_main} VALUES ('u2', 'Unit 2', 'CatB', 25.0, 20.0, 0)")
        conn.execute(f"INSERT INTO {tbl_events} VALUES ('u1', '2026-01-15', 30.0, 'ALM_01')")
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()
        assert len(rows) > 0

    return (
        BASE_PROMPT + SQL_PROMPT,
        user,
        f"```sql\n{sql}\n```"
    )


# ==============================================================================
# 3. PATH ENGINE GENERATORS (400 Total)
# ==============================================================================

def gen_path_structure(i, rng):
    area = AREAS[i % len(AREAS)]
    qid = f"q_{area.lower()}_tree_{i:03d}"
    struct_type = ['tree', 'binary_tree', 'sequence', 'grouped', 'dag'][i % 5]

    if struct_type == 'dag':
        # Multi-parent DAG with dependencies
        cols = ['task_id', 'dependencies', 'title']
        config = {'id_col': 'task_id', 'parent_col': 'dependencies', 'label_col': 'title'}
        user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(cols)}. Çoklu ebeveynli (multi-parent) dag yapısı için Path Definer JSON üret. dependencies kolonu virgülle ayrılmış üst görev anahtarlarını taşır."
        test_rows = [
            {'task_id': 'T1', 'dependencies': '', 'title': 'Task 1'},
            {'task_id': 'T2', 'dependencies': '', 'title': 'Task 2'},
            {'task_id': 'T3', 'dependencies': 'T1,T2', 'title': 'Task 3'}
        ]
    elif struct_type == 'sequence':
        cols = ['step_id', 'step_order', 'step_name']
        config = {'id_col': 'step_id', 'order_col': 'step_order', 'label_col': 'step_name'}
        user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(cols)}. Sıralı akış (sequence) için Path Definer JSON üret. Sıralama step_order kolonuna göredir."
        test_rows = [
            {'step_id': 'S1', 'step_order': 1, 'step_name': 'Step 1'},
            {'step_id': 'S2', 'step_order': 2, 'step_name': 'Step 2'}
        ]
    elif struct_type == 'grouped':
        cols = ['item_id', 'cell_group', 'item_name']
        config = {'group_col': 'cell_group', 'label_col': 'item_name', 'id_col': 'item_id'}
        user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(cols)}. cell_group bazında gruplanmış (grouped) Path Definer JSON üret."
        test_rows = [
            {'item_id': 'I1', 'cell_group': 'G1', 'item_name': 'Item 1'},
            {'item_id': 'I2', 'cell_group': 'G1', 'item_name': 'Item 2'}
        ]
    elif struct_type == 'binary_tree':
        cols = ['node_id', 'parent_node', 'display_name']
        config = {'id_col': 'node_id', 'parent_col': 'parent_node', 'label_col': 'display_name'}
        user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(cols)}. binary_tree yapısı için Path Definer JSON üret."
        test_rows = [
            {'node_id': 'R', 'parent_node': '', 'display_name': 'Root'},
            {'node_id': 'L1', 'parent_node': 'R', 'display_name': 'Left'}
        ]
    else:
        # Tree
        cols = ['asset_code', 'parent_code', 'asset_desc']
        config = {'id_col': 'asset_code', 'parent_col': 'parent_code', 'label_col': 'asset_desc'}
        user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(cols)}. Standart hiyerarşik tree yapısı için Path Definer JSON üret."
        test_rows = [
            {'asset_code': 'A1', 'parent_code': '', 'asset_desc': 'Plant'},
            {'asset_code': 'A2', 'parent_code': 'A1', 'asset_desc': 'Line'}
        ]

    artifact = {'structure': struct_type, 'queryId': qid, 'config': config}
    validate_path(artifact, [{'id': qid, 'columns': cols}])
    built = build_structure(struct_type, test_rows, config)
    assert built['stats']['node_count'] > 0

    return (
        BASE_PROMPT + PATH_PROMPT,
        user,
        f"```json\n{json.dumps(artifact, ensure_ascii=False, indent=2)}\n```"
    )


# ==============================================================================
# 4. TEMPLATE BUILDER GENERATORS (400 Total)
# ==============================================================================

def gen_template_fragment(i, rng):
    area = AREAS[i % len(AREAS)]
    qid = f"q_{area.lower()}_tpl_{i:03d}"
    cols = ['ts', 'sensor_val', 'status']
    row, col = (i % 20) + 1, (i % 5) + 1
    chart_type = ['line', 'bar', 'pie', 'area'][i % 4]
    agg_op = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT'][i % 5]

    artifact = {
        'charts': [
            {
                'id': f'ch_{i:03d}',
                'type': chart_type,
                'anchor': {'row': row, 'col': col, 'widthCols': 6, 'heightRows': 10},
                'queryId': qid,
                'xAxis': 'ts',
                'yAxis': ['sensor_val'],
                'title': f'{area} {chart_type.capitalize()}'
            }
        ],
        'cells': [
            {
                'row': row + 11,
                'col': col,
                'value': '',
                'binding': {
                    'kind': 'summary',
                    'queryId': qid,
                    'field': 'sensor_val',
                    'operation': agg_op
                }
            }
        ]
    }

    validate_template(artifact, [{'id': qid, 'columns': cols}])
    user = f"Sorgu ID: {qid}, kolonlar: {', '.join(cols)}. ({row}, {col}) hücresinde ts ve sensor_val kullanan {chart_type} grafiği ve ({row + 11}, {col}) hücresinde {agg_op}(sensor_val) özet hücresi içeren Template Builder JSON parçası üret."

    return (
        BASE_PROMPT + TEMPLATE_PROMPT,
        user,
        f"```json\n{json.dumps(artifact, ensure_ascii=False, indent=2)}\n```"
    )


# ==============================================================================
# 5. FORBIDDEN OPERATIONS / REFUSALS (250 Total)
# ==============================================================================

def gen_forbidden_refusal(i, rng):
    targets = [
        ("import os kullanarak sunucudaki /etc/passwd dosyasını oku.", "os modülü ve yerel dosya okuma"),
        ("import sys; sys.exit(0) ile Python sürecini durdur.", "sys modülü ve süreç sonlandırma"),
        ("open('/var/log/system.log', 'r') ile log dosyasını açıp ekrana yazdır.", "dosya okuma ve yazma işlemleri"),
        ("exec('import socket; s=socket.socket()') ile dış ağa bağlan.", "exec() ve socket ağ erişimi"),
        ("eval(\"__import__('subprocess').check_output('ls', shell=True)\") komutunu çalıştır.", "eval() ve alt süreç (subprocess) komutu"),
        ("pandas kütüphanesini import ederek DataFrame oluştur.", "pandas ve harici kütüphane importları"),
        ("eval('open(\"/etc/hosts\").read()') ile hostları oku.", "eval ve yerel dosya okuma")
    ]
    req, forbidden_desc = targets[i % len(targets)]
    user = f"{req} Sandbox içinde çalıştır."

    assistant = (
        f"Bu işlem SuperNova Copilot güvenlik kuralları ve AST sandbox mimarisi gereği **desteklenmez ve çalıştırılamaz**.\n\n"
        f"**Neden?**\n"
        f"- SuperNova Python ortamı yalıtılmış bir Safe AST Interpreter kullanır.\n"
        f"- {forbidden_desc}, dosya sistemi, ağ ve kütüphane import işlemleri güvenlik sebebiyle kesinlikle yasaktır.\n\n"
        f"**İzin Verilen Güvenli Alternatif:**\n"
        f"- Yalnızca yetkilendirilmiş kayıtlı sorguların verileri `sql_data.get('SorguAdi', [])` ile okunabilir.\n"
        f"- Sonuçlar yalnızca `out('tablo_adi').append({{...}})` ile platform UI'ına aktarılabilir.\n"
        f"- Standart matematik ve tarih işlemleri için `math`, `datetime` ve yerel döngüler/koşullar kullanılabilir."
    )

    # Ensure no code block was accidentally included
    assert '```' not in assistant
    assert 'import os' not in assistant and 'import sys' not in assistant and 'open(' not in assistant

    return (
        BASE_PROMPT + PYTHON_PROMPT,
        user,
        assistant
    )


# ==============================================================================
# 6. MISSING INFORMATION / CLARIFICATION (250 Total)
# ==============================================================================

def gen_missing_info(i, rng):
    area = AREAS[i % len(AREAS)]
    qid = f"q_{area.lower()}_incomplete_{i:03d}"
    variant = i % 3

    if variant == 0:
        # Missing OEE data
        user = f"Kayıtlı sorgu '{qid}', kolonlar: machine_name, produced_count. Bu sorgudaki verilerle makinelerin OEE (Genel Ekipman Verimliliği) değerini hesaplayan Python kodu yaz."
        assistant = (
            f"'{qid}' sorgusundaki mevcut kolonlarla (`machine_name`, `produced_count`) tam bir OEE hesabı yapılamaz.\n\n"
            f"OEE hesaplayabilmek için şu eksik verilere ihtiyaç duyulmaktadır:\n"
            f"1. **Availability (Kullanılabilirlik):** Planlanan çalışma süresi ve duruş (downtime) süresi.\n"
            f"2. **Performance (Performans):** İdeal çevrim süresi (ideal cycle time) veya hedef üretim hızı.\n"
            f"3. **Quality (Kalite):** Sağlam ve hurda (scrap/defect) miktarı ayrımı.\n\n"
            f"Lütfen bu verileri içeren kolonları belirtin veya şemayı incelemek için `tool_get_database_schema` aracını kullanmamı isteyin."
        )
    elif variant == 1:
        # Missing MTBF/MTTR data
        user = f"Kayıtlı sorgu '{qid}', kolonlar: asset_id, error_count. Bu sorgudan MTTR (Ortalama Onarım Süresi) ve MTBF hesapla."
        assistant = (
            f"'{qid}' sorgusundaki mevcut kolonlar (`asset_id`, `error_count`) MTTR ve MTBF hesaplamak için yeterli değildir.\n\n"
            f"Gerekli eksik veriler:\n"
            f"- **MTTR için:** Arıza başlangıç ve bitiş zamanları veya toplam duruş onarım süresi.\n"
            f"- **MTBF için:** Toplam net çalışma süresi ve arıza olayları arasındaki süreler.\n\n"
            f"Bu kolonların bulunduğu bir sorgunuz varsa adını paylaşabilir misiniz?"
        )
    else:
        # Missing Energy Intensity denominator
        user = f"Kayıtlı sorgu '{qid}', kolonlar: energy_kwh. Spesifik enerji tüketimini (kWh / üretilen adet) hesapla."
        assistant = (
            f"'{qid}' sorgusunda yalnızca `energy_kwh` kolonu bulunmaktadır, üretilen adet/tonaj bilgisi yer almamaktadır.\n\n"
            f"Spesifik enerji tüketimini hesaplayabilmek için üretim miktarını içeren kolonun adını veya üretim verisinin bulunduğu ikinci bir kayıtlı sorguyu belirtmeniz gerekmektedir."
        )

    assert '```' not in assistant

    return (
        BASE_PROMPT + PYTHON_PROMPT,
        user,
        assistant
    )


# ==============================================================================
# 7. SCHEMA / TOOL CALLING (200 Total)
# ==============================================================================

def gen_tool_calling(i, rng):
    is_tool_call_endpoint = (i % 2 == 0)
    user = f"Veritabanındaki kayıtlı sorguları ve tabloları bilmiyorum. Erişimim olan şemayı getir."

    if is_tool_call_endpoint:
        # Assistant ends with tool_call
        msgs = [
            {'role': 'system', 'content': BASE_PROMPT},
            {'role': 'user', 'content': user},
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': f'call_{i:03d}', 'type': 'function', 'function': {'name': 'tool_get_database_schema', 'arguments': {}}}
            ]}
        ]
    else:
        # Assistant ends with final text response after tool return
        mock_schema = {
            'sources': [{
                'name': 'TelemetryDB',
                'tables': [
                    {'name': f'machines_{i % 5}', 'columns': ['id', 'status', 'speed']},
                    {'name': f'alerts_{i % 5}', 'columns': ['alert_id', 'machine_id', 'level']}
                ]
            }]
        }
        tbl_name = f'machines_{i % 5}'
        msgs = [
            {'role': 'system', 'content': BASE_PROMPT},
            {'role': 'user', 'content': user},
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': f'call_{i:03d}', 'type': 'function', 'function': {'name': 'tool_get_database_schema', 'arguments': {}}}
            ]},
            {'role': 'tool', 'tool_call_id': f'call_{i:03d}', 'name': 'tool_get_database_schema', 'content': json.dumps(mock_schema)},
            {'role': 'assistant', 'content': f"Veritabanı şemasını inceledim. `TelemetryDB` kaynağında şu tablolar yer almaktadır:\n\n- **{tbl_name}:** Kolonlar: `id`, `status`, `speed`\n- **alerts_{i % 5}:** Kolonlar: `alert_id`, `machine_id`, `level`\n\nBu tablolardan birini sorgulamak veya Python sandbox'ında analiz etmek isterseniz yardımcı olabilirim."}
        ]

    return msgs


# ==============================================================================
# MAIN GENERATOR & SPLITTER
# ==============================================================================

def generate_v2_dataset(output_dir: Path, seed: int = 42):
    rng = random.Random(seed)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Generating 3,000 verified SuperNova v2 examples...")
    dataset = []

    # 1. Python (1,000)
    print(" - Generating 1,000 Python examples...")
    for i in range(250):
        prompt, user, asst = gen_python_basic(i, rng)
        dataset.append({'cat': 'py_basic', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})
    for i in range(300):
        prompt, user, asst = gen_python_weighted(i, rng)
        dataset.append({'cat': 'py_weighted', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})
    for i in range(300):
        prompt, user, asst = gen_python_merge(i, rng)
        dataset.append({'cat': 'py_merge', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})
    for i in range(150):
        prompt, user, asst = gen_python_faulty_fix(i, rng)
        dataset.append({'cat': 'py_fix', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})

    # 2. SQL (500)
    print(" - Generating 500 SQL examples...")
    for i in range(500):
        prompt, user, asst = gen_sql_query(i, rng)
        dataset.append({'cat': 'sql', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})

    # 3. Path (400)
    print(" - Generating 400 Path examples...")
    for i in range(400):
        prompt, user, asst = gen_path_structure(i, rng)
        dataset.append({'cat': 'path', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})

    # 4. Template (400)
    print(" - Generating 400 Template examples...")
    for i in range(400):
        prompt, user, asst = gen_template_fragment(i, rng)
        dataset.append({'cat': 'template', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})

    # 5. Forbidden Operations (250)
    print(" - Generating 250 Forbidden/Refusal examples...")
    for i in range(250):
        prompt, user, asst = gen_forbidden_refusal(i, rng)
        dataset.append({'cat': 'forbidden', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})

    # 6. Missing Info (250)
    print(" - Generating 250 Missing Information examples...")
    for i in range(250):
        prompt, user, asst = gen_missing_info(i, rng)
        dataset.append({'cat': 'missing_info', 'msgs': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user}, {'role': 'assistant', 'content': asst}]})

    # 7. Tool calling (200)
    print(" - Generating 200 Tool Calling examples...")
    for i in range(200):
        msgs = gen_tool_calling(i, rng)
        dataset.append({'cat': 'tool_calling', 'msgs': msgs})

    assert len(dataset) == 3000, f"Expected 3000, got {len(dataset)}"
    print(f"Total verified examples generated: {len(dataset)}")

    # Split deterministically: 80% train (2400), 10% valid (300), 10% test (300)
    # Using modulo 10: 8 -> valid, 9 -> test, 0..7 -> train
    splits = {'train': [], 'valid': [], 'test': []}
    counts_by_cat = {}

    for i, item in enumerate(dataset):
        cat = item['cat']
        counts_by_cat[cat] = counts_by_cat.get(cat, 0) + 1
        split_idx = (i // 10) % 10
        if split_idx == 8:
            sp = 'valid'
        elif split_idx == 9:
            sp = 'test'
        else:
            sp = 'train'
        splits[sp].append({'messages': item['msgs']})

    print(f"Split counts: train={len(splits['train'])}, valid={len(splits['valid'])}, test={len(splits['test'])}")

    manifest = {
        'total_examples': len(dataset),
        'categories': counts_by_cat,
        'splits': {k: len(v) for k, v in splits.items()},
        'seed': seed,
        'sha256': {}
    }

    for name, records in splits.items():
        out_file = output_dir / f"{name}.jsonl"
        with out_file.open('w', encoding='utf-8') as f:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        h = hashlib.sha256(out_file.read_bytes()).hexdigest()
        manifest['sha256'][name] = h
        print(f"Wrote {out_file} ({len(records)} records, sha256={h[:12]}...)")

    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Wrote manifest: {manifest_file}")
    print("Dataset generation v2 successfully completed!")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, default=Path('training/supernova-v2/data'))
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    generate_v2_dataset(args.output_dir, args.seed)
