#!/usr/bin/env python3
"""Prepare v2.2 data when explicitly run; never load a model or train adapters.

Scenario families stay disjoint. Semantic variants are balanced independently in
each split. Reference outputs are checked against the actual SuperNova engines.
The separate tokenizer audit must pass before the training wrapper accepts data.
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

from ai_prompts import BASE_PROMPT, PYTHON_PROMPT, SQL_PROMPT, PATH_PROMPT, TEMPLATE_PROMPT
from ai_service import TOOL_DEFINITIONS
from ai_tools import validate_path, validate_python, validate_template
from path_engine import build_structure
from safe_interpreter.interpreter import OutHelper, SafeASTInterpreter, _safe_builtins
from scripts.generate_ai_dataset_v21 import (
    SCENARIOS, FORBIDDEN_ATTACK_CATEGORIES, MISSING_INFO_CATEGORIES,
    gen_python_basic, gen_python_faulty_fix,
)

COUNTS = {
    'py_basic': 250, 'py_weighted': 300, 'py_merge': 300, 'py_fix': 150,
    'sql': 500, 'path': 400, 'template': 400, 'forbidden': 250,
    'missing_info': 250, 'tool_calling': 200,
}
VARIANTS = {
    'py_basic': ['sum', 'average', 'group', 'filter', 'range'],
    'py_weighted': ['quality', 'availability', 'scrap'],
    'py_merge': ['left_difference', 'full_difference'],
    'py_fix': ['zero_division', 'null_arithmetic', 'unsupported_comprehension'],
    'sql': ['sum', 'count', 'average'],
    'path': ['tree', 'binary_tree', 'sequence', 'grouped', 'dag'],
    'template': ['line', 'bar', 'pie', 'area'],
    'forbidden': [str(i) for i in range(len(FORBIDDEN_ATTACK_CATEGORIES))],
    'missing_info': [str(i) for i in range(len(MISSING_INFO_CATEGORIES))],
    'tool_calling': ['call', 'roundtrip'],
}
PROMPTS = {'python': PYTHON_PROMPT, 'sql': SQL_PROMPT,
           'path': PATH_PROMPT, 'template': TEMPLATE_PROMPT}
RESERVED_QUERIES = {'Quality_Summary', 'Production', 'Scrap', 'q_workflow',
                    'q_energy_blind', 'Production_Simple'}


def ensure(condition, message):
    # These checks remain enabled even if Python is launched with -O.
    if not condition:
        raise ValueError(message)


def chat(domain, user, answer):
    return {'messages': [
        {'role': 'system', 'content': BASE_PROMPT + PROMPTS.get(domain, '')},
        {'role': 'user', 'content': user},
        {'role': 'assistant', 'content': answer},
    ]}


def fenced(language, content):
    return f'```{language}\n{content}\n```'


def execute(code, data):
    validate_python(code)
    out = OutHelper()
    SafeASTInterpreter(_safe_builtins(out), {'sql_data': data},
                       max_statements=20000).evaluate(ast.parse(code))
    return out.get_results()


def exact_rows(actual, expected):
    canonical = lambda rows: sorted(json.dumps(r, sort_keys=True) for r in rows)
    ensure(canonical(actual) == canonical(expected), f'Expected {expected}, got {actual}')


def choose(rng, stem):
    return rng.choice([stem, f'{stem}_value', f'{stem}_amount', f'{stem}_reading'])


def query_id(scenario, category, serial, version='2.2'):
    category_code = {'py_basic': 'pb', 'py_weighted': 'pw', 'py_merge': 'pm', 'py_fix': 'pf',
                     'sql': 'sql', 'path': 'path', 'template': 'tpl', 'forbidden': 'no',
                     'missing_info': 'gap', 'tool_calling': 'tool'}[category]
    # Compact query identities keep multi-turn tool records within 1024 tokens.
    return f"v{version.replace('.', '')}_{scenario['id'].split('_')[0]}_{category_code}_{serial:03d}"


def python_weighted(qid, subtype, rng):
    names = {
        'quality': ('accepted', 'processed', 'kalite', 100.0),
        'availability': ('running_minutes', 'planned_minutes', 'kullanılabilirlik', 100.0),
        'scrap': ('discarded', 'gross', 'hurda', 100.0),
    }
    nbase, dbase, title, scale = names[subtype]
    numerator, denominator = choose(rng, nbase), choose(rng, dbase)
    dataset = rng.choice(['ratio_report', 'shift_summary', 'weighted_result'])
    result_field = rng.choice(['percentage', 'weighted_rate', 'overall_pct'])
    wording = rng.choice([
        f'Toplam {numerator} / toplam {denominator} * 100 ile genel {title} yüzdesini hesapla.',
        f'Satır oranlarını ortalamadan, iki kolonu ayrı ayrı toplayıp genel {title} oranını yüzde olarak bul.',
        f'{title.capitalize()} raporu için önce pay ve paydayı tüm satırlarda biriktir, ardından yüzdelik oranı hesapla.',
    ])
    user = (f"Kayıtlı sorgu '{qid}', kolonlar: {numerator}, {denominator}. {wording} "
            f"'{dataset}' veri setine tek satır, yalnızca '{result_field}' alanını yaz. "
            'NULL ve eksik sayısal değerleri 0 say; boş veride veya sıfır paydada 0.0 üret.')
    acc1, acc2 = rng.choice([('sum_numerator', 'sum_denominator'),
                             ('numerator_total', 'denominator_total'), ('top', 'bottom')])
    code = '\n'.join([
        f"rows = sql_data.get('{qid}', [])", f'{acc1} = 0.0', f'{acc2} = 0.0',
        'for row in rows:', f"    {acc1} = {acc1} + (row.get('{numerator}', 0) or 0)",
        f"    {acc2} = {acc2} + (row.get('{denominator}', 0) or 0)",
        'value = 0.0', f'if {acc2} > 0:', f'    value = ({acc1} / {acc2}) * {scale}',
        f"out('{dataset}').append({{'{result_field}': value}})",
    ])
    fixtures = [
        ('unequal_weights', [{numerator: 21, denominator: 70}, {numerator: 18, denominator: 20}], 39 / 90 * 100),
        ('null_and_missing', [{numerator: None, denominator: 10}, {numerator: 12, denominator: 30}, {}], 30.0),
        ('zero_denominator', [{numerator: 7, denominator: 0}], 0.0),
        ('all_null', [{numerator: None, denominator: None}], 0.0),
        ('empty', [], 0.0),
    ]
    for name, rows, value in fixtures:
        actual = execute(code, {qid: rows})
        ensure(set(actual) == {dataset} and len(actual[dataset]) == 1, f'Weighted {name}: {actual}')
        ensure(set(actual[dataset][0]) == {result_field}, 'Unexpected weighted fields')
        ensure(math.isclose(actual[dataset][0][result_field], value, rel_tol=1e-9, abs_tol=1e-9),
               f'Weighted {name}: {actual}')
    return chat('python', user, fenced('python', code)), [f[0] for f in fixtures]


def python_merge(qid, subtype, rng):
    qleft, qright = qid + '_left', qid + '_right'
    key = rng.choice(['asset_code', 'line_key', 'equipment_no', 'workcell_id'])
    same_column = rng.choice([True, False])
    left_col = choose(rng, 'gross_qty')
    right_col = left_col if same_column else choose(rng, 'reject_qty')
    dataset = rng.choice(['net_report', 'joined_totals', 'production_balance'])
    field_name = rng.choice(['net_value', 'balance', 'usable_qty'])
    full = subtype == 'full_difference'
    scope = ('İki sorgudaki anahtarların birleşimini kullan; yalnızca sağ sorguda olan anahtarda sol toplam 0 olsun.'
             if full else 'Yalnızca sol sorguda bulunan anahtarları sonuçta göster; sağ taraftaki eşleşmeyen anahtarları alma.')
    request = rng.choice([
        'İki sorguyu ayrı ayrı anahtar bazında topla, sonra sol toplamdan sağ toplamı çıkar.',
        'Her anahtar için sol ve sağ miktarları biriktirip net miktarı hesapla; her anahtar tek satır olsun.',
        'Tekrarlı kayıtları her iki tarafta grupla ve toplamların farkını üret.',
    ])
    user = (f"Kayıtlı sorgular '{qleft}' ({key}, {left_col}) ve '{qright}' ({key}, {right_col}). "
            f"{request} {scope} '{dataset}' veri setine yalnızca '{key}' ve '{field_name}' alanlarını yaz. "
            'NULL anahtarları atla, NULL/eksik miktarları 0 say. Eşleşmeyen miktar 0; iki liste de boşsa 0 satır üret.')
    lines = [f"left_rows = sql_data.get('{qleft}', [])", f"right_rows = sql_data.get('{qright}', [])",
             'left_totals = {}', 'right_totals = {}']
    for side, col in [('left', left_col), ('right', right_col)]:
        lines += [f'for row in {side}_rows:', f"    key = row.get('{key}')", '    if key != None:',
                  f"        {side}_totals[key] = {side}_totals.get(key, 0) + (row.get('{col}', 0) or 0)"]
    if full:
        lines += ['keys = []', 'for key in left_totals:', '    keys.append(key)',
                  'for key in right_totals:', '    if key not in keys:', '        keys.append(key)',
                  'for key in keys:', '    net = left_totals.get(key, 0) - right_totals.get(key, 0)']
    else:
        lines += ['for key, total in left_totals.items():', '    net = total - right_totals.get(key, 0)']
    lines += [f"    out('{dataset}').append({{'{key}': key, '{field_name}': net}})"]
    code = '\n'.join(lines)
    fixtures = [
        ('duplicates_both_sides', [{key: 'X', left_col: 36}, {key: 'X', left_col: 24}, {key: 'Y', left_col: 18}],
         [{key: 'X', right_col: 3}, {key: 'X', right_col: 4}, {key: 'Z', right_col: 2}], {'X': 53, 'Y': 18, **({'Z': -2} if full else {})}),
        ('null_and_missing', [{key: 'X', left_col: None}, {key: 'X', left_col: 9}, {key: None, left_col: 99}, {key: 'Y'}],
         [{key: 'X', right_col: None}, {key: 'X', right_col: 2}, {key: None, right_col: 88}], {'X': 7, 'Y': 0}),
        ('right_empty', [{key: 'X', left_col: 11}], [], {'X': 11}),
        ('left_empty', [], [{key: 'Z', right_col: 4}], {'Z': -4} if full else {}),
        ('both_empty', [], [], {}),
    ]
    for name, left, right, expected in fixtures:
        actual = execute(code, {qleft: left, qright: right})
        ensure(set(actual) <= {dataset}, f'Merge {name}: extra dataset')
        exact_rows(actual.get(dataset, []), [{key: k, field_name: v} for k, v in expected.items()])
    return chat('python', user, fenced('python', code)), [f[0] for f in fixtures]


def sql_example(qid, subtype, rng):
    main, events = qid + '_assets', qid + '_events'
    key, foreign = choose(rng, 'asset_key'), choose(rng, 'asset_ref')
    stamp, metric = choose(rng, 'recorded_at'), choose(rng, 'duration')
    function = {'sum': 'SUM', 'count': 'COUNT', 'average': 'AVG'}[subtype]
    aggregate = f'{function}(e.{metric})' if subtype != 'count' else 'COUNT(e.event_no)'
    sql = (f'SELECT a.{key}, COALESCE({aggregate}, 0.0) AS result\nFROM {main} a\n'
           f'LEFT JOIN {events} e ON a.{key} = e.{foreign} AND e.{stamp} BETWEEN :start AND :end\n'
           f'GROUP BY a.{key}\nORDER BY a.{key}')
    user = (f'SQLite şeması: {main}({key} TEXT), {events}(event_no TEXT, {foreign} TEXT, {stamp} TEXT, {metric} REAL). '
            f':start ve :end arasında varlık bazında {function} hesabı yap. Aralıkta olayı olmayan varlıkları da 0 ile göster. '
            'Tek salt okunur SQL üret; tarihleri parametre olarak kullan.')
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute(f'CREATE TABLE {main}({key} TEXT)')
        conn.execute(f'CREATE TABLE {events}(event_no TEXT, {foreign} TEXT, {stamp} TEXT, {metric} REAL)')
        conn.executemany(f'INSERT INTO {main} VALUES (?)', [('X',), ('Y',), ('Z',)])
        conn.executemany(f'INSERT INTO {events} VALUES (?, ?, ?, ?)', [
            ('e1', 'X', '2026-04-04', 12.0), ('e2', 'X', '2026-04-08', 6.0),
            ('e3', 'X', '2026-04-10', None), ('e4', 'Y', '2026-05-05', 99.0),
        ])
        conn.execute('PRAGMA query_only=ON')
        rows = conn.execute(sql, {'start': '2026-04-01', 'end': '2026-04-30'}).fetchall()
        expected = {'sum': 18.0, 'count': 3, 'average': 9.0}[subtype]
        ensure(rows == [('X', expected), ('Y', 0.0), ('Z', 0.0)], f'SQL result: {rows}')
    return chat('sql', user, fenced('sql', sql)), ['outside_range', 'no_events', 'null_metric', 'exact_aggregate']


def path_example(qid, subtype, rng):
    ident, label = choose(rng, 'node_code'), choose(rng, 'caption_text')
    relation = choose(rng, 'upstream_keys' if subtype == 'dag' else 'ancestor_key')
    order, group = choose(rng, 'step_position'), choose(rng, 'cluster_key')
    config = {'id_col': ident, 'label_col': label}
    rows = [{ident: 'R', label: 'Root'}, {ident: 'S', label: 'Second'}, {ident: 'T', label: 'Third'}]
    if subtype in ('tree', 'binary_tree', 'dag'):
        config['parents_col' if subtype == 'dag' else 'parent_col'] = relation
        for row, parents in zip(rows, ['', '' if subtype == 'dag' else 'R', 'R,S' if subtype == 'dag' else 'R']):
            row[relation] = parents
        detail = f'{relation} üst düğümleri içerir; çoklu değerler virgülle ayrılır.'
    elif subtype == 'sequence':
        config['order_col'] = order
        for row, number in zip(rows, [3, 1, 2]):
            row[order] = number
        detail = f'Artan sıralama {order} kolonuna göredir.'
    else:
        config['group_col'] = group
        for row, value in zip(rows, ['G1', 'G1', 'G2']):
            row[group] = value
        detail = f'Gruplama {group} kolonuna göredir.'
    columns = list(rows[0])
    artifact = {'structure': subtype, 'queryId': qid, 'config': config}
    validate_path(artifact, [{'id': qid, 'columns': columns}])
    built = build_structure(subtype, rows, config)
    nodes = {n['id']: n for n in built['nodes']}
    if subtype == 'dag':
        ensure(set(nodes['T']['parents']) == {'R', 'S'}, 'DAG parents mismatch')
        ensure('T' in nodes['R']['children'] and 'T' in nodes['S']['children'], 'DAG children mismatch')
    elif subtype in ('tree', 'binary_tree'):
        ensure(nodes['S']['parent'] == 'R' and nodes['T']['parent'] == 'R', 'Tree parent mismatch')
    elif subtype == 'sequence':
        ensure([n['id'] for n in built['nodes']] == ['S', 'T', 'R'], 'Sequence order mismatch')
    else:
        ensure(nodes['R']['parent'] == 'group::G1' and nodes['T']['parent'] == 'group::G2', 'Group mismatch')
    request = rng.choice(['Path Definer JSON hazırla.', 'Şemadaki kolonlarla yapı eşlemesini üret.', 'Harita konfigürasyonunu JSON olarak ver.'])
    user = f"Sorgu ID: {qid}. Kolonlar: {', '.join(columns)}. Yapı: {subtype}. {detail} {request}"
    return chat('path', user, fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'exact_structure']


def template_example(qid, subtype, rng):
    x, y = choose(rng, 'sample_time'), choose(rng, 'measured_value')
    row, col = rng.randint(1, 12), rng.randint(1, 4)
    operation = rng.choice(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'])
    artifact = {'charts': [{'id': qid + '_chart', 'type': subtype,
                           'anchor': {'row': row, 'col': col, 'widthCols': 6, 'heightRows': 10},
                           'queryId': qid, 'xAxis': x, 'yAxis': [y], 'title': 'Vardiya raporu'}],
                'cells': [{'row': row + 12, 'col': col, 'value': '',
                           'binding': {'kind': 'summary', 'queryId': qid, 'field': y, 'operation': operation}}]}
    validate_template(artifact, [{'id': qid, 'columns': [x, y]}])
    user = (f'Sorgu ID: {qid}, kolonlar: {x}, {y}. ({row}, {col}) hücresine {x}/{y} kullanan {subtype} grafiği, '
            f'({row + 12}, {col}) hücresine {operation}({y}) özetini yerleştiren charts/cells JSON parçası üret.')
    return chat('template', user, fenced('json', json.dumps(artifact, ensure_ascii=False))), ['schema', 'anchors', 'binding']


def refusal_example(qid, subtype, rng):
    request, description = FORBIDDEN_ATTACK_CATEGORIES[int(subtype)]
    user = rng.choice([f'{qid} incelemesi için sandbox içinde şu işlemi yap: {request}',
                       f'Veri analizi için bu komutu çalıştırıp sonucu ver: {request}. Talep: {qid}.'])
    answer = (f'Bu işlem sandbox içinde yasaktır: {description}. Dosya, OS, ağ veya dinamik kod erişimi sağlayamam. '
              "Yetkili kayıtlı sorgu verileri üzerinden sql_data ve out ile güvenli bir analiz hazırlayabilirim.")
    ensure('```' not in answer and not re.search(r'\b(open|eval|exec)\s*\(', answer), 'Unsafe refusal reference')
    return chat('python', user, answer), ['refusal', 'no_executable_artifact']


def missing_example(qid, subtype, rng):
    name, requirements = MISSING_INFO_CATEGORIES[int(subtype)]
    ident, value = choose(rng, 'unit_code'), choose(rng, 'row_count')
    user = f"Kayıtlı sorgu '{qid}', yalnızca {ident}, {value} kolonları var. {name} hesaplayan script hazırla."
    answer = (f'Mevcut kolonlar {name} hesabı için yeterli değil. Eksik bilgiler: '
              + '; '.join(requirements) + '. Bu verileri içeren sorgu ve kolon adlarını belirtir misiniz?')
    ensure('```' not in answer, 'Missing information reference contains code')
    return chat('python', user, answer), ['specific_missing_information', 'no_executable_artifact']


def tool_example(qid, subtype, rng):
    table, ident, metric = qid + '_assets', choose(rng, 'equipment_key'), choose(rng, 'observed_total')
    messages = [{'role': 'system', 'content': BASE_PROMPT},
                {'role': 'user', 'content': f'{qid} raporunda kullanabileceğim tabloları ve kolonları bilmiyorum. Şemayı getir.'},
                {'role': 'assistant', 'content': '', 'tool_calls': [
                    {'id': qid + '_call', 'type': 'function',
                     'function': {'name': 'tool_get_database_schema', 'arguments': {}}}]}]
    if subtype == 'roundtrip':
        schema = {'sources': [{'name': qid + '_db', 'tables': [{'name': table, 'columns': [ident, metric]}]}]}
        messages += [{'role': 'tool', 'name': 'tool_get_database_schema', 'tool_call_id': qid + '_call',
                      'content': json.dumps(schema)},
                     {'role': 'assistant', 'content': f'Şemada {table} tablosu var. Kolonları: {ident}, {metric}. Bu alanlarla analiz hazırlayabilirim.'}]
    ensure(messages[2]['tool_calls'][0]['function']['arguments'] == {}, 'Invalid schema arguments')
    return {'messages': messages, 'tools': TOOL_DEFINITIONS}, ['structured_call', subtype]


def legacy_python(qid, category, subtype, scenario, rng, serial):
    # Preserve verified simple/fix examples while decoupling operation from scenario.
    variants = VARIANTS[category]
    index = serial * len(variants) + variants.index(subtype)
    producer = gen_python_basic if category == 'py_basic' else gen_python_faulty_fix
    prompt, user, answer = producer(index, rng, scenario)
    old_query = re.search(r"sql_data\.get\('([^']+)'", answer).group(1)
    user, answer = user.replace(old_query, qid), answer.replace(old_query, qid)
    # Basic aggregation/filtering already runs normal and empty fixtures in producer.
    # Fix tasks are explicitly re-executed with their new query identity below.
    code = answer.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    validate_python(code)
    if category == 'py_fix':
        data = [{'val': 6}, {'val': None}, {'val': 4}, {}]
        actual = execute(code, {qid: data})
        expected = {'zero_division': [{'avg': 5.0, 'count': 2}],
                    'null_arithmetic': [{'val': 12}, {'val': 8}],
                    'unsupported_comprehension': [{'cnt': 2}]}[subtype]
        exact_rows(actual.get('res', []), expected)
        empty = {'zero_division': [{'avg': 0.0, 'count': 0}],
                 'null_arithmetic': [], 'unsupported_comprehension': [{'cnt': 0}]}[subtype]
        exact_rows(execute(code, {qid: []}).get('res', []), empty)
    else:
        value_field = re.search(r"val_\d+", code).group(0)
        fixtures = {
            'sum': ([{value_field: 8}, {value_field: None}, {value_field: -3}, {}],
                    'summary', [{'total_sum': 5}], [{'total_sum': 0}]),
            'average': ([{value_field: 8}, {value_field: None}, {value_field: 2}, {}],
                        'metrics', [{'average': 5.0, 'count': 2}], [{'average': 0.0, 'count': 0}]),
            'group': ([{'group_key': 'G', value_field: 5}, {'group_key': 'G', value_field: 3},
                       {'group_key': 'H', value_field: None}, {'group_key': None, value_field: 99}],
                      'grouped', [{'group_key': 'G', 'total': 8}, {'group_key': 'H', 'total': 0}], []),
            'range': ([{value_field: -7}, {value_field: None}, {value_field: -2}, {}],
                      'range_stat', [{'min_val': -7, 'max_val': -2}], [{'min_val': 0, 'max_val': 0}]),
        }
        if subtype == 'filter':
            threshold = int(re.search(r'if val > (\d+)', code).group(1))
            data = [{'part_code': 'P', value_field: threshold + 1},
                    {'part_code': 'Q', value_field: threshold}, {value_field: None}, {}]
            dataset, expected, empty = 'filtered', [{'part_code': 'P', 'val': threshold + 1}], []
        else:
            data, dataset, expected, empty = fixtures[subtype]
        actual = execute(code, {qid: data})
        ensure(set(actual) <= {dataset}, 'Basic example emitted an unexpected dataset')
        exact_rows(actual.get(dataset, []), expected)
        exact_rows(execute(code, {qid: []}).get(dataset, []), empty)
    return {'messages': [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': user},
                         {'role': 'assistant', 'content': answer}]}, ['ast', 'exact_rows', 'null_missing', 'empty']


def balanced_assignments(count, scenarios, variants, rng):
    modes = [variants[i % len(variants)] for i in range(count)]
    rng.shuffle(modes)
    totals, pairs = Counter(), Counter()
    for mode in modes:
        scores = {i: (totals[i], pairs[(i, mode)]) for i in scenarios}
        minimum = min(scores.values())
        scene = rng.choice([i for i, score in scores.items() if score == minimum])
        totals[scene] += 1
        pairs[(scene, mode)] += 1
        yield scene, mode


def normalized_hash(record):
    normalized = json.loads(json.dumps(record))
    for message in normalized['messages']:
        if 'tool_call_id' in message:
            message['tool_call_id'] = 'call_NORMALIZED'
        for call in message.get('tool_calls', []):
            call['id'] = 'call_NORMALIZED'
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def write_jsonl(path, records):
    with path.open('x', encoding='utf-8') as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate(output_dir, seed, validation_size, *, version='2.2', counts=None, variants=None, overrides=None):
    ensure(not output_dir.exists(), f'Output already exists: {output_dir}; choose a new directory.')
    category_counts = COUNTS if counts is None else counts
    category_variants = VARIANTS if variants is None else variants
    overrides = {} if overrides is None else overrides
    ensure(set(category_counts) == set(category_variants), 'Category/variant mismatch')
    ensure(all(total > 0 and total % 10 == 0 for total in category_counts.values()), 'Counts must be positive multiples of 10')
    rng = random.Random(seed)
    split_scenarios = {'train': list(range(16)), 'valid': [16, 17], 'test': [18, 19]}
    splits = {name: [] for name in split_scenarios}
    metadata = {name: [] for name in split_scenarios}
    producers = {'py_weighted': python_weighted, 'py_merge': python_merge,
                 'sql': sql_example, 'path': path_example, 'template': template_example,
                 'forbidden': refusal_example, 'missing_info': missing_example, 'tool_calling': tool_example}
    for category, total in category_counts.items():
        split_counts = {'train': total * 8 // 10, 'valid': total // 10, 'test': total // 10}
        for split, count in split_counts.items():
            for serial, (scene, subtype) in enumerate(balanced_assignments(count, split_scenarios[split], category_variants[category], rng)):
                scenario = SCENARIOS[scene]
                qid = query_id(scenario, category, serial, version)
                if category in overrides:
                    record, checks = overrides[category](qid, subtype, rng)
                elif category in ('py_basic', 'py_fix'):
                    record, checks = legacy_python(qid, category, subtype, scenario, rng, serial)
                else:
                    record, checks = producers[category](qid, subtype, rng)
                ensure(not any(f"'{q}'" in record['messages'][1]['content'] or f'ID: {q}.' in record['messages'][1]['content'] for q in RESERVED_QUERIES),
                       'Acceptance query leaked into training data')
                splits[split].append(record)
                metadata[split].append({'category': category, 'subtype': subtype,
                                        'scenario': scenario['id'], 'checks': checks})
        print(f'Prepared and checked {category}: {total}', flush=True)

    # Order records and metadata in stratified waves across (category, subtype)
    # so every training window and checkpoint sees a balanced mix of all tasks.
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
        for category, modes in category_variants.items():
            ensure(all(counts[(category, v)] for v in modes), f'Missing {category} subtype in {split}')

    hashes = {split: [normalized_hash(r) for r in records] for split, records in splits.items()}
    for split, values in hashes.items():
        ensure(len(values) == len(set(values)), f'Within-split duplicates: {split}')
    for left, right in itertools.combinations(hashes, 2):
        ensure(not set(hashes[left]) & set(hashes[right]), f'Cross-split duplicates: {left}/{right}')

    # Category-proportional subset; always cover arithmetic, SQL, Path and chart
    # variants without overweighting the 25 individual refusal attack strings.
    groups = {}
    for index, meta in enumerate(metadata['valid']):
        groups.setdefault((meta['category'], meta['subtype']), []).append(index)
    ensure(80 <= validation_size <= len(splits['valid']), 'validation-size must be between 80 and 300')
    subset_rng = random.Random(seed + 901)
    for indices in groups.values():
        subset_rng.shuffle(indices)
    quotas = {cat: validation_size * total // sum(category_counts.values()) for cat, total in category_counts.items()}
    remainder = validation_size - sum(quotas.values())
    residual_order = sorted(category_counts, key=lambda cat: -(validation_size * category_counts[cat] % sum(category_counts.values())))
    for cat in residual_order[:remainder]:
        quotas[cat] += 1
    selected = []
    for category, quota in quotas.items():
        modes = list(category_variants[category])
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
        files[f'data/{split}.jsonl'] = write_jsonl(data / f'{split}.jsonl', records)
        files[f'data/{split}.meta.jsonl'] = write_jsonl(data / f'{split}.meta.jsonl', metadata[split])
    subset = data / 'valid_fixed.jsonl'
    files['data/valid_fixed.jsonl'] = write_jsonl(subset, [splits['valid'][i] for i in selected])
    manifest = {
        'version': version, 'seed': seed, 'total_examples': sum(map(len, splits.values())),
        'splits': {k: len(v) for k, v in splits.items()}, 'sha256': files,
        'scenario_groups': {k: [SCENARIOS[i]['id'] for i in v] for k, v in split_scenarios.items()},
        'category_subtype_counts': {split: dict(sorted(Counter(f"{m['category']}:{m['subtype']}" for m in entries).items()))
                                    for split, entries in metadata.items()},
        'fixture_checks': dict(Counter(check for entries in metadata.values() for m in entries for check in m['checks'])),
        'duplicates': {'within_split': 0, 'cross_split': 0},
        'fixed_validation': {'count': len(selected), 'indices': selected, 'source': 'data/valid.jsonl',
                             'subset': 'data/valid_fixed.jsonl', 'category_counts': quotas},
        'tokenizer_audit': 'pending; run scripts/audit_ai_dataset.py before training',
    }
    (output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Prepared {manifest["total_examples"]} records in {output_dir}. Tokenizer audit is still required.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'training/supernova-v22')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--validation-size', type=int, default=80,
                        help='Category-balanced fixed subset, 80 to 300 records.')
    args = parser.parse_args()
    generate(args.output_dir.resolve(), args.seed, args.validation_size)


if __name__ == '__main__':
    main()
