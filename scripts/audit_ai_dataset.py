#!/usr/bin/env python3
"""CPU-only tokenizer/data audit. Runs only on the user's explicit invocation."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.local_ai import read_profile, resolve_cached_model


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(root, model_path, max_length):
    from transformers import AutoTokenizer

    manifest = json.loads((root / 'manifest.json').read_text())
    errors = []
    for name, expected in manifest['sha256'].items():
        if sha256(root / name) != expected:
            errors.append(f'SHA256 mismatch: {name}')
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True,
                                             trust_remote_code=False)
    # Recheck group membership and identity after generation, so hand edits cannot
    # silently invalidate the split guarantees in the manifest.
    scenario_sets, record_hashes, split_records = {}, {}, {}
    for split in ('train', 'valid', 'test'):
        records = [json.loads(line) for line in (root / 'data' / f'{split}.jsonl').open()]
        meta = [json.loads(line) for line in (root / 'data' / f'{split}.meta.jsonl').open()]
        if len(records) != len(meta) or len(records) != manifest['splits'][split]:
            errors.append(f'{split}: record/metadata count mismatch')
        scenario_sets[split] = {m['scenario'] for m in meta}
        if scenario_sets[split] != set(manifest['scenario_groups'][split]):
            errors.append(f'{split}: scenario membership changed')
        hashes = [hashlib.sha256(json.dumps(r, sort_keys=True).encode()).hexdigest() for r in records]
        record_hashes[split] = set(hashes)
        if len(hashes) != len(record_hashes[split]):
            errors.append(f'{split}: duplicate records')
        split_records[split] = records
    from itertools import combinations
    for left, right in combinations(scenario_sets, 2):
        if scenario_sets[left] & scenario_sets[right] or record_hashes[left] & record_hashes[right]:
            errors.append(f'{left}/{right}: split overlap')
    fixed = [json.loads(line) for line in (root / 'data/valid_fixed.jsonl').open()]
    if fixed != [split_records['valid'][i] for i in manifest['fixed_validation']['indices']]:
        errors.append('Fixed validation does not match declared valid indices')
    results = {}
    for split in ('train', 'valid', 'test', 'valid_fixed'):
        lengths, targets = [], []
        path = root / 'data' / f'{split}.jsonl'
        for index, line in enumerate(path.open(encoding='utf-8')):
            record = json.loads(line)
            messages, tools = record['messages'], record.get('tools')
            full = tokenizer.apply_chat_template(messages, tools=tools, return_dict=False,
                                                 enable_thinking=False)
            prefix = tokenizer.apply_chat_template(messages[:-1], tools=tools, return_dict=False,
                                                   add_generation_prompt=True, enable_thinking=False)
            lengths.append(len(full))
            targets.append(len(full) - len(prefix))
            if full[:len(prefix)] != prefix:
                errors.append(f'{split}:{index}: assistant prefix/mask mismatch')
            if len(full) <= len(prefix) or tokenizer.eos_token_id not in full[len(prefix):]:
                errors.append(f'{split}:{index}: missing assistant target/EOS')
            if len(full) > max_length:
                errors.append(f'{split}:{index}: {len(full)} tokens exceeds {max_length}')
            final = messages[-1]
            if final.get('role') != 'assistant':
                errors.append(f'{split}:{index}: final turn is not assistant')
            if any(m.get('tool_calls') for m in messages) and not tools:
                errors.append(f'{split}:{index}: tool definitions missing')
        if not lengths:
            errors.append(f'{split}: empty split')
        results[split] = {'count': len(lengths), 'min': min(lengths, default=0), 'max': max(lengths, default=0),
                          'mean': round(sum(lengths) / len(lengths), 2) if lengths else 0,
                          'min_target': min(targets, default=0), 'max_target': max(targets, default=0)}
    report = {'passed': not errors, 'model': str(model_path), 'max_seq_length': max_length,
              'enable_thinking': False, 'mask_prompt': True, 'lengths': results,
              'sha256': {name: sha256(root / name) for name in manifest['sha256']},
              'tokenizer_sha256': {name: sha256(model_path / name)
                                   for name in ('tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja')},
              'errors': errors}
    (root / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return not errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset-root', type=Path, default=ROOT / 'training/supernova-v22')
    parser.add_argument('--model-path', type=Path)
    parser.add_argument('--max-seq-length', type=int, default=1024)
    args = parser.parse_args()
    model = resolve_cached_model(read_profile()['model'], model_path=args.model_path)
    raise SystemExit(0 if audit(args.dataset_root.resolve(), model, args.max_seq_length) else 1)


if __name__ == '__main__':
    main()
