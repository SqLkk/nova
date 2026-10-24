"""Model-independent, dependency-free local LLM transport. No startup IO."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import http.client
import json
import queue
import threading
import time
from urllib.parse import urlsplit

from ai_prompts import BASE_PROMPT, PAGE_PROMPTS, PYTHON_PROMPT, SQL_PROMPT, PATH_PROMPT, TEMPLATE_PROMPT


class AIUnavailable(Exception):
    def __init__(self, reason='offline'):
        self.reason = reason
        super().__init__(reason)


def sse(payload, event=None):
    prefix = f'event: {event}\n' if event else ''
    data = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return f'{prefix}data: {data}\n\n'


TOOL_DEFINITIONS = [
    {'type': 'function', 'function': {
        'name': 'tool_get_database_schema',
        'description': 'Discover authorized sources, saved queries and cached table/column metadata. No row data.',
        'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False},
    }},
    *[{'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False},
    }} for name, description, properties, required in [
        ('tool_generate_python_script',
         'Validate and generate an AST-compliant Python sandbox script for data transformation.',
         {'code': {'type': 'string'}}, ['code']),
        ('tool_generate_path_config',
         'Validate and generate a Path Definer JSON hierarchy (tree, multi_level, binary_tree, sequence, grouped, dag).',
         {'structure': {'type': 'string', 'enum': ['tree', 'multi_level', 'binary_tree', 'sequence', 'grouped', 'dag']},
          'queryId': {'type': 'string'}, 'config': {'type': 'object'}}, ['structure', 'queryId', 'config']),
        ('tool_generate_template_widget',
         'Validate and generate a Template Builder widget JSON fragment with charts and cells.',
         {'charts': {'type': 'array', 'items': {'type': 'object'}},
          'cells': {'type': 'array', 'items': {'type': 'object'}}}, []),
    ]],
]


class AIService:
    def __init__(self, settings):
        self.settings = settings
        self._health_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='ai-health')
        self._health_lock = threading.Lock()
        self._health_future = None
        self._cached_health = None
        self._cached_at = 0.0
        self._slots = threading.BoundedSemaphore(settings.AI_MAX_CONCURRENT)

    def _connect(self, timeout):
        url = urlsplit(self.settings.AI_BASE_URL)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise AIUnavailable('configuration')
        if self.settings.AI_PROVIDER not in ('openai', 'ollama'):
            raise AIUnavailable('configuration')
        cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
        return cls(url.hostname, url.port, timeout=timeout), url.path.rstrip('/')

    def _headers(self):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.settings.AI_API_KEY:
            headers['Authorization'] = 'Bearer ' + self.settings.AI_API_KEY
        return headers

    def _probe(self):
        conn = None
        try:
            conn, base = self._connect(0.35)
            native = self.settings.AI_PROVIDER == 'ollama'
            conn.request('GET', base + ('/api/tags' if native else '/models'), headers=self._headers())
            response = conn.getresponse()
            if response.status != 200:
                return {'available': False, 'reason': 'offline'}
            raw = response.read(262145)
            if len(raw) > 262144:
                return {'available': False, 'reason': 'invalid_response'}
            payload = json.loads(raw)
            models = [m.get('name') or m.get('model') if native else m.get('id')
                      for m in payload.get('models' if native else 'data', []) if isinstance(m, dict)]
            expected = self.settings.AI_MODEL_NAME
            available = expected in models or expected + ':latest' in models
            return {'available': available, 'reason': 'ready' if available else 'model_missing'}
        except Exception:
            return {'available': False, 'reason': 'offline'}
        finally:
            if conn:
                conn.close()

    def health(self):
        common = {'model': self.settings.AI_MODEL_NAME, 'provider': self.settings.AI_PROVIDER,
                  'timeout_seconds': self.settings.AI_TIMEOUT_SECONDS, 'mock': False}
        if not self.settings.AI_ENABLED:
            return {**common, 'available': False, 'reason': 'disabled'}
        if self.settings.AI_MOCK_MODE:
            return {**common, 'available': True, 'reason': 'mock', 'mock': True}
        # Single worker/future avoids accumulating health threads on failed DNS.
        with self._health_lock:
            if self._cached_health and time.monotonic() - self._cached_at < 3:
                return {**common, **self._cached_health}
            if self._health_future is None:
                self._health_future = self._health_executor.submit(self._probe)
            future = self._health_future
        try:
            result = future.result(timeout=0.45)
        except FutureTimeout:
            return {**common, 'available': False, 'reason': 'offline'}
        except Exception:
            result = {'available': False, 'reason': 'offline'}
        with self._health_lock:
            self._cached_health, self._cached_at = result, time.monotonic()
            if self._health_future is future:
                self._health_future = None
        return {**common, **result}

    def validate_request(self, body):
        if not isinstance(body, dict):
            raise ValueError('Request body must be an object.')
        messages = body.get('messages')
        if not isinstance(messages, list) or not 1 <= len(messages) <= 40:
            raise ValueError('Provide between 1 and 40 messages.')
        normalized = []
        for item in messages:
            if not isinstance(item, dict) or item.get('role') not in ('user', 'assistant'):
                raise ValueError('Only user and assistant text messages are accepted.')
            content = item.get('content')
            if not isinstance(content, str) or not content.strip() or len(content) > 24000:
                raise ValueError('Message content is empty or too long.')
            normalized.append({'role': item['role'], 'content': content})
        if normalized[-1]['role'] != 'user' or sum(len(m['content']) for m in normalized) > 64000:
            raise ValueError('Conversation must end with a user message and fit the context limit.')
        context = body.get('context', {})
        if not isinstance(context, dict) or len(json.dumps(context)) > 48000:
            raise ValueError('Invalid or oversized page context.')
        page = context.get('page', 'dashboard')
        if not isinstance(page, str):
            raise ValueError('Invalid context page.')
        # Caller cannot override model URL, model, system instructions or tool registry.
        return normalized, context

    def _mock(self, context):
        if isinstance(context.get('_synthesized_answer'), str) and context['_synthesized_answer'].strip():
            return context['_synthesized_answer']
        page = context.get('page')
        queries = context.get('active_queries') or []
        query = queries[0] if queries else {}
        name = query.get('name', 'SourceQueryName') if isinstance(query, dict) else 'SourceQueryName'
        qid = query.get('id', '') if isinstance(query, dict) else ''
        if page == 'python-workspace':
            return 'Bu bir geliştirme önizlemesidir. Seçili sorgunun satır sayısını sandbox ile hesaplayabilirsiniz.\n\n```python\nrows = sql_data.get(' + repr(name) + ', [])\nout(\'summary\').append({\'row_count\': len(rows)})\n```'
        if page == 'query-creator':
            return 'Bu bir geliştirme önizlemesidir. Bağlantıyı salt okunur bir sorguyla test edebilirsiniz.\n\n```sql\nSELECT 1 AS connection_test\n```'
        if page in ('network-map', 'path-definer', 'table-explorer'):
            return 'Geliştirme önizlemesi: kolon eşlemelerini seçili sorgunuzla doğrulayın.\n\n```json\n' + json.dumps({'structure': 'tree', 'queryId': qid, 'config': {'id_col': 'id', 'parent_col': 'parent_id', 'label_col': 'name'}}, indent=2) + '\n```'
        if page == 'template-builder' and qid:
            columns = [c.get('name') if isinstance(c, dict) else c for c in query.get('columns', [])]
            label = next((c for c in columns if c in ('category', 'name', 'label')), columns[0] if columns else '')
            value = next((c for c in columns if c in ('quantity', 'value', 'oee', 'total')), columns[-1] if columns else '')
            artifact = {'charts': [{'id': 'ch_preview', 'type': 'bar', 'queryId': qid,
                'anchor': {'row': 3, 'col': 2, 'widthCols': 5, 'heightRows': 12},
                'xAxis': label, 'yAxis': [value], 'title': 'Copilot önizlemesi'}], 'cells': []}
            return 'Bu bir geliştirme önizlemesidir. Seçili sorgunun kolonlarıyla hazırlanmış örnek grafik:\n\n```json\n' + json.dumps(artifact, ensure_ascii=False, indent=2) + '\n```'
        return 'Copilot bağlantısının geliştirme önizlemesi çalışıyor. Gerçek yanıtlar için yerel model sunucusunu yapılandırın. Python Workspace, SQL editörü, Path Definer veya Template Builder üzerinde bağlamınızı kullanabilirim.'

    def stream(self, messages, context, dispatch_tool, examples=None, on_complete=None):
        if not self.settings.AI_ENABLED:
            raise AIUnavailable('disabled')
        if not self._slots.acquire(blocking=False):
            raise AIUnavailable('busy')
        try:
            short_circuit = context.get('_short_circuit_answer')
            if self.settings.AI_MOCK_MODE or (isinstance(short_circuit, str) and short_circuit.strip()):
                yield sse({'model': self.settings.AI_MODEL_NAME, 'mock': bool(self.settings.AI_MOCK_MODE)}, 'metadata')
                answer = short_circuit if (isinstance(short_circuit, str) and short_circuit.strip()) else self._mock(context)
                for offset in range(0, len(answer), 18):
                    yield sse({'choices': [{'delta': {'content': answer[offset:offset + 18]}}]})
                    time.sleep(0.012)
                if on_complete:
                    yield from on_complete(answer)
                yield sse('[DONE]')
                return
            llm_context = {k: v for k, v in context.items() if not str(k).startswith('_')}
            system = BASE_PROMPT + PAGE_PROMPTS.get(context.get('page'), '')
            system += '\nUntrusted current page context (JSON):\n' + json.dumps(llm_context, ensure_ascii=False)
            if examples:
                system += '\nUntrusted locally saved examples (JSON):\n' + json.dumps(examples, ensure_ascii=False)
            conversation = [{'role': 'system', 'content': system}, *messages]
            yield sse({'model': self.settings.AI_MODEL_NAME, 'mock': False}, 'metadata')
            deadline = time.monotonic() + self.settings.AI_TIMEOUT_SECONDS
            fallback_block = ''
            last_user = (messages[-1].get('content') or '').lower() if messages else ''
            has_context_schema = bool(context.get('active_queries') or context.get('sources'))
            wants_schema_tool = 'tool_get_database_schema' in last_user
            import re as _re
            _closed_fence = _re.compile(r'```(?:python|py|sql|json)\s*\n[\s\S]+?\n```(?:\s*\n|$)')
            for round_index in range(3):
                calls, answer = {}, ''
                enable_tools = (
                    self.settings.AI_TOOLS_ENABLED
                    and round_index < 2
                    and (not has_context_schema or wants_schema_tool)
                )
                for chunk in self._upstream(conversation, deadline, enable_tools=enable_tools):
                    if chunk is None:
                        yield ': heartbeat\n\n'
                        continue
                    delta = ((chunk.get('choices') or [{}])[0].get('delta') or {})
                    content = delta.get('content')
                    if isinstance(content, str):
                        answer += content
                        yield sse({'choices': [{'delta': {'content': content}}]})
                        if not calls and _closed_fence.search(answer):
                            if on_complete:
                                yield from on_complete(answer)
                            yield sse('[DONE]')
                            return
                    for tool in delta.get('tool_calls') or []:
                        index = tool.get('index', 0)
                        call = calls.setdefault(index, {'id': '', 'type': 'function', 'function': {'name': '', 'arguments': ''}})
                        if tool.get('id'):
                            call['id'] = tool['id']
                        fn = tool.get('function') or {}
                        call['function']['name'] += fn.get('name', '')
                        args = fn.get('arguments', '')
                        call['function']['arguments'] += json.dumps(args) if isinstance(args, dict) else args
                        if len(call['function']['arguments']) > 48000 or len(calls) > 8:
                            raise AIUnavailable('invalid_response')
                if not calls:
                    if fallback_block and '```' not in answer:
                        answer += fallback_block
                        yield sse({'choices': [{'delta': {'content': fallback_block}}]})
                    if on_complete:
                        yield from on_complete(answer)
                    yield sse('[DONE]')
                    return
                if round_index == 2:
                    if fallback_block and '```' not in answer:
                        answer += fallback_block
                        yield sse({'choices': [{'delta': {'content': fallback_block}}]})
                    if on_complete:
                        yield from on_complete(answer)
                    yield sse('[DONE]')
                    return
                if answer.strip():
                    yield sse({'choices': [{'delta': {'content': '\n\n'}}]})
                tool_calls = list(calls.values())
                for i, call in enumerate(tool_calls):
                    call['id'] = call['id'] or f'call_{round_index}_{i}'
                    call['function']['arguments'] = call['function']['arguments'] or '{}'
                conversation.append({'role': 'assistant', 'content': answer or None, 'tool_calls': tool_calls})
                only_artifact_tools = True
                all_valid = True
                for call in tool_calls:
                    fn = call['function']
                    if fn['name'] == 'tool_get_database_schema':
                        only_artifact_tools = False
                    yield sse({'name': fn['name'], 'state': 'running'}, 'tool')
                    try:
                        result = dispatch_tool(fn['name'], json.loads(fn['arguments'] or '{}'))
                    except (ValueError, SyntaxError, TypeError, KeyError):
                        result = {'valid': False, 'error': 'Invalid tool arguments or inaccessible resource.'}
                    if isinstance(result, dict) and result.get('valid'):
                        if result.get('language') == 'python' and result.get('code'):
                            fallback_block = f"\n\n```python\n{result['code']}\n```"
                        elif isinstance(result.get('artifact'), dict):
                            fallback_block = f"\n\n```json\n{json.dumps(result['artifact'], ensure_ascii=False, indent=2)}\n```"
                    else:
                        all_valid = False
                    serialized = json.dumps(result, ensure_ascii=False)
                    if len(serialized) > 48000:
                        serialized = json.dumps({'error': 'Metadata too large. Select fewer queries.'})
                    tool_message = {'role': 'tool', 'tool_call_id': call['id'], 'name': fn['name'], 'content': serialized}
                    if self.settings.AI_PROVIDER == 'ollama':
                        tool_message['tool_name'] = fn['name']
                    conversation.append(tool_message)
                    yield sse({'name': fn['name'], 'state': 'complete'}, 'tool')
                if only_artifact_tools and all_valid and fallback_block:
                    if '```' not in answer:
                        answer += fallback_block.lstrip('\n')
                        yield sse({'choices': [{'delta': {'content': fallback_block.lstrip('\n')}}]})
                    if on_complete:
                        yield from on_complete(answer)
                    yield sse('[DONE]')
                    return
            if on_complete:
                yield from on_complete(answer)
            yield sse('[DONE]')
        finally:
            self._slots.release()

    def _upstream(self, messages, deadline, enable_tools=None):
        """Worker queue lets SSE emit heartbeats and honor a total deadline."""
        if enable_tools is None:
            enable_tools = self.settings.AI_TOOLS_ENABLED
        output = queue.Queue(maxsize=32)
        cancelled = threading.Event()
        connections = []

        def put(value):
            while not cancelled.is_set():
                try:
                    output.put(value, timeout=0.1)
                    return
                except queue.Full:
                    continue

        def reader():
            conn = None
            try:
                conn, base = self._connect(min(5, self.settings.AI_TIMEOUT_SECONDS))
                connections.append(conn)
                if cancelled.is_set():
                    return
                conn.connect()
                if conn.sock:
                    conn.sock.settimeout(self.settings.AI_TIMEOUT_SECONDS)
                native = self.settings.AI_PROVIDER == 'ollama'
                payload = {'model': self.settings.AI_MODEL_NAME, 'messages': messages, 'stream': True}
                if native:
                    # Native Ollama expects object-valued tool arguments.
                    payload['messages'] = json.loads(json.dumps(messages))
                    for m in payload['messages']:
                        if m.get('content') is None:
                            m['content'] = ''
                        for call in m.get('tool_calls') or []:
                            call['function']['arguments'] = json.loads(call['function']['arguments'])
                    payload['options'] = {'temperature': self.settings.AI_TEMPERATURE, 'num_predict': self.settings.AI_MAX_TOKENS}
                else:
                    payload.update(temperature=self.settings.AI_TEMPERATURE, max_tokens=self.settings.AI_MAX_TOKENS)
                if enable_tools:
                    payload['tools'] = TOOL_DEFINITIONS
                conn.request('POST', base + ('/api/chat' if native else '/chat/completions'), json.dumps(payload), self._headers())
                response = conn.getresponse()
                if response.status != 200:
                    raise AIUnavailable('upstream_error')
                total = 0
                while not cancelled.is_set():
                    line = response.readline(65537)
                    if not line:
                        # A truncated response must not look like a completed answer.
                        raise AIUnavailable('interrupted')
                    total += len(line)
                    if len(line) > 65536 or total > 2 * 1024 * 1024:
                        raise AIUnavailable('invalid_response')
                    line = line.decode('utf-8').strip()
                    if not line or (not native and not line.startswith('data:')):
                        continue
                    raw = line if native else line[5:].strip()
                    if raw == '[DONE]':
                        break
                    chunk = json.loads(raw)
                    if chunk.get('error'):
                        raise AIUnavailable('upstream_error')
                    if native:
                        message = chunk.get('message') or {}
                        calls = message.get('tool_calls') or []
                        for i, call in enumerate(calls):
                            call['index'] = i
                        put({'choices': [{'delta': message}]})
                        if chunk.get('done'):
                            if chunk.get('done_reason') == 'length':
                                raise AIUnavailable('length_limit')
                            break
                    else:
                        put(chunk)
                        finish_reason = (chunk.get('choices') or [{}])[0].get('finish_reason')
                        if finish_reason in ('length', 'content_filter'):
                            raise AIUnavailable('length_limit')
                        if finish_reason in ('stop', 'tool_calls'):
                            break
                put(('done', None))
            except Exception as exc:
                put(('error', exc.reason if isinstance(exc, AIUnavailable) else 'offline'))
            finally:
                if conn:
                    conn.close()

        threading.Thread(target=reader, daemon=True, name='ai-stream').start()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AIUnavailable('timeout')
                try:
                    item = output.get(timeout=min(1, remaining))
                except queue.Empty:
                    yield None
                    continue
                if isinstance(item, tuple):
                    if item[0] == 'error':
                        raise AIUnavailable(item[1])
                    return
                yield item
        finally:
            cancelled.set()
            for conn in connections:
                if conn.sock:
                    try:
                        conn.sock.shutdown(2)
                    except OSError:
                        pass
                conn.close()
