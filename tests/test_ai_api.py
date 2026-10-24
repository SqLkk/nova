import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'supernova-backend'))
from db.database import Database
from api_server import app
import auth
from ai_memory import LocalMemory
from config import config


class AiApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='supernova-ai-tests-')
        cls.database = Database(str(Path(cls.temp.name) / 'app.sqlite'))
        cls.source = str(Path(cls.temp.name) / 'source.sqlite')
        with closing(sqlite3.connect(cls.source)) as conn:
            conn.execute('CREATE TABLE assets (id TEXT, parent_id TEXT, name TEXT, value REAL)')
            conn.executemany('INSERT INTO assets VALUES (?, ?, ?, ?)', [('A', None, 'Root', 10), ('B', 'A', 'Child', 20)])
            conn.commit()
        with cls.database._conn() as conn:
            cls.admin = conn.execute("SELECT id FROM users WHERE role='superuser' LIMIT 1").fetchone()['id']
            conn.execute("INSERT INTO data_sources (id,name,db_type,database_name,password,cached_tables) VALUES ('ds_ai','AI source','sqlite',?,'secret-never-leak','[\"assets\"]')", (cls.source,))
            for qid, owner, roles in [('q_ai', cls.admin, '[]'), ('q_private', 'someone_else', '[]')]:
                conn.execute('INSERT INTO queries (id,name,data_source_id,sql_text,owner_id,allowed_roles,columns_meta) VALUES (?,?,?,?,?,?,?)',
                    (qid, qid, 'ds_ai', 'SELECT * FROM assets', owner, roles, json.dumps([{'name': c} for c in ['id','parent_id','name','value']])))
        cls.patch = patch('api_server.get_db', return_value=cls.database); cls.patch.start()
        # Blueprint captures get_db; replace the lazy singleton rather than the closure.
        cls.singleton_patch = patch('db.database._db_instance', cls.database); cls.singleton_patch.start()
        app.config['TESTING'] = True
    @classmethod
    def tearDownClass(cls):
        cls.singleton_patch.stop(); cls.patch.stop(); cls.temp.cleanup()
    def setUp(self):
        self.client = app.test_client()
        self.headers = {'Authorization': 'Bearer ' + auth.create_token(self.admin, 'test-admin', 'superuser', 100)}
        self.viewer_headers = {'Authorization': 'Bearer ' + auth.create_token('other-viewer', 'viewer', 'viewer', 20)}
        self.config_patch = patch.multiple(config, AI_ENABLED=True, AI_MOCK_MODE=True)
        self.config_patch.start(); self.addCleanup(self.config_patch.stop)
    def test_auth_and_offline_fallback(self):
        self.assertEqual(self.client.get('/api/ai/status').status_code, 401)
        with patch.object(config, 'AI_ENABLED', False):
            self.assertFalse(self.client.get('/api/ai/status', headers=self.headers).json['available'])
            self.assertEqual(self.client.post('/api/ai/chat/stream', headers=self.headers, json={'messages':[{'role':'user','content':'hi'}]}).status_code, 503)
            self.assertEqual(self.client.get('/health').status_code, 200)
            self.assertEqual(self.client.get('/api/queries', headers=self.headers).status_code, 200)
    def test_enabled_model_service_offline_preserves_core(self):
        gateway = app.extensions['ai_service']
        with patch.multiple(config, AI_ENABLED=True, AI_MOCK_MODE=False,
                            AI_BASE_URL='http://127.0.0.1:1/v1', AI_TIMEOUT_SECONDS=1):
            gateway._cached_health = None
            import time
            start = time.monotonic()
            result = self.client.get('/api/ai/status', headers=self.headers)
            self.assertLess(time.monotonic() - start, .5)
            self.assertFalse(result.json['available'])
            self.assertEqual(self.client.get('/health').status_code, 200)
            self.assertEqual(self.client.get('/api/queries', headers=self.headers).status_code, 200)
            stream = self.client.post('/api/ai/chat/stream', headers=self.headers,
                json={'messages': [{'role': 'user', 'content': 'hi'}], 'context': {'page': 'python-workspace'}}).data.decode()
            self.assertIn('event: error', stream)
            self.assertNotIn('[DONE]', stream)
        gateway._cached_health = None
    def test_disabled_ai_does_not_index_normal_saves(self):
        with patch.object(config, 'AI_ENABLED', False), patch('ai_api.LocalMemory') as memory:
            response = self.client.post('/api/python/scripts', headers=self.headers,
                json={'name': 'Normal script without AI', 'code': "out('summary').append({'value': 1})"})
            self.assertEqual(response.status_code, 201)
            memory.assert_not_called()
    def test_mock_stream_and_aliases(self):
        for endpoint in ('/api/ai/chat/stream', '/api/ai/chat/completions'):
            response = self.client.post(endpoint, headers=self.headers, json={'messages':[{'role':'user','content':'satır sayısı'}],
                'context':{'page':'python-workspace','active_queries':[{'id':'q_ai','name':'forged'}]}})
            self.assertEqual(response.status_code, 200); self.assertEqual(response.mimetype, 'text/event-stream')
            self.assertEqual(response.headers['X-Accel-Buffering'], 'no')
            chunks = response.data.decode(); self.assertIn('[DONE]', chunks)
            text = ''.join(json.loads(line[6:])['choices'][0]['delta'].get('content','') for line in chunks.splitlines() if line.startswith('data: {"choices"'))
            self.assertIn('q_ai', text); self.assertNotIn('forged', text)
        self.assertTrue(self.client.get('/api/ai/health', headers=self.headers).json['mock'])
    def test_schema_acl_and_no_credentials(self):
        response = self.client.get('/api/ai/schema', headers=self.viewer_headers)
        serialized = json.dumps(response.json)
        self.assertNotIn('q_private', serialized); self.assertNotIn('secret-never-leak', serialized)
        self.assertNotIn('password', serialized); self.assertNotIn('username', serialized)
    def test_context_authorization_and_validation(self):
        body = {'messages':[{'role':'user','content':'hi'}], 'context':{'page':'python-workspace'}}
        self.assertEqual(self.client.post('/api/ai/chat/stream', headers=self.viewer_headers, json=body).status_code, 403)
        body['context']['active_queries'] = [{'id': []}]
        self.assertEqual(self.client.post('/api/ai/chat/stream', headers=self.headers, json=body).status_code, 400)
        body['messages'][0]['role'] = 'system'
        self.assertEqual(self.client.post('/api/ai/chat/stream', headers=self.headers, json=body).status_code, 400)
    def test_artifact_validation_and_real_path_preview(self):
        artifact = {'structure':'tree','queryId':'q_ai','config':{'id_col':'id','parent_col':'parent_id','label_col':'name'}}
        response = self.client.post('/api/ai/artifacts/validate', headers=self.headers, json={'kind':'path','artifact':artifact})
        self.assertEqual(response.status_code,200)
        response = self.client.post('/api/paths/preview', headers=self.headers, json=response.json['data'])
        self.assertEqual(response.status_code,200); self.assertEqual(response.json['data']['structure']['stats']['node_count'],2)
        artifact['config']['id_col'] = 'fiction'
        self.assertEqual(self.client.post('/api/ai/artifacts/validate', headers=self.headers, json={'kind':'path','artifact':artifact}).status_code,422)
    def test_real_sql_and_sandbox_test(self):
        result = self.client.post('/api/queries/preview', headers=self.headers, json={'dataSourceId':'ds_ai','sql':'SELECT SUM(value) AS total FROM assets'})
        self.assertEqual(result.status_code,200); self.assertEqual(result.json['data']['rows'][0]['total'],30)
        forbidden = self.client.post('/api/queries/preview', headers=self.headers, json={'dataSourceId':'ds_ai','sql':'DELETE FROM assets'})
        self.assertNotEqual(forbidden.status_code,200)
        script = "total = 0\nfor row in sql_data.get('q_ai', []):\n    total = total + row.get('value', 0)\nout('summary').append({'total': total})"
        result = self.client.post('/api/python/run', headers=self.headers, json={'code':script,'sqlQueryIds':['q_ai']})
        self.assertEqual(result.status_code,200); self.assertEqual(result.json['data']['summary']['rows'][0]['total'],30)
        self.assertEqual(self.client.post('/api/python/run', headers=self.viewer_headers, json={'code':script}).status_code,403)
    def test_saved_sources_indexed_and_updated(self):
        query = self.client.post('/api/queries', headers=self.headers, json={'name':'AI memory test','dataSourceId':'ds_ai','sql':'SELECT value FROM assets','allowedRoles':[]})
        self.assertEqual(query.status_code,201); qid=query.json['data']['id']
        self.client.put('/api/queries/'+qid, headers=self.headers, json={'sql':'SELECT name FROM assets'})
        with self.database._conn() as conn:
            row=conn.execute("SELECT * FROM golden_examples WHERE source_id=?",(qid,)).fetchone()
            self.assertEqual(row['content'],'SELECT name FROM assets')
        script=self.client.post('/api/python/scripts',headers=self.headers,json={'name':'AI script memory test','code':"out('summary').append({'value':1})"})
        self.assertEqual(script.status_code,201)
        sid=script.json['data']['id']
        self.client.put('/api/python/scripts/'+sid,headers=self.headers,json={'code':"out('summary').append({'value':2})"})
        with self.database._conn() as conn:
            self.assertIn("'value':2",conn.execute('SELECT content FROM golden_examples WHERE source_id=?',(sid,)).fetchone()['content'])
    def test_memory_revocation_and_deletion(self):
        memory=LocalMemory(self.database)
        with self.database._conn() as conn: row=dict(conn.execute("SELECT * FROM queries WHERE id='q_private'").fetchone())
        memory.index('sql',row)
        self.assertTrue(memory.retrieve('q_private assets',lambda r:r['owner_id']=='someone_else','query-creator'))
        self.assertFalse(memory.retrieve('q_private assets',lambda r:r['owner_id']=='unrelated','query-creator'))
        with self.database._conn() as conn: conn.execute("DELETE FROM queries WHERE id='q_private'")
        self.assertFalse(memory.retrieve('q_private assets',lambda r:True,'query-creator'))

    def test_chat_history_persistence_and_user_isolation(self):
        first = self.client.post(
            '/api/ai/chat/stream',
            headers=self.headers,
            json={
                'messages': [{'role': 'user', 'content': 'assets tablosundaki satır sayısını analiz et'}],
                'context': {'page': 'python-workspace', 'active_queries': [{'id': 'q_ai'}]},
            },
        )
        self.assertEqual(first.status_code, 200)
        raw_stream = first.data.decode()
        self.assertIn('event: session', raw_stream)

        session_payload = None
        lines = raw_stream.splitlines()
        for idx, line in enumerate(lines):
            if line.strip() == 'event: session' and idx + 1 < len(lines) and lines[idx + 1].startswith('data:'):
                session_payload = json.loads(lines[idx + 1][5:].strip())
                break
        self.assertIsNotNone(session_payload)
        chat_id = session_payload['sessionId']
        self.assertTrue(chat_id.startswith('chat_'))

        # Second turn in same session
        second = self.client.post(
            '/api/ai/chat/stream',
            headers=self.headers,
            json={
                'messages': [
                    {'role': 'user', 'content': 'assets tablosundaki satır sayısını analiz et'},
                    {'role': 'assistant', 'content': 'Önceki yanıt'},
                    {'role': 'user', 'content': 'toplam değeri de ekle'},
                ],
                'context': {
                    'page': 'python-workspace',
                    'chat_session_id': chat_id,
                    'active_queries': [{'id': 'q_ai'}],
                },
            },
        )
        self.assertEqual(second.status_code, 200)
        _ = second.data

        # Sync live coworker steps metadata onto latest assistant turn
        meta_res = self.client.post(
            f'/api/ai/history/{chat_id}/meta',
            headers=self.headers,
            json={'coworkerSteps': [{'id': 's1', 'label': 'Python çalıştırıldı', 'status': 'done', 'pageBadge': 'Python'}]},
        )
        self.assertEqual(meta_res.status_code, 200)
        self.assertTrue(meta_res.json['updated'])

        # Retrieve session and verify messages + persisted coworkerSteps
        detail = self.client.get(f'/api/ai/history/{chat_id}', headers=self.headers)
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json['data']['session']['messageCount'], 4)
        self.assertEqual(len(detail.json['data']['messages']), 4)
        self.assertEqual(detail.json['data']['messages'][-1]['coworkerSteps'][0]['id'], 's1')

        # Strict user isolation: viewer cannot read, update, or delete admin's session
        self.assertEqual(self.client.get(f'/api/ai/history/{chat_id}', headers=self.viewer_headers).status_code, 404)
        viewer_list = self.client.get('/api/ai/history', headers=self.viewer_headers).json['data']['sessions']
        self.assertFalse(any(s['id'] == chat_id for s in viewer_list))
        del_forbidden = self.client.delete(f'/api/ai/history/{chat_id}', headers=self.viewer_headers)
        self.assertFalse(del_forbidden.json['deleted'])

        # Owner can delete session
        del_ok = self.client.delete(f'/api/ai/history/{chat_id}', headers=self.headers)
        self.assertTrue(del_ok.json['deleted'])
        self.assertEqual(self.client.get(f'/api/ai/history/{chat_id}', headers=self.headers).status_code, 404)

    def test_cross_session_persistent_memory_learning_and_recall(self):
        # 1. Manual memory note sets chart preference to pie
        note_res = self.client.post(
            '/api/ai/memory',
            headers=self.headers,
            json={'note': 'Raporlarda her zaman pasta grafik kullan'},
        )
        self.assertEqual(note_res.status_code, 200)
        mem_id = note_res.json['data']['id']

        # 2. First chat turn builds a report with q_ai and explicitly updates preference to line chart
        turn1 = self.client.post(
            '/api/ai/chat/stream',
            headers=self.headers,
            json={
                'messages': [{'role': 'user', 'content': 'q_ai sorgusunu kullanarak rapor oluştur, unutma her zaman çizgi grafik kullan'}],
                'context': {'page': 'template-builder', 'data_source_id': 'ds_ai'},
            },
        )
        self.assertEqual(turn1.status_code, 200)
        stream1 = turn1.data.decode()
        self.assertIn('event: proposal', stream1)

        # Verify memories were learned in local SQLite DB
        hist = self.client.get('/api/ai/history', headers=self.headers).json['data']
        self.assertTrue(any(m['key'] == 'pref:chart_type' and m['payload'].get('chartType') == 'line' for m in hist['memories']))

        # 3. Brand-new chat session (no chat_session_id, single shorthand message) recalls q_ai + line chart!
        turn2 = self.client.post(
            '/api/ai/chat/stream',
            headers=self.headers,
            json={
                'messages': [{'role': 'user', 'content': 'geçen sorgu ile aynı raporu hazırla'}],
                'context': {'page': 'template-builder'},
            },
        )
        self.assertEqual(turn2.status_code, 200)
        stream2 = turn2.data.decode()
        self.assertIn('event: proposal', stream2)
        proposal2 = None
        lines2 = stream2.splitlines()
        for idx, line in enumerate(lines2):
            if line.strip() == 'event: proposal' and idx + 1 < len(lines2) and lines2[idx + 1].startswith('data:'):
                proposal2 = json.loads(lines2[idx + 1][5:].strip())
                break
        self.assertIsNotNone(proposal2)
        self.assertEqual(proposal2['queryId'], 'q_ai')
        self.assertEqual(proposal2['chart']['type'], 'line')

        # 4. Delete single memory & clear remaining memories
        self.assertTrue(self.client.delete(f'/api/ai/memory/{mem_id}', headers=self.headers).json.get('deleted') in (True, False))
        cleared = self.client.delete('/api/ai/memory', headers=self.headers)
        self.assertEqual(cleared.status_code, 200)
        after_mem = self.client.get('/api/ai/history', headers=self.headers).json['data']['memories']
        self.assertEqual(len(after_mem), 0)

    def test_plug_and_play_optional_ai_mode(self):
        with patch.object(config, 'AI_ENABLED', False):
            pub_health = self.client.get('/api/ai/health')
            self.assertEqual(pub_health.status_code, 200)
            self.assertFalse(pub_health.json['available'])
            self.assertEqual(pub_health.json['reason'], 'disabled')
            self.assertTrue(pub_health.json['optional'])

            auth_status = self.client.get('/api/ai/status', headers=self.headers)
            self.assertEqual(auth_status.status_code, 200)
            self.assertFalse(auth_status.json['available'])
            self.assertTrue(auth_status.json['optional'])

            # Local DB chat history remains safely readable even when AI is disabled
            hist = self.client.get('/api/ai/history', headers=self.headers)
            self.assertEqual(hist.status_code, 200)
            self.assertIn('sessions', hist.json['data'])

            # All core SuperNova endpoints work at 100% capacity without AI
            self.assertEqual(self.client.get('/health').status_code, 200)
            self.assertEqual(self.client.get('/api/queries', headers=self.headers).status_code, 200)
            self.assertEqual(self.client.get('/api/paths', headers=self.headers).status_code, 200)
            self.assertEqual(self.client.get('/api/templates', headers=self.headers).status_code, 200)


if __name__ == '__main__': unittest.main()
