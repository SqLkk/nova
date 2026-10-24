#!/usr/bin/env python3
"""Prepare the final bounded v2.3 experiment on explicit user invocation only."""
from __future__ import annotations

import argparse
import ast
from contextlib import closing
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'supernova-backend'))

from ai_service import TOOL_DEFINITIONS
from ai_tools import validate_path, validate_template
from path_engine import build_structure
from scripts import generate_ai_dataset_v22 as base
from scripts.run_acceptance_suite import has_executable_artifact

COUNTS = {
    'py_basic': 200,
    'py_weighted': 400,
    'py_merge': 400,
    'py_fix': 300,
    'sql': 350,
    'path': 300,
    'template': 300,
    'forbidden': 250,
    'missing_info': 300,
    'tool_calling': 200,
}

VARIANTS = {category: list(modes) for category, modes in base.VARIANTS.items()}
VARIANTS['py_basic'] = ['sum', 'average', 'group', 'filter', 'range', 'oee_full']
VARIANTS['py_weighted'] = ['quality', 'availability', 'scrap', 'performance']
VARIANTS['py_merge'] = ['left_difference', 'left_net', 'left_balance', 'full_difference']
VARIANTS['py_fix'] = [
    'zero_division',
    'null_arithmetic',
    'unsupported_comprehension',
    'nested_output',
    'per_row_merge',
    'average_instead_of_weighted',
]
VARIANTS['sql'] = ['sum', 'count', 'average', 'sum_with_name', 'cte_sum']
VARIANTS['missing_info'] = (
    [str(i) for i in range(len(base.MISSING_INFO_CATEGORIES))]
    + ['oee_time_gap', 'oee_quality_gap', 'oee_perf_gap', 'oee_general_gap']
)


def code_from(record):
    return record['messages'][-1]['content'].split('\n', 1)[1].rsplit('```', 1)[0].strip()


def verify_output_contract(code):
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


def py_basic_v23(qid, subtype, rng):
    if subtype != 'oee_full':
        scene_idx = int(qid.split('_')[1][2:])
        serial_num = int(qid.rsplit('_', 1)[1])
        scene = base.SCENARIOS[scene_idx]
        record, checks = base.legacy_python(qid, 'py_basic', subtype, scene, rng, serial_num)
        verify_output_contract(code_from(record))
        return record, checks
    ident = rng.choice(['machine_code', 'line_id', 'station_key'])
    run_col = base.choose(rng, 'run_minutes')
    plan_col = base.choose(rng, 'planned_minutes')
    good_col = base.choose(rng, 'good_count')
    total_col = base.choose(rng, 'total_count')
    dataset = rng.choice(['oee_report', 'line_efficiency', 'oee_summary'])
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
    return base.chat('python', user, base.fenced('python', code)), ['ast', 'exact_rows', 'null_missing', 'empty']


def weighted(qid, subtype, rng):
    specs = {
        'quality': (
            ['good_qty', 'accepted', 'ok_units', 'valid_parts'],
            ['total_qty', 'processed', 'gross_units', 'inspected_parts'],
            'kalite',
            ['overall_quality_pct', 'quality_rate', 'percentage', 'weighted_rate'],
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
            ['scrap_qty', 'discarded', 'reject_units', 'defect_qty'],
            ['gross_qty', 'gross', 'total_produced', 'input_qty'],
            'hurda',
            ['scrap_pct', 'reject_rate', 'percentage', 'weighted_rate'],
            ['scrap_kpi', 'ratio_report', 'shift_summary', 'weighted_result'],
        ),
        'performance': (
            ['actual_output', 'produced_units', 'completed_cycles'],
            ['target_output', 'expected_units', 'standard_cycles'],
            'performans',
            ['performance_pct', 'efficiency_rate', 'percentage', 'overall_pct'],
            ['performance_kpi', 'ratio_report', 'shift_summary', 'weighted_result'],
        ),
    }
    num_pool, den_pool, title, field_pool, ds_pool = specs[subtype]
    numerator = rng.choice(num_pool) + rng.choice(['', '_val', '_count', '_amount'])
    denominator = rng.choice(den_pool) + rng.choice(['', '_val', '_count', '_amount'])
    if numerator == denominator:
        denominator = denominator + '_total'
    dataset = rng.choice(ds_pool)
    result_field = rng.choice(field_pool)
    extra_col = rng.choice(['line', 'shift_code', 'station', 'machine_id'])
    has_extra = rng.choice([True, False])
    cols_text = f'{extra_col}, {numerator}, {denominator}' if has_extra else f'{numerator}, {denominator}'
    user = rng.choice([
        (
            f"Kayıtlı sorgu '{qid}' kolonları: {cols_text}. "
            f"Her satırın kendi yüzdesinin ortalamasını alma; önce pay ve paydayı tüm satırlarda topla, "
            f"sonra genel ağırlıklı {title} yüzdesini hesapla. "
            f"Sonucu '{dataset}' adlı veri setine tek satır olarak {{'{result_field}': ...}} şeklinde yaz. "
            f"NULL değerleri 0 kabul et ve toplam {denominator} 0 ise 0.0 döndür."
        ),
        (
            f"Kayıtlı sorgu '{qid}', kolonlar: {cols_text}. "
            f"Satır yüzdelerinin ortalamasını alma; önce tüm satırlarda {numerator} ve {denominator} toplamlarını bul, "
            f"ardından genel ağırlıklı {title} oranını yüzde olarak hesapla. "
            f"'{dataset}' veri setine yalnızca '{result_field}' alanını içeren tek satır yaz. "
            f"NULL ve eksik değerleri 0 say; sıfır paydada 0.0 üret."
        ),
        (
            f"Kayıtlı sorgu '{qid}', kolonlar: {cols_text}. "
            f"Toplam {numerator} / toplam {denominator} * 100 ile genel {title} yüzdesini hesapla. "
            f"'{dataset}' veri setine tek satır, yalnızca '{result_field}' alanını yaz. "
            f"NULL ve eksik sayısal değerleri 0 say; boş veride veya sıfır paydada 0.0 üret."
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
        ('all_null', [{numerator: None, denominator: None}], 0.0),
        ('empty', [], 0.0),
    ]
    for name, rows, value in fixtures:
        actual = base.execute(code, {qid: rows})
        base.ensure(set(actual) == {dataset} and len(actual[dataset]) == 1, f'Weighted {name}: {actual}')
        base.ensure(set(actual[dataset][0]) == {result_field}, 'Unexpected weighted fields')
        base.ensure(math.isclose(actual[dataset][0][result_field], value, rel_tol=1e-9, abs_tol=1e-9), f'Weighted {name}: {actual}')
    return base.chat('python', user, base.fenced('python', code)), [f[0] for f in fixtures] + ['direct_row_output', 'ratio_after_aggregation']


def merge(qid, subtype, rng):
    qleft, qright = qid + '_left', qid + '_right'
    key = rng.choice(['machine', 'asset_code', 'line_key', 'equipment_no', 'workcell_id', 'station_code'])
    same_column = rng.choice([True, False])
    left_col = rng.choice(['qty', 'gross_qty', 'produced_qty', 'output_amount', 'gross_units'])
    right_col = left_col if same_column else rng.choice(['scrap_qty', 'reject_qty', 'loss_qty', 'defect_amount', 'rework_units'])
    dataset = rng.choice(['net_production', 'net_report', 'joined_totals', 'production_balance'])
    field_name = rng.choice(['net_qty', 'net_value', 'balance', 'usable_qty'])
    full = subtype == 'full_difference'
    if full:
        user = (
            f"Kayıtlı sorgular '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
            f"Her iki sorguyu önce {key} bazında ayrı sözlüklerde topla, sonra sol toplamdan sağ toplamı çıkar. "
            f"İki sorgudaki anahtarların birleşimini kullan; yalnızca sağ sorguda olan anahtarda sol toplam 0 olsun. "
            f"'{dataset}' veri setine yalnızca '{key}' ve '{field_name}' alanlarını yaz. "
            f"NULL anahtarları atla, NULL/eksik miktarları 0 say; iki liste de boşsa 0 satır üret."
        )
    else:
        user = rng.choice([
            (
                f"İki kayıtlı sorgu var: '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
                f"İki sorguyu {key} anahtarına göre birleştir. Her iki sorguda aynı {key} birden fazla satırda geçebilir; "
                f"önce {key} bazında toplam {left_col} ve toplam {right_col} değerlerini ayrı ayrı biriktir, "
                f"sonra net miktarı (toplam {left_col} - toplam {right_col}) hesapla. "
                f"Sonucu '{dataset}' adlı veri setine her {key} için tek satır olacak şekilde "
                f"{{'{key}': ..., '{field_name}': ...}} olarak yaz. "
                f"Yalnızca '{qleft}' sorgusunda görünen {key} anahtarlarını dahil et; yalnızca '{qright}' içinde olan "
                f"{key} değerlerini çıktıya ekleme. NULL anahtarları atla; eşleşmeyen kayıtlarda 0 kabul et."
            ),
            (
                f"Kayıtlı sorgular '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
                f"Tekrarlı kayıtları her iki tarafta {key} bazında gruplayıp sol toplamdan sağ toplamı çıkar. "
                f"Yalnızca sol sorguda bulunan anahtarları sonuçta göster; sağ taraftaki eşleşmeyen anahtarları alma. "
                f"'{dataset}' veri setine yalnızca '{key}' ve '{field_name}' alanlarını yaz. "
                f"NULL anahtarları atla, NULL/eksik miktarları 0 say. Eşleşmeyen miktar 0; iki liste de boşsa 0 satır üret."
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
        ('right_empty', [{key: 'X', left_col: 11}], [], {'X': 11}),
        ('left_empty', [], [{key: 'Z', right_col: 4}], {'Z': -4} if full else {}),
        ('both_empty', [], [], {}),
    ]
    for name, left, right, expected in fixtures:
        actual = base.execute(code, {qleft: left, qright: right})
        base.ensure(set(actual) <= {dataset}, f'Merge {name}: extra dataset')
        base.exact_rows(actual.get(dataset, []), [{key: k, field_name: v} for k, v in expected.items()])
    return base.chat('python', user, base.fenced('python', code)), [f[0] for f in fixtures] + ['direct_row_output', 'no_is_comparison']


def fix(qid, subtype, rng):
    if subtype == 'average_instead_of_weighted':
        record, checks = weighted(qid, 'quality', rng)
        correct = code_from(record)
        numerator, denominator = re.findall(r"row\.get\('([^']+)'", correct)
        bad = (
            f"rows = sql_data.get('{qid}', [])\n"
            'mean = 0.0\nfor row in rows:\n'
            f"    mean = mean + (row.get('{numerator}', 0) or 0) / (row.get('{denominator}', 0) or 1) * 100\n"
            'mean = mean / len(rows)'
        )
        instruction = 'Bu kod satır yüzdelerinin ortalamasını alıyor; genel ağırlıklı yüzde için iki toplamı ayrı hesapla. '
    elif subtype in ('nested_output', 'per_row_merge'):
        record, checks = merge(qid, 'left_difference', rng)
        correct = code_from(record)
        if subtype == 'nested_output':
            body, output = correct.rsplit('\n', 1)
            row_dict = output.split('.append(', 1)[1][:-1]
            dataset = re.search(r"out\('([^']+)'\)", output).group(1)
            bad = (
                'result_rows = []\n' + body + '\n    result_rows.append(' + row_dict + ')\n'
                f"out('{dataset}').append(result_rows)"
            )
            instruction = 'Toplamlar doğru, fakat çıktı tek bir iç içe liste oldu. Her anahtarın sözlüğünü doğrudan out().append() ile ayrı yaz. '
        else:
            qleft, qright = qid + '_left', qid + '_right'
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
            instruction = 'Bu kod tekrar eden sol kayıtları ayrı yazıp aynı kaybı her satırdan düşürüyor. Her iki sorguyu önce gruplayıp tek satır/anahtar üret. '
    else:
        scene_idx = int(qid.split('_')[1][2:])
        serial_num = int(qid.rsplit('_', 1)[1])
        scene = base.SCENARIOS[scene_idx]
        return base.legacy_python(qid, 'py_fix', subtype, scene, rng, serial_num)
    record['messages'][1]['content'] = (
        instruction.strip() + '\n\nHatalı kod:\n' + base.fenced('python', bad)
    )
    verify_output_contract(correct)
    return record, checks + ['error_correction', 'direct_row_output']


def sql_v23(qid, subtype, rng):
    if subtype in ('sum', 'count', 'average') and rng.choice([True, False]):
        return base.sql_example(qid, subtype, rng)
    main = qid + rng.choice(['_machines', '_assets', '_lines'])
    events = qid + rng.choice(['_downtime_logs', '_events', '_stops'])
    key = rng.choice(['id', 'asset_key', 'machine_id'])
    name_col = rng.choice(['name', 'machine_name', 'title'])
    foreign = rng.choice(['machine_id', 'asset_ref', 'line_id'])
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
        agg = f'COUNT(d.event_no)' if subtype == 'count' else f'{func}(d.{metric})'
        sql = (
            f'SELECT m.{key}, m.{name_col}, COALESCE({agg}, 0.0) AS {alias}\n'
            f'FROM {main} m\n'
            f'LEFT JOIN {events} d ON m.{key} = d.{foreign} AND d.{stamp} BETWEEN :start AND :end\n'
            f'GROUP BY m.{key}, m.{name_col}\n'
            f'ORDER BY m.{key}'
        )
    user = (
        f'SQLite şeması: {main}({key} TEXT, {name_col} TEXT) ve '
        f'{events}(event_no TEXT, {foreign} TEXT, {stamp} TEXT, {metric} REAL). '
        f':start ile :end tarihleri arasındaki toplam değeri makine bazında listeleyen tek bir salt-okunur SQL sorgusu yaz. '
        f'Seçilen tarih aralığında hiç kaydı olmayan makineler de sonuçta 0 olarak görünmeli; '
        f'aralık dışı kayıtlar toplama dahil edilmemeli.'
    )
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute(f'CREATE TABLE {main}({key} TEXT, {name_col} TEXT)')
        conn.execute(f'CREATE TABLE {events}(event_no TEXT, {foreign} TEXT, {stamp} TEXT, {metric} REAL)')
        conn.executemany(f'INSERT INTO {main} VALUES (?, ?)', [('M1', 'Press 1'), ('M2', 'Press 2'), ('M3', 'Weld 3')])
        conn.executemany(
            f'INSERT INTO {events} VALUES (?, ?, ?, ?)',
            [
                ('e1', 'M1', '2026-04-04', 12.0),
                ('e2', 'M1', '2026-04-08', 6.0),
                ('e3', 'M1', '2026-04-10', None),
                ('e4', 'M2', '2026-05-05', 99.0),
            ],
        )
        conn.execute('PRAGMA query_only=ON')
        rows = conn.execute(sql, {'start': '2026-04-01', 'end': '2026-04-30'}).fetchall()
        expected = 3 if subtype == 'count' else (9.0 if subtype == 'average' else 18.0)
        base.ensure(
            rows == [('M1', 'Press 1', expected), ('M2', 'Press 2', 0.0), ('M3', 'Weld 3', 0.0)],
            f'SQL v23 result mismatch: {rows}',
        )
    return base.chat('sql', user, base.fenced('sql', sql)), ['outside_range', 'no_events', 'null_metric', 'exact_aggregate', 'two_col_parent']


def path_v23(qid, subtype, rng):
    ident = base.choose(rng, 'step_id' if subtype == 'dag' else 'node_code')
    label = base.choose(rng, 'step_name' if subtype == 'dag' else 'caption_text')
    relation = base.choose(rng, 'prev_steps' if subtype == 'dag' else 'ancestor_key')
    order = base.choose(rng, 'step_position')
    group = base.choose(rng, 'cluster_key')
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
            f'{ident} benzersiz kimlik, {relation} virgülle ayrılmış birden fazla üst adımı tutan kolon ve {label} görünen isimdir.'
            if subtype == 'dag'
            else f'{relation} üst düğümü, {label} görünen etiketi gösterir.'
        )
    elif subtype == 'sequence':
        config['order_col'] = order
        third_col = order
        rows = [
            {ident: 'R', order: 3, label: 'Root'},
            {ident: 'S', order: 1, label: 'Second'},
            {ident: 'T', order: 2, label: 'Third'},
        ]
        detail = f'Artan sıralama {order} kolonuna göredir; {label} görünen etikettir.'
    else:
        config['group_col'] = group
        third_col = group
        rows = [
            {ident: 'R', group: 'G1', label: 'Root'},
            {ident: 'S', group: 'G1', label: 'Second'},
            {ident: 'T', group: 'G2', label: 'Third'},
        ]
        detail = f'Gruplama {group} kolonuna göredir; {label} görünen etikettir.'
    columns = [ident, third_col, label] if rng.choice([True, False]) else [ident, label, third_col]
    artifact = {'structure': subtype, 'queryId': qid, 'config': config}
    validate_path(artifact, [{'id': qid, 'columns': columns}])
    built = build_structure(subtype, rows, config)
    nodes = {n['id']: n for n in built['nodes']}
    if subtype == 'dag':
        base.ensure(set(nodes['T']['parents']) == {'R', 'S'}, 'DAG parents mismatch')
    user = rng.choice([
        f"Kayıtlı sorgu '{qid}' kolonları: {', '.join(columns)}. {detail} Bu akışı '{subtype}' yapısında Path Definer için JSON olarak döndür.",
        f"Sorgu ID: {qid}. Kolonlar: {', '.join(columns)}. Yapı: {subtype}. {detail} Path Definer JSON hazırla.",
    ])
    return base.chat('path', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'exact_structure']


def template_v23(qid, subtype, rng):
    x = base.choose(rng, 'ts' if rng.choice([True, False]) else 'sample_time')
    y = base.choose(rng, 'kwh' if rng.choice([True, False]) else 'measured_value')
    if rng.choice([True, False]):
        row, col, cell_row = 1, 1, 14
    else:
        row, col = rng.randint(1, 12), rng.randint(1, 4)
        cell_row = row + 12
    operation = rng.choice(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'])
    tr_names = {
        'line': 'çizgi grafiği (line)',
        'bar': 'çubuk grafiği (bar)',
        'pie': 'pasta grafiği (pie)',
        'area': 'alan grafiği (area)',
    }
    chart_label = rng.choice([subtype, tr_names[subtype], 'çizgi grafiği' if subtype == 'line' else subtype])
    artifact = {
        'charts': [{
            'id': qid + '_chart',
            'type': subtype,
            'anchor': {'row': row, 'col': col, 'widthCols': 6, 'heightRows': 10},
            'queryId': qid,
            'xAxis': x,
            'yAxis': [y],
            'title': 'Vardiya raporu',
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
            f"Kayıtlı sorgu '{qid}' kolonları: {x}, {y}. "
            f"Sayfaya ({row}, {col}) konumunda bir {chart_label} ve ({cell_row}, {col}) hücresinde "
            f"toplam/özet {y} ({operation}) değerini gösteren özet (summary) hücresi ekleyen "
            f"TemplateBuilder fragment JSON üret."
        ),
        (
            f'Sorgu ID: {qid}, kolonlar: {x}, {y}. ({row}, {col}) hücresine {x}/{y} kullanan {chart_label} grafiği, '
            f'({cell_row}, {col}) hücresine {operation}({y}) özetini yerleştiren charts/cells JSON parçası üret.'
        ),
    ])
    return base.chat('template', user, base.fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'anchors', 'binding']


def missing(qid, subtype, rng):
    if subtype not in ('0', 'oee_time_gap', 'oee_quality_gap', 'oee_perf_gap', 'oee_general_gap'):
        record, checks = base.missing_example(qid, subtype, rng)
        ans = record['messages'][-1]['content']
        base.ensure(not has_executable_artifact(ans), f'Missing info triggered executable detector: {ans}')
        return record, checks
    ident = rng.choice(['machine', 'device_key', 'workcell_code', 'station_id'])
    if subtype == 'oee_time_gap':
        columns = [ident, 'accepted_qty', 'total_qty']
        absent = 'planlanan üretim süresi, fiili çalışma süresi (duruş süresi) ve ideal çevrim süresi (hedef hız)'
    elif subtype == 'oee_quality_gap':
        columns = [ident, 'planned_minutes', 'active_minutes', 'ideal_cycle_sec', 'total_qty']
        absent = 'sağlam ürün adedi (good count) veya hurda/fire adedi (scrap)'
    elif subtype == 'oee_perf_gap':
        columns = [ident, 'planned_minutes', 'active_minutes', 'good_qty', 'scrap_qty']
        absent = 'ideal çevrim süresi (cycle time) veya hedef üretim hızı'
    else:
        columns = [ident, rng.choice(['qty', 'unit_count', 'total_count'])]
        absent = 'planlanan üretim süresi, çalışma/duruş süresi, ideal çevrim süresi (hedef hız) ve sağlam/hurda adetleri'
    user = (
        f"Elimde sadece '{qid}' sorgusu var; kolonları: {', '.join(columns)}. "
        f"Bu veriden tam OEE (Availability x Performance x Quality) hesaplayan Python scripti yaz."
    )
    answer = (
        f"Mevcut '{qid}' sorgusundaki kolonlar ({', '.join(columns)}) tam OEE hesabı için yeterli değil; "
        f"eksik kolonlar nedeniyle kod üretemem. Tam OEE hesabı için şu üç bileşenin verileri gereklidir:\n"
        f"- Kullanılabilirlik (Availability): planlanan üretim süresi ve fiili çalışma süresi (veya duruş süresi)\n"
        f"- Performans (Performance): ideal çevrim süresi (cycle time / hedef hız) ve toplam üretim adedi\n"
        f"- Kalite (Quality): sağlam ürün adedi (good) ve hurda/fire adedi (scrap)\n"
        f"Lütfen eksik olan {absent} kolonlarını içeren kayıtlı sorguyu paylaşır mısınız?"
    )
    base.ensure(not has_executable_artifact(answer), 'OEE missing answer triggered executable detector')
    lower = answer.lower()
    base.ensure(any(k in lower for k in ('eksik', 'yeterli değil', 'bulunmuyor')), 'Missing gap keyword')
    base.ensure(any(k in lower for k in ('kullanılabilirlik', 'availability', 'planlanan', 'çalışma süresi', 'duruş')), 'Missing availability keyword')
    base.ensure(any(k in lower for k in ('performans', 'performance', 'çevrim', 'cycle', 'hedef hız')), 'Missing performance keyword')
    base.ensure(any(k in lower for k in ('kalite', 'quality', 'sağlam', 'hurda', 'fire', 'scrap')), 'Missing quality keyword')
    return base.chat('python', user, answer), ['specific_missing_information', 'no_executable_artifact', 'oee_all_components']


def tool_v23(qid, subtype, rng):
    record, checks = base.tool_example(qid, subtype, rng)
    if subtype == 'roundtrip' and rng.choice([True, False]):
        table = qid + '_assets'
        qname = qid + '_query'
        col1 = base.choose(rng, 'equipment_key')
        col2 = base.choose(rng, 'observed_total')
        schema = {
            'sources': [{'id': qid + '_src', 'name': 'Factory DB', 'tables': [{'name': table, 'columns': [col1, col2]}]}],
            'queries': [{'id': qid, 'name': qname, 'columns': [col1, col2]}],
        }
        record['messages'][1]['content'] = (
            f'Hangi veritabanı tabloları ve kayıtlı sorgular mevcut bilmiyorum ({qid}). '
            f'Önce şemayı keşfet, sonra kullanabileceğim tablo ve sorguları kolonlarıyla özetle.'
        )
        record['messages'][3]['content'] = json.dumps(schema)
        record['messages'][4]['content'] = (
            f'Veritabanı şemasında `{table}` tablosu ve `{qname}` (`{qid}`) kayıtlı sorgusu bulunuyor. '
            f'Kullanılabilir kolonlar: `{col1}`, `{col2}`.'
        )
    return record, checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'training/supernova-v23')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--validation-size', type=int, default=80)
    args = parser.parse_args()
    base.generate(
        args.output_dir.resolve(),
        args.seed,
        args.validation_size,
        version='2.3',
        counts=COUNTS,
        variants=VARIANTS,
        overrides={
            'py_basic': py_basic_v23,
            'py_weighted': weighted,
            'py_merge': merge,
            'py_fix': fix,
            'sql': sql_v23,
            'path': path_v23,
            'template': template_v23,
            'missing_info': missing,
            'tool_calling': tool_v23,
        },
    )


if __name__ == '__main__':
    main()
