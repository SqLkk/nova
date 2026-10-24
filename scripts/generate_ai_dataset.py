#!/usr/bin/env python3
"""Generate deterministic, validated SuperNova instruction examples (no LLM/GPU)."""
import argparse
import ast
from contextlib import closing
import json
from pathlib import Path
import random
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'supernova-backend'))
from ai_prompts import BASE_PROMPT, PYTHON_PROMPT, SQL_PROMPT, PATH_PROMPT, TEMPLATE_PROMPT
from ai_tools import validate_python, validate_path, validate_template
from path_engine import build_structure
from safe_interpreter.interpreter import SafeASTInterpreter, OutHelper, _safe_builtins

COUNTS = {'python': 500, 'sql': 500, 'path': 300, 'template': 300}
AREAS = ['Production', 'Energy', 'Quality', 'Maintenance', 'Inventory', 'Telemetry', 'OEE', 'Alarms', 'Assets', 'Process']


def example(kind, index):
    area = AREAS[index % len(AREAS)]
    source = f'{area}_{index:03d}'
    field = f'metric_{index % 17}'
    rows = [{field: 10, 'category': 'A'}, {field: 20, 'category': 'B'}, {field: None, 'category': 'A'}]
    if kind == 'python':
        operation = index % 5
        prefix = f"rows = sql_data.get('{source}', [])\n"
        if operation == 0:
            request, code = 'toplamı', "total = 0\nfor row in rows:\n    total = total + (row.get('" + field + "', 0) or 0)\nout('summary').append({'total': total})"
        elif operation == 1:
            request, code = 'ortalama ve satır sayısını', "total = 0\nfor row in rows:\n    total = total + (row.get('" + field + "', 0) or 0)\ncount = len(rows)\naverage = 0\nif count > 0:\n    average = total / count\nout('summary').append({'average': average, 'count': count})"
        elif operation == 2:
            request, code = 'kategori bazında toplamı', "groups = {}\nfor row in rows:\n    key = row.get('category', 'unknown')\n    groups[key] = groups.get(key, 0) + (row.get('" + field + "', 0) or 0)\nfor key, value in groups.items():\n    out('grouped').append({'category': key, 'total': value})"
        elif operation == 3:
            threshold = index % 23
            request, code = f'{threshold} üzerindeki kayıtları', "for row in rows:\n    value = row.get('" + field + "', 0) or 0\n    if value > " + str(threshold) + ":\n        out('filtered').append({'category': row.get('category'), 'value': value})"
        else:
            request, code = 'normalize edilmiş satırları', "for row in rows:\n    out('normalized').append({'category': str(row.get('category', '')).upper(), 'value': row.get('" + field + "', 0) or 0})"
        code = prefix + code
        validate_python(code)
        for test_rows in [rows, []]:
            output = OutHelper()
            SafeASTInterpreter(_safe_builtins(output), {'sql_data': {source: test_rows}}).evaluate(ast.parse(code))
        return PYTHON_PROMPT, f"Kayıtlı sorgu '{source}', kolonlar: category, {field}. {field} için {request} hesaplayan sandbox scripti yaz. NULL ve boş listeyi destekle.", '```python\n' + code + '\n```'
    if kind == 'sql':
        table = f'{area.lower()}_{index:03d}'
        op = index % 5
        sqls = [f'SELECT category, SUM({field}) AS total FROM {table} GROUP BY category',
                f'SELECT category, AVG({field}) AS average FROM {table} GROUP BY category',
                f'SELECT category, {field} FROM {table} WHERE {field} > :threshold',
                f'SELECT COUNT(*) AS row_count FROM {table}',
                f'SELECT category, MIN({field}) AS minimum, MAX({field}) AS maximum FROM {table} GROUP BY category']
        tasks = ['kategori bazında toplam', 'kategori bazında ortalama', 'parametreli eşik filtresi', 'satır sayısı', 'kategori bazında minimum ve maksimum']
        with closing(sqlite3.connect(':memory:')) as conn:
            conn.execute(f'CREATE TABLE {table} (category TEXT, {field} REAL)')
            conn.execute(f'INSERT INTO {table} VALUES (?, ?)', ('A', 12))
            conn.execute(sqls[op], {'threshold': 5}).fetchall()
        return SQL_PROMPT, f'SQLite şeması: {table}(category TEXT, {field} REAL). {tasks[op]} için salt okunur SQL yaz.', '```sql\n' + sqls[op] + '\n```'
    qid = f'q_{source.lower()}'
    columns = ['asset_id', 'parent_id', 'asset_name', 'next_id', 'step_order', 'category', field]
    query = {'id': qid, 'columns': columns}
    if kind == 'path':
        structure = ['tree', 'binary_tree', 'sequence', 'grouped', 'dag'][index % 5]
        config = {'label_col': 'asset_name'}
        if structure == 'grouped': config.update(group_col='category', order_col='step_order')
        else:
            config['id_col'] = 'asset_id'
            if structure == 'sequence': config['order_col'] = 'step_order'
            else: config['parent_col'] = 'parent_id'
        artifact = {'structure': structure, 'queryId': qid, 'config': config}
        validate_path(artifact, [query])
        built = build_structure(structure, [{'asset_id': 'A', 'parent_id': None, 'asset_name': 'Root', 'category': 'Area', 'step_order': 1}], config)
        assert built['stats']['node_count'] > 0
        return PATH_PROMPT, f'Sorgu ID: {qid}. Kolonlar: {", ".join(columns)}. {structure} yapısı için Path Definer JSON üret.', '```json\n' + json.dumps(artifact, ensure_ascii=False, indent=2) + '\n```'
    row, col = index % 30 + 1, index % 8 + 1
    if index % 3:
        artifact = {'charts': [{'id': f'ch_{index}', 'type': ['bar', 'line', 'pie', 'area'][index % 4],
                               'anchor': {'row': row, 'col': col, 'widthCols': 5, 'heightRows': 12},
                               'queryId': qid, 'xAxis': 'category', 'yAxis': [field], 'title': area}], 'cells': []}
        task = f'{artifact["charts"][0]["type"]} grafiği'
    else:
        artifact = {'charts': [], 'cells': [{'row': row, 'col': col, 'binding': {
            'kind': 'summary', 'queryId': qid, 'field': field, 'operation': ['SUM', 'AVG', 'COUNT'][index % 7 % 3]}}]}
        task = f'{field} özet hücresi'
    validate_template(artifact, [query])
    return TEMPLATE_PROMPT, f'Sorgu ID: {qid}; kolonlar: {", ".join(columns)}. ({row}, {col}) hücresinde {task} için şablon parçası oluştur.', '```json\n' + json.dumps(artifact, ensure_ascii=False, indent=2) + '\n```'


def generate(output_dir, seed=42):
    output_dir.mkdir(parents=True, exist_ok=True)
    grouped = {kind: [example(kind, i) for i in range(count)] for kind, count in COUNTS.items()}
    # Hold out entire query/table identities (including all Python operations).
    # Numeric identifiers use the same identity across train/eval families.
    records = {'train': [], 'eval': []}
    for kind, examples in grouped.items():
        for i, (prompt, user, assistant) in enumerate(examples):
            split = 'eval' if (i // 10) % 10 == 9 else 'train'
            records[split].append({'messages': [{'role': 'system', 'content': BASE_PROMPT + prompt},
                                               {'role': 'user', 'content': user}, {'role': 'assistant', 'content': assistant}]})
    rng = random.Random(seed)
    for split, items in records.items():
        rng.shuffle(items)
        with (output_dir / f'{split}.jsonl').open('w', encoding='utf-8') as handle:
            for item in items: handle.write(json.dumps(item, ensure_ascii=False) + '\n')
    manifest = {'counts': COUNTS, 'total': sum(COUNTS.values()), 'train': len(records['train']), 'eval': len(records['eval']),
                'seed': seed, 'validation': ['real AST interpreter: nonempty and empty rows', 'SQLite execution', 'path engine', 'template model validation'],
                'review_required': 'Synthetic starter corpus. Expand diverse cases, negative/security examples and domain-specific scenarios before training.'}
    (output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    print(json.dumps(generate(args.output_dir, args.seed), ensure_ascii=False, indent=2))
