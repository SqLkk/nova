#!/usr/bin/env python3
"""Prepare the SuperNova v2.4 full-platform mastery dataset on explicit invocation.

Guarantees:
1. 20 scenario families strictly partitioned across train (0..15), valid (16..17), test (18..19).
2. Zero duplicate normalized hashes within or across splits.
3. Zero leakage of core, extended, or v2.4 mastery acceptance identifiers, and zero forbidden brand strings.
4. Every executable artifact is verified against the real SuperNova runtime engines:
   - Python: SafeASTInterpreter + validate_python across normal, NULL, zero, duplicate, and empty fixtures
   - SQL: SQLite in-memory execution with PRAGMA query_only=ON and named :parameters
   - Path Definer: validate_path + path_engine.build_structure (tree, binary_tree, sequence, grouped, dag, multi_level + spaceMapConfig)
   - Template Builder: validate_template (charts, summary cells, builtin/formula cells, and dynamic repeating bands — never hardcoded static query numbers)
   - Admin & RBAC: validate_admin_action (create_user, create_role, update_sharing, set_user_overrides + strict privilege escalation & credential refusal)
   - Plain-text refusals & missing-schema answers: verified against has_executable_artifact() == False (zero ``` fences).
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter
from contextlib import closing
import hashlib
import itertools
import json
import math
from pathlib import Path
import random
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'supernova-backend'))

from ai_prompts import (
    ADMIN_PROMPT,
    BASE_PROMPT,
    PATH_PROMPT,
    PYTHON_PROMPT,
    QUERY_VIEWER_PROMPT,
    SQL_PROMPT,
    TEMPLATE_PROMPT,
)
from ai_service import TOOL_DEFINITIONS
from ai_tools import (
    SHARING_RESOURCE_TYPES,
    VALID_PERMISSION_KEYS,
    validate_admin_action,
    validate_path,
    validate_python,
    validate_template,
)
from path_engine import build_structure
from scripts import generate_ai_dataset_v22 as base
from scripts.generate_ai_dataset_v21 import (
    FORBIDDEN_ATTACK_CATEGORIES,
    MISSING_INFO_CATEGORIES,
    SCENARIOS,
)
from scripts.run_acceptance_suite import has_executable_artifact

COUNTS = {
    'py_basic': 160,
    'py_weighted': 220,
    'py_merge': 220,
    'py_fix': 180,
    'sql': 240,
    'query_viewer': 160,
    'path': 240,
    'template': 280,
    'admin_rbac': 220,
    'tool_calling': 160,
    'missing_info': 160,
    'forbidden': 160,
}

VARIANTS = {
    'py_basic': ['sum', 'average', 'group', 'filter', 'range', 'oee_full'],
    'py_weighted': ['quality', 'availability', 'scrap', 'performance'],
    'py_merge': ['left_difference', 'left_net', 'left_balance', 'full_difference'],
    'py_fix': [
        'zero_division',
        'null_arithmetic',
        'unsupported_comprehension',
        'nested_output',
        'per_row_merge',
        'pandas_sandbox_rewrite',
    ],
    'sql': ['sum', 'count', 'average', 'sum_with_name', 'cte_sum', 'three_table_join'],
    'query_viewer': [
        'explain_and_connect',
        'parameter_live_binding',
        'interactive_disambiguation',
        'resolved_selection_sql',
    ],
    'path': ['tree', 'binary_tree', 'sequence', 'grouped', 'dag', 'multi_level'],
    'template': [
        'chart_summary_line',
        'chart_summary_bar',
        'chart_summary_pie_area',
        'full_band_report',
        'multi_summary_band',
        'builtin_formula_sheet',
    ],
    'admin_rbac': [
        'create_user',
        'create_role',
        'update_sharing',
        'set_user_overrides',
        'refuse_escalation',
    ],
    'tool_calling': ['schema_call', 'schema_roundtrip', 'rbac_call', 'rbac_roundtrip'],
    'missing_info': [
        'oee_gap',
        'kpi_gap',
        'sql_missing_col',
        'template_missing_col',
        'path_missing_col',
        'ambiguous_tables',
    ],
    'forbidden': [
        'os_subprocess',
        'file_open',
        'network_socket',
        'eval_exec',
        'pandas_numpy',
        'sql_dml_ddl',
        'admin_password_dump',
        'sandbox_bypass',
    ],
}

DOMAIN_PROMPTS = {
    'python': PYTHON_PROMPT,
    'sql': SQL_PROMPT,
    'query_viewer': QUERY_VIEWER_PROMPT,
    'query_sql': QUERY_VIEWER_PROMPT + SQL_PROMPT,
    'path': PATH_PROMPT,
    'template': TEMPLATE_PROMPT,
    'admin': ADMIN_PROMPT,
}

CATEGORY_CODES = {
    'py_basic': 'pb',
    'py_weighted': 'pw',
    'py_merge': 'pm',
    'py_fix': 'pf',
    'sql': 'sql',
    'query_viewer': 'qv',
    'path': 'pth',
    'template': 'tpl',
    'admin_rbac': 'adm',
    'tool_calling': 'tl',
    'missing_info': 'gap',
    'forbidden': 'ref',
}

RESERVED_SUBSTRINGS = (
    'Quality_Summary',
    'Production_Simple',
    'q_workflow',
    'q_energy_blind',
    'holdout_ratio_',
    'holdout_input_',
    'holdout_loss_',
    'holdout_path_',
    'holdout_chart_',
    'holdout_partial_',
    'holdout_equipment_',
    'q_mastery_shift_kpi',
    'q_mastery_factory_flat',
    'q_mastery_assembly_seq',
    'q_mastery_furnace_temp',
    'mastery_lines',
    'mastery_stations',
    'mastery_alarms',
    'q_mastery_batches',
    'shift_auditor',
    'tpl_mastery_shift',
    'auditor_u1',
    'mastery_sensors',
    'employee_salary_bonus',
    'quality_lead_x',
)

_FORBIDDEN_BRAND_TOKENS = (
    'sie' + 'mens',
    'sima' + 'tic',
    'sinu' + 'merik',
    'sip' + 'lus',
    'sina' + 'mics',
    's7-' + '1500',
    'sp7' + '_',
    'his_' + 'db',
    'dor_' + 'db',
    'oms_' + 'db',
)
FORBIDDEN_BRAND_PATTERNS = re.compile(
    r'\b(?:' + '|'.join(_FORBIDDEN_BRAND_TOKENS) + r')\b',
    re.IGNORECASE,
)


def chat_v24(domain: str, user: str, answer: str) -> dict:
    return {
        'messages': [
            {'role': 'system', 'content': BASE_PROMPT + DOMAIN_PROMPTS.get(domain, '')},
            {'role': 'user', 'content': user},
            {'role': 'assistant', 'content': answer},
        ]
    }


def query_id_v24(scenario: dict, category: str, serial: int) -> str:
    code = CATEGORY_CODES[category]
    return f"v24_{scenario['id'].split('_')[0]}_{code}_{serial:03d}"


def code_from(record: dict) -> str:
    return record['messages'][-1]['content'].split('\n', 1)[1].rsplit('```', 1)[0].strip()


def verify_output_contract(code: str) -> None:
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            base.ensure(
                not any(isinstance(op, (ast.Is, ast.IsNot)) for op in node.ops),
                'Unsupported identity comparison in reference',
            )
        if isinstance(node, ast.Assign):
            base.ensure(
                not any(isinstance(t, ast.Name) and t.id == 'out' for t in node.targets),
                'Reference shadows out helper',
            )
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'append':
            receiver = node.func.value
            if isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name) and receiver.func.id == 'out':
                base.ensure(
                    len(node.args) == 1 and isinstance(node.args[0], ast.Dict),
                    'Every out append must emit one row dictionary',
                )


# ==============================================================================
# 1. PYTHON GENERATORS (Basic, Weighted, Merge, Sandbox Rewrite/Fix)
# ==============================================================================

def gen_py_basic(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    if subtype != 'oee_full':
        record, checks = base.legacy_python(qid, 'py_basic', subtype, scenario, rng, serial)
        verify_output_contract(code_from(record))
        return record, checks
    ident = rng.choice(['machine_code', 'line_id', 'station_key', 'cell_code'])
    run_col = base.choose(rng, 'run_minutes')
    plan_col = base.choose(rng, 'planned_minutes')
    good_col = base.choose(rng, 'good_count')
    total_col = base.choose(rng, 'total_count')
    dataset = rng.choice(['oee_report', 'line_efficiency', 'oee_summary', 'kpi_summary'])
    field_name = rng.choice(['oee_pct', 'availability_quality_pct', 'efficiency_pct'])
    user = (
        f"Kayıtlı sorgu '{qid}', kolonlar: {ident}, {run_col}, {plan_col}, {good_col}, {total_col}. "
        f"Tüm satırlarda toplam {run_col}/{plan_col} (kullanılabilirlik) ve toplam {good_col}/{total_col} (kalite) "
        f"oranlarının çarpımını yüzde olarak hesapla. '{dataset}' veri setine tek satır olarak "
        f"{{'{field_name}': ...}} şeklinde yaz. NULL değerleri 0 kabul et ve sıfıra bölmeyi önle."
    )
    code = '\n'.join([
        f"rows = sql_data.get('{qid}', [])",
        'total_run = 0.0',
        'total_plan = 0.0',
        'total_good = 0.0',
        'total_qty = 0.0',
        'for row in rows:',
        f"    total_run = total_run + (row.get('{run_col}', 0) or 0)",
        f"    total_plan = total_plan + (row.get('{plan_col}', 0) or 0)",
        f"    total_good = total_good + (row.get('{good_col}', 0) or 0)",
        f"    total_qty = total_qty + (row.get('{total_col}', 0) or 0)",
        'result = 0.0',
        'if total_plan > 0 and total_qty > 0:',
        '    result = (total_run / total_plan) * (total_good / total_qty) * 100.0',
        f"out('{dataset}').append({{'{field_name}': result}})",
    ])
    verify_output_contract(code)
    sample = [
        {ident: 'M1', run_col: 80, plan_col: 100, good_col: 90, total_col: 100},
        {ident: 'M2', run_col: None, plan_col: 100, good_col: 90, total_col: 100},
    ]
    actual = base.execute(code, {qid: sample})
    base.ensure(math.isclose(actual[dataset][0][field_name], (80 / 200) * (180 / 200) * 100.0, rel_tol=1e-9), 'OEE basic check failed')
    empty_actual = base.execute(code, {qid: []})
    base.ensure(math.isclose(empty_actual[dataset][0][field_name], 0.0, abs_tol=1e-9), 'OEE empty check failed')
    return chat_v24('python', user, base.fenced('python', code)), ['ast', 'exact_rows', 'null_missing', 'empty']


def gen_py_weighted(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    specs = {
        'quality': (
            ['good_qty', 'accepted_pcs', 'ok_units', 'valid_parts'],
            ['total_qty', 'processed_pcs', 'gross_units', 'inspected_parts'],
            'kalite',
            ['overall_quality_pct', 'quality_rate', 'yield_pct', 'weighted_rate'],
            ['quality_kpi', 'ratio_report', 'shift_summary', 'weighted_result'],
        ),
        'availability': (
            ['run_time', 'running_minutes', 'active_min', 'uptime_minutes'],
            ['planned_time', 'planned_minutes', 'scheduled_min', 'shift_minutes'],
            'kullanılabilirlik',
            ['availability_pct', 'uptime_rate', 'percentage', 'overall_pct'],
            ['availability_kpi', 'ratio_report', 'shift_summary', 'weighted_result'],
        ),
        'scrap': (
            ['scrap_qty', 'discarded_pcs', 'reject_units', 'defect_qty'],
            ['gross_qty', 'gross_pcs', 'total_produced', 'input_qty'],
            'hurda',
            ['scrap_pct', 'reject_rate', 'percentage', 'weighted_rate'],
            ['scrap_kpi', 'ratio_report', 'shift_summary', 'weighted_result'],
        ),
        'performance': (
            ['actual_output', 'produced_units', 'completed_cycles', 'done_batches'],
            ['target_output', 'expected_units', 'standard_cycles', 'planned_batches'],
            'performans',
            ['performance_pct', 'efficiency_rate', 'percentage', 'overall_pct'],
            ['performance_kpi', 'ratio_report', 'shift_summary', 'weighted_result'],
        ),
    }
    num_pool, den_pool, title, field_pool, ds_pool = specs[subtype]
    numerator = rng.choice(num_pool) + rng.choice(['', '_val', '_cnt'])
    denominator = rng.choice(den_pool) + rng.choice(['', '_val', '_cnt'])
    if numerator == denominator:
        denominator = denominator + '_total'
    dataset = rng.choice(ds_pool)
    result_field = rng.choice(field_pool)
    extra_col = rng.choice(['line_code', 'shift_code', 'station_id', 'cell_id'])
    cols_text = f'{extra_col}, {numerator}, {denominator}' if rng.choice([True, False]) else f'{numerator}, {denominator}'
    user = rng.choice([
        (
            f"Sorgu '{qid}': {cols_text}. Toplam {numerator}/toplam {denominator}*100 hesapla; "
            f"satır oranlarını ortalama. '{dataset}' çıktısına yalnızca '{result_field}' alanıyla tek satır yaz. "
            f"NULL/eksik sayılar 0; boş veya sıfır paydada 0.0."
        ),
        (
            f"Kayıtlı sorgu '{qid}', kolonlar: {cols_text}. "
            f"Satır yüzdelerinin ortalamasını alma; önce tüm satırlarda {numerator} ve {denominator} toplamlarını bul, "
            f"ardından genel ağırlıklı {title} oranını yüzde olarak hesapla. "
            f"'{dataset}' veri setine yalnızca '{result_field}' alanını içeren tek satır yaz. "
            f"NULL ve eksik değerleri 0 say; sıfır paydada 0.0 üret."
        ),
        (
            f"Kayıtlı sorgu '{qid}' kolonları: {cols_text}. "
            f"Her satırın oranını ayrı hesaplayıp ortalama almak yerine toplam {numerator} / toplam {denominator} * 100 ile "
            f"ağırlıklı {title} yüzdesini bul. Sonucu '{dataset}' tablosuna tek satır {{'{result_field}': ...}} olarak yaz (NULL=0, boş=0.0)."
        ),
    ])
    acc1, acc2 = rng.choice([
        ('total_num', 'total_den'),
        ('sum_numerator', 'sum_denominator'),
        ('numerator_total', 'denominator_total'),
    ])
    code = '\n'.join([
        f"rows = sql_data.get('{qid}', [])",
        f'{acc1} = 0.0',
        f'{acc2} = 0.0',
        'for row in rows:',
        f"    {acc1} = {acc1} + (row.get('{numerator}', 0) or 0)",
        f"    {acc2} = {acc2} + (row.get('{denominator}', 0) or 0)",
        'value = 0.0',
        f'if {acc2} > 0:',
        f'    value = ({acc1} / {acc2}) * 100.0',
        f"out('{dataset}').append({{'{result_field}': value}})",
    ])
    verify_output_contract(code)
    fixtures = [
        ('unequal_weights', [{numerator: 21, denominator: 70}, {numerator: 18, denominator: 20}], 39 / 90 * 100.0),
        ('null_and_missing', [{numerator: None, denominator: 10}, {numerator: 12, denominator: 30}, {}], 30.0),
        ('zero_denominator', [{numerator: 7, denominator: 0}], 0.0),
        ('empty', [], 0.0),
    ]
    for name, rows, value in fixtures:
        actual = base.execute(code, {qid: rows})
        base.ensure(set(actual) == {dataset} and len(actual[dataset]) == 1, f'Weighted {name}: {actual}')
        base.ensure(set(actual[dataset][0]) == {result_field}, 'Unexpected weighted fields')
        base.ensure(math.isclose(actual[dataset][0][result_field], value, rel_tol=1e-9, abs_tol=1e-9), f'Weighted {name}: {actual}')
    return chat_v24('python', user, base.fenced('python', code)), [f[0] for f in fixtures] + ['ratio_after_aggregation']


def gen_py_merge(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    qleft, qright = qid + '_in', qid + '_loss'
    key = rng.choice(['machine_code', 'asset_code', 'line_key', 'zone_id', 'workcell_id', 'station_code'])
    same_column = rng.choice([True, False])
    left_col = rng.choice(['qty', 'gross_qty', 'made_pcs', 'output_amount', 'gross_units'])
    right_col = left_col if same_column else rng.choice(['scrap_qty', 'reject_qty', 'lost_pcs', 'defect_amount'])
    dataset = rng.choice(['net_output', 'net_report', 'joined_totals', 'balance_table'])
    field_name = rng.choice(['net_qty', 'net_value', 'balance_units', 'usable_qty'])
    full = subtype == 'full_difference'
    if full:
        user = (
            f"Kayıtlı sorgular '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
            f"Her iki sorguyu önce {key} bazında ayrı sözlüklerde topla, sonra sol toplamdan sağ toplamı çıkar. "
            f"İki sorgudaki anahtarların birleşimini kullan; yalnızca sağ sorguda olan anahtarda sol toplam 0 olsun. "
            f"'{dataset}' veri setine yalnızca '{key}' ve '{field_name}' alanlarını yaz. "
            f"NULL anahtarları atla, NULL/eksik miktarları 0 say; iki liste de boşsa 0 satır üret (boş/None yer tutucu satır ekleme)."
        )
    else:
        user = rng.choice([
            (
                f"Sorgular '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
                f"İki tarafta da tekrarlı anahtarları önce topla. Sol taraftaki her anahtar için toplam {left_col} - toplam {right_col} hesapla. "
                f"Sağda eşleşme yoksa 0 kullan; yalnız sağda olan anahtarları alma. "
                f"'{dataset}' çıktısına yalnızca '{key}', '{field_name}' ile anahtar başına tek satır yaz. "
                f"NULL anahtarları atla; NULL/eksik sayılar 0, boş solda 0 satır."
            ),
            (
                f"İki kayıtlı sorgu var: '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
                f"Önce her iki sorguyu {key} bazında gruplayıp topla, ardından yalnızca '{qleft}' içinde geçen {key} anahtarları için "
                f"(sol toplam - sağ toplam) değerini '{dataset}' veri setine {{'{key}': ..., '{field_name}': ...}} olarak ekle. "
                f"NULL anahtarları yok say; sol sorgu boşsa hiçbir satır üretme."
            ),
        ])
    lines = [
        f"left_rows = sql_data.get('{qleft}', [])",
        f"right_rows = sql_data.get('{qright}', [])",
        'left_totals = {}',
        'right_totals = {}',
    ]
    for side, col in [('left', left_col), ('right', right_col)]:
        lines += [
            f'for row in {side}_rows:',
            f"    k = row.get('{key}')",
            '    if k != None:',
            f"        {side}_totals[k] = {side}_totals.get(k, 0) + (row.get('{col}', 0) or 0)",
        ]
    if full:
        lines += [
            'keys = []',
            'for k in left_totals:',
            '    keys.append(k)',
            'for k in right_totals:',
            '    if k not in keys:',
            '        keys.append(k)',
            'for k in keys:',
            '    net = left_totals.get(k, 0) - right_totals.get(k, 0)',
            f"    out('{dataset}').append({{'{key}': k, '{field_name}': net}})",
        ]
    else:
        lines += [
            'for k, total in left_totals.items():',
            '    net = total - right_totals.get(k, 0)',
            f"    out('{dataset}').append({{'{key}': k, '{field_name}': net}})",
        ]
    code = '\n'.join(lines)
    verify_output_contract(code)
    fixtures = [
        (
            'duplicates_both_sides',
            [{key: 'X', left_col: 36}, {key: 'X', left_col: 24}, {key: 'Y', left_col: 18}],
            [{key: 'X', right_col: 3}, {key: 'X', right_col: 4}, {key: 'Z', right_col: 2}],
            {'X': 53, 'Y': 18, **({'Z': -2} if full else {})},
        ),
        (
            'null_and_missing',
            [{key: 'X', left_col: None}, {key: 'X', left_col: 9}, {key: None, left_col: 99}, {key: 'Y'}],
            [{key: 'X', right_col: None}, {key: 'X', right_col: 2}, {key: None, right_col: 88}],
            {'X': 7, 'Y': 0},
        ),
        ('left_empty', [], [{key: 'Z', right_col: 4}], {'Z': -4} if full else {}),
        ('both_empty', [], [], {}),
    ]
    for name, left, right, expected in fixtures:
        actual = base.execute(code, {qleft: left, qright: right})
        base.ensure(set(actual) <= {dataset}, f'Merge {name}: extra dataset')
        base.exact_rows(actual.get(dataset, []), [{key: k, field_name: v} for k, v in expected.items()])
    return chat_v24('python', user, base.fenced('python', code)), [f[0] for f in fixtures] + ['zero_placeholder_rows']


def gen_py_fix(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    if subtype == 'pandas_sandbox_rewrite':
        record, checks = gen_py_weighted(qid, rng.choice(['quality', 'performance']), scenario, rng, serial)
        correct = code_from(record)
        numerator, denominator = re.findall(r"row\.get\('([^']+)'", correct)
        dataset = re.search(r"out\('([^']+)'\)", correct).group(1)
        field_name = re.findall(r"'([^']+)'\s*:", correct.splitlines()[-1])[0]
        bad = (
            "import pandas as pd\n"
            f"rows = sql_data['{qid}']\n"
            f"rates = [r['{numerator}'] / r['{denominator}'] * 100 for r in rows]\n"
            f"out('{dataset}').append({{'{field_name}': sum(rates) / len(rates)}})"
        )
        record['messages'][1]['content'] = (
            f"Aşağıdaki kod AST sandbox içinde yasaklı import, list comprehension ve satır ortalaması/sıfıra bölme hatası içeriyor. "
            f"Kayıtlı sorgu '{qid}' ({numerator}, {denominator}) üzerinden toplam {numerator} / toplam {denominator} * 100 genel ağırlıklı oranı hesaplayıp "
            f"'{dataset}' veri setine tek satır {{'{field_name}': ...}} yazacak şekilde düzelt (NULL/eksik=0, boş/sıfır payda=0.0):\n\n"
            + base.fenced('python', bad)
        )
        verify_output_contract(correct)
        return record, checks + ['pandas_rewrite']
    if subtype in ('nested_output', 'per_row_merge'):
        record, checks = gen_py_merge(qid, 'left_difference', scenario, rng, serial)
        correct = code_from(record)
        if subtype == 'nested_output':
            qleft, qright = qid + '_in', qid + '_loss'
            fields = re.findall(r"row\.get\('([^']+)'", correct)
            key, left_col, _, right_col = fields
            output = correct.rsplit('\n', 1)[1]
            dataset = re.search(r"out\('([^']+)'\)", output).group(1)
            field_name = re.findall(r"'([^']+)'\s*:", output)[-1]
            bad = (
                f"lt, rt, res = {{}}, {{}}, []\n"
                f"for r in sql_data.get('{qleft}', []):\n"
                f"    k = r.get('{key}')\n"
                f"    if k != None: lt[k] = lt.get(k, 0) + (r.get('{left_col}', 0) or 0)\n"
                f"for r in sql_data.get('{qright}', []):\n"
                f"    k = r.get('{key}')\n"
                f"    if k != None: rt[k] = rt.get(k, 0) + (r.get('{right_col}', 0) or 0)\n"
                f"for k, tot in lt.items():\n"
                f"    res.append({{'{key}': k, '{field_name}': tot - rt.get(k, 0)}})\n"
                f"out('{dataset}').append(res)"
            )
            instruction = 'Çıktı iç içe liste oldu; her anahtar sözlüğünü doğrudan out().append() ile ayrı satır yaz.'
        else:
            qleft, qright = qid + '_in', qid + '_loss'
            fields = re.findall(r"row\.get\('([^']+)'", correct)
            key, left_col, _, right_col = fields
            output = correct.rsplit('\n', 1)[1]
            dataset = re.search(r"out\('([^']+)'\)", output).group(1)
            field_name = re.findall(r"'([^']+)'\s*:", output)[-1]
            bad = (
                f"for row in sql_data.get('{qleft}', []):\n    k = row.get('{key}')\n"
                f"    net = row.get('{left_col}', 0) or 0\n"
                f"    for other in sql_data.get('{qright}', []):\n"
                f"        if other.get('{key}') == k:\n            net = net - (other.get('{right_col}', 0) or 0)\n"
                f"    out('{dataset}').append({{'{key}': k, '{field_name}': net}})"
            )
            instruction = 'Bu kod tekrar eden sol kayıtları ayrı yazıp aynı kaybı her satırdan düşüyor; önce iki sorguyu sözlükte gruplayıp anahtar başına tek satır üret.'
        record['messages'][1]['content'] = instruction + '\n' + base.fenced('python', bad)
        verify_output_contract(correct)
        return record, checks + ['error_correction']
    return base.legacy_python(qid, 'py_fix', subtype, scenario, rng, serial)


# ==============================================================================
# 2. SQL & QUERY VIEWER GENERATORS
# ==============================================================================

def gen_sql(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    if subtype == 'three_table_join':
        lines_tbl = qid + '_lines'
        stations_tbl = qid + '_stations'
        alarms_tbl = qid + '_alarms'
        lkey = rng.choice(['line_id', 'area_id', 'shop_id'])
        lname = rng.choice(['line_name', 'area_name', 'shop_title'])
        skey = rng.choice(['station_id', 'cell_id', 'unit_id'])
        stamp = rng.choice(['triggered_at', 'event_time', 'logged_at'])
        metric = rng.choice(['duration_sec', 'downtime_min', 'loss_sec'])
        alias = rng.choice(['total_loss', 'total_duration', 'alarm_total'])
        sql = (
            f'SELECT l.{lkey}, l.{lname}, COALESCE(SUM(a.{metric}), 0.0) AS {alias}\n'
            f'FROM {lines_tbl} l\n'
            f'LEFT JOIN {stations_tbl} s ON l.{lkey} = s.{lkey}\n'
            f'LEFT JOIN {alarms_tbl} a ON s.{skey} = a.{skey} AND a.{stamp} BETWEEN :start AND :end\n'
            f'GROUP BY l.{lkey}, l.{lname}\n'
            f'ORDER BY l.{lkey}'
        )
        user = (
            f'SQLite şeması: {lines_tbl}({lkey} TEXT, {lname} TEXT), '
            f'{stations_tbl}({skey} TEXT, {lkey} TEXT), '
            f'{alarms_tbl}(alarm_no TEXT, {skey} TEXT, {stamp} TEXT, {metric} REAL). '
            f':start ve :end tarih aralığında her hat ({lkey}, {lname}) için toplam {metric} değerini hesaplayan tek bir salt okunur SQL yaz. '
            f'İstasyonu veya belirtilen tarihte kaydı olmayan hatlar da sonuçta 0 olarak görünmelidir.'
        )
        with closing(sqlite3.connect(':memory:')) as conn:
            conn.execute(f'CREATE TABLE {lines_tbl}({lkey} TEXT, {lname} TEXT)')
            conn.execute(f'CREATE TABLE {stations_tbl}({skey} TEXT, {lkey} TEXT)')
            conn.execute(f'CREATE TABLE {alarms_tbl}(alarm_no TEXT, {skey} TEXT, {stamp} TEXT, {metric} REAL)')
            conn.executemany(f'INSERT INTO {lines_tbl} VALUES (?, ?)', [('L1', 'Line A'), ('L2', 'Line B'), ('L3', 'Line C')])
            conn.executemany(f'INSERT INTO {stations_tbl} VALUES (?, ?)', [('S1', 'L1'), ('S2', 'L1'), ('S3', 'L2')])
            conn.executemany(f'INSERT INTO {alarms_tbl} VALUES (?, ?, ?, ?)', [
                ('a1', 'S1', '2026-04-05', 40.0),
                ('a2', 'S2', '2026-04-12', 25.0),
                ('a3', 'S1', '2026-05-20', 300.0),
            ])
            conn.execute('PRAGMA query_only=ON')
            rows = conn.execute(sql, {'start': '2026-04-01', 'end': '2026-04-30'}).fetchall()
            base.ensure(rows == [('L1', 'Line A', 65.0), ('L2', 'Line B', 0.0), ('L3', 'Line C', 0.0)], f'3-table SQL mismatch: {rows}')
        return chat_v24('sql', user, base.fenced('sql', sql)), ['three_table_join', 'outside_range', 'zero_preserve']

    if subtype in ('sum', 'count', 'average') and rng.choice([True, False]):
        return base.sql_example(qid, subtype, rng)

    main = qid + rng.choice(['_machines', '_assets', '_cells'])
    events = qid + rng.choice(['_downtime_logs', '_events', '_stops'])
    key = rng.choice(['id', 'asset_key', 'machine_id'])
    name_col = rng.choice(['name', 'machine_name', 'title'])
    foreign = rng.choice(['machine_id', 'asset_ref', 'cell_ref'])
    stamp = rng.choice(['event_date', 'recorded_at', 'log_date'])
    metric = rng.choice(['duration_min', 'duration', 'lost_minutes'])
    alias = rng.choice(['total_downtime', 'result', 'total_duration'])
    if subtype == 'cte_sum':
        sql = (
            f'WITH filtered_events AS (\n'
            f'    SELECT {foreign}, {metric}\n'
            f'    FROM {events}\n'
            f'    WHERE {stamp} BETWEEN :start AND :end\n'
            f')\n'
            f'SELECT m.{key}, m.{name_col}, COALESCE(SUM(f.{metric}), 0.0) AS {alias}\n'
            f'FROM {main} m\n'
            f'LEFT JOIN filtered_events f ON m.{key} = f.{foreign}\n'
            f'GROUP BY m.{key}, m.{name_col}\n'
            f'ORDER BY m.{key}'
        )
    else:
        func = 'COUNT' if subtype == 'count' else ('AVG' if subtype == 'average' else 'SUM')
        agg = 'COUNT(d.event_no)' if subtype == 'count' else f'{func}(d.{metric})'
        sql = (
            f'SELECT m.{key}, m.{name_col}, COALESCE({agg}, 0.0) AS {alias}\n'
            f'FROM {main} m\n'
            f'LEFT JOIN {events} d ON m.{key} = d.{foreign} AND d.{stamp} BETWEEN :start AND :end\n'
            f'GROUP BY m.{key}, m.{name_col}\n'
            f'ORDER BY m.{key}'
        )
    op_label = 'kayıt sayısını (COUNT)' if subtype == 'count' else ('ortalama değeri (AVG)' if subtype == 'average' else 'toplam değeri (SUM)')
    user = (
        f'SQLite şeması: {main}({key} TEXT, {name_col} TEXT) ve '
        f'{events}(event_no TEXT, {foreign} TEXT, {stamp} TEXT, {metric} REAL). '
        f':start ile :end tarihleri arasındaki {op_label} makine bazında listeleyen tek bir salt okunur SQL sorgusu yaz. '
        f'Seçilen tarih aralığında hiç kaydı olmayan makineler de sonuçta 0 olarak görünmeli.'
    )
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute(f'CREATE TABLE {main}({key} TEXT, {name_col} TEXT)')
        conn.execute(f'CREATE TABLE {events}(event_no TEXT, {foreign} TEXT, {stamp} TEXT, {metric} REAL)')
        conn.executemany(f'INSERT INTO {main} VALUES (?, ?)', [('M1', 'Unit 1'), ('M2', 'Unit 2'), ('M3', 'Unit 3')])
        conn.executemany(f'INSERT INTO {events} VALUES (?, ?, ?, ?)', [
            ('e1', 'M1', '2026-04-04', 12.0),
            ('e2', 'M1', '2026-04-08', 6.0),
            ('e3', 'M1', '2026-04-10', None),
            ('e4', 'M2', '2026-05-05', 99.0),
        ])
        conn.execute('PRAGMA query_only=ON')
        rows = conn.execute(sql, {'start': '2026-04-01', 'end': '2026-04-30'}).fetchall()
        expected = 3 if subtype == 'count' else (9.0 if subtype == 'average' else 18.0)
        base.ensure(rows == [('M1', 'Unit 1', expected), ('M2', 'Unit 2', 0.0), ('M3', 'Unit 3', 0.0)], f'SQL mismatch: {rows}')
    return chat_v24('sql', user, base.fenced('sql', sql)), ['outside_range', 'no_events', 'exact_aggregate']


def gen_query_viewer(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    dom = scenario['domain']
    unit_col = scenario['unit'] + '_id'
    metric_col = scenario['metric']
    ts_col = rng.choice(['logged_at', 'shift_date', 'recorded_at'])
    param_name = rng.choice(['min_val', 'shift_code', 'line_filter', 'start_date'])

    if subtype in ('explain_and_connect', 'parameter_live_binding'):
        desc = f'{dom} sahası {metric_col} izleme sorgusu'
        user = (
            f"Query Viewer'daki kayıtlı sorgu '{qid}' (açıklama: '{desc}', kolonlar: {unit_col}, {ts_col}, {metric_col}, "
            f"parametre: :{param_name}) neyi ölçer ve sonuçlarını sabit veri kopyalamadan Template Builder, Space Map ve Dashboard ekranlarında canlı olarak nasıl kullanırım? Kod bloğu üretmeden açıkla."
        )
        answer = (
            f"Kayıtlı sorgu `{qid}` ({desc}), `:{param_name}` parametresine göre `{unit_col}`, `{ts_col}` ve `{metric_col}` kolonlarını canlı olarak döndürür. "
            f"Sonuçları statik sayı olarak kopyalamadan şu şekilde bağlayabilirsiniz:\n"
            f"- **Template Builder**: Grafiklerde `queryId: \"{qid}\"`, özet hücrelerde `summary` (`SUM`/`AVG` `{metric_col}`) ve tekrarlı satır tablolarında `bands` (`query_field`) bağlaması kullanın; rapor her çalıştırıldığında sorgu canlı yürütülür.\n"
            f"- **Path Definer & Space Map**: `{qid}` sorgusunu topoloji kaynağı seçip `{unit_col}` kolonunu düğüm kimliği olarak eşleyerek Space Map üzerinde canlı durum ve metrikleri izleyin.\n"
            f"- **Dashboard & Python Workspace**: Dashboard bileşenlerine doğrudan `{qid}` bağlayın veya Python Workspace içinde `sql_data.get('{qid}', [])` ile okuyun."
        )
        base.ensure(not has_executable_artifact(answer), f'Query viewer explanation triggered executable check: {answer}')
        return chat_v24('query_viewer', user, answer), ['query_comprehension', 'live_connectivity', 'no_executable_artifact']

    if subtype == 'interactive_disambiguation':
        t1 = f'{qid}_hourly_{scenario["unit"]}'
        t2 = f'{qid}_shift_{scenario["unit"]}'
        user = (
            f"Veritabanında hem `{t1}` ({unit_col}, hour_slot, {metric_col}) hem de `{t2}` ({unit_col}, shift_code, {metric_col}, target_qty) "
            f"tabloları var. `{dom}` üretim raporu için SQL sorgusu yazmak istiyorum ama hangisini kullanacağımı belirtmedim."
        )
        answer = (
            f"Şemada `{dom}` verisi için iki aday tablo bulunuyor; yanlış tabloyu varsaymamak için lütfen hangisini kullanmamı istediğinizi seçin:\n"
            f"1. `{t1}` — Saatlik kırılım (`{unit_col}`, `hour_slot`, `{metric_col}`)\n"
            f"2. `{t2}` — Vardiya bazlı özet ve hedef karşılaştırması (`{unit_col}`, `shift_code`, `{metric_col}`, `target_qty`)\n"
            f"Saatlik trend mi yoksa vardiya bazlı hedef analizi mi hazırlamamı istersiniz?"
        )
        base.ensure(not has_executable_artifact(answer), 'Disambiguation leaked code')
        return chat_v24('query_sql', user, answer), ['interactive_disambiguation', 'no_executable_artifact']

    # resolved_selection_sql: user resolved table selection -> immediately emit SQL without re-asking!
    chosen_tbl = f'{qid}_shift_{scenario["unit"]}'
    sql = (
        f'SELECT {unit_col}, shift_code, COALESCE(SUM({metric_col}), 0.0) AS total_metric\n'
        f'FROM {chosen_tbl}\n'
        f'WHERE shift_date BETWEEN :start AND :end\n'
        f'GROUP BY {unit_col}, shift_code\n'
        f'ORDER BY {unit_col}'
    )
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute(f'CREATE TABLE {chosen_tbl}({unit_col} TEXT, shift_code TEXT, shift_date TEXT, {metric_col} REAL)')
        conn.execute(f'INSERT INTO {chosen_tbl} VALUES (?, ?, ?, ?)', ('U1', 'S1', '2026-05-02', 55.0))
        conn.execute('PRAGMA query_only=ON')
        rows = conn.execute(sql, {'start': '2026-05-01', 'end': '2026-05-31'}).fetchall()
        base.ensure(rows == [('U1', 'S1', 55.0)], 'Resolved SQL check failed')
    user = (
        f"Önceki soruna yanıt olarak `{chosen_tbl}` ({unit_col} TEXT, shift_code TEXT, shift_date TEXT, {metric_col} REAL) tablosunu seçtim "
        f"(resolved_selection: selected_tables=['{chosen_tbl}']). Tekrar soru sormadan :start ve :end tarih aralığında "
        f"{unit_col} ve shift_code bazında toplam {metric_col} değerini getiren salt okunur SQL sorgusunu üret."
    )
    return chat_v24('query_sql', user, base.fenced('sql', sql)), ['resolved_selection', 'sql_execution']


# ==============================================================================
# 3. PATH DEFINER & SPACE MAP GENERATOR (All 6 structures + SpaceMap icons/themes)
# ==============================================================================

def gen_path(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    if subtype == 'multi_level':
        l1 = rng.choice(['plant_area', 'shop_floor', 'building_code', 'sector_name'])
        l2 = rng.choice(['line_group', 'cell_group', 'bay_code', 'corridor_id'])
        ident = rng.choice(['station_id', 'machine_code', 'asset_id', 'node_key'])
        label = rng.choice(['station_title', 'asset_name', 'display_label', 'machine_caption'])
        health = rng.choice(['health_score', 'oee_pct', 'uptime_score'])
        theme = rng.choice(['factory', 'cyber', 'emerald', 'cosmic'])
        layout = rng.choice(['radial', 'hierarchy', 'grid', 'force'])
        icons = rng.choice([
            ('fa-industry', 'fa-sitemap', 'fa-robot'),
            ('fa-building', 'fa-cogs', 'fa-microchip'),
            ('fa-warehouse', 'fa-project-diagram', 'fa-bolt'),
        ])
        use_level_cols = rng.choice([True, False])
        config = {
            'id_col': ident,
            'label_col': label,
            'health_col': health,
            'spaceMapConfig': {
                'theme': theme,
                'layout': layout,
                'level1Icon': icons[0],
                'level2Icon': icons[1],
                'level3Icon': icons[2],
            },
        }
        if use_level_cols:
            config['level_cols'] = [l1, l2]
        else:
            config['level1_col'] = l1
            config['level2_col'] = l2
        columns = [l1, l2, ident, label, health]
        artifact = {'structure': 'multi_level', 'queryId': qid, 'config': config}
        validate_path(artifact, [{'id': qid, 'columns': columns}])
        rows = [
            {l1: 'AreaA', l2: 'Group1', ident: 'N1', label: 'Node 1', health: 93},
            {l1: 'AreaA', l2: 'Group2', ident: 'N2', label: 'Node 2', health: 78},
        ]
        built = build_structure('multi_level', rows, config)
        base.ensure(built['stats']['max_depth'] >= 2, 'multi_level depth check failed')
        user = (
            f"Sorgu ID: {qid}. Kolonlar: {', '.join(columns)}. "
            f"Parent kolonu olmayan bu düz tablodan {l1} ve {l2} kırılımlarıyla 'multi_level' yapısında Path Definer JSON üret. "
            f"Kimlik {ident}, etiket {label}, sağlık kolonu {health} olsun. "
            f"Ayrıca config içinde spaceMapConfig ile theme='{theme}', layout='{layout}', "
            f"level1Icon='{icons[0]}', level2Icon='{icons[1]}', level3Icon='{icons[2]}' tanımla."
        )
        return chat_v24('path', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'multi_level', 'space_map_icons']

    ident = base.choose(rng, 'step_id' if subtype == 'dag' else 'node_code')
    label = base.choose(rng, 'step_name' if subtype == 'dag' else 'caption_text')
    relation = base.choose(rng, 'prev_steps' if subtype == 'dag' else 'ancestor_key')
    order = base.choose(rng, 'step_position')
    group = base.choose(rng, 'cluster_key')
    add_status = rng.choice([True, False])
    status_col = rng.choice(['op_status', 'node_state', 'alarm_state'])
    config = {'id_col': ident, 'label_col': label}

    if subtype in ('tree', 'binary_tree', 'dag'):
        config['parents_col' if subtype == 'dag' else 'parent_col'] = relation
        third_col = relation
        rows = [
            {ident: 'R', relation: '', label: 'Root'},
            {ident: 'S', relation: '' if subtype == 'dag' else 'R', label: 'Second'},
            {ident: 'T', relation: 'R,S' if subtype == 'dag' else 'R', label: 'Third'},
        ]
        detail = (
            f'İlk kolon kimlik ({ident}), {relation} virgülle ayrılan birden çok üst düğüm kimliği, {label} etiket.'
            if subtype == 'dag'
            else f'İlk kolon kimlik ({ident}), {relation} üst düğüm kimliği, {label} etiket.'
        )
    elif subtype == 'sequence':
        config['order_col'] = order
        third_col = order
        rows = [
            {ident: 'R', order: 3, label: 'Root'},
            {ident: 'S', order: 1, label: 'Second'},
            {ident: 'T', order: 2, label: 'Third'},
        ]
        detail = f'İlk kolon kimlik ({ident}), {order} artan sıra numarası, {label} etiket.'
    else:
        config['group_col'] = group
        third_col = group
        rows = [
            {ident: 'R', group: 'G1', label: 'Root'},
            {ident: 'S', group: 'G1', label: 'Second'},
            {ident: 'T', group: 'G2', label: 'Third'},
        ]
        detail = f'İlk kolon kimlik ({ident}), {group} grup kimliği, {label} etiket.'

    columns = [ident, third_col, label]
    extra_prompt = ''
    if add_status:
        config['status_col'] = status_col
        columns.append(status_col)
        for r in rows:
            r[status_col] = 'HEALTHY'
        extra_prompt = f' Durum kolonu (status_col) olarak {status_col} eşle.'

    artifact = {'structure': subtype, 'queryId': qid, 'config': config}
    validate_path(artifact, [{'id': qid, 'columns': columns}])
    built = build_structure(subtype, rows, config)
    nodes = {n['id']: n for n in built['nodes']}
    if subtype == 'dag':
        base.ensure(set(nodes['T']['parents']) == {'R', 'S'}, 'DAG parents mismatch')
    user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(columns)}. Yapı: {subtype}. {detail}{extra_prompt} Path Definer JSON üret."
    return chat_v24('path', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'exact_structure']


# ==============================================================================
# 4. TEMPLATE BUILDER GENERATOR (Charts, Summary Cells, Dynamic Bands, Formulas)
# ==============================================================================

def gen_template(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    if subtype in ('chart_summary_line', 'chart_summary_bar', 'chart_summary_pie_area'):
        chart_type = (
            'line' if subtype == 'chart_summary_line'
            else ('bar' if subtype == 'chart_summary_bar' else rng.choice(['pie', 'area']))
        )
        x = base.choose(rng, 'logged_at' if chart_type in ('line', 'area') else 'station_label')
        y = base.choose(rng, 'kwh_used' if chart_type in ('line', 'area') else 'produced_units')
        row, col = (1, 1) if rng.choice([True, False]) else (rng.randint(1, 8), rng.randint(1, 3))
        cell_row = 14 if (row == 1 and col == 1) else row + 12
        operation = rng.choice(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'])
        tr_chart = {'line': 'çizgi (line)', 'bar': 'çubuk (bar)', 'pie': 'pasta (pie)', 'area': 'alan (area)'}[chart_type]
        artifact = {
            'charts': [{
                'id': f'ch_{qid}',
                'type': chart_type,
                'anchor': {'row': row, 'col': col, 'widthCols': 6, 'heightRows': 10},
                'queryId': qid,
                'xAxis': x,
                'yAxis': [y],
                'title': f"{scenario['domain']} Raporu",
            }],
            'cells': [{
                'row': cell_row,
                'col': col,
                'value': '',
                'binding': {'kind': 'summary', 'queryId': qid, 'field': y, 'operation': operation},
            }],
        }
        validate_template(artifact, [{'id': qid, 'columns': [x, y]}])
        user = rng.choice([
            (
                f'Sorgu ID: {qid}, kolonlar: {x}, {y}. ({row}, {col}) hücresinde {x} ve {y} kullanan {tr_chart} grafiği ve '
                f'({cell_row}, {col}) hücresinde {operation}({y}) özet hücresi içeren Template Builder JSON parçası üret.'
            ),
            (
                f'Sorgu ID: {qid}, kolonlar: {x}, {y}. ({row}, {col}) hücresinde {x}/{y} kullanan {chart_type} grafik ve '
                f'({cell_row}, {col}) hücresinde {operation}({y}) özet hücresi JSON üret.'
            ),
        ])
        return chat_v24('template', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'chart_and_summary_only']

    if subtype in ('full_band_report', 'multi_summary_band'):
        c1 = rng.choice(['shift_code', 'batch_no', 'period_label'])
        c2 = rng.choice(['line_code', 'station_code', 'cell_name'])
        c3 = rng.choice(['good_units', 'produced_qty', 'output_pcs'])
        c4 = rng.choice(['scrap_units', 'defect_qty', 'loss_pcs'])
        cols = [c1, c2, c3, c4]
        chart_type = rng.choice(['bar', 'line', 'area'])
        op1, op2 = ('SUM', 'AVG') if subtype == 'multi_summary_band' else (rng.choice(['SUM', 'MAX']), rng.choice(['AVG', 'COUNT']))
        band_row = rng.choice([15, 16])
        cells = [
            {'row': 12, 'col': 1, 'value': '', 'binding': {'kind': 'summary', 'queryId': qid, 'field': c3, 'operation': op1}},
            {'row': 12, 'col': 2, 'value': '', 'binding': {'kind': 'summary', 'queryId': qid, 'field': c4, 'operation': op2}},
        ]
        artifact = {
            'charts': [{
                'id': f'ch_{qid}',
                'type': chart_type,
                'anchor': {'row': 1, 'col': 1, 'widthCols': 6, 'heightRows': 10},
                'queryId': qid,
                'xAxis': c1,
                'yAxis': [c3],
                'title': f"{scenario['domain']} Raporu",
            }],
            'cells': cells,
            'bands': [{
                'id': f'bnd_{qid}',
                'queryId': qid,
                'range': {'startRow': band_row, 'startCol': 1, 'endRow': band_row, 'endCol': 4},
                'fieldMap': {'1': c1, '2': c2, '3': c3, '4': c4},
            }],
        }
        validate_template(artifact, [{'id': qid, 'columns': cols}])
        user = (
            f"Sorgu ID: {qid}, kolonlar: {', '.join(cols)}. "
            f"(1, 1) konumuna {c1} ve {c3} kullanan {chart_type} grafik, "
            f"(12, 1) hücresine {op1}({c3}) özet (summary) hücresi, "
            f"(12, 2) hücresine {op2}({c4}) özet hücresi ve "
            f"{band_row}. satırda (startRow={band_row}, endRow={band_row}, startCol=1, endCol=4) tüm 4 kolonu sırasıyla "
            f"(1: {c1}, 2: {c2}, 3: {c3}, 4: {c4}) bağlayan dinamik tekrarlı detay bandı (bands) içeren Template Builder JSON parçası üret. "
            f"Özet hücrelerine sabit sayı yazma."
        )
        return chat_v24('template', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False, separators=(',', ':')))), ['schema', 'live_bands', 'zero_hardcoded_numbers']

    # builtin_formula_sheet
    col_x = rng.choice(['machine_code', 'line_name'])
    col_good = rng.choice(['ok_qty', 'accepted_qty'])
    col_tot = rng.choice(['gross_qty', 'total_qty'])
    cols = [col_x, col_good, col_tot]
    artifact = {
        'charts': [],
        'cells': [
            {'row': 1, 'col': 1, 'value': '', 'binding': {'kind': 'builtin', 'builtin': 'report_name'}},
            {'row': 1, 'col': 4, 'value': '', 'binding': {'kind': 'builtin', 'builtin': 'report_datetime'}},
            {'row': 3, 'col': 1, 'value': '', 'binding': {'kind': 'summary', 'queryId': qid, 'field': col_good, 'operation': 'SUM'}},
            {'row': 3, 'col': 2, 'value': '', 'binding': {'kind': 'summary', 'queryId': qid, 'field': col_tot, 'operation': 'SUM'}},
            {'row': 3, 'col': 3, 'value': '=IF(B3>0, A3/B3*100, 0)', 'binding': {'kind': 'formula', 'formula': '=IF(B3>0, A3/B3*100, 0)'}},
        ],
    }
    validate_template(artifact, [{'id': qid, 'columns': cols}])
    user = (
        f"Sorgu ID: {qid}, kolonlar: {', '.join(cols)}. "
        f"(1, 1) hücresine report_name ve (1, 4) hücresine report_datetime builtin bağlaması, "
        f"(3, 1) hücresine SUM({col_good}), (3, 2) hücresine SUM({col_tot}) özet hücresi ve "
        f"(3, 3) hücresine '=IF(B3>0, A3/B3*100, 0)' formül hücresi ekleyen Template Builder JSON parçası üret."
    )
    return chat_v24('template', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'builtin_and_formula']


# ==============================================================================
# 5. USER MANAGEMENT & RBAC GENERATOR
# ==============================================================================

def gen_admin_rbac(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    dom_slug = scenario['id'].split('_')[1]
    if subtype == 'create_user':
        uname = f'{dom_slug}_usr_{serial:02d}'
        dname = f'{scenario["domain"]} Operatörü {serial}'
        role_key = rng.choice(['engineer', 'operator', 'viewer'])
        email = f'{uname}@factory.local'
        artifact = {
            'action': 'create_user',
            'user': {
                'username': uname,
                'displayName': dname,
                'email': email,
                'roleKey': role_key,
                'isActive': True,
            },
        }
        validate_admin_action(artifact, caller_level=80)
        user = (
            f"Admin ekranındayım (rolüm admin, seviye 80). Kullanıcı adı '{uname}', görünen adı '{dname}', "
            f"e-postası '{email}' ve rolü '{role_key}' olan aktif bir kullanıcı oluşturma (create_user) JSON taslağı üret. "
            f"Parola bilgisini taslağa ekleme."
        )
        return chat_v24('admin', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['rbac_create_user', 'no_credentials']

    if subtype == 'create_role':
        rkey = f'{dom_slug}_role_{serial:02d}'
        rname = f'{scenario["domain"]} Sorumlusu'
        level = rng.choice([30, 45, 50, 55, 65, 70])
        perm_pool = [
            'page:dashboard',
            'page:reports',
            'page:network-map',
            'page:table-explorer',
            'page:template-builder',
            'page:python-workspace',
            'datasource:view',
            'share:templates',
        ]
        perms = sorted(rng.sample(perm_pool, k=4))
        artifact = {
            'action': 'create_role',
            'role': {
                'key': rkey,
                'name': rname,
                'description': f'{scenario["domain"]} özel erişim rolü',
                'level': level,
                'permissions': perms,
            },
        }
        validate_admin_action(artifact, caller_level=80)
        user = (
            f"Admin ekranındayım ve kendi rol seviyem admin (80). Anahtarı '{rkey}', adı '{rname}', "
            f"seviyesi {level} olan ve yalnızca {', '.join(perms)} izinlerine sahip yeni rol oluşturma (create_role) JSON taslağı üret."
        )
        return chat_v24('admin', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['rbac_create_role', 'level_hierarchy']

    if subtype == 'update_sharing':
        rtype = rng.choice(sorted(SHARING_RESOURCE_TYPES))
        rid = f'{rtype[:-1]}_{qid}'
        roles = sorted(rng.sample(['operator', 'engineer', 'viewer'], k=2))
        uname = f'{dom_slug}_lead_{serial:02d}'
        artifact = {
            'action': 'update_sharing',
            'resourceType': rtype,
            'resourceId': rid,
            'allowedRoles': roles,
            'allowedUsers': [uname],
        }
        validate_admin_action(artifact, caller_level=80)
        user = (
            f"Admin ekranında '{rtype}' türündeki '{rid}' kaynağını "
            f"{' ve '.join(repr(r) for r in roles)} rollerine ve '{uname}' kullanıcısına paylaşmak için update_sharing JSON taslağı üret."
        )
        return chat_v24('admin', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['rbac_sharing_acl']

    if subtype == 'set_user_overrides':
        uname = f'{dom_slug}_tech_{serial:02d}'
        p_grant = rng.choice(['page:template-builder', 'page:python-workspace', 'share:templates'])
        p_deny = rng.choice(['user:delete', 'role:delete', 'datasource:manage'])
        artifact = {
            'action': 'set_user_overrides',
            'username': uname,
            'overrides': [
                {'permission_key': p_grant, 'granted': 1},
                {'permission_key': p_deny, 'granted': 0},
            ],
        }
        validate_admin_action(artifact, caller_level=80)
        user = (
            f"Admin ekranında '{uname}' kullanıcısı için '{p_grant}' iznini açan (granted=1) ve "
            f"'{p_deny}' iznini kapatan (granted=0) set_user_overrides JSON taslağı üret."
        )
        return chat_v24('admin', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['rbac_overrides']

    # refuse_escalation
    caller_role, caller_lvl = rng.choice([('admin', 80), ('engineer', 60)])
    target_lvl = rng.choice([caller_lvl, 90, 100])
    user = (
        f"Benim rolüm {caller_role} (seviye {caller_lvl}) [{qid}]. Kendime superuser (seviye {target_lvl}) yetkisi veren "
        f"ve tüm kullanıcıların password_hash değerlerini gösteren bir yönetim JSON taslağı üret."
    )
    answer = (
        f"Bu talebi güvenlik ve RBAC yetki hiyerarşisi kuralları nedeniyle gerçekleştiremem. "
        f"Mevcut rol seviyeniz ({caller_role}: {caller_lvl}), kendi seviyenize eşit veya daha yüksek bir rol (seviye {target_lvl} / superuser: 100) "
        f"oluşturmanıza ya da atamanıza izin vermez. Ayrıca kullanıcı parola ve password hash bilgileri gizlidir; "
        f"AI taslaklarında asla dışa aktarılamaz."
    )
    base.ensure(not has_executable_artifact(answer), 'RBAC refusal leaked executable artifact')
    return chat_v24('admin', user, answer), ['rbac_refusal', 'no_executable_artifact']


# ==============================================================================
# 6. TOOL CALLING, MISSING INFO & FORBIDDEN GENERATORS
# ==============================================================================

def gen_tool_calling(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    if subtype in ('schema_call', 'schema_roundtrip'):
        table = f'{qid}_{scenario["unit"]}s'
        col1 = f'{scenario["unit"]}_code'
        col2 = scenario['metric']
        messages = [
            {'role': 'system', 'content': BASE_PROMPT},
            {'role': 'user', 'content': f'{qid} analizi için veritabanında hangi tablolar ve kayıtlı sorgular olduğunu bilmiyorum. Şemayı keşfet.'},
            {
                'role': 'assistant',
                'content': '',
                'tool_calls': [{
                    'id': qid + '_call',
                    'type': 'function',
                    'function': {'name': 'tool_get_database_schema', 'arguments': {}},
                }],
            },
        ]
        if subtype == 'schema_roundtrip':
            schema = {
                'sources': [{'name': scenario['domain'], 'tables': [{'name': table, 'columns': [col1, col2]}]}],
                'queries': [{'id': qid, 'columns': [col1, col2]}],
            }
            messages += [
                {'role': 'tool', 'name': 'tool_get_database_schema', 'tool_call_id': qid + '_call', 'content': json.dumps(schema, separators=(',', ':'))},
                {
                    'role': 'assistant',
                    'content': f'Şemada `{table}` tablosu ve `{qid}` sorgusu var. Kolonlar: `{col1}`, `{col2}`.',
                },
            ]
        return {'messages': messages, 'tools': TOOL_DEFINITIONS}, ['structured_call', subtype]

    # rbac_call / rbac_roundtrip
    custom_role = f'{scenario["id"].split("_")[1]}_sup_{serial:02d}'
    lvl = rng.choice([45, 55, 65])
    messages = [
        {'role': 'system', 'content': BASE_PROMPT},
        {'role': 'user', 'content': f'{qid} için sistemde tanımlı rolleri ve izin anahtarlarını bilmiyorum. Önce RBAC bilgisini araçla getir.'},
        {
            'role': 'assistant',
            'content': '',
            'tool_calls': [{
                'id': qid + '_rcall',
                'type': 'function',
                'function': {'name': 'tool_get_rbac_info', 'arguments': {}},
            }],
        },
    ]
    if subtype == 'rbac_roundtrip':
        rbac_payload = {
            'roles': [
                {'key': 'admin', 'level': 80},
                {'key': custom_role, 'level': lvl},
            ],
            'permissionKeys': ['page:dashboard', 'page:reports'],
        }
        messages += [
            {'role': 'tool', 'name': 'tool_get_rbac_info', 'tool_call_id': qid + '_rcall', 'content': json.dumps(rbac_payload, ensure_ascii=False, separators=(',', ':'))},
            {
                'role': 'assistant',
                'content': f'RBAC bilgisinde `admin` (80) ve `{custom_role}` ({lvl}) rolleri ile `page:dashboard`, `page:reports` izinleri tanımlı.',
            },
        ]
    return {'messages': messages, 'tools': TOOL_DEFINITIONS}, ['structured_call', subtype]


def gen_missing_info(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    unit_col = f'{scenario["unit"]}_code'
    metric_col = scenario['metric']

    if subtype == 'oee_gap':
        columns = [unit_col, metric_col]
        user = f"Kayıtlı sorgu '{qid}' içinde yalnızca {', '.join(columns)} kolonları var. OEE hesaplayan Python kodu yaz."
        answer = (
            f"Mevcut '{qid}' sorgusundaki kolonlar ({', '.join(columns)}) tam OEE hesabı için yeterli değil; eksik kolonlar nedeniyle kod üretemem. "
            f"OEE hesabı için şu üç bileşenin verileri gereklidir:\n"
            f"- Kullanılabilirlik (Availability): planlanan üretim süresi ve fiili çalışma/duruş süresi\n"
            f"- Performans (Performance): ideal çevrim süresi (hedef hız) ve toplam üretim adedi\n"
            f"- Kalite (Quality): sağlam ürün adedi ve hurda/fire adedi\n"
            f"Bu kolonları içeren kayıtlı sorguyu paylaşır mısınız?"
        )
        domain = 'python'
    elif subtype == 'kpi_gap':
        name, reqs = MISSING_INFO_CATEGORIES[serial % len(MISSING_INFO_CATEGORIES)]
        user = f"Kayıtlı sorgu '{qid}', yalnızca {unit_col}, {metric_col} kolonlarını içeriyor. {name} hesaplayan script hazırla."
        answer = (
            f"'{qid}' sorgusundaki mevcut kolonlar ({unit_col}, {metric_col}) {name} hesabı için yeterli değil. "
            f"Eksik veriler: {'; '.join(reqs)}. Lütfen bu alanları içeren sorgu veya kolon adlarını belirtin."
        )
        domain = 'python'
    elif subtype == 'sql_missing_col':
        actual_tbl = f'{qid}_{scenario["unit"]}_logs'
        fake_topic, fake_col = rng.choice([
            ('personel maaş ve ikramiye ödemelerini', 'payroll_bonus_try'),
            ('tedarikçi fatura iskonto tutarlarını', 'vendor_invoice_discount'),
            ('araç filo yakıt vergilerini', 'fleet_tax_amount'),
        ])
        user = (
            f"Veritabanı şemasında yalnızca {actual_tbl}({unit_col} TEXT, recorded_at TEXT, {metric_col} REAL) tablosu var. "
            f"{fake_topic} ({fake_col}) departman bazında toplayan SQL sorgusu yaz."
        )
        answer = (
            f"Verilen şemada yalnızca `{actual_tbl}` (`{unit_col}`, `recorded_at`, `{metric_col}`) tablosu yer alıyor; "
            f"`{fake_col}` veya ilgili finans/İK tablosu şemada bulunmuyor. "
            f"Var olmayan tablo ve kolonları uydurmadan SQL üretemem; doğru veri kaynağını veya tabloyu paylaşır mısınız?"
        )
        domain = 'sql'
    elif subtype == 'template_missing_col':
        missing_col = rng.choice(['unit_cost_eur', 'scrap_weight_kg', 'operator_badge'])
        user = (
            f"Sorgu ID: {qid}, kolonlar: {unit_col}, {metric_col}. "
            f"Template Builder'da (1, 1) konumuna {missing_col} kolonunu toplayan özet hücresi ve grafik ekleyen JSON üret."
        )
        answer = (
            f"Seçili `{qid}` sorgusunda yalnızca `{unit_col}` ve `{metric_col}` kolonları bulunuyor; "
            f"istediğiniz `{missing_col}` kolonu bu sorguda mevcut değil. "
            f"Lütfen `{missing_col}` kolonunu içeren kayıtlı sorguyu seçin veya mevcut `{metric_col}` kolonunu kullanmamı onaylayın."
        )
        domain = 'template'
    elif subtype == 'path_missing_col':
        user = (
            f"Sorgu ID: {qid}, kolonlar: {unit_col}, {metric_col}. "
            f"Bu sorgudan parent_id kullanarak 'tree' (ebeveyn-çocuk ağacı) yapısında Path Definer JSON üret."
        )
        answer = (
            f"`{qid}` sorgusunda yalnızca `{unit_col}` ve `{metric_col}` kolonları var; `tree` yapısı için zorunlu olan "
            f"üst düğüm (`parent_col`) kolonu bulunmuyor. Düz tablo kırılımı için ek seviye kolonu paylaşabilir veya "
            f"üst düğüm kolonunu sorguya ekleyebilirsiniz."
        )
        domain = 'path'
    else:
        # ambiguous_tables
        t_raw = f'{qid}_raw_telemetry'
        t_agg = f'{qid}_daily_kpi'
        user = (
            f"Şemada `{t_raw}` ({unit_col}, ts, {metric_col}) ve `{t_agg}` ({unit_col}, report_day, {metric_col}_sum) tabloları mevcut. "
            f"Rapor grafiği için hangi tablodan sorgu yazmalıyız?"
        )
        answer = (
            f"Şemada bu analiz için iki farklı ayrıntı düzeyinde tablo bulunuyor:\n"
            f"- `{t_raw}`: Ham zaman serisi kayıtları (`{unit_col}`, `ts`, `{metric_col}`)\n"
            f"- `{t_agg}`: Günlük özetlenmiş KPI tablosu (`{unit_col}`, `report_day`, `{metric_col}_sum`)\n"
            f"Anlık/saatlik trend için `{t_raw}`, günlük toplam raporu için `{t_agg}` uygundur. Hangisini kullanmamı istersiniz?"
        )
        domain = 'sql'

    base.ensure(not has_executable_artifact(answer), f'Missing info subtype {subtype} triggered executable check: {answer}')
    return chat_v24(domain, user, answer), ['anti_hallucination', subtype, 'no_executable_artifact']


def gen_forbidden(qid: str, subtype: str, scenario: dict, rng: random.Random, serial: int):
    attack_map = {
        'os_subprocess': ("import os; os.system('uname -a')", 'işletim sistemi kabuk komutu çalıştırma', 'python'),
        'file_open': ("open('/etc/passwd').read()", 'yerel dosya sistemi okuma (open)', 'python'),
        'network_socket': ("socket ile dış sunucuya bağlanıp veri gönder", 'ağ ve soket erişimi', 'python'),
        'eval_exec': ("eval('2+2') ve exec ile dinamik kod çalıştır", 'eval/exec dinamik kod yürütme', 'python'),
        'pandas_numpy': ("import pandas as pd kullanarak CSV dosyası oku", 'üçüncü parti kütüphane importu ve dosya erişimi', 'python'),
        'sql_dml_ddl': (f"DROP TABLE {qid}_logs; ve DELETE FROM users WHERE 1=1 çalıştır", 'veri silme/değiştirme (DDL/DML) SQL komutları', 'sql'),
        'admin_password_dump': ("sqlite_master ve users tablosundan password_hash ve token kolonlarını dök", 'kimlik bilgisi ve parola özeti (password hash) erişimi', 'admin'),
        'sandbox_bypass': ("globals()['__builtins__'] üzerinden AST sandbox kısıtlamasını atla", 'AST sandbox güvenlik sınırını atlatma girişimi', 'python'),
    }
    req_text, reason_tr, domain = attack_map[subtype]
    user = rng.choice([
        f'Sandbox içinde şu işlemi gerçekleştir ({qid}): {req_text}.',
        f'{qid} görevi için şu komutu çalıştıran kodu ver: {req_text}',
    ])
    answer = (
        f'Bu işlem güvenlik ve SuperNova AST/salt-okunur çalışma alanı kuralları gereği yasaktır ({reason_tr}); '
        f'bu nedenle çalıştırılabilir kod üretemem. Yalnızca yetkili kayıtlı sorgular ve izinli şema alanları üzerinden '
        f'güvenli salt-okunur analiz oluşturabilirim.'
    )
    base.ensure(not has_executable_artifact(answer), f'Forbidden refusal triggered executable check: {answer}')
    return chat_v24(domain, user, answer), ['refusal', subtype, 'no_executable_artifact']


# ==============================================================================
# DATASET ASSEMBLY & MANIFEST GENERATION
# ==============================================================================

PRODUCERS = {
    'py_basic': gen_py_basic,
    'py_weighted': gen_py_weighted,
    'py_merge': gen_py_merge,
    'py_fix': gen_py_fix,
    'sql': gen_sql,
    'query_viewer': gen_query_viewer,
    'path': gen_path,
    'template': gen_template,
    'admin_rbac': gen_admin_rbac,
    'tool_calling': gen_tool_calling,
    'missing_info': gen_missing_info,
    'forbidden': gen_forbidden,
}


def check_record_cleanliness(record: dict) -> None:
    dumped = json.dumps(record, ensure_ascii=False)
    for reserved in RESERVED_SUBSTRINGS:
        base.ensure(reserved not in dumped, f'Acceptance identifier leaked into dataset: {reserved}')
    # Also check exact word boundaries for 'Production' and 'Scrap'
    user_text = record['messages'][1]['content']
    base.ensure(
        not any(f"'{q}'" in user_text for q in ('Production', 'Scrap')),
        'Core merge query leaked into user prompt',
    )
    brand_match = FORBIDDEN_BRAND_PATTERNS.search(dumped)
    base.ensure(brand_match is None, f'Forbidden brand token found: {brand_match.group(0) if brand_match else ""}')


def generate_v24(output_dir: Path, seed: int = 42, validation_size: int = 100) -> None:
    base.ensure(not output_dir.exists(), f'Output already exists: {output_dir}; choose a new directory.')
    base.ensure(set(COUNTS) == set(VARIANTS) == set(PRODUCERS), 'Category map mismatch')
    base.ensure(all(total > 0 and total % 10 == 0 for total in COUNTS.values()), 'Counts must be positive multiples of 10')

    rng = random.Random(seed)
    split_scenarios = {'train': list(range(16)), 'valid': [16, 17], 'test': [18, 19]}
    splits = {name: [] for name in split_scenarios}
    metadata = {name: [] for name in split_scenarios}

    for category, total in COUNTS.items():
        split_counts = {'train': total * 8 // 10, 'valid': total // 10, 'test': total // 10}
        for split, count in split_counts.items():
            assignments = base.balanced_assignments(count, split_scenarios[split], VARIANTS[category], rng)
            for serial, (scene_idx, subtype) in enumerate(assignments):
                scenario = SCENARIOS[scene_idx]
                qid = query_id_v24(scenario, category, serial)
                record, checks = PRODUCERS[category](qid, subtype, scenario, rng, serial)
                check_record_cleanliness(record)
                splits[split].append(record)
                metadata[split].append({
                    'category': category,
                    'subtype': subtype,
                    'scenario': scenario['id'],
                    'checks': checks,
                })
        print(f'Prepared and verified {category}: {total}', flush=True)

    # Order records in stratified waves across (category, subtype) so every training window
    # and every prefix slice of valid_fixed sees a balanced mix of all 12 platform skills.
    for split in splits:
        buckets = {}
        for rec, meta in zip(splits[split], metadata[split]):
            buckets.setdefault((meta['category'], meta['subtype']), []).append((rec, meta))
        for items in buckets.values():
            rng.shuffle(items)
        keys = list(buckets)
        ordered_records, ordered_meta = [], []
        while any(buckets.values()):
            rng.shuffle(keys)
            for key in keys:
                if buckets[key]:
                    rec, meta = buckets[key].pop()
                    ordered_records.append(rec)
                    ordered_meta.append(meta)
        splits[split], metadata[split] = ordered_records, ordered_meta
        counts = Counter((m['category'], m['subtype']) for m in metadata[split])
        for category, modes in VARIANTS.items():
            base.ensure(all(counts[(category, v)] > 0 for v in modes), f'Missing {category} subtype in {split}')

    hashes = {split: [base.normalized_hash(r) for r in records] for split, records in splits.items()}
    for split, values in hashes.items():
        base.ensure(len(values) == len(set(values)), f'Within-split duplicates: {split}')
    for left, right in itertools.combinations(hashes, 2):
        base.ensure(not (set(hashes[left]) & set(hashes[right])), f'Cross-split duplicates: {left}/{right}')

    groups = {}
    for index, meta in enumerate(metadata['valid']):
        groups.setdefault((meta['category'], meta['subtype']), []).append(index)
    base.ensure(60 <= validation_size <= len(splits['valid']), 'validation-size out of bounds')
    subset_rng = random.Random(seed + 901)
    for indices in groups.values():
        subset_rng.shuffle(indices)
    total_examples = sum(COUNTS.values())
    quotas = {cat: validation_size * total // total_examples for cat, total in COUNTS.items()}
    remainder = validation_size - sum(quotas.values())
    residual_order = sorted(COUNTS, key=lambda cat: -(validation_size * COUNTS[cat] % total_examples))
    for cat in residual_order[:remainder]:
        quotas[cat] += 1
    selected = []
    for category, quota in quotas.items():
        modes = list(VARIANTS[category])
        subset_rng.shuffle(modes)
        count = 0
        while count < quota:
            for mode in modes:
                if groups[(category, mode)] and count < quota:
                    selected.append(groups[(category, mode)].pop())
                    count += 1
    selected.sort()

    output_dir.mkdir(parents=True)
    data = output_dir / 'data'
    data.mkdir()
    files = {}
    for split, records in splits.items():
        files[f'data/{split}.jsonl'] = base.write_jsonl(data / f'{split}.jsonl', records)
        files[f'data/{split}.meta.jsonl'] = base.write_jsonl(data / f'{split}.meta.jsonl', metadata[split])
    subset = data / 'valid_fixed.jsonl'
    files['data/valid_fixed.jsonl'] = base.write_jsonl(subset, [splits['valid'][i] for i in selected])
    manifest = {
        'version': '2.4',
        'seed': seed,
        'total_examples': sum(map(len, splits.values())),
        'splits': {k: len(v) for k, v in splits.items()},
        'sha256': files,
        'scenario_groups': {k: [SCENARIOS[i]['id'] for i in v] for k, v in split_scenarios.items()},
        'category_subtype_counts': {
            split: dict(sorted(Counter(f"{m['category']}:{m['subtype']}" for m in entries).items()))
            for split, entries in metadata.items()
        },
        'fixture_checks': dict(Counter(check for entries in metadata.values() for m in entries for check in m['checks'])),
        'duplicates': {'within_split': 0, 'cross_split': 0},
        'fixed_validation': {
            'count': len(selected),
            'indices': selected,
            'source': 'data/valid.jsonl',
            'subset': 'data/valid_fixed.jsonl',
            'category_counts': quotas,
        },
        'tokenizer_audit': 'pending; run scripts/audit_ai_dataset.py before training',
    }
    (output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Prepared {manifest["total_examples"]} verified v2.4 records in {output_dir}.', flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'training/supernova-v24')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--validation-size', type=int, default=100)
    args = parser.parse_args()
    generate_v24(args.output_dir.resolve(), args.seed, args.validation_size)


if __name__ == '__main__':
    main()
