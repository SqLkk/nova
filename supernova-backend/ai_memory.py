"""Local SQLite memory & persistent chat history for optional SuperNova Copilot.

Design guarantees:
1. 100% optional & fault-tolerant: tables are created lazily with IF NOT EXISTS;
   core SuperNova works identically even if AI is disabled or never used.
2. Strictly user-scoped: chat sessions, messages, and learned preferences are
   isolated by `user_id` using parameterized SQL queries.
3. ACL-aware retrieval: `golden_examples` and query memories verify live access
   against current source objects so revoked sharing never leaks.
"""
from datetime import datetime
import json
import logging
import re
import uuid

logger = logging.getLogger(__name__)

_MEMORY_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS golden_examples (
    kind TEXT NOT NULL CHECK(kind IN ('sql', 'python')),
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, source_id)
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT 'Yeni Sohbet',
    last_page     TEXT NOT NULL DEFAULT 'dashboard',
    summary_json  TEXT NOT NULL DEFAULT '{}',
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_user
    ON ai_chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT NOT NULL DEFAULT '',
    meta_json   TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
    ON ai_chat_messages(session_id, id ASC);

CREATE TABLE IF NOT EXISTS ai_user_memory (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    memory_key   TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'context',
    label        TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    hit_count    INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_user_memory_user
    ON ai_user_memory(user_id, updated_at DESC);
"""

_KNOWN_TABLES = (
    'C_POINT',
    'C_PATH_ELEMENT',
    'C_POINT_PATH_ELEMENT',
    'machine_telemetry_timeseries',
    'production_batches',
    'quality_inspections',
    'equipment_downtime_events',
    'facility_energy_esg',
    'factory_assets_hierarchy',
    'manufacturing_process_sequence',
)


def _safe_json_loads(raw, default):
    if not raw or not isinstance(raw, str):
        return default
    try:
        val = json.loads(raw)
        return val if isinstance(val, type(default)) else default
    except Exception:
        return default


def _compact_meta(meta):
    """Bound stored message metadata size so SQLite remains lightweight."""
    if not isinstance(meta, dict):
        return {}
    cleaned = {}
    for key in ('page', 'timestamp', 'error', 'interrupted'):
        if key in meta and meta[key] is not None:
            cleaned[key] = meta[key]
    if isinstance(meta.get('reportProposal'), dict):
        prop = dict(meta['reportProposal'])
        if isinstance(prop.get('previewRows'), list):
            prop['previewRows'] = prop['previewRows'][:5]
        if isinstance(prop.get('candidateQueries'), list):
            prop['candidateQueries'] = prop['candidateQueries'][:12]
        cleaned['reportProposal'] = prop
    if isinstance(meta.get('dialog'), dict):
        dlg = dict(meta['dialog'])
        if isinstance(dlg.get('options'), list):
            dlg['options'] = dlg['options'][:10]
        cleaned['dialog'] = dlg
    if isinstance(meta.get('coworkerSteps'), list):
        cleaned['coworkerSteps'] = meta['coworkerSteps'][:10]
    raw = json.dumps(cleaned, ensure_ascii=False)
    if len(raw) > 48000:
        cleaned.pop('coworkerSteps', None)
        if 'reportProposal' in cleaned and isinstance(cleaned['reportProposal'], dict):
            cleaned['reportProposal'].pop('previewRows', None)
    return cleaned


def _derive_session_title(user_text: str) -> str:
    text = re.sub(r'\s+', ' ', (user_text or '').strip())
    # Strip verbose auto-generated prefixes when user clicks dialog buttons
    text = re.sub(r'^[📊🔍🐍🧭✅🏭📡🔗🔄]+\s*', '', text)
    if not text:
        return 'Yeni Sohbet'
    if len(text) <= 54:
        return text
    return text[:51].rstrip() + '…'


class LocalMemory:
    _initialized_dbs = set()

    def __init__(self, database):
        self.database = database
        self._ensure_tables()

    def _ensure_tables(self):
        db_key = getattr(self.database, 'db_path', id(self.database))
        if db_key in LocalMemory._initialized_dbs:
            return
        try:
            with self.database._conn() as conn:
                conn.executescript(_MEMORY_SCHEMA_SQL)
            LocalMemory._initialized_dbs.add(db_key)
        except Exception:
            logger.debug('Could not initialize optional AI memory tables', exc_info=True)

    # ------------------------------------------------------------------
    # 1. Golden Examples (Saved SQL & Python Scripts — ACL Checked)
    # ------------------------------------------------------------------
    def index(self, kind, row):
        content = row.get('code') if kind == 'python' else row.get('sql_text')
        with self.database._conn() as conn:
            conn.execute('''INSERT INTO golden_examples (kind, source_id, name, content)
                VALUES (?, ?, ?, ?) ON CONFLICT(kind, source_id) DO UPDATE SET
                name=excluded.name, content=excluded.content, updated_at=datetime('now')''',
                (kind, row['id'], row['name'], content))

    def retrieve(self, prompt, can_access, page, limit=3):
        kinds = ('python',) if page == 'python-workspace' else ('sql',)
        tokens = set(re.findall(r'[\w]+', (prompt or '').lower()))
        candidates = []
        with self.database._conn() as conn:
            for kind in kinds:
                table = 'python_scripts' if kind == 'python' else 'queries'
                # JOIN excludes deleted sources; current ACL excludes revoked sharing.
                rows = conn.execute(f'''SELECT s.*, e.content AS example_content
                    FROM golden_examples e JOIN {table} s ON s.id=e.source_id
                    WHERE e.kind=? AND s.is_active=1 ORDER BY e.updated_at DESC LIMIT 200''', (kind,)).fetchall()
                for source in rows:
                    row = dict(source)
                    if not can_access(row):
                        continue
                    words = set(re.findall(r'[\w]+', (row['name'] + ' ' + row.get('description', '') + ' ' + row['example_content']).lower()))
                    score = len(tokens & words)
                    if score:
                        candidates.append((score, {'name': row['name'], 'kind': kind, 'content': row['example_content'][:4000]}))
        candidates.sort(key=lambda c: c[0], reverse=True)
        return [entry for _, entry in candidates[:limit]]

    # ------------------------------------------------------------------
    # 2. Persistent Chat Sessions & Messages (User-Scoped in Local DB)
    # ------------------------------------------------------------------
    def list_sessions(self, user_id: str, limit: int = 25) -> list:
        if not user_id:
            return []
        lim = max(1, min(100, int(limit or 25)))
        with self.database._conn() as conn:
            rows = conn.execute(
                """SELECT id, title, last_page, summary_json, message_count, created_at, updated_at
                   FROM ai_chat_sessions
                   WHERE user_id = ? AND message_count > 0
                   ORDER BY datetime(updated_at) DESC, rowid DESC
                   LIMIT ?""",
                (user_id, lim),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            out.append({
                'id': d['id'],
                'title': d['title'],
                'lastPage': d['last_page'],
                'messageCount': d['message_count'],
                'summary': _safe_json_loads(d.get('summary_json'), {}),
                'createdAt': d['created_at'],
                'updatedAt': d['updated_at'],
            })
        return out

    def get_session(self, user_id: str, session_id: str):
        if not user_id or not session_id:
            return None
        with self.database._conn() as conn:
            s_row = conn.execute(
                """SELECT id, title, last_page, summary_json, message_count, created_at, updated_at
                   FROM ai_chat_sessions
                   WHERE id = ? AND user_id = ?""",
                (session_id, user_id),
            ).fetchone()
            if not s_row:
                return None
            m_rows = conn.execute(
                """SELECT id, role, content, meta_json, created_at
                   FROM ai_chat_messages
                   WHERE session_id = ? AND user_id = ?
                   ORDER BY id ASC
                   LIMIT 80""",
                (session_id, user_id),
            ).fetchall()
        s_dict = dict(s_row)
        messages = []
        for m in m_rows:
            md = dict(m)
            meta = _safe_json_loads(md.get('meta_json'), {})
            messages.append({
                'id': md['id'],
                'role': md['role'],
                'content': md['content'],
                'timestamp': meta.get('timestamp') or (md['created_at'][11:16] if len(md.get('created_at') or '') >= 16 else ''),
                'page': meta.get('page') or s_dict['last_page'],
                'reportProposal': meta.get('reportProposal'),
                'dialog': meta.get('dialog'),
                'coworkerSteps': meta.get('coworkerSteps'),
            })
        return {
            'session': {
                'id': s_dict['id'],
                'title': s_dict['title'],
                'lastPage': s_dict['last_page'],
                'messageCount': s_dict['message_count'],
                'summary': _safe_json_loads(s_dict.get('summary_json'), {}),
                'createdAt': s_dict['created_at'],
                'updatedAt': s_dict['updated_at'],
            },
            'messages': messages,
        }

    def save_turn(
        self,
        user_id: str,
        session_id: str | None,
        page: str,
        user_content: str,
        assistant_content: str,
        assistant_meta: dict | None = None,
        summary_patch: dict | None = None,
    ) -> dict:
        if not user_id:
            return {'sessionId': '', 'title': ''}
        sid = (session_id or '').strip()
        if not sid or not re.match(r'^[A-Za-z0-9_\-]{4,64}$', sid):
            sid = f"chat_{uuid.uuid4().hex[:12]}"
        safe_page = (page or 'dashboard')[:40]
        now_hm = datetime.now().strftime('%H:%M')
        u_text = (user_content or '').strip()[:12000]
        a_text = (assistant_content or '').strip()[:32000]
        meta_obj = _compact_meta({
            **(assistant_meta or {}),
            'page': safe_page,
            'timestamp': (assistant_meta or {}).get('timestamp') or now_hm,
        })
        user_meta_json = json.dumps({'page': safe_page, 'timestamp': now_hm}, ensure_ascii=False)
        asst_meta_json = json.dumps(meta_obj, ensure_ascii=False)

        with self.database._conn() as conn:
            existing = conn.execute(
                'SELECT id, user_id, title, summary_json FROM ai_chat_sessions WHERE id = ?',
                (sid,),
            ).fetchone()
            if existing and existing['user_id'] != user_id:
                # Never allow cross-user session ID collision
                sid = f"chat_{uuid.uuid4().hex[:12]}"
                existing = None

            if not existing:
                title = _derive_session_title(u_text)
                merged_summary = dict(summary_patch or {})
                conn.execute(
                    """INSERT INTO ai_chat_sessions
                       (id, user_id, title, last_page, summary_json, message_count)
                       VALUES (?, ?, ?, ?, ?, 0)""",
                    (sid, user_id, title, safe_page, json.dumps(merged_summary, ensure_ascii=False)),
                )
            else:
                title = existing['title']
                if not title or title == 'Yeni Sohbet':
                    title = _derive_session_title(u_text)
                prev_summary = _safe_json_loads(existing['summary_json'], {})
                merged_summary = {**prev_summary, **(summary_patch or {})}

            if u_text:
                conn.execute(
                    """INSERT INTO ai_chat_messages (session_id, user_id, role, content, meta_json)
                       VALUES (?, ?, 'user', ?, ?)""",
                    (sid, user_id, u_text, user_meta_json),
                )
            if a_text or meta_obj.get('reportProposal') or meta_obj.get('dialog'):
                conn.execute(
                    """INSERT INTO ai_chat_messages (session_id, user_id, role, content, meta_json)
                       VALUES (?, ?, 'assistant', ?, ?)""",
                    (sid, user_id, a_text, asst_meta_json),
                )

            cnt_row = conn.execute(
                'SELECT COUNT(*) AS cnt FROM ai_chat_messages WHERE session_id = ? AND user_id = ?',
                (sid, user_id),
            ).fetchone()
            msg_count = int(cnt_row['cnt']) if cnt_row else 0
            conn.execute(
                """UPDATE ai_chat_sessions
                   SET title = ?, last_page = ?, summary_json = ?, message_count = ?, updated_at = datetime('now')
                   WHERE id = ? AND user_id = ?""",
                (title, safe_page, json.dumps(merged_summary, ensure_ascii=False)[:8000], msg_count, sid, user_id),
            )

            # Auto-prune oldest sessions beyond 50 per user so local DB stays lean
            old_rows = conn.execute(
                """SELECT id FROM ai_chat_sessions
                   WHERE user_id = ?
                   ORDER BY datetime(updated_at) DESC, rowid DESC
                   LIMIT -1 OFFSET 50""",
                (user_id,),
            ).fetchall()
            for old in old_rows:
                conn.execute('DELETE FROM ai_chat_messages WHERE session_id = ? AND user_id = ?', (old['id'], user_id))
                conn.execute('DELETE FROM ai_chat_sessions WHERE id = ? AND user_id = ?', (old['id'], user_id))

        return {'sessionId': sid, 'title': title}

    def update_last_assistant_meta(self, user_id: str, session_id: str, patch_meta: dict) -> bool:
        if not user_id or not session_id or not isinstance(patch_meta, dict):
            return False
        with self.database._conn() as conn:
            row = conn.execute(
                """SELECT id, meta_json FROM ai_chat_messages
                   WHERE session_id = ? AND user_id = ? AND role = 'assistant'
                   ORDER BY id DESC LIMIT 1""",
                (session_id, user_id),
            ).fetchone()
            if not row:
                return False
            current = _safe_json_loads(row['meta_json'], {})
            merged = _compact_meta({**current, **patch_meta})
            conn.execute(
                'UPDATE ai_chat_messages SET meta_json = ? WHERE id = ? AND user_id = ?',
                (json.dumps(merged, ensure_ascii=False), row['id'], user_id),
            )
            conn.execute(
                "UPDATE ai_chat_sessions SET updated_at = datetime('now') WHERE id = ? AND user_id = ?",
                (session_id, user_id),
            )
        return True

    def delete_session(self, user_id: str, session_id: str) -> bool:
        if not user_id or not session_id:
            return False
        with self.database._conn() as conn:
            conn.execute('DELETE FROM ai_chat_messages WHERE session_id = ? AND user_id = ?', (session_id, user_id))
            cur = conn.execute('DELETE FROM ai_chat_sessions WHERE id = ? AND user_id = ?', (session_id, user_id))
            return cur.rowcount > 0

    def clear_sessions(self, user_id: str) -> int:
        if not user_id:
            return 0
        with self.database._conn() as conn:
            conn.execute('DELETE FROM ai_chat_messages WHERE user_id = ?', (user_id,))
            cur = conn.execute('DELETE FROM ai_chat_sessions WHERE user_id = ?', (user_id,))
            return cur.rowcount

    # ------------------------------------------------------------------
    # 3. Cross-Session Persistent User Memory (Preferences, Tables, Work)
    # ------------------------------------------------------------------
    def upsert_memory(self, user_id: str, memory_key: str, category: str, label: str, payload: dict | None = None):
        if not user_id or not memory_key or not label:
            return None
        safe_key = memory_key.strip()[:120]
        safe_cat = (category or 'context').strip()[:32]
        safe_label = re.sub(r'\s+', ' ', label.strip())[:240]
        payload_str = json.dumps(payload or {}, ensure_ascii=False)[:4000]
        with self.database._conn() as conn:
            conn.execute(
                """INSERT INTO ai_user_memory (user_id, memory_key, category, label, payload_json, hit_count, updated_at)
                   VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
                   ON CONFLICT(user_id, memory_key) DO UPDATE SET
                       category = excluded.category,
                       label = excluded.label,
                       payload_json = excluded.payload_json,
                       hit_count = ai_user_memory.hit_count + 1,
                       updated_at = datetime('now')""",
                (user_id, safe_key, safe_cat, safe_label, payload_str),
            )
            # Keep top 40 memory entries per user
            stale = conn.execute(
                """SELECT id FROM ai_user_memory
                   WHERE user_id = ?
                   ORDER BY datetime(updated_at) DESC, hit_count DESC
                   LIMIT -1 OFFSET 40""",
                (user_id,),
            ).fetchall()
            for st in stale:
                conn.execute('DELETE FROM ai_user_memory WHERE id = ? AND user_id = ?', (st['id'], user_id))
            saved = conn.execute(
                'SELECT id, memory_key, category, label, payload_json, hit_count, updated_at FROM ai_user_memory WHERE user_id = ? AND memory_key = ?',
                (user_id, safe_key),
            ).fetchone()
        if not saved:
            return None
        d = dict(saved)
        return {
            'id': d['id'],
            'key': d['memory_key'],
            'category': d['category'],
            'label': d['label'],
            'payload': _safe_json_loads(d.get('payload_json'), {}),
            'hitCount': d['hit_count'],
            'updatedAt': d['updated_at'],
        }

    def list_memories(self, user_id: str, limit: int = 20) -> list:
        if not user_id:
            return []
        lim = max(1, min(60, int(limit or 20)))
        with self.database._conn() as conn:
            rows = conn.execute(
                """SELECT id, memory_key, category, label, payload_json, hit_count, updated_at
                   FROM ai_user_memory
                   WHERE user_id = ?
                   ORDER BY CASE WHEN category = 'preference' THEN 0 ELSE 1 END,
                            datetime(updated_at) DESC, hit_count DESC
                   LIMIT ?""",
                (user_id, lim),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            out.append({
                'id': d['id'],
                'key': d['memory_key'],
                'category': d['category'],
                'label': d['label'],
                'payload': _safe_json_loads(d.get('payload_json'), {}),
                'hitCount': d['hit_count'],
                'updatedAt': d['updated_at'],
            })
        return out

    def delete_memory(self, user_id: str, mem_id: int) -> bool:
        if not user_id or not mem_id:
            return False
        with self.database._conn() as conn:
            cur = conn.execute('DELETE FROM ai_user_memory WHERE id = ? AND user_id = ?', (int(mem_id), user_id))
            return cur.rowcount > 0

    def clear_memories(self, user_id: str) -> int:
        if not user_id:
            return 0
        with self.database._conn() as conn:
            cur = conn.execute('DELETE FROM ai_user_memory WHERE user_id = ?', (user_id,))
            return cur.rowcount

    def learn_from_turn(
        self,
        user_id: str,
        user_content: str,
        assistant_content: str = '',
        context: dict | None = None,
        proposal: dict | None = None,
    ) -> dict:
        """Automatically extract durable user preferences, chosen tables, queries & reports."""
        if not user_id:
            return {}
        ctx = context or {}
        u_text = (user_content or '').strip()
        u_low = u_text.lower()
        summary_patch = {}

        # 1. Detect tables explicitly selected or used in SQL / proposal
        used_tables = []
        sel = ctx.get('user_selection') if isinstance(ctx.get('user_selection'), dict) else {}
        for t in (sel.get('selectedTables') or []):
            if isinstance(t, str) and t not in used_tables:
                used_tables.append(t)

        sql_blob = ''
        if isinstance(proposal, dict) and proposal.get('sql'):
            sql_blob = proposal['sql']
        else:
            sql_match = re.search(r'```sql\s*\n([\s\S]+?)```', assistant_content or '', re.IGNORECASE)
            if sql_match:
                sql_blob = sql_match.group(1).strip()

        combined_check = f"{u_text}\n{sql_blob}"
        for tbl in _KNOWN_TABLES:
            if re.search(r'\b' + re.escape(tbl) + r'\b', combined_check, re.IGNORECASE):
                if tbl not in used_tables:
                    used_tables.append(tbl)

        if used_tables:
            summary_patch['lastTables'] = used_tables[:6]
            if len(used_tables) >= 2:
                join_str = ' ⋈ '.join(used_tables[:4])
                self.upsert_memory(
                    user_id,
                    f"join:{'+'.join(sorted(used_tables[:4]))}",
                    'table',
                    f"Tercih edilen tablo birleşimi: {join_str}",
                    {'tables': used_tables[:4]},
                )
            else:
                t0 = used_tables[0]
                self.upsert_memory(
                    user_id,
                    f"table:{t0}",
                    'table',
                    f"Sık çalışılan tablo: {t0}",
                    {'tables': [t0]},
                )

        if sql_blob:
            summary_patch['lastSql'] = sql_blob[:4000]

        # 2. Detect Report Proposal & Chart / Column preferences
        if isinstance(proposal, dict):
            r_name = (proposal.get('reportName') or '').strip()
            qid = (proposal.get('queryId') or '').strip()
            q_name = (proposal.get('queryName') or qid).strip()
            chart = proposal.get('chart') if isinstance(proposal.get('chart'), dict) else {}
            c_type = chart.get('type') if chart.get('include', True) else 'none'
            if qid:
                summary_patch['lastQueryId'] = qid
                self.upsert_memory(
                    user_id,
                    f"query:{qid}",
                    'query',
                    f"Son kullanılan sorgu: {q_name} ({qid})",
                    {'queryId': qid, 'queryName': q_name, 'dataSourceId': proposal.get('dataSourceId')},
                )
            if r_name:
                summary_patch['lastReportName'] = r_name
                self.upsert_memory(
                    user_id,
                    f"report:{qid or r_name[:40]}",
                    'report',
                    f"Hazırlanan rapor: {r_name} ({c_type.upper() if c_type != 'none' else 'Tablo'})",
                    {
                        'reportName': r_name,
                        'queryId': qid,
                        'chartType': c_type,
                        'selectedColumns': (proposal.get('selectedColumns') or [])[:10],
                    },
                )

        # 3. Detect explicit chart preference or persistent user rule in Turkish
        if any(k in u_low for k in ('çizgi grafik', 'line chart', 'line grafik')):
            self.upsert_memory(user_id, 'pref:chart_type', 'preference', 'Grafik tercihi: Çizgi (Line) Grafik', {'chartType': 'line'})
        elif any(k in u_low for k in ('pasta grafik', 'pie chart', 'daire grafik')):
            self.upsert_memory(user_id, 'pref:chart_type', 'preference', 'Grafik tercihi: Pasta (Pie) Grafik', {'chartType': 'pie'})
        elif any(k in u_low for k in ('çubuk grafik', 'bar chart', 'sütun grafik')):
            self.upsert_memory(user_id, 'pref:chart_type', 'preference', 'Grafik tercihi: Çubuk (Bar) Grafik', {'chartType': 'bar'})

        # Explicit memory keywords ("unutma", "her zaman", "bundan sonra", "varsayılan olarak", "hatırla")
        if any(kw in u_low for kw in ('unutma', 'her zaman', 'bundan sonra', 'varsayılan olarak', 'aklında tut', 'hatırla')):
            note_clean = u_text[:200]
            digest_key = re.sub(r'[^a-z0-9ğüşıöç]+', '_', u_low)[:48].strip('_') or 'custom'
            self.upsert_memory(
                user_id,
                f"pref:note_{digest_key}",
                'preference',
                f"Kullanıcı kuralı: {note_clean}",
                {'note': note_clean},
            )

        # Custom filter notes from interactive dialog
        custom_filter = (sel.get('customText') or '').strip()
        if custom_filter and len(custom_filter) >= 3:
            self.upsert_memory(
                user_id,
                'pref:last_filter',
                'preference',
                f"Son uygulanan filtre/tercih: {custom_filter[:140]}",
                {'filter': custom_filter[:200]},
            )

        return summary_patch

    def recall_context(self, user_id: str, prompt: str = '', can_access_query=None) -> dict:
        """Build a compact cross-session memory digest so the user never repeats prior context."""
        if not user_id:
            return {}
        memories = self.list_memories(user_id, limit=16)
        sessions = self.list_sessions(user_id, limit=4)

        # Filter out any query memory whose underlying query was deleted or ACL-revoked
        accessible_qids = None
        if callable(can_access_query):
            try:
                with self.database._conn() as conn:
                    q_rows = [dict(r) for r in conn.execute('SELECT * FROM queries WHERE is_active = 1').fetchall()]
                accessible_qids = {r['id'] for r in q_rows if can_access_query(r)}
            except Exception:
                accessible_qids = None

        filtered_memories = []
        preferred_chart = None
        last_tables = []
        last_query_id = ''
        last_report_name = ''

        for m in memories:
            payload = m.get('payload') or {}
            qid = payload.get('queryId')
            if qid and accessible_qids is not None and qid not in accessible_qids:
                continue
            filtered_memories.append({
                'category': m['category'],
                'label': m['label'],
                **({'tables': payload['tables']} if payload.get('tables') else {}),
                **({'queryId': qid} if qid else {}),
            })
            if m['key'] == 'pref:chart_type' and payload.get('chartType'):
                preferred_chart = payload['chartType']
            if not last_tables and payload.get('tables'):
                last_tables = list(payload['tables'])
            if not last_query_id and qid:
                last_query_id = qid
            if not last_report_name and payload.get('reportName'):
                last_report_name = payload['reportName']

        last_sql = ''
        recent_chats = []
        for s in sessions[:3]:
            summ = s.get('summary') or {}
            s_qid = summ.get('lastQueryId') or ''
            if s_qid and accessible_qids is not None and s_qid not in accessible_qids:
                s_qid = ''
            if not last_sql and summ.get('lastSql'):
                last_sql = summ['lastSql']
            if not last_query_id and s_qid:
                last_query_id = s_qid
            if not last_tables and summ.get('lastTables'):
                last_tables = list(summ['lastTables'])
            if not last_report_name and summ.get('lastReportName'):
                last_report_name = summ['lastReportName']
            recent_chats.append({
                'title': s['title'],
                'page': s['lastPage'],
                'updatedAt': s['updatedAt'],
                **({'tables': summ['lastTables']} if summ.get('lastTables') else {}),
                **({'queryId': s_qid} if s_qid else {}),
                **({'reportName': summ['lastReportName']} if summ.get('lastReportName') else {}),
            })

        if not filtered_memories and not recent_chats:
            return {}

        return {
            'remembered_items': filtered_memories[:10],
            'recent_chats': recent_chats,
            'last_tables': last_tables[:6],
            'last_query_id': last_query_id,
            'last_report_name': last_report_name,
            'last_sql': last_sql[:3000] if last_sql else '',
            'preferred_chart_type': preferred_chart,
        }
