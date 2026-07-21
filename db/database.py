import sqlite3
import json
import os
import uuid
import hashlib
import logging
from datetime import datetime
from threading import Lock
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_DB_DIR = os.path.dirname(os.path.abspath(__file__))
_DB_PATH = os.path.join(_DB_DIR, 'supernova_reports.db')
_SCHEMA_VERSION = 1

_CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'viewer',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboards (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT 'My Dashboard',
    layout      TEXT DEFAULT '{}',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS widgets (
    id           TEXT PRIMARY KEY,
    dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    widget_type  TEXT NOT NULL DEFAULT 'chart',
    title        TEXT NOT NULL DEFAULT '',
    config       TEXT DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS data_sources (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    db_type       TEXT NOT NULL DEFAULT 'postgres',
    host          TEXT DEFAULT '',
    port          INTEGER DEFAULT 5432,
    username      TEXT DEFAULT '',
    password      TEXT DEFAULT '',
    database_name TEXT DEFAULT '',
    cached_tables TEXT DEFAULT '',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    report_name      TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending',
    parameters       TEXT DEFAULT '{}',
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saklı SQL sorgular (Template Builder sol paneli). Python backend koşar.
CREATE TABLE IF NOT EXISTS queries (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT NOT NULL DEFAULT '',
    data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    sql_text        TEXT NOT NULL,
    parameters      TEXT DEFAULT '[]',   -- JSON: QueryParameter[]
    columns_meta    TEXT DEFAULT '[]',   -- JSON: QueryColumn[]
    owner_id        TEXT DEFAULT '',
    allowed_roles   TEXT DEFAULT '[]',
    allowed_users   TEXT DEFAULT '[]',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Excel-benzeri grid şablonları (TemplateDocument JSON olarak saklanır).
CREATE TABLE IF NOT EXISTS report_templates (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '{}',  -- TemplateDocument JSON
    owner_id        TEXT DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS python_scripts (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    description    TEXT NOT NULL DEFAULT '',
    code           TEXT NOT NULL,
    sql_query_ids  TEXT DEFAULT '[]',
    owner_id       TEXT DEFAULT '',
    allowed_roles  TEXT DEFAULT '[]',
    allowed_users  TEXT DEFAULT '[]',
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hiyerarşik path tanımları (Path Definer). Bir saved query'nin sonucunu
-- tree / binary_tree / sequence / grouped yapısına çevirir; veriye mantıklı,
-- filtreli erişim için (SCADA/fabrika hiyerarşisi gibi).
CREATE TABLE IF NOT EXISTS path_defs (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    query_id        TEXT NOT NULL,
    structure       TEXT NOT NULL,          -- tree | binary_tree | sequence | grouped
    config          TEXT NOT NULL DEFAULT '{}',  -- JSON: kolon eşlemesi + ayarlar
    owner_id        TEXT DEFAULT '',
    allowed_roles   TEXT DEFAULT '[]',
    allowed_users   TEXT DEFAULT '[]',
    materialized    TEXT DEFAULT '',        -- JSON cache: son hesaplanan yapı
    materialized_at TEXT DEFAULT '',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

def _generate_salt() -> str:
    return uuid.uuid4().hex

def _hash_password(password: str, salt: str = None) -> tuple:
    if salt is None:
        salt = _generate_salt()
    hashed = hashlib.sha256(f'{salt}:{password}'.encode()).hexdigest()
    return hashed, salt

def _new_id(prefix: str = '') -> str:
    short = uuid.uuid4().hex[:12]
    return f'{prefix}{short}' if prefix else short

class Database:
    def __init__(self, db_path: str = _DB_PATH):
        self.db_path = db_path
        self._lock = Lock()
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()
        logger.info(f"Database ready: {self.db_path}")

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA foreign_keys=ON')
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self):
        with self._lock, self._conn() as conn:
            conn.executescript(_CREATE_TABLES)
            try:
                conn.execute("ALTER TABLE data_sources ADD COLUMN cached_tables TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass
            count = conn.execute('SELECT COUNT(*) as c FROM users').fetchone()['c']
            if count == 0:
                self._seed_demo_data(conn)
            # Demo varlıklar her zaman idempotent olarak güvence altına (mevcut
            # DB'lerde de şema genişlemesinden sonra oluşsun).
            self._ensure_demo_assets(conn)

    def _seed_demo_data(self, conn):
        now = datetime.now().isoformat()
        pw_hash, pw_salt = _hash_password('admin123')
        conn.execute(
            '''INSERT INTO users (id, username, display_name, email, password_hash, password_salt, role, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            ('u1', 'admin', 'System Admin', 'admin@supernova.com', pw_hash, pw_salt, 'admin', now, now)
        )

    def _ensure_demo_assets(self, conn):
        """Template Builder için demo veri kaynağı + sorgu + şablon (idempotent)."""
        now = datetime.now().isoformat()

        # Demo kullanıcılar — login ekranında gösterilen kimlik bilgileriyle.
        # ON CONFLICT → restart'ta demo parolaları hep taze tutar (gerçek
        # kullanıcılar dokunulmaz). Gerçek üretimde bu blok kaldırılmalı.
        demo_users = [
            ('u_developer', 'developer', 'Geliştirici (Superuser)', 'developer@supernovacorp.com', 'superuser', 'Sp7_Super#4302'),
            ('u_admin',     'admin',     'System Admin',            'admin@supernovacorp.com',     'admin',     'Sp7_Admin#9841'),
            ('u_utku',      'utku',      'Geliştirici',             'utku@supernovacorp.com',      'superuser', 'Sp7_Super#4302'),
            ('u_operator',  'operator',  'System Operator',         'operator@supernovacorp.com',  'user',      'Sp7_Operator#1520'),
            ('u_viewer',    'viewer',    'Viewer',                  'viewer@supernovacorp.com',    'viewer',    'Sp7_Viewer#7611'),
        ]
        for uid, uname, dname, email, role, pwd in demo_users:
            ph, salt = _hash_password(pwd)
            conn.execute(
                '''INSERT INTO users (id, username, display_name, email, password_hash, password_salt, role, is_active, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                     password_hash=excluded.password_hash,
                     password_salt=excluded.password_salt,
                     role=excluded.role, is_active=1''',
                (uid, uname, dname, email, ph, salt, role, now, now)
            )
        # Yerel SQLite kaynağı → uygulama DB'si (repo köküne göre göreceli yol).
        conn.execute(
            '''INSERT OR IGNORE INTO data_sources
               (id, name, db_type, host, port, username, password, database_name, is_active, created_at, updated_at)
               VALUES (?, ?, 'sqlite', '', 0, '', '', ?, 1, ?, ?)''',
            ('ds_app', 'Nov4 Local (SQLite)', 'db/supernova_reports.db', now, now)
        )
        # Demo sorgu: sistem kullanıcıları.
        conn.execute(
            '''INSERT OR IGNORE INTO queries
               (id, name, description, data_source_id, sql_text, parameters, columns_meta, owner_id, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, '[]', '[]', 'system', 1, ?, ?)''',
            ('q_users', 'Active Users',
             'Sistem kullanıcılarını listeler (Template Builder demo).',
             'ds_app',
             'SELECT username AS "username", display_name AS "Display Name", email AS "Email", role AS "Role" '
             'FROM users WHERE is_active = 1 ORDER BY username',
             now, now)
        )
        # Demo şablon: başlık + tarih + q_users'a bağlı detail band.
        conn.execute(
            '''INSERT OR IGNORE INTO report_templates
               (id, name, description, model, owner_id, version, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'system', 1, 1, ?, ?)''',
            ('tpl_demo', 'Kullanıcı Listesi (Demo)',
             'q_users sorgusuna bağlı bant örneği.',
             json.dumps(self._demo_template_model(), ensure_ascii=False), now, now)
        )
        # Demo path: kullanıcıları Role'a göre grupla (Path Definer örneği).
        conn.execute(
            '''INSERT OR IGNORE INTO path_defs
               (id, name, description, query_id, structure, config, owner_id, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'grouped', ?, 'system', 1, ?, ?)''',
            ('pth_demo', 'Kullanıcılar → Role (Demo)',
             'q_users sonucunu Role kolonuna göre gruplar.',
             'q_users',
             json.dumps({'group_col': 'Role', 'label_col': 'Display Name'}, ensure_ascii=False),
             now, now)
        )

    @staticmethod
    def _demo_template_model():
        """Frontend TemplateDocument modeliyle aynı şekle sahip demo şablon."""
        header_style = {'bold': True, 'bg': '#F5B301', 'color': '#1A1714'}
        return {
            'id': 'tpl_demo',
            'name': 'Kullanıcı Listesi (Demo)',
            'description': '',
            'sheets': [{
                'id': 's1',
                'name': 'Sheet1',
                'rowCount': 24,
                'columnCount': 6,
                'cells': {
                    '1,1': {'row': 1, 'col': 1, 'value': 'Kullanıcı Raporu', 'style': {'bold': True, 'fontSize': 16}},
                    '2,1': {'row': 2, 'col': 1, 'value': '{{report_date}}',
                            'binding': {'kind': 'builtin', 'builtin': 'report_date'}},
                    '4,1': {'row': 4, 'col': 1, 'value': 'Kullanıcı Adı', 'style': header_style},
                    '4,2': {'row': 4, 'col': 2, 'value': 'Display Name', 'style': header_style},
                    '4,3': {'row': 4, 'col': 3, 'value': 'Email', 'style': header_style},
                    '4,4': {'row': 4, 'col': 4, 'value': 'Role', 'style': header_style},
                    '5,1': {'row': 5, 'col': 1, 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'username'}},
                    '5,2': {'row': 5, 'col': 2, 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'Display Name'}},
                    '5,3': {'row': 5, 'col': 3, 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'Email'}},
                    '5,4': {'row': 5, 'col': 4, 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'Role'}},
                },
                'bands': [{
                    'id': 'b1',
                    'queryId': 'q_users',
                    'range': {'startRow': 5, 'startCol': 1, 'endRow': 5, 'endCol': 4},
                    'fieldMap': {1: 'username', 2: 'Display Name', 3: 'Email', 4: 'Role'}
                }],
                'charts': []
            }],
            'version': 1
        }

# Global instance pattern similar to original
_db_instance = None
def get_db():
    global _db_instance
    if _db_instance is None:
        _db_instance = Database()
    return _db_instance
