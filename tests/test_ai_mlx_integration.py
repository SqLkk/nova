"""Explicit hardware integration: SUPERNOVA_TEST_MLX=1; launch local_ai.py first."""
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'supernova-backend'))


@unittest.skipUnless(os.environ.get('SUPERNOVA_TEST_MLX') in ('1', 'offline'), 'Explicit local MLX hardware test')
class MlxIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from api_server import app
        import auth
        from config import config
        from db.database import Database
        cls.temp = tempfile.TemporaryDirectory(prefix='supernova-mlx-integration-')
        cls.database = Database(str(Path(cls.temp.name) / 'app.sqlite'))
        source = str(Path(cls.temp.name) / 'source.sqlite')
        with closing(sqlite3.connect(source)) as conn:
            conn.execute('CREATE TABLE assets (value REAL)')
            conn.executemany('INSERT INTO assets VALUES (?)', [(10,), (20,)])
            conn.commit()
        with cls.database._conn() as conn:
            uid = conn.execute("SELECT id FROM users WHERE role='superuser' LIMIT 1").fetchone()['id']
            conn.execute("INSERT INTO data_sources (id,name,db_type,database_name) VALUES ('ds_mlx','MLX test','sqlite',?)", (source,))
            conn.execute('INSERT INTO queries (id,name,data_source_id,sql_text,owner_id,allowed_roles,columns_meta) VALUES (?,?,?,?,?,?,?)',
                         ('q_mlx', 'Assets', 'ds_mlx', 'SELECT value FROM assets', uid, '[]', '[{"name":"value"}]'))
        cls.singleton = patch('db.database._db_instance', cls.database)
        cls.singleton.start()
        cls.settings = patch.multiple(config, AI_ENABLED=True, AI_MOCK_MODE=False,
            AI_BASE_URL='http://127.0.0.1:8085/v1', AI_PROVIDER='openai',
            AI_MODEL_NAME='mlx-community/Qwen3.5-9B-MLX-4bit', AI_TIMEOUT_SECONDS=120,
            AI_MAX_TOKENS=1024, AI_TOOLS_ENABLED=True, AI_MEMORY_ENABLED=False)
        cls.settings.start()
        cls.app = app
        cls.client = app.test_client()
        cls.headers = {'Authorization': 'Bearer ' + auth.create_token(uid, 'mlx-test', 'superuser', 100)}

    @classmethod
    def tearDownClass(cls):
        cls.settings.stop()
        cls.singleton.stop()
        cls.temp.cleanup()

    @unittest.skipUnless(os.environ.get('SUPERNOVA_TEST_MLX') == '1', 'Requires running model')
    def test_real_model_stream_and_sandbox_execution(self):
        start = time.monotonic()
        health = self.client.get('/api/ai/status', headers=self.headers)
        self.assertLess(time.monotonic() - start, .5)
        self.assertTrue(health.json['available'], health.json)
        self.assertFalse(health.json['mock'])
        body = {'messages': [{'role': 'user', 'content':
            "Assets sorgusundaki value sütununu topla. Yalnızca Python kod bloğu döndür. "
            "sql_data.get('Assets', []) satırlarını döngüyle oku ve sonucu "
            "out('summary').append({'total': total}) ile yaz. Başka işlem yapma."}],
            'context': {'page': 'python-workspace', 'active_queries': [{'id': 'q_mlx'}]}}
        response = self.client.post('/api/ai/chat/stream', json=body, headers=self.headers)
        stream = response.data.decode()
        self.assertEqual(response.status_code, 200)
        self.assertIn('[DONE]', stream)
        self.assertNotIn('event: error', stream)
        answer = ''.join(json.loads(line[6:])['choices'][0]['delta'].get('content', '')
            for line in stream.splitlines() if line.startswith('data: {"choices"'))
        self.assertNotIn('<think>', answer)
        self.assertNotIn('</think>', answer)
        code_match = re.search(r'```(?:python)?\s*\n(.*?)```', answer, re.S)
        self.assertIsNotNone(code_match, answer)
        code = code_match.group(1).strip()
        validation = self.client.post('/api/ai/artifacts/validate', headers=self.headers,
            json={'kind': 'python', 'artifact': code})
        self.assertEqual(validation.status_code, 200, validation.json)
        result = self.client.post('/api/python/run', headers=self.headers,
            json={'code': code, 'sqlQueryIds': ['q_mlx']})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json['data']['summary']['rows'][0]['total'], 30)
        print(f'\nReal Qwen/Flask/SSE/sandbox passed ({time.monotonic() - start:.1f}s):\n{code}')

    @unittest.skipUnless(os.environ.get('SUPERNOVA_TEST_MLX') == '1', 'Requires running model')
    def test_real_schema_function_call(self):
        body = {'messages': [{'role': 'user', 'content':
            'tool_get_database_schema aracını bir kez çağırıp erişebildiğim kayıtlı sorguların '
            'isimlerini ve kolonlarını kısaca listele. Başka araç çağırma ve kod üretme.'}],
            'context': {'page': 'query-creator', 'active_queries': []}}
        response = self.client.post('/api/ai/chat/stream', json=body, headers=self.headers)
        stream = response.data.decode()
        self.assertEqual(response.status_code, 200)
        self.assertIn('event: tool', stream)
        self.assertIn('tool_get_database_schema', stream)
        self.assertIn('[DONE]', stream)
        self.assertNotIn('event: error', stream)
        answer = ''.join(json.loads(line[6:])['choices'][0]['delta'].get('content', '')
            for line in stream.splitlines() if line.startswith('data: {"choices"'))
        self.assertIn('Assets', answer)
        self.assertIn('value', answer)
        self.assertNotIn('<think>', answer)
        print('\nReal Qwen schema tool round trip passed.')

    @unittest.skipUnless(os.environ.get('SUPERNOVA_TEST_MLX') == 'offline', 'Requires stopped model')
    def test_stopped_model_keeps_platform_working(self):
        start = time.monotonic()
        health = self.client.get('/api/ai/status', headers=self.headers)
        elapsed = time.monotonic() - start
        self.assertFalse(health.json['available'], health.json)
        self.assertLess(elapsed, .5)
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/api/queries', headers=self.headers).status_code, 200)
        result = self.client.post('/api/python/run', headers=self.headers,
            json={'code': "out('summary').append({'count': len(sql_data.get('Assets', []))})", 'sqlQueryIds': ['q_mlx']})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json['data']['summary']['rows'][0]['count'], 2)
        print(f'\nStopped MLX: health unavailable in {elapsed * 1000:.0f} ms; queries and sandbox work.')


if __name__ == '__main__':
    unittest.main()
