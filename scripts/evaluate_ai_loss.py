#!/usr/bin/env python3
"""Explicit fixed-validation loss evaluation; never trains or opens a service."""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.local_ai import read_profile, resolve_cached_model


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-file', type=Path, required=True)
    parser.add_argument('--adapter-path', type=Path)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--model-path', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-seq-length', type=int, default=1024)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Report already exists. Choose a new file.')
    if args.checkpoint and not args.adapter_path:
        parser.error('--checkpoint requires --adapter-path')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    adapter_model = None
    if args.adapter_path:
        adapter_model = Path(json.loads((args.adapter_path / 'adapter_config.json').read_text())['model'])
    model_path = resolve_cached_model(read_profile()['model'], model_path=args.model_path or adapter_model)
    if adapter_model is not None and adapter_model.resolve() != model_path:
        parser.error('Adapter base differs from selected model. Use its original snapshot.')
    import mlx.core as mx
    import numpy as np
    from mlx_lm import load
    from mlx_lm.tuner.datasets import CacheDataset, ChatDataset
    from mlx_lm.tuner.trainer import evaluate, iterate_batches
    from scripts.run_acceptance_suite import prepare_adapter

    class Tokenizer:
        def __init__(self, wrapped):
            self.wrapped = wrapped

        def __getattr__(self, name):
            return getattr(self.wrapped, name)

        def apply_chat_template(self, *positional, **kwargs):
            kwargs['enable_thinking'] = False
            return self.wrapped.apply_chat_template(*positional, **kwargs)

    with tempfile.TemporaryDirectory(prefix='supernova-loss-eval-') as scratch:
        adapter, weights = (prepare_adapter(args.adapter_path.resolve(), args.checkpoint, scratch)
                            if args.adapter_path else (None, None))
        model, tokenizer = load(model_path, adapter_path=str(adapter) if adapter else None)
        try:
            records = [json.loads(line) for line in args.data_file.open(encoding='utf-8')]
            if not records:
                parser.error('Data file is empty.')
            data = CacheDataset(ChatDataset(records, Tokenizer(tokenizer), mask_prompt=True))
            for index in range(len(data)):
                tokens, offset = data[index]
                if len(tokens) > args.max_seq_length or offset >= len(tokens):
                    parser.error(f'Invalid target or overlong record: {index}')
            np.random.seed(943)
            mx.random.seed(42)
            start = time.monotonic()
            loss = float(evaluate(model, data, batch_size=1, num_batches=-1,
                                  max_seq_length=args.max_seq_length, iterate_batches=iterate_batches))
            elapsed = time.monotonic() - start
            if not math.isfinite(loss):
                raise ValueError('Non-finite evaluation loss')
            report = {'loss': loss, 'ppl': math.exp(loss), 'duration_seconds': elapsed,
                      'peak_memory_bytes': mx.get_peak_memory(), 'records': len(records),
                      'data_file': str(args.data_file.resolve()), 'data_sha256': digest(args.data_file),
                      'model': str(model_path), 'adapter': str(args.adapter_path) if args.adapter_path else None,
                      'weights_sha256': digest(weights) if weights else None,
                      'enable_thinking': False, 'mask_prompt': True, 'max_seq_length': args.max_seq_length}
        finally:
            del model, tokenizer
            gc.collect()
            mx.clear_cache()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
