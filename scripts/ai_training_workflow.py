#!/usr/bin/env python3
"""User-invoked phases for preparing, training and comparing the v2.2/v2.3 experiments.

No background jobs, polling, downloads, services, .env updates or model fusion.
Each phase writes a distinct log and stops immediately on a failed command.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
AI_PYTHON = ROOT / '.venv-ai/bin/python'


def archive_existing(path: Path) -> Path | None:
    if not path.exists() and not path.is_symlink():
        return None
    stamp = time.strftime('%Y%m%d-%H%M%S')
    archived = path.with_name(f'{path.name}-archive-{stamp}')
    counter = 1
    while archived.exists() or archived.is_symlink():
        counter += 1
        archived = path.with_name(f'{path.name}-archive-{stamp}-{counter}')
    path.rename(archived)
    print(f'Archived previous artifact: {path} -> {archived}', flush=True)
    return archived


def run(script, arguments, log):
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists() or log.is_symlink():
        archive_existing(log)
    environment = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                       PYTHONUNBUFFERED='1', TOKENIZERS_PARALLELISM='false')
    command = [str(AI_PYTHON), str(ROOT / 'scripts' / script), *map(str, arguments)]
    print(f'Running {script}; log: {log}', flush=True)
    with log.open('x', encoding='utf-8') as handle:
        with subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, bufsize=1) as process:
            try:
                for line in process.stdout:
                    print(line, end='', flush=True)
                    handle.write(line)
                    handle.flush()
                code = process.wait()
            except KeyboardInterrupt:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise
    if code:
        raise SystemExit(f'{script} failed (exit {code}). Stop here; inspect {log}.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'smoke', 'train', 'evaluate', 'extended', 'report'])
    parser.add_argument('--profile', choices=['pilot', 'final'], default='pilot')
    parser.add_argument('--experiment-root', type=Path)
    parser.add_argument('--checkpoint', type=int, help='Selected checkpoint for extended phase')
    parser.add_argument('--results-dir', type=Path,
                        help='New directory for evaluation retries; defaults to experiment-root/results')
    args = parser.parse_args()
    final = args.profile == 'final'
    version = 'v23' if final else 'v22'
    total_iters = 600 if final else 150
    steps = (150, 300, 450, 600) if final else (50, 100, 150)
    experiment = (args.experiment_root or ROOT / f'training/supernova-{version}').resolve()
    results = args.results_dir.resolve() if args.results_dir else experiment / 'results'
    adapter = experiment / f'adapter{total_iters}'
    config = ROOT / f'optional-ai/training/{version}.yaml'
    checkpoint_step = args.checkpoint if args.checkpoint is not None else total_iters
    if not AI_PYTHON.is_file():
        parser.error('Optional MLX Python not found: .venv-ai/bin/python')
    if args.phase == 'prepare':
        logs = experiment.parent / (experiment.name + '-preparation-logs')
        if experiment.exists():
            archive_existing(experiment)
        if logs.exists():
            archive_existing(logs)
        run(f'generate_ai_dataset_{version}.py', ['--output-dir', experiment], logs / 'generate.log')
        run('audit_ai_dataset.py', ['--dataset-root', experiment], logs / 'audit.log')
        print('Preparation finished. Inspect manifest.json and audit.json before training.')
    elif args.phase in ('smoke', 'train'):
        if not (experiment / 'audit.json').is_file():
            parser.error('Run prepare successfully before training.')
        if not json.loads((experiment / 'audit.json').read_text()).get('passed'):
            parser.error('Tokenizer audit failed. Resolve preparation errors before training.')
        if args.phase == 'smoke':
            smoke_adapter = experiment / 'adapter-smoke'
            if smoke_adapter.exists():
                archive_existing(smoke_adapter)
            run('train_ai_lora.py', ['--dataset-root', experiment, '--config', config,
                                   '--adapter-path', smoke_adapter, '--iters', 10, '--smoke'],
                experiment / 'logs/smoke10.log')
            print('Smoke run finished. Inspect memory/step metrics; full training starts from the base again.')
        else:
            if final and not (experiment / 'adapter-smoke/completion.json').is_file():
                parser.error('Run the final profile smoke phase successfully before the full training.')
            if final:
                smoke = json.loads((experiment / 'adapter-smoke/completion.json').read_text())
                provenance = json.loads((experiment / 'adapter-smoke/training_provenance.json').read_text())
                smoke_settings = provenance['settings']
                try:
                    import yaml
                    cfg = yaml.safe_load(config.read_text())
                    exp_layers = cfg.get('num_layers', 1)
                    exp_rank = cfg.get('lora_parameters', {}).get('rank', 4)
                except ModuleNotFoundError:
                    exp_layers = smoke_settings.get('num_layers', 1)
                    exp_rank = smoke_settings.get('lora_parameters', {}).get('rank', 4)
                if not smoke.get('completed') or smoke.get('num_layers') != exp_layers or smoke.get('rank') != exp_rank:
                    parser.error(f'Smoke capacity check does not match configured {exp_layers}-layer/rank-{exp_rank} profile.')
                if provenance['tokenizer_audit_sha256'] != hashlib.sha256((experiment / 'audit.json').read_bytes()).hexdigest():
                    parser.error('Data/tokenizer audit changed after smoke; repeat the capacity check in a new output directory.')
                if smoke_settings['max_seq_length'] != 1024 or smoke_settings['batch_size'] != 1:
                    parser.error('Smoke input dimensions differ from final training.')
            if adapter.exists():
                archive_existing(adapter)
            train_log = experiment / f'logs/train{total_iters}.log'
            run('train_ai_lora.py', ['--dataset-root', experiment, '--config', config, '--adapter-path', adapter],
                train_log)
            if final:
                legacy_log = experiment / 'logs/train2400.log'
                if legacy_log.exists() or legacy_log.is_symlink():
                    archive_existing(legacy_log)
                shutil.copy2(train_log, legacy_log)
    elif args.phase == 'evaluate':
        available = [(step, adapter / f'{step:07d}_adapters.safetensors')
                     for step in steps if (adapter / f'{step:07d}_adapters.safetensors').is_file()]
        if not available:
            parser.error(f'No checkpoints found in {adapter} for steps {steps}. Run train first.')
        if results.exists() and not args.results_dir:
            archive_existing(results)
        core_reports = []
        model_path = Path(json.loads((experiment / 'audit.json').read_text())['model'])
        models = [('baseline', None, None)]
        v21_dir = ROOT / 'training/supernova-v21/adapter150'
        if (v21_dir / 'adapters.safetensors').is_file():
            models.append(('v21_adapter150', v21_dir, None))
        models.extend((f'{version}_step{step}', adapter, path) for step, path in available)
        for label, directory, checkpoint in models:
            selection = ['--adapter-path', directory, '--skip-baseline'] if directory else []
            if checkpoint:
                selection += ['--checkpoint', checkpoint]
            output = results / f'{label}_core.json'
            existing = ROOT / f'training/supernova-v22/results/{label}_core.json'
            reusable = False
            if final and label in ('baseline', 'v21_adapter150') and existing.is_file():
                meta = json.loads(existing.read_text()).get('_meta', {})
                expected_files = {'script_sha256': ROOT / 'scripts/run_acceptance_suite.py',
                                  'prompts_sha256': ROOT / 'supernova-backend/ai_prompts.py',
                                  'validators_sha256': ROOT / 'supernova-backend/ai_tools.py',
                                  'tokenizer_sha256': model_path / 'chat_template.jinja'}
                reusable = all(meta.get(name) == hashlib.sha256(file.read_bytes()).hexdigest()
                               for name, file in expected_files.items())
                reusable = reusable and meta.get('suite') == 'core' and meta.get('model') == str(model_path)
                reusable = reusable and meta.get('max_tokens') == 512 and meta.get('tool_max_tokens') == 256
                reusable = reusable and meta.get('temperature') == 0 and meta.get('enable_thinking') is False and meta.get('seed') == 42
                if directory:
                    reusable = reusable and meta.get('adapter', {}).get('sha256') == hashlib.sha256(
                        (directory / 'adapters.safetensors').read_bytes()).hexdigest()
            if reusable:
                results.mkdir(parents=True, exist_ok=True)
                with output.open('x', encoding='utf-8') as handle:
                    handle.write(existing.read_text())
                print(f'Reused matching report: {existing}')
            else:
                run('run_acceptance_suite.py', [*selection, '--model-path', model_path, '--suite', 'core', '--output', output],
                    results / f'{label}_core.log')
            core_reports.append(output)
            loss_selection = ['--adapter-path', directory] if directory else []
            if checkpoint:
                loss_selection += ['--checkpoint', checkpoint]
            if not final or checkpoint:
                run('evaluate_ai_loss.py', [*loss_selection, '--model-path', model_path, '--data-file', experiment / 'data/valid_fixed.jsonl',
                                           '--output', results / f'{label}_fixed_loss.json'],
                    results / f'{label}_fixed_loss.log')
        run('summarize_ai_results.py', core_reports, results / 'comparison.txt')
        print('Compare core results first. Use extended only for the selected checkpoint.')
    elif args.phase == 'extended':
        if checkpoint_step not in steps:
            parser.error(f'Select one of {steps}')
        path = adapter / f'{checkpoint_step:07d}_adapters.safetensors'
        if not path.is_file():
            parser.error(f'Checkpoint missing: {path}')
        model_path = Path(json.loads((experiment / 'audit.json').read_text())['model'])
        run('run_acceptance_suite.py', ['--adapter-path', adapter, '--checkpoint', path,
                                       '--model-path', model_path,
                                       '--suite', 'extended', '--output', results / f'step{checkpoint_step}_extended.json'],
            results / f'step{checkpoint_step}_extended.log')
    else:
        reports = sorted(results.glob('*_core.json')) + sorted(results.glob('*_extended.json'))
        if not reports:
            parser.error(f'No acceptance reports in {results}')
        subprocess.run([sys.executable, str(ROOT / 'scripts/summarize_ai_results.py'), *map(str, reports)],
                       cwd=ROOT, check=True)
        for path in sorted(results.glob('*_fixed_loss.json')):
            report = json.loads(path.read_text())
            print(f'{path.stem}: loss={report["loss"]:.4f}, ppl={report["ppl"]:.4f}, records={report["records"]}')


if __name__ == '__main__':
    main()
