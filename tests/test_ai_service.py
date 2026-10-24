import json
from pathlib import Path
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'supernova-backend'))
from ai_service import AIService, AIUnavailable
from ai_tools import validate_python, validate_path, validate_template


def settings(**overrides):
    values = dict(AI_ENABLED=True, AI_PROVIDER='openai', AI_BASE_URL='http://127.0.0.1:1/v1',
                  AI_MODEL_NAME='test-model', AI_API_KEY='', AI_TEMPERATURE=0.2,
                  AI_TIMEOUT_SECONDS=2, AI_MAX_TOKENS=512, AI_MAX_CONCURRENT=1,
                  AI_MEMORY_ENABLED=True, AI_TOOLS_ENABLED=True, AI_MOCK_MODE=False)
    return SimpleNamespace(**{**values, **overrides})


class FakeModel(BaseHTTPRequestHandler):
    mode = 'normal'
    payloads = []
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        data = {'models': [{'name': 'test-model'}]} if self.path.endswith('/api/tags') else {'data': [{'id': 'test-model'}]}
        self.wfile.write(json.dumps(data).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.payloads.append(body)
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        if self.mode == 'stall': time.sleep(1); return
        if self.mode == 'broken': self.wfile.write(b'data: {bad json}\n\n'); return
        if self.mode == 'length':
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n'); return
        native = self.path.endswith('/api/chat')
        if self.mode == 'tool' and not any(m['role'] == 'tool' for m in body['messages']):
            if native:
                self.wfile.write((json.dumps({'message': {'content': '', 'tool_calls': [{'function': {'name': 'tool_get_database_schema', 'arguments': {}}}]}, 'done': True}) + '\n').encode()); return
            data = {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'c1', 'function': {'name': 'tool_get_database_schema', 'arguments': '{}'}}]}, 'finish_reason': 'tool_calls'}]}
            self.wfile.write(('data: ' + json.dumps(data) + '\n\n').encode()); return
        if native:
            self.wfile.write((json.dumps({'message': {'content': 'Merhaba 🌟'}, 'done': True}) + '\n').encode())
        else:
            for text in ['Mer', 'haba 🌟']:
                self.wfile.write(('data: ' + json.dumps({'choices': [{'delta': {'content': text}}]}, ensure_ascii=False) + '\n\n').encode())
                self.wfile.flush()
            if self.mode != 'truncated': self.wfile.write(b'data: [DONE]\n\n')


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FakeModel)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.worker.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close()
    def setUp(self): FakeModel.mode = 'normal'; FakeModel.payloads = []
    def gateway(self, **overrides):
        result = AIService(settings(AI_BASE_URL=self.base + '/v1', **overrides))
        self.addCleanup(result._health_executor.shutdown, wait=False)
        return result
    def stream(self, service, dispatch=lambda *_: {}):
        return ''.join(service.stream([{'role': 'user', 'content': 'Merhaba'}], {'page': 'python-workspace'}, dispatch))
    def test_disabled_does_no_network(self):
        service = self.gateway(AI_ENABLED=False)
        with patch.object(service, '_probe', side_effect=AssertionError('Network used')):
            start = time.monotonic(); self.assertFalse(service.health()['available'])
            self.assertLess(time.monotonic() - start, .1)
        with self.assertRaises(AIUnavailable): self.stream(service)
    def test_health_and_missing_model(self):
        service = self.gateway(); self.assertTrue(service.health()['available'])
        service = self.gateway(AI_MODEL_NAME='not-installed'); self.assertEqual(service.health()['reason'], 'model_missing')
    def test_health_total_budget_even_slow_dns(self):
        service = self.gateway()
        with patch.object(service, '_probe', side_effect=lambda: (time.sleep(.7) or {'available': True})):
            start = time.monotonic(); self.assertFalse(service.health()['available'])
            self.assertLess(time.monotonic() - start, .5)
        service._health_future.result(timeout=1)
    def test_openai_stream_utf8_and_server_system(self):
        output = self.stream(self.gateway())
        self.assertIn('haba 🌟', output); self.assertIn('[DONE]', output)
        payload = FakeModel.payloads[0]
        self.assertEqual(payload['model'], 'test-model')
        self.assertIn('NO imports', payload['messages'][0]['content'])
        self.assertIn('tools', payload)
    def test_native_ollama(self):
        service = AIService(settings(AI_BASE_URL=self.base, AI_PROVIDER='ollama'))
        self.addCleanup(service._health_executor.shutdown, wait=False)
        self.assertTrue(service.health()['available']); self.assertIn('Merhaba 🌟', self.stream(service))
        self.assertIn('options', FakeModel.payloads[0])
    def test_tool_round_trip(self):
        FakeModel.mode = 'tool'; calls = []
        output = self.stream(self.gateway(), lambda name, args: calls.append((name, args)) or {'queries': []})
        self.assertEqual(calls, [('tool_get_database_schema', {})]); self.assertIn('event: tool', output)
        self.assertEqual(FakeModel.payloads[-1]['messages'][-1]['role'], 'tool'); self.assertIn('[DONE]', output)
    def test_native_tool_round_trip(self):
        FakeModel.mode = 'tool'
        service = AIService(settings(AI_BASE_URL=self.base, AI_PROVIDER='ollama'))
        self.addCleanup(service._health_executor.shutdown, wait=False)
        output = self.stream(service, lambda *_: {'queries': []})
        self.assertIn('[DONE]', output)
        self.assertEqual(FakeModel.payloads[-1]['messages'][-1]['tool_name'], 'tool_get_database_schema')
    def test_partial_or_malformed_upstream_fails(self):
        for mode in ('broken', 'truncated', 'length'):
            FakeModel.mode = mode
            with self.assertRaises(AIUnavailable): self.stream(self.gateway())
    def test_total_stream_deadline(self):
        FakeModel.mode = 'stall'
        service = self.gateway(AI_TIMEOUT_SECONDS=.15)
        start = time.monotonic()
        with self.assertRaises(AIUnavailable): self.stream(service)
        self.assertLess(time.monotonic() - start, .5)
    def test_cancel_releases_slot(self):
        service = self.gateway(AI_MOCK_MODE=True)
        stream = service.stream([{'role': 'user', 'content': 'hi'}], {}, lambda *_: {})
        next(stream); stream.close()
        self.assertIn('[DONE]', self.stream(service))
    def test_concurrent_requests_bounded(self):
        service = self.gateway(AI_MOCK_MODE=True)
        active = service.stream([{'role': 'user', 'content': 'hi'}], {}, lambda *_: {}); next(active)
        with self.assertRaises(AIUnavailable): self.stream(service)
        active.close()
    def test_request_validation_and_client_overrides(self):
        service = self.gateway()
        for bad in ([], {}, {'messages': [{'role': 'system', 'content': 'override'}]},
                    {'messages': [{'role': 'user', 'content': ''}]},
                    {'messages': [{'role': 'user', 'content': 'hi'}], 'context': []},
                    {'messages': [{'role': 'assistant', 'content': 'hi'}]}):
            with self.assertRaises(ValueError): service.validate_request(bad)
        messages, _ = service.validate_request({'messages': [{'role': 'user', 'content': 'hi'}], 'model': 'attacker'})
        self.assertEqual(messages[0]['role'], 'user'); self.assertEqual(service.settings.AI_MODEL_NAME, 'test-model')


class ArtifactTests(unittest.TestCase):
    queries = [{'id': 'q1', 'columns': [{'name': c} for c in ['id', 'parent_id', 'label', 'value', 'category', 'order']]}]
    def test_sandbox_validation(self):
        self.assertTrue(validate_python("for row in sql_data.get('Q', []):\n    out('data').append({'x': row.get('value', 0)})")['valid'])
        for code in ['import os', "open('/tmp/x')", 'x.__class__', "'{0}'.format(1)", 'x = [i for i in range(5)]']:
            with self.assertRaises(ValueError): validate_python(code)
    def test_all_path_types(self):
        configs = {'tree': {'id_col': 'id', 'parent_col': 'parent_id'}, 'binary_tree': {'id_col': 'id', 'parent_col': 'parent_id'},
                   'sequence': {'id_col': 'id', 'order_col': 'order'}, 'grouped': {'group_col': 'category'}, 'dag': {'id_col': 'id', 'parents_col': 'parent_id'}}
        for structure, config in configs.items(): self.assertEqual(validate_path({'queryId': 'q1', 'structure': structure, 'config': config}, self.queries)['structure'], structure)
        with self.assertRaises(ValueError): validate_path({'queryId': 'q1', 'structure': 'tree', 'config': {'id_col': 'invented', 'parent_col': 'parent_id'}}, self.queries)
        with self.assertRaises(ValueError): validate_path({'queryId': 'private', 'structure': 'grouped', 'config': {'group_col': 'category'}}, self.queries)
    def test_template_validation(self):
        chart = {'id': 'c1', 'type': 'pie', 'queryId': 'q1', 'anchor': {'row': 1, 'col': 1, 'widthCols': 5, 'heightRows': 12}, 'xAxis': 'label', 'yAxis': ['value']}
        valid = validate_template({'charts': [chart], 'cells': [{'row': 2, 'col': 1, 'binding': {'kind': 'summary', 'queryId': 'q1', 'field': 'value', 'operation': 'SUM'}}]}, self.queries)
        self.assertEqual(valid['charts'][0]['type'], 'pie')
        chart['anchor']['row'] = 0
        with self.assertRaises(ValueError): validate_template({'charts': [chart]}, self.queries)
        with self.assertRaises(ValueError): validate_template({'cells': [{'row': 1, 'col': 1, 'binding': {'kind': 'query_field', 'queryId': 'q1', 'field': 'fake'}}]}, self.queries)


if __name__ == '__main__': unittest.main()
