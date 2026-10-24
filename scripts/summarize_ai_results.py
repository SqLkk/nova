#!/usr/bin/env python3
"""Read completed reports and print comparison. Does not run models or tests."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', type=Path, nargs='+')
    args = parser.parse_args()
    rows, tasks = [], []
    for path in args.reports:
        report = json.loads(path.read_text())
        metadata = report.get('_meta', {})
        for tag, results in report.items():
            if tag.startswith('_'):
                continue
            if not isinstance(results, dict) or not all(isinstance(r, dict) and 'ok' in r for r in results.values()):
                continue
            rows.append((f'{path.stem}/{tag}', results, metadata))
            tasks += [task for task in results if task not in tasks]
    print('| Task | ' + ' | '.join(row[0] for row in rows) + ' |')
    print('| --- | ' + ' | '.join('---' for _ in rows) + ' |')
    for task in tasks:
        print('| ' + task + ' | ' + ' | '.join('PASS' if r[1].get(task, {}).get('ok') else ('FAIL' if task in r[1] else '—') for r in rows) + ' |')
    print('| Score | ' + ' | '.join(f'{sum(v["ok"] for v in r[1].values())}/{len(r[1])}' for r in rows) + ' |')
    versions = {(row[2].get('script_sha256', 'legacy/unknown'), row[2].get('prompts_sha256'),
                 row[2].get('validators_sha256'), row[2].get('max_tokens'), row[2].get('tool_max_tokens')) for row in rows}
    if len(versions) > 1:
        print('\nValidator versions differ; compare scores only after reevaluating with the same script.')
    for label, results, _ in rows:
        for task, result in results.items():
            if not result['ok']:
                print(f'{label}: {task}: {result["msg"]}')


if __name__ == '__main__':
    main()
