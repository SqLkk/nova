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
_SCHEMA_VERSION = 3

# ---------------------------------------------------------------------------
# RBAC: rol seviyeleri + izin kataloğu + varsayılan rol izinleri
# Bu sabitler hem seed hem de api_server tarafındaki yetki kontrolleri için
# tek kaynak olarak kullanılır. Frontend (permission-catalog.ts) bunları mirror'lar.
# ---------------------------------------------------------------------------
ROLE_LEVELS = {
    'superuser': 100,
    'admin': 80,
    'engineer': 60,
    'operator': 40,
    'viewer': 20,
}

# İzin kataloğu: grup → [(key, label)]. Etiketler ayrıca i18n'de de tanımlıdır;
# buradaki değer backend/fallback için kullanılır.
PERMISSION_CATALOG = [
    {'group': 'pages', 'permissions': [
        ('page:dashboard', 'Dashboard'),
        ('page:reports', 'Raporlar'),
        ('page:network-map', 'Network Map'),
        ('page:alarms', 'Alarmlar'),
        ('page:table-explorer', 'Table Explorer'),
        ('page:template-builder', 'Template Builder'),
        ('page:query-creator', 'Query Creator'),
        ('page:python-workspace', 'Python Workspace'),
        ('page:admin', 'Admin Panel'),
        ('page:settings', 'Ayarlar'),
        ('page:profile', 'Profil'),
    ]},
    {'group': 'users', 'permissions': [
        ('user:view', 'Kullanıcıları görüntüle'),
        ('user:create', 'Kullanıcı oluştur'),
        ('user:edit', 'Kullanıcı düzenle'),
        ('user:delete', 'Kullanıcı sil'),
        ('user:reset-password', 'Şifre sıfırla'),
        ('user:activate', 'Aktif/pasif yap'),
    ]},
    {'group': 'roles', 'permissions': [
        ('role:view', 'Rolleri görüntüle'),
        ('role:create', 'Rol oluştur'),
        ('role:edit', 'Rol düzenle'),
        ('role:delete', 'Rol sil'),
    ]},
    {'group': 'sharing', 'permissions': [
        ('share:templates', 'Template paylaşımı'),
        ('share:paths', 'Network-map / path paylaşımı'),
        ('share:queries', 'Sorgu paylaşımı'),
        ('share:scripts', 'Python script paylaşımı'),
        ('share:dashboards', 'Dashboard paylaşımı'),
    ]},
    {'group': 'datasources', 'permissions': [
        ('datasource:view', 'Veri kaynaklarını görüntüle'),
        ('datasource:manage', 'Veri kaynaklarını yönet'),
    ]},
]

ALL_PERMISSION_KEYS = [k for _g in PERMISSION_CATALOG for k, _l in _g['permissions']]

# Varsayılan rol izinleri (seed edilir). superuser ayrıca koda özel olarak
# tüm izinleri (wildcard) almıştır — kataloğa yeni izin eklendiğinde otomatik.
DEFAULT_ROLE_PERMISSIONS = {
    'superuser': list(ALL_PERMISSION_KEYS),
    'admin': list(ALL_PERMISSION_KEYS),
    'engineer': [
        'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
        'page:table-explorer', 'page:template-builder', 'page:query-creator',
        'page:python-workspace', 'page:settings', 'page:profile',
        'share:templates', 'share:paths', 'share:queries', 'share:scripts',
        'share:dashboards',
        'datasource:view',
    ],
    'operator': [
        'page:dashboard', 'page:reports', 'page:alarms', 'page:table-explorer',
        'page:settings', 'page:profile', 'datasource:view',
    ],
    'viewer': [
        'page:dashboard', 'page:reports', 'page:alarms', 'page:profile',
    ],
}


def _reset_demo_passwords() -> bool:
    """Demo parolalarının her restart'ta sıfırlanıp sıfırlanmayacağı.
    config.RESET_DEMO_PASSWORDS yoksa ortam değişkenine, o da yoksa True'ya düşer."""
    try:
        from config import config  # type: ignore
        return bool(getattr(config, 'RESET_DEMO_PASSWORDS', True))
    except Exception:
        return os.environ.get('NOVA_RESET_DEMO_PASSWORDS', '1') != '0'


_CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'viewer',   -- legacy string (token payload); role_id asıl kaynak
    role_id       TEXT DEFAULT '',                  -- FK → roles(id)
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roles (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    level       INTEGER NOT NULL DEFAULT 0,          -- hiyerarşi sırası (yüksek = daha yetkili)
    is_system   INTEGER NOT NULL DEFAULT 0,          -- 1 = yerleşik rol (key/level kilitli, silinemez)
    is_active   INTEGER NOT NULL DEFAULT 1,
    color       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS user_permissions (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    granted        INTEGER NOT NULL DEFAULT 1,        -- 1 = izin ver (override), 0 = reddet
    PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE IF NOT EXISTS dashboards (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id      TEXT DEFAULT '',
    name          TEXT NOT NULL DEFAULT 'My Dashboard',
    description   TEXT NOT NULL DEFAULT '',
    layout        TEXT DEFAULT '[]',
    is_default    INTEGER NOT NULL DEFAULT 0,
    allowed_roles TEXT DEFAULT '[]',
    allowed_users TEXT DEFAULT '[]',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
    allowed_roles   TEXT DEFAULT '[]',           -- ACL: hangi roller görebilir
    allowed_users   TEXT DEFAULT '[]',           -- ACL: hangi kullanıcılar görebilir
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

-- Refresh token rotation + revocation (Faz 4). Token HASH olarak saklanır:
-- DB sızıntısında opak token kullanılamaz. family_id → yeniden kullanım tespiti.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    family_id    TEXT NOT NULL,           -- tek login oturumu; rotation aynı aileden
    token_hash   TEXT NOT NULL UNIQUE,    -- sha256(opak token)
    issued_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0,
    replaced_by  TEXT DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash   ON refresh_tokens(token_hash);

-- Denetim (audit) logu (Faz 9). Güvenlik olayları: kimlik doğrulama, kullanıcı/rol
-- yönetimi, parola sıfırlama, paylaşım değişikliği, veri kaynağı yönetimi, sandbox
-- kullanımı. NIS2 Art.21(1)(b)/(i); ISO/IEC 27002:2022 A.8.15-A.8.16.
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (datetime('now')),
    actor_uid   TEXT DEFAULT '',
    actor_user  TEXT DEFAULT '',
    action      TEXT NOT NULL,
    target      TEXT DEFAULT '',
    detail      TEXT DEFAULT '',          -- JSON
    ip          TEXT DEFAULT '',
    status      TEXT DEFAULT ''           -- success | fail | deny
);
CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_uid);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
"""

def _generate_salt() -> str:
    return uuid.uuid4().hex

def _hash_password(password: str, salt: str = None) -> tuple:
    """Parolayı hashler → (hash, salt).

    Öncelik argon2id'dir (backend `passwords` modülü); salt PHC içinde olduğundan
    salt='' döner. Modül kullanılamıyorsa legacy sha256(salt:password)'e düşer
    (yalnızca bağımsız/önyükleme kullanımı için; uygulama bağlamında her zaman
    argon2id üretilir). Seeding/yığın içindir; kullanıcıdan gelen parolalarda
    politika (passwords.validate_password_policy) ayrıca uygulanmalıdır.
    """
    try:
        from passwords import hash_password as _argon2_hash
        return (_argon2_hash(password), "")
    except Exception:
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
            # --- Şema genişletmeleri (idempotent; mevcut DB'ler için) ---
            for stmt in (
                "ALTER TABLE data_sources ADD COLUMN cached_tables TEXT DEFAULT ''",
                "ALTER TABLE users ADD COLUMN role_id TEXT DEFAULT ''",
                "ALTER TABLE report_templates ADD COLUMN allowed_roles TEXT DEFAULT '[]'",
                "ALTER TABLE report_templates ADD COLUMN allowed_users TEXT DEFAULT '[]'",
                # Kaba kuvvet kilidi (Faz 5b): başarısız deneme sayacı/pencere + kilit sonu.
                "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE users ADD COLUMN last_failed_at TEXT NOT NULL DEFAULT ''",
                "ALTER TABLE users ADD COLUMN locked_until TEXT NOT NULL DEFAULT ''",
                # Dashboards çoklu dashboard & ACL genişletmesi (Faz 1)
                "ALTER TABLE dashboards ADD COLUMN description TEXT DEFAULT ''",
                "ALTER TABLE dashboards ADD COLUMN owner_id TEXT DEFAULT ''",
                "ALTER TABLE dashboards ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE dashboards ADD COLUMN allowed_roles TEXT DEFAULT '[]'",
                "ALTER TABLE dashboards ADD COLUMN allowed_users TEXT DEFAULT '[]'",
            ):
                try:
                    conn.execute(stmt)
                except sqlite3.OperationalError:
                    pass
            try:
                conn.execute("UPDATE dashboards SET owner_id = user_id WHERE (owner_id IS NULL OR owner_id = '') AND user_id IS NOT NULL AND user_id != ''")
                conn.execute("UPDATE dashboards SET user_id = owner_id WHERE (user_id IS NULL OR user_id = '') AND owner_id IS NOT NULL AND owner_id != ''")
            except Exception:
                pass
            count = conn.execute('SELECT COUNT(*) as c FROM users').fetchone()['c']
            if count == 0:
                self._seed_demo_data(conn)
            # Demo varlıklar her zaman idempotent olarak güvence altına (mevcut
            # DB'lerde de şema genişlemesinden sonra oluşsun).
            self._ensure_demo_assets(conn)
            # RBAC: rolleri + izinleri seed et, mevcut kullanıcıların role_id'sini backfill et.
            self._seed_rbac(conn)

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
        reset_pwd = _reset_demo_passwords()

        # Demo kullanıcılar — login ekranında gösterilen kimlik bilgileriyle.
        # reset_pwd=True (varsayılan) → restart'ta demo parolaları/rolleri taze
        # tutar (eski davranış). False → sadece yoksa oluşturur; yöneticinin
        # admin panelinden ayarladığı parolalar korunur.
        demo_users = [
            ('u_developer', 'developer', 'Geliştirici (Superuser)', 'developer@supernovacorp.com', 'superuser', 'Sp7_Super#4302'),
            ('u_admin',     'admin',     'System Admin',            'admin@supernovacorp.com',     'admin',     'Sp7_Admin#9841'),
            ('u_utku',      'utku',      'Geliştirici',             'utku@supernovacorp.com',      'superuser', 'Sp7_Super#4302'),
            ('u_operator',  'operator',  'System Operator',         'operator@supernovacorp.com',  'operator',  'Sp7_Operator#1520'),
            ('u_viewer',    'viewer',    'Viewer',                  'viewer@supernovacorp.com',    'viewer',    'Sp7_Viewer#7611'),
        ]
        for uid, uname, dname, email, role, pwd in demo_users:
            ph, salt = _hash_password(pwd)
            if reset_pwd:
                conn.execute(
                    '''INSERT INTO users (id, username, display_name, email, password_hash, password_salt, role, is_active, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                       ON CONFLICT(username) DO UPDATE SET
                         password_hash=excluded.password_hash,
                         password_salt=excluded.password_salt,
                         role=excluded.role, is_active=1''',
                    (uid, uname, dname, email, ph, salt, role, now, now)
                )
            else:
                conn.execute(
                    '''INSERT OR IGNORE INTO users
                       (id, username, display_name, email, password_hash, password_salt, role, is_active, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)''',
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

    def _seed_rbac(self, conn):
        """Rolleri + varsayılan izinleri seed eder, mevcut kullanıcıların role_id'sini
        backfill eder. İdempotent — her açılışta güvenle çalışır; admin düzenlemelerini
        (izin ekleme/çıkarma, özel rol) korur."""
        now = datetime.now().isoformat()
        role_defs = [
            # id, key, name, description, level, is_system, color
            ('r_super',    'superuser', 'Superuser', 'Tam yetkili sistem yöneticisi.', 100, 1, '#F5B301'),
            ('r_admin',    'admin',     'Admin',     'Yönetici.', 80, 1, '#FF7A1A'),
            ('r_engineer', 'engineer',  'Engineer',  'Mühendis — sorgu/path/python.', 60, 1, '#7C8DB5'),
            ('r_operator', 'operator',  'Operator',  'Operatör — operasyonel kullanım.', 40, 1, '#34D399'),
            ('r_viewer',   'viewer',    'Viewer',    'Salt okuma (silinemez taban rol).', 20, 1, '#A39A89'),
        ]
        for rid, key, name, desc, level, is_system, color in role_defs:
            conn.execute(
                '''INSERT OR IGNORE INTO roles
                   (id, key, name, description, level, is_system, is_active, color, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)''',
                (rid, key, name, desc, level, is_system, color, now, now))
        # Varsayılan izinleri seed et (INSERT OR IGNORE — admin düzenlemesi korunur).
        for role_key, perms in DEFAULT_ROLE_PERMISSIONS.items():
            rid_row = conn.execute('SELECT id FROM roles WHERE key=?', (role_key,)).fetchone()
            if not rid_row:
                continue
            for p in perms:
                conn.execute(
                    'INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)',
                    (rid_row['id'], p))
        # Mevcut kullanıcıların role_id'sini legacy role string'inden backfill et.
        conn.execute('''
            UPDATE users SET role_id = CASE
                WHEN role='superuser' THEN (SELECT id FROM roles WHERE key='superuser')
                WHEN role='admin'     THEN (SELECT id FROM roles WHERE key='admin')
                WHEN role='engineer'  THEN (SELECT id FROM roles WHERE key='engineer')
                WHEN role IN ('user','operator') THEN (SELECT id FROM roles WHERE key='operator')
                WHEN role='viewer'    THEN (SELECT id FROM roles WHERE key='viewer')
                ELSE (SELECT id FROM roles WHERE key='viewer')
            END
            WHERE role_id IS NULL OR role_id = ''
        ''')
        # role string'ini role_id'den kanonik key'e normalize et (tutarlılık).
        conn.execute('''
            UPDATE users SET role = (SELECT key FROM roles WHERE id = users.role_id)
            WHERE role_id IS NOT NULL AND role_id != ''
        ''')

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
