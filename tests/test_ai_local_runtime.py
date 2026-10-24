"""The optional lifecycle must work without importing any AI packages."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('supernova_local_ai', ROOT / 'scripts' / 'local_ai.py')
local_ai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_ai)


class LocalAiLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='supernova-ai-lifecycle-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'models--mlx-community--Qwen3.5-9B-MLX-4bit'
        self.snapshot = self.repo / 'snapshots' / 'revision1'
        self.snapshot.mkdir(parents=True)
        for name in ('config.json', 'tokenizer_config.json', 'tokenizer.json'):
            (self.snapshot / name).write_text('{}')
        (self.snapshot / 'chat_template.jinja').write_text('template')
        (self.snapshot / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'layer': 'model.safetensors'}}))
        (self.snapshot / 'model.safetensors').write_bytes(b'weights')
        (self.repo / 'refs').mkdir()
        (self.repo / 'refs' / 'main').write_text('revision1')

    def test_snapshot_resolution_never_imports_runtime(self):
        self.assertNotIn('mlx_lm', sys.modules)
        profile = local_ai.read_profile()
        self.assertFalse(profile['enabled_by_default'])
        self.assertTrue(profile['optional'])
        self.assertFalse(profile['download_at_runtime'])
        self.assertEqual(local_ai.resolve_cached_model(profile['model'], self.root), self.snapshot.resolve())
        self.assertNotIn('mlx_lm', sys.modules)

    def test_incomplete_or_dangling_weights_rejected(self):
        shard = self.snapshot / 'model.safetensors'
        shard.unlink()
        shard.symlink_to(self.root / 'missing-blob')
        with self.assertRaises(ValueError):
            local_ai.resolve_cached_model(local_ai.read_profile()['model'], self.root)

    def test_explicit_snapshot_and_revision_pin(self):
        self.assertEqual(local_ai.resolve_cached_model('ignored', model_path=self.snapshot), self.snapshot.resolve())
        (self.repo / 'refs' / 'main').write_text('missing-revision')
        with self.assertRaises(ValueError):
            local_ai.resolve_cached_model(local_ai.read_profile()['model'], self.root)

    def test_configure_disable_preserves_platform_settings(self):
        path = self.root / '.env'
        path.write_text('# Keep this comment\nNOVA_OTHER_SETTING="unchanged"\nAI_ENABLED=false\nAI_ENABLED=true\n')
        path.chmod(0o600)
        values = local_ai.read_profile()['environment']
        local_ai.update_ai_environment(path, values)
        enabled = path.read_text()
        self.assertIn('NOVA_OTHER_SETTING="unchanged"', enabled)
        self.assertEqual(enabled.count('AI_ENABLED='), 1)
        self.assertIn('AI_MOCK_MODE=false', enabled)
        local_ai.update_ai_environment(path, {'AI_ENABLED': 'false'})
        self.assertEqual(path.read_text(), enabled.replace('AI_ENABLED=true', 'AI_ENABLED=false'))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            local_ai.update_ai_environment(path, {'NOVA_OTHER_SETTING': 'override'})

    def test_local_service_pins_model_and_disables_thinking(self):
        class BaseHandler:
            def handle_chat_completions(self): return self.body
        handler_type = local_ai.make_handler(BaseHandler, 'pinned-model')
        handler = handler_type()
        handler.body = {'messages': []}
        handler.max_tokens = 99999
        handler.requested_model = 'untrusted/model'
        handler.adapter = '/untrusted/adapter'
        handler.chat_template_kwargs = {'enable_thinking': True}
        handler.handle_chat_completions()
        self.assertEqual(handler.requested_model, 'pinned-model')
        self.assertIsNone(handler.adapter)
        self.assertIsNone(handler.requested_draft_model)
        self.assertFalse(handler.chat_template_kwargs['enable_thinking'])
        self.assertEqual(handler.max_tokens, 8192)
        provider = SimpleNamespace(model=None)
        handler.response_generator = SimpleNamespace(is_healthy=True, model_provider=provider)
        self.assertFalse(handler.ready())
        provider.model = object()
        self.assertTrue(handler.ready())
        handler.response_generator.is_healthy = False
        self.assertFalse(handler.ready())


if __name__ == '__main__':
    unittest.main()
