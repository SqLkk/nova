#!/usr/bin/env python3
"""Explicit optional MLX training with a fixed validation subset and chat mask.

Pinned mlx-lm integration is process-local. It does not modify site-packages or
SuperNova startup. The immutable validation subset is evaluated deterministically.
"""
from __future__ import annotations

import argparse
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.local_ai import read_profile, resolve_cached_model


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset-root', type=Path, default=ROOT / 'training/supernova-v22')
    parser.add_argument('--config', type=Path, default=ROOT / 'optional-ai/training/v22.yaml')
    parser.add_argument('--adapter-path', type=Path, required=True)
    parser.add_argument('--model-path', type=Path)
    parser.add_argument('--iters', type=int)
    parser.add_argument('--smoke', action='store_true', help='Short capacity check with 4 fixed validation examples')
    args = parser.parse_args()
    if args.adapter_path.exists():
        parser.error('Adapter output already exists. Choose a new directory; existing weights are never overwritten.')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import yaml
    config = yaml.safe_load(args.config.read_text())
    dataset = args.dataset_root.resolve()
    audit = json.loads((dataset / 'audit.json').read_text())
    manifest = json.loads((dataset / 'manifest.json').read_text())
    if not audit['passed'] or audit['max_seq_length'] != config['max_seq_length']:
        parser.error('A passing tokenizer audit with the configured sequence length is required.')
    if audit.get('enable_thinking') is not False or audit.get('mask_prompt') is not True:
        parser.error('The audit must use non-thinking completion prefixes and prompt masking.')
    for name, expected in manifest['sha256'].items():
        if audit['sha256'].get(name) != expected or sha256(dataset / name) != expected:
            parser.error(f'Dataset changed after audit: {name}')
    model_path = resolve_cached_model(read_profile()['model'], model_path=args.model_path or Path(audit['model']))
    for name, expected in audit['tokenizer_sha256'].items():
        if sha256(model_path / name) != expected:
            parser.error(f'Tokenizer changed after audit: {name}')
    if version('mlx-lm') != '0.32.0':
        parser.error('This wrapper targets mlx-lm==0.32.0; verify the integration before changing versions.')

    import mlx_lm.lora as lora
    from mlx_lm.tuner.datasets import ChatDataset

    original_load = lora.load
    original_load_dataset = lora.load_dataset
    original_train = lora.train

    configured_val_batches = config.get('val_batches', -1)

    class NoThinkingTokenizer:
        def __init__(self, tokenizer):
            self.tokenizer = tokenizer

        def __getattr__(self, name):
            return getattr(self.tokenizer, name)

        def apply_chat_template(self, *positional, **kwargs):
            kwargs['enable_thinking'] = False
            return self.tokenizer.apply_chat_template(*positional, **kwargs)

    def load(*positional, **kwargs):
        model, tokenizer = original_load(*positional, **kwargs)
        return model, NoThinkingTokenizer(tokenizer)

    def load_dataset(config_args, tokenizer):
        train_ds, _, test_ds = original_load_dataset(config_args, tokenizer)
        records = [json.loads(line) for line in (dataset / 'data/valid_fixed.jsonl').open()]
        if args.smoke:
            records = records[:4]
        elif isinstance(configured_val_batches, int) and configured_val_batches > 0:
            records = records[:configured_val_batches]
        valid_ds = ChatDataset(records, tokenizer, mask_prompt=True)
        return train_ds, valid_ds, test_ds

    def train(*positional, **kwargs):
        # Pass a custom iterator to MLX rather than mutating its installed module.
        # Training shuffles within stratified windows; validation never changes training RNG.
        import numpy as np
        from mlx_lm.tuner.trainer import iterate_batches as original_iterator
        training_rng = np.random.RandomState(config_args.seed)

        def iterator(dataset, batch_size, max_seq_length, loop=False, seed=None, comm_group=None, **extra):
            if loop:
                window_size = 60
                total = len(dataset)
                while True:
                    for start in range(0, total, window_size):
                        window = [dataset[i] for i in range(start, min(start + window_size, total))]
                        if not window:
                            continue
                        previous = np.random.get_state()
                        try:
                            np.random.set_state(training_rng.get_state())
                            epoch = iter(original_iterator(window, batch_size, max_seq_length,
                                                           loop=False, comm_group=comm_group))
                            first = next(epoch)
                            training_rng.set_state(np.random.get_state())
                        finally:
                            np.random.set_state(previous)
                        yield first
                        yield from epoch
            else:
                # Fixed order and fixed membership, all selected validation records evaluated.
                previous = np.random.get_state()
                np.random.seed(config_args.seed + 901)
                try:
                    batches = list(original_iterator(dataset, batch_size, max_seq_length,
                                                     loop=False, comm_group=comm_group))
                finally:
                    np.random.set_state(previous)
                yield from batches

        kwargs['iterate_batches'] = iterator
        return original_train(*positional, **kwargs)

    values = dict(lora.CONFIG_DEFAULTS)
    values.update(config)
    values.update({'model': str(model_path), 'data': str(dataset / 'data'),
                   'adapter_path': str(args.adapter_path.resolve()), 'train': True,
                   'test': False, 'resume_adapter_file': None, 'val_batches': -1,
                   'config': str(args.config.resolve())})
    if args.smoke:
        values['steps_per_report'] = 1
        values['lr_schedule'] = None
    if args.iters is not None:
        values['iters'] = args.iters
    if args.smoke and values['iters'] > 10:
        parser.error('Smoke is bounded to at most 10 steps.')
    if values['iters'] < 1 or values['batch_size'] != 1 or values['grad_accumulation_steps'] != 1:
        parser.error('This controlled experiment requires positive iters, batch_size=1 and accumulation=1.')
    if not values['mask_prompt']:
        parser.error('Prompt masking must stay enabled.')
    config_args = SimpleNamespace(**values)
    lora.load, lora.load_dataset, lora.train = load, load_dataset, train
    args.adapter_path.mkdir(parents=True)
    active_val_count = (4 if args.smoke else
                        (configured_val_batches if isinstance(configured_val_batches, int) and configured_val_batches > 0
                         else manifest['fixed_validation']['count']))
    provenance = {'dataset_manifest_sha256': sha256(dataset / 'manifest.json'),
                  'fixed_validation_sha256': sha256(dataset / 'data/valid_fixed.jsonl'),
                  'tokenizer_audit_sha256': sha256(dataset / 'audit.json'),
                  'enable_thinking': False, 'validation_count': active_val_count,
                  'full_fixed_validation_count': manifest['fixed_validation']['count'],
                  'smoke_only': args.smoke,
                  'optimizer_resume': False, 'settings': values}
    (args.adapter_path / 'training_provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'Fresh training: {values["iters"]} steps; fixed validation: {provenance["validation_count"]} records.', flush=True)
    import time
    import mlx.core as mx
    started = time.monotonic()
    lora.run(config_args)
    completion = {'completed': True, 'iters': values['iters'], 'duration_seconds': time.monotonic() - started,
                  'peak_memory_bytes': mx.get_peak_memory(), 'training_records': manifest['splits']['train'],
                  'approx_epochs': values['iters'] / manifest['splits']['train'],
                  'num_layers': values['num_layers'], 'rank': values['lora_parameters']['rank']}
    (args.adapter_path / 'completion.json').write_text(json.dumps(completion, indent=2) + '\n')
    print(json.dumps(completion, indent=2), flush=True)


if __name__ == '__main__':
    main()
