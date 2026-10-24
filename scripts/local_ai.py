#!/usr/bin/env python3
"""Explicit, optional MLX service lifecycle. Never imported by SuperNova.

check: inspect cached weights/runtime without loading MLX or making network calls.
configure / disable: update only AI settings in the local .env.
serve: load cached weights in a separate runtime and expose a loopback OpenAI API.
"""
from __future__ import annotations

from contextlib import ExitStack
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = ROOT / 'optional-ai' / 'profiles' / 'mlx-qwen35.json'


def read_profile():
    return json.loads(PROFILE_PATH.read_text(encoding='utf-8'))


def runtime_version(python):
    if not python.is_file():
        return None
    try:
        result = subprocess.run([str(python), '-c',
            'from importlib.metadata import version; print(version("mlx-lm"))'],
            capture_output=True, text=True, timeout=5, check=True)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def resolve_cached_model(model_id, cache_dir=None, model_path=None):
    """Resolve a complete local snapshot; never call Hugging Face APIs."""
    if model_path:
        candidates = [Path(model_path).expanduser()]
    else:
        if not cache_dir:
            cache_dir = os.environ.get('HF_HUB_CACHE') or os.environ.get('HUGGINGFACE_HUB_CACHE')
        cache = Path(cache_dir).expanduser() if cache_dir else Path(
            os.environ.get('HF_HOME', str(Path.home() / '.cache' / 'huggingface'))).expanduser() / 'hub'
        repo = cache / ('models--' + model_id.replace('/', '--'))
        main_ref = repo / 'refs' / 'main'
        candidates = []
        if main_ref.is_file():
            revision = main_ref.read_text(encoding='utf-8').strip()
            if revision and Path(revision).name == revision and revision not in ('.', '..'):
                candidates.append(repo / 'snapshots' / revision)
        # Respect refs/main when present; do not silently change model revisions.
        else:
            snapshots = repo / 'snapshots'
            if snapshots.is_dir():
                candidates = sorted(snapshots.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for candidate in candidates:
        try:
            for name in ('config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja'):
                if not (candidate / name).is_file():
                    raise ValueError('Incomplete tokenizer/config')
            index = json.loads((candidate / 'model.safetensors.index.json').read_text(encoding='utf-8'))
            shards = set(index['weight_map'].values())
            if not shards:
                raise ValueError('Empty weight index')
            for shard in shards:
                if not isinstance(shard, str) or Path(shard).name != shard:
                    raise ValueError('Invalid weight index')
                if not (candidate / shard).is_file() or (candidate / shard).stat().st_size == 0:
                    raise ValueError('Missing weights')
            return candidate.resolve()
        except (OSError, ValueError, KeyError, TypeError):
            continue
    raise ValueError('Complete cached model not found. Supply --model-path with an offline snapshot directory.')


def update_ai_environment(path, values):
    """Atomic opt-in configuration; preserve every non-AI setting, never log it."""
    path = Path(path)
    if any(not key.startswith('AI_') or '\n' in str(value) or '\r' in str(value)
           for key, value in values.items()):
        raise ValueError('Only single-line AI settings may be updated.')
    original = path.read_text(encoding='utf-8') if path.exists() else ''
    lines, remaining = [], dict(values)
    for line in original.splitlines():
        key = line.partition('=')[0].strip()
        if key in values:
            if key in remaining:
                lines.append(key + '=' + str(remaining.pop(key)))
        else:
            lines.append(line)
    if remaining:
        lines += ['', '# Optional local AI Copilot']
        lines += [key + '=' + str(value) for key, value in remaining.items()]
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ai-config-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(lines) + '\n')
        os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def resolve_adapter_directory(adapter_path, stack: ExitStack):
    """Accept either an adapter directory or a specific *_adapters.safetensors checkpoint file."""
    if adapter_path is None:
        return None
    target = Path(adapter_path).expanduser().resolve()
    if target.is_file() and target.suffix == '.safetensors':
        config_file = target.parent / 'adapter_config.json'
        if not config_file.is_file():
            raise ValueError(f'adapter_config.json missing next to checkpoint: {target}')
        scratch = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='supernova-serve-adapter-')))
        (scratch / 'adapter_config.json').symlink_to(config_file)
        (scratch / 'adapters.safetensors').symlink_to(target)
        return scratch
    if target.is_dir() and (target / 'adapters.safetensors').is_file() and (target / 'adapter_config.json').is_file():
        return target
    raise ValueError(f'Adapter weights/config not found: {target}')


def runtime_settings(model_path, template, adapter_path=None):
    # Kept separate from Flask's config/requirements. Match pinned mlx-lm CLI.
    resolved_adapter = str(Path(adapter_path).resolve()) if adapter_path else None
    return SimpleNamespace(
        model=str(model_path), adapter_path=resolved_adapter, draft_model=None, pipeline=False,
        trust_remote_code=False, chat_template=template, use_default_chat_template=False,
        chat_template_args={'enable_thinking': False}, allowed_origins=[],
        temp=0.2, top_p=1.0, top_k=0, min_p=0.0, max_tokens=2048,
        num_draft_tokens=3, decode_concurrency=1, prompt_concurrency=1,
        prefill_step_size=512, prompt_cache_size=1, prompt_cache_bytes=512 * 1024 * 1024,
        kv_bits=None, kv_group_size=64, quantized_kv_start=5000,
    )


def make_handler(base_handler, model_id, pinned_adapter=None):
    resolved_adapter = str(Path(pinned_adapter).resolve()) if pinned_adapter else None

    class LocalModelHandler(base_handler):
        def ready(self):
            return (self.response_generator.is_healthy and
                    self.response_generator.model_provider.model is not None)

        def do_GET(self):
            # Do not scan the HF cache on health checks or advertise unrelated models.
            if self.path not in ('/v1/models', '/health'):
                self._set_completion_headers(404)
                self.end_headers()
                return
            ready = self.ready()
            self._set_completion_headers(200 if ready else 503)
            self.end_headers()
            payload = {'status': 'ok' if ready else 'loading_or_unavailable'}
            if self.path == '/v1/models':
                payload = {'object': 'list', 'data': [{'id': model_id, 'object': 'model'}] if ready else []}
            self.wfile.write(json.dumps(payload).encode())

        def do_POST(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                size = 0
            # Browser clients use authenticated Flask, never the raw model port.
            if self.headers.get('Origin') or self.path != '/v1/chat/completions' or not 0 < size <= 262144:
                self._set_completion_headers(400)
                self.end_headers()
                return
            if not self.ready():
                self._set_completion_headers(503)
                self.end_headers()
                return
            super().do_POST()

        def handle_chat_completions(self):
            # Pin the local snapshot; callers cannot load arbitrary models/adapters or enable thinking.
            self.requested_model = model_id
            self.requested_draft_model = None
            self.adapter = resolved_adapter
            self.chat_template_kwargs = {'enable_thinking': False}
            self.max_tokens = max(1, min(int(self.max_tokens), 8192))
            return super().handle_chat_completions()

    return LocalModelHandler


def serve(model_path, model_id, port, adapter_path=None):
    # Set before importing MLX/transformers. Loading uses a resolved path, never a repo lookup.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                      TOKENIZERS_PARALLELISM='false')
    from mlx_lm.models.cache import LRUPromptCache
    from mlx_lm.server import APIHandler, ModelProvider, ResponseGenerator

    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    with ExitStack() as stack:
        prepared_adapter = resolve_adapter_directory(adapter_path, stack)
        settings = runtime_settings(
            model_path,
            (model_path / 'chat_template.jinja').read_text(encoding='utf-8'),
            adapter_path=prepared_adapter,
        )
        provider = ModelProvider(settings)
        # Stable public model identity maps to the one resolved, offline snapshot.
        provider._model_map[model_id] = str(model_path)
        generator = ResponseGenerator(provider, LRUPromptCache(settings.prompt_cache_size, settings.prompt_cache_bytes))
        try:
            with ThreadingHTTPServer(('127.0.0.1', port), partial(make_handler(APIHandler, model_id, prepared_adapter), generator)) as server:
                adapter_note = f' (adapter: {adapter_path})' if adapter_path else ''
                print(f'Optional MLX service: http://127.0.0.1:{port}/v1 · {model_id}{adapter_note}', flush=True)
                print('Loading cached weights. Ctrl+C stops AI; SuperNova runs independently.', flush=True)
                server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass
        finally:
            generator.stop_and_join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'configure', 'disable', 'serve'])
    parser.add_argument('--model-path', help='Complete local snapshot directory')
    parser.add_argument('--adapter-path', type=Path, help='Optional fine-tuned LoRA adapter directory or checkpoint .safetensors file')
    parser.add_argument('--cache-dir', help='Hugging Face hub cache directory')
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--runtime-python', type=Path, default=ROOT / '.venv-ai' / 'bin' / 'python')
    parser.add_argument('--port', type=int, default=8085)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    profile = read_profile()
    try:
        if args.command == 'disable':
            update_ai_environment(args.env_file, {'AI_ENABLED': 'false'})
            print('AI disabled in local config. Restart the backend; standard SuperNova remains available.')
            return
        model_path = resolve_cached_model(profile['model'], args.cache_dir, args.model_path)
        if args.command == 'check':
            version = runtime_version(args.runtime_python)
            print(json.dumps({'model': profile['model'], 'snapshot': str(model_path),
                'runtime_python': str(args.runtime_python), 'runtime_installed': bool(version), 'runtime_version': version,
                'supported_platform': platform.system() == 'Darwin' and platform.machine() == 'arm64',
                'network_used': False, 'model_loaded': False}, indent=2))
            return
        if args.command == 'configure':
            values = dict(profile['environment'], AI_BASE_URL=f'http://127.0.0.1:{args.port}/v1')
            update_ai_environment(args.env_file, values)
            print('Local MLX profile enabled. Start AI separately with: python3 scripts/local_ai.py serve')
            print('Restart the backend to read the profile. Core startup never launches or installs AI.')
            return
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise ValueError('MLX requires Apple Silicon. Use the OpenAI/Ollama Gateway on other platforms.')
        if not args.runtime_python.is_file():
            raise ValueError('Optional runtime missing. Create .venv-ai and install optional-ai/requirements-mlx.txt.')
        if args.adapter_path is not None:
            target = args.adapter_path.expanduser().resolve()
            valid_file = target.is_file() and target.suffix == '.safetensors' and (target.parent / 'adapter_config.json').is_file()
            valid_dir = target.is_dir() and (target / 'adapters.safetensors').is_file() and (target / 'adapter_config.json').is_file()
            if not (valid_file or valid_dir):
                raise ValueError(f'Adapter weights/config not found: {target}')
        # Re-exec into the isolated runtime without relying on shell activation.
        if Path(sys.prefix).resolve() != args.runtime_python.parent.parent.resolve():
            os.execv(str(args.runtime_python), [str(args.runtime_python), str(Path(__file__).resolve()), *sys.argv[1:]])
        serve(model_path, profile['model'], args.port, adapter_path=args.adapter_path)
    except (ValueError, OSError, ImportError) as exc:
        parser.exit(1, f'Optional AI: {exc}\nSuperNova does not require this service.\n')


if __name__ == '__main__':
    main()
