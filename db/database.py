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
        ('page:schedules', 'Zamanlayıcı (Schedules)'),
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
        ('share:schedules', 'Schedule paylaşımı'),
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

CREATE TABLE IF NOT EXISTS golden_examples (
    kind TEXT NOT NULL CHECK(kind IN ('sql', 'python')),
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, source_id)
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

-- Evrensel Dinamik Rapor Zamanlayıcı (Universal Dynamic Report Scheduler)
CREATE TABLE IF NOT EXISTS report_schedules (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    template_id          TEXT NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
    frequency            TEXT NOT NULL DEFAULT 'daily',  -- hourly | daily | weekly | monthly | cron | manual
    cron_expression      TEXT NOT NULL DEFAULT '',       -- e.g. '0 6 * * *'
    window_type          TEXT NOT NULL DEFAULT 'yesterday', -- yesterday | today | last_24h | last_7d | last_30d | this_week | last_week | this_month | last_month | custom
    custom_window_config TEXT DEFAULT '{}',              -- JSON: { offset_days, duration_days, offset_hours, duration_hours }
    params_override      TEXT DEFAULT '{}',              -- JSON: fixed extra params or query overrides
    output_format        TEXT NOT NULL DEFAULT 'xlsx',   -- xlsx | pdf
    recipients           TEXT DEFAULT '[]',              -- JSON: array of email or webhook targets
    is_active            INTEGER NOT NULL DEFAULT 1,
    last_run_at          TEXT DEFAULT '',
    last_run_status      TEXT DEFAULT '',                -- success | failed | running
    next_run_at          TEXT DEFAULT '',
    owner_id             TEXT DEFAULT '',
    allowed_roles        TEXT DEFAULT '[]',
    allowed_users        TEXT DEFAULT '[]',
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS report_schedule_runs (
    id               TEXT PRIMARY KEY,
    schedule_id      TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
    template_id      TEXT NOT NULL,
    reference_date   TEXT NOT NULL,                  -- Hesaplama referans tarihi (YYYY-MM-DD HH:MM:SS)
    window_type      TEXT NOT NULL,
    start_time       TEXT NOT NULL,                  -- Çözümlenen pencere başlangıcı
    end_time         TEXT NOT NULL,                  -- Çözümlenen pencere bitişi
    resolved_params  TEXT DEFAULT '{}',              -- JSON: query'lere enjekte edilen parametreler
    output_format    TEXT NOT NULL,
    output_file_path TEXT DEFAULT '',
    output_file_size INTEGER DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'running', -- running | success | failed
    duration_ms      INTEGER DEFAULT 0,
    error_message    TEXT DEFAULT '',
    executed_by      TEXT DEFAULT 'scheduler',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sched_runs_sched  ON report_schedule_runs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_sched_runs_status ON report_schedule_runs(status);
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
            ('u_developer', 'developer', 'Geliştirici (Superuser)',           'developer@supernovacorp.com', 'superuser', 'Nova_Super#4302'),
            ('u_admin',     'admin',     'System Admin',                      'admin@supernovacorp.com',     'admin',     'Nova_Admin#9841'),
            ('u_engineer',  'engineer',  'Endüstriyel Otomasyon Mühendisi',   'engineer@supernovacorp.com',  'engineer',  'Nova_Engineer#5544'),
            ('u_utku',      'utku',      'Geliştirici',                       'utku@supernovacorp.com',      'superuser', 'utku123'),
            ('u_operator',  'operator',  'System Operator',                   'operator@supernovacorp.com',  'operator',  'Nova_Operator#1520'),
            ('u_viewer',    'viewer',    'Viewer',                            'viewer@supernovacorp.com',    'viewer',    'Nova_Viewer#7611'),
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
        conn.execute(
            '''INSERT OR IGNORE INTO data_sources
               (id, name, db_type, host, port, username, password, database_name, is_active, created_at, updated_at)
               VALUES (?, ?, 'sqlite', '', 0, '', '', ?, 1, ?, ?)''',
            ('ds_apex_factory', 'Apex Smart Factory (Standalone SQL DB)', 'db/apex_smart_factory_prod.db', now, now)
        )
        default_roles_json = json.dumps(['admin', 'superuser', 'engineer', 'operator', 'viewer'])
        # Demo sorgu: sistem kullanıcıları.
        q_users_cols = json.dumps([
            {'name': 'username', 'dataType': 'TEXT'},
            {'name': 'Display Name', 'dataType': 'TEXT'},
            {'name': 'Email', 'dataType': 'TEXT'},
            {'name': 'Role', 'dataType': 'TEXT'},
        ], ensure_ascii=False)
        conn.execute(
            '''INSERT OR IGNORE INTO queries
               (id, name, description, data_source_id, sql_text, parameters, columns_meta, owner_id, allowed_roles, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, '[]', ?, 'system', ?, 1, ?, ?)''',
            ('q_users', 'Active Users (Sistem Kullanıcıları)',
             'Aktif sistem kullanıcılarını, ekran adlarını, e-posta adreslerini ve RBAC rollerini listeler.',
             'ds_app',
             'SELECT username AS "username", display_name AS "Display Name", email AS "Email", role AS "Role" '
             'FROM users WHERE is_active = 1 ORDER BY username',
             q_users_cols, default_roles_json, now, now)
        )
        conn.execute(
            '''UPDATE queries SET columns_meta=?, description=?
               WHERE id='q_users' AND (columns_meta IS NULL OR columns_meta='[]' OR columns_meta='')''',
            (q_users_cols, 'Aktif sistem kullanıcılarını, ekran adlarını, e-posta adreslerini ve RBAC rollerini listeler.')
        )

        # Rename and enrich auto-generated queries with clear names and descriptions
        auto_query_fixes = [
            ('q_b0d48d0120',
             '[Smart Factory] C_Point Sensör Kataloğu & Ölçüm Limitleri',
             'C_POINT tablosundaki tüm endüstriyel sensör noktalarını, sinyal tiplerini (POINT_TYPE) ve alt/üst spesifikasyon limitlerini (MIN_VAL / MAX_VAL) listeler.'),
            ('q_f5390aa942',
             '[Smart Factory] Sensör - Varlık Yolu Eşleşmeleri (C_POINT_PATH_ELEMENT)',
             'C_POINT_PATH_ELEMENT köprü tablosundaki sensör noktaları (POINT_ID) ile varlık ağacı düğümleri (ELEMENT_ID) arasındaki ilişkileri listeler.'),
            ('q_4bd69f38e2',
             '[Smart Factory] Endüstriyel Varlık Yolu Düğümleri (C_PATH_ELEMENT)',
             'C_PATH_ELEMENT tablosundaki tesis, üretim hattı ve makine hiyerarşi düğümlerini (ELEMENT_ID, PARENT_ELEMENT_ID, ELEMENT_NAME) listeler.'),
            ('q_2a64c5db3a',
             '[Smart Factory] Fabrika Varlık Envanteri & Hiyerarşi Tablosu',
             'factory_assets_hierarchy tablosundaki tüm ekipmanları, kritiklik seviyelerini, üretici bilgilerini ve tesis konumlarını getirir.'),
        ]
        for qid, qname, qdesc in auto_query_fixes:
            conn.execute(
                '''UPDATE queries
                   SET name=?,
                       description=?,
                       owner_id='system',
                       allowed_roles=?
                   WHERE id=? AND (description IS NULL OR description='' OR description='Auto-generated for Path Definer')''',
                (qname, qdesc, default_roles_json, qid)
            )

        # Seed rich Python Scripts (sandbox-compatible, linked to Smart Factory & App SQL queries)
        demo_python_scripts = [
            (
                'py_oee_pareto',
                '[Smart Factory] Hat Bazlı OEE, Fire (Scrap) & Verimlilik Analizi',
                'Üretim batch verilerini (q_ind_production_oee) hat ve vardiya bazında gruplayarak ağırlıklı OEE %, toplam sağlam/hurda üretim ve kalite indeksini hesaplar. Çıktı: line_summary ve shift_performance.',
                '''# Hat ve Vardiya Bazlı Canlı OEE & Fire (Scrap) Analizi
rows = sql_data.get('q_ind_production_oee') or sql_data.get('[Smart Factory] Production Batches & OEE Performance') or []

by_line = {}
by_shift = {}

for r in rows:
    line = str(r.get('line_id') or 'Unknown Line')
    shift = str(r.get('shift_name') or 'Standard')
    prod = float(r.get('produced_qty') or 0)
    good = float(r.get('good_qty') or 0)
    scrap = float(r.get('scrap_qty') or 0)
    oee = float(r.get('oee_percentage') or 0)

    if line not in by_line:
        by_line[line] = {'batches': 0, 'produced': 0.0, 'good': 0.0, 'scrap': 0.0, 'oee_sum': 0.0}
    by_line[line]['batches'] += 1
    by_line[line]['produced'] += prod
    by_line[line]['good'] += good
    by_line[line]['scrap'] += scrap
    by_line[line]['oee_sum'] += oee

    if shift not in by_shift:
        by_shift[shift] = {'batches': 0, 'produced': 0.0, 'scrap': 0.0, 'oee_sum': 0.0}
    by_shift[shift]['batches'] += 1
    by_shift[shift]['produced'] += prod
    by_shift[shift]['scrap'] += scrap
    by_shift[shift]['oee_sum'] += oee

line_summary = []
for line, st in sorted(by_line.items()):
    cnt = max(st['batches'], 1)
    avg_oee = round(st['oee_sum'] / cnt, 2)
    scrap_pct = round((st['scrap'] / st['produced']) * 100.0, 2) if st['produced'] > 0 else 0.0
    yield_pct = round((st['good'] / st['produced']) * 100.0, 2) if st['produced'] > 0 else 0.0
    status = 'OPTIMAL' if avg_oee >= 85 else ('WARNING' if avg_oee >= 75 else 'CRITICAL')
    line_summary.append({
        'line_id': line,
        'batch_count': st['batches'],
        'total_produced': int(st['produced']),
        'total_good': int(st['good']),
        'total_scrap': int(st['scrap']),
        'yield_pct': yield_pct,
        'scrap_rate_pct': scrap_pct,
        'avg_oee_pct': avg_oee,
        'performance_status': status
    })

shift_performance = []
for shift, st in sorted(by_shift.items()):
    cnt = max(st['batches'], 1)
    shift_performance.append({
        'shift_name': shift,
        'batch_count': st['batches'],
        'total_produced': int(st['produced']),
        'total_scrap': int(st['scrap']),
        'avg_oee_pct': round(st['oee_sum'] / cnt, 2)
    })

out('line_summary', line_summary)
out('shift_performance', shift_performance)
''',
                json.dumps(['q_ind_production_oee'])
            ),
            (
                'py_energy_carbon_kpi',
                '[Smart Factory] Tesis Enerji Yoğunluğu & Karbon Ayak İzi (ESG) Hesaplama',
                'Tesis enerji tüketimi ve CO2 emisyon sorgusunu (q_ind_energy_esg) işleyerek tesis/bölge bazlı toplam kWh, ortalama güç faktörü, CO2 emisyonu (kg) ve maliyet tahminini üretir. Çıktı: energy_kpi.',
                '''# Tesis & Bölge Bazlı Enerji Tüketimi ve ESG Karbon Analizi
rows = sql_data.get('q_ind_energy_esg') or sql_data.get('[Smart Factory] Facility Energy Consumption & CO2 Emissions (ESG)') or []

by_zone = {}
for r in rows:
    zone = str(r.get('plant_area') or r.get('facility_id') or 'Main Plant')
    kwh = float(r.get('active_power_kwh') or 0)
    co2 = float(r.get('co2_emissions_kg') or 0)
    peak = float(r.get('peak_demand_kw') or 0)
    pf = float(r.get('power_factor') or 0)

    if zone not in by_zone:
        by_zone[zone] = {'readings': 0, 'kwh': 0.0, 'co2': 0.0, 'max_peak': 0.0, 'pf_sum': 0.0}
    by_zone[zone]['readings'] += 1
    by_zone[zone]['kwh'] += kwh
    by_zone[zone]['co2'] += co2
    if peak > by_zone[zone]['max_peak']:
        by_zone[zone]['max_peak'] = peak
    by_zone[zone]['pf_sum'] += pf

energy_kpi = []
for zone, st in sorted(by_zone.items(), key=lambda x: x[1]['kwh'], reverse=True):
    cnt = max(st['readings'], 1)
    total_kwh = round(st['kwh'], 2)
    total_co2 = round(st['co2'], 2)
    carbon_intensity = round(total_co2 / total_kwh, 4) if total_kwh > 0 else 0.0
    est_cost_eur = round(total_kwh * 0.14, 2)
    energy_kpi.append({
        'plant_area': zone,
        'reading_count': st['readings'],
        'total_power_kwh': total_kwh,
        'avg_power_kwh': round(total_kwh / cnt, 2),
        'peak_demand_kw': round(st['max_peak'], 2),
        'avg_power_factor': round(st['pf_sum'] / cnt, 3),
        'total_co2_kg': total_co2,
        'carbon_intensity_kg_per_kwh': carbon_intensity,
        'estimated_cost_eur': est_cost_eur
    })

out('energy_kpi', energy_kpi)
''',
                json.dumps(['q_ind_energy_esg'])
            ),
            (
                'py_downtime_mtbf_mttr',
                '[Smart Factory] Ekipman Arıza Pareto, MTTR & Risk Skoru',
                'Duruş ve arıza kayıtlarını (q_ind_downtime_pareto) analiz ederek makine bazlı toplam duruş süresi, ortalama tamir süresi (MTTR), onarım maliyeti ($) ve kritik risk puanını hesaplar. Çıktı: machine_risk.',
                '''# Ekipman Arıza Pareto, MTTR ve Risk Skoru Analizi
rows = sql_data.get('q_ind_downtime_pareto') or sql_data.get('[Smart Factory] Equipment Downtime & Failure Pareto') or []

by_machine = {}
for r in rows:
    m_name = str(r.get('machine_name') or r.get('machine_id') or 'Unknown Machine')
    cat = str(r.get('failure_category') or 'Mechanical')
    mins = float(r.get('downtime_minutes') or 0)
    cost = float(r.get('repair_cost_usd') or 0)

    if m_name not in by_machine:
        by_machine[m_name] = {'events': 0, 'total_mins': 0.0, 'total_cost': 0.0, 'top_category': cat}
    by_machine[m_name]['events'] += 1
    by_machine[m_name]['total_mins'] += mins
    by_machine[m_name]['total_cost'] += cost

machine_risk = []
for m_name, st in sorted(by_machine.items(), key=lambda x: x[1]['total_mins'], reverse=True):
    ev = max(st['events'], 1)
    mttr = round(st['total_mins'] / ev, 1)
    risk_score = min(100.0, round((st['total_mins'] * 0.15) + (ev * 6.0) + (st['total_cost'] / 500.0), 1))
    machine_risk.append({
        'machine_name': m_name,
        'failure_events': st['events'],
        'total_downtime_min': round(st['total_mins'], 1),
        'mttr_minutes': mttr,
        'total_repair_cost_usd': round(st['total_cost'], 2),
        'primary_category': st['top_category'],
        'risk_score': risk_score,
        'priority': 'HIGH' if risk_score >= 60 else ('MEDIUM' if risk_score >= 35 else 'LOW')
    })

out('machine_risk', machine_risk)
''',
                json.dumps(['q_ind_downtime_pareto'])
            ),
            (
                'py_sensor_anomaly_detector',
                '[Smart Factory] C_Point Sensör Telemetri & Limit Sapma Analizi',
                'C_Point sensör ölçüm değerlerini (q_ind_cpoint_values) spesifikasyon limitleriyle (SPEC_MIN_VAL / SPEC_MAX_VAL) karşılaştırarak bant kullanım yüzdesini ve sensör sağlık durumunu hesaplar. Çıktı: sensor_health.',
                '''# C_Point Sensör Ölçüm Değerleri ve Limit Sapma Analizi
rows = sql_data.get('q_ind_cpoint_values') or sql_data.get('[Smart Factory] C_Point Sensör Değerleri & Varlık Yolu (Value Raporu)') or []

sensor_health = []
for r in rows:
    pid = str(r.get('POINT_ID') or '')
    pname = str(r.get('POINT_NAME') or pid)
    asset = str(r.get('ASSET_NAME') or 'Genel Hat')
    avg_v = float(r.get('AVG_VALUE') or 0)
    min_v = float(r.get('MIN_VALUE') or 0)
    max_v = float(r.get('MAX_VALUE') or 0)
    spec_min = float(r.get('SPEC_MIN_VAL') or 0)
    spec_max = float(r.get('SPEC_MAX_VAL') or 100)
    span = max(spec_max - spec_min, 0.0001)
    utilization_pct = round(((avg_v - spec_min) / span) * 100.0, 1)
    headroom_pct = round(((spec_max - max_v) / span) * 100.0, 1)
    status = 'ALARM' if (max_v > spec_max or min_v < spec_min) else ('WARNING' if headroom_pct < 15 else 'NORMAL')

    sensor_health.append({
        'point_id': pid,
        'point_name': pname,
        'asset_name': asset,
        'avg_value': round(avg_v, 2),
        'min_value': round(min_v, 2),
        'max_value': round(max_v, 2),
        'spec_min': round(spec_min, 2),
        'spec_max': round(spec_max, 2),
        'band_utilization_pct': utilization_pct,
        'headroom_pct': headroom_pct,
        'health_status': status
    })

out('sensor_health', sensor_health)
''',
                json.dumps(['q_ind_cpoint_values'])
            ),
        ]
        for sid, sname, sdesc, scode, sqids in demo_python_scripts:
            conn.execute(
                '''INSERT OR IGNORE INTO python_scripts
                   (id, name, description, code, sql_query_ids, owner_id, allowed_roles, allowed_users, is_active, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'system', ?, '[]', 1, ?, ?)''',
                (sid, sname, sdesc, scode, sqids, default_roles_json, now, now)
            )

        # Demo şablon: başlık + tarih + q_users'a bağlı detail band.
        conn.execute(
            '''INSERT INTO report_templates
               (id, name, description, model, owner_id, allowed_roles, version, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'system', ?, 1, 1, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 model=excluded.model,
                 owner_id=CASE WHEN report_templates.owner_id='' THEN 'system' ELSE report_templates.owner_id END,
                 allowed_roles=CASE WHEN report_templates.allowed_roles='[]' THEN excluded.allowed_roles ELSE report_templates.allowed_roles END''',
            ('tpl_demo', 'Kullanıcı Listesi (Demo)',
             'q_users sorgusuna bağlı canlı kullanıcı ve rol dağılım raporu.',
             json.dumps(self._demo_template_model(), ensure_ascii=False),
             default_roles_json, now, now)
        )

        # Python + SQL birleşik örnek şablonu:
        conn.execute(
            '''INSERT OR IGNORE INTO report_templates
               (id, name, description, model, owner_id, allowed_roles, version, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'system', ?, 1, 1, ?, ?)''',
            ('tpl_python_oee_esg',
             'Python Analytics — Hat Bazlı OEE & Fire (Scrap) Raporu',
             'py_oee_pareto Python scriptinin line_summary veri setine bağlı dinamik üretim verimlilik raporu.',
             json.dumps(self._python_oee_template_model(), ensure_ascii=False),
             default_roles_json, now, now)
        )

        # Demo path: kullanıcıları Role'a göre grupla (Path Definer örneği).
        conn.execute(
            '''INSERT OR IGNORE INTO path_defs
               (id, name, description, query_id, structure, config, owner_id, allowed_roles, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'grouped', ?, 'system', ?, 1, ?, ?)''',
            ('pth_demo', 'Kullanıcılar → Role (Demo)',
             'q_users sonucunu Role kolonuna göre gruplar.',
             'q_users',
             json.dumps({'group_col': 'Role', 'label_col': 'Display Name'}, ensure_ascii=False),
             default_roles_json, now, now)
        )

        # Onarım: owner_id='' veya allowed_roles='[]' kalmış sistem nesnelerini tüm rollere aç
        for tbl in ('queries', 'python_scripts', 'report_templates', 'path_defs', 'report_schedules'):
            conn.execute(
                f'''UPDATE {tbl}
                    SET owner_id = CASE WHEN owner_id IS NULL OR owner_id = '' THEN 'system' ELSE owner_id END,
                        allowed_roles = CASE WHEN allowed_roles IS NULL OR allowed_roles = '' OR allowed_roles = '[]' THEN ? ELSE allowed_roles END
                    WHERE owner_id IS NULL OR owner_id = '' OR owner_id = 'system' ''',
                (default_roles_json,)
            )
        self._repair_existing_templates(conn)
        self._repair_and_enrich_path_defs(conn, default_roles_json, now)

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
        banner_style = {'bold': True, 'fontSize': 15, 'bg': '#1F1B26', 'color': '#F5B301', 'align': 'left'}
        return {
            'id': 'tpl_demo',
            'name': 'Kullanıcı Listesi (Demo)',
            'description': 'Nov4 kurumsal başlık, özet sayaç ve q_users sorgusuna bağlı detay bandı.',
            'sheets': [{
                'id': 's1',
                'name': 'Sheet1',
                'rowCount': 28,
                'columnCount': 8,
                'columnWidths': {1: 140, 2: 180, 3: 220, 4: 140},
                'cells': {
                    '1,1': {'row': 1, 'col': 1, 'value': 'NOV4 KULLANICI VE YETKİ RAPORU',
                            'mergeAnchor': '1,1,1,4', 'style': banner_style},
                    '2,1': {'row': 2, 'col': 1, 'value': 'Rapor Tarihi:', 'style': {'bold': True, 'color': '#A39A89'}},
                    '2,2': {'row': 2, 'col': 2, 'value': '{{report_date}}',
                            'binding': {'kind': 'builtin', 'builtin': 'report_date'}},
                    '2,3': {'row': 2, 'col': 3, 'value': 'Toplam Kayıt:', 'style': {'bold': True, 'color': '#A39A89', 'align': 'right'}},
                    '2,4': {'row': 2, 'col': 4, 'value': '{{COUNT(username)}}',
                            'binding': {'kind': 'summary', 'queryId': 'q_users', 'field': 'username', 'operation': 'COUNT'},
                            'style': {'bold': True, 'bg': '#2F2934', 'color': '#F5B301', 'align': 'center'}},
                    '4,1': {'row': 4, 'col': 1, 'value': 'Kullanıcı Adı', 'style': header_style},
                    '4,2': {'row': 4, 'col': 2, 'value': 'Display Name', 'style': header_style},
                    '4,3': {'row': 4, 'col': 3, 'value': 'Email', 'style': header_style},
                    '4,4': {'row': 4, 'col': 4, 'value': 'Role', 'style': {**header_style, 'align': 'center'}},
                    '5,1': {'row': 5, 'col': 1, 'value': '{{username}}', 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'username'}},
                    '5,2': {'row': 5, 'col': 2, 'value': '{{Display Name}}', 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'Display Name'}},
                    '5,3': {'row': 5, 'col': 3, 'value': '{{Email}}', 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'Email'}},
                    '5,4': {'row': 5, 'col': 4, 'value': '{{Role}}', 'binding': {'kind': 'query_field', 'queryId': 'q_users', 'field': 'Role'}, 'style': {'align': 'center', 'bold': True}},
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

    @staticmethod
    def _python_oee_template_model():
        """Python script çıktısına (py:py_oee_pareto:line_summary) bağlı örnek şablon."""
        py_ref = 'py:py_oee_pareto:line_summary'
        header_style = {'bold': True, 'bg': '#0F172A', 'color': '#FFFFFF', 'align': 'center'}
        banner_style = {'bold': True, 'fontSize': 14, 'bg': '#1E293B', 'color': '#38BDF8', 'align': 'left'}
        cols = [
            ('line_id', 'Üretim Hattı', False),
            ('batch_count', 'Batch Sayısı', True),
            ('total_produced', 'Toplam Üretim', True),
            ('total_good', 'Sağlam Adet', True),
            ('total_scrap', 'Fire (Scrap)', True),
            ('yield_pct', 'Kalite Oranı %', True),
            ('scrap_rate_pct', 'Fire Oranı %', True),
            ('avg_oee_pct', 'Ortalama OEE %', True),
            ('performance_status', 'Durum', False),
        ]
        cells = {
            '1,1': {'row': 1, 'col': 1, 'value': 'PYTHON ANALYTICS — HAT BAZLI OEE & VERİMLİLİK RAPORU',
                    'mergeAnchor': '1,1,1,9', 'style': banner_style},
            '2,1': {'row': 2, 'col': 1, 'value': 'Çalıştırma Zamanı: {{report_datetime}} · Kaynak: Python Script (py_oee_pareto → line_summary)',
                    'mergeAnchor': '2,1,2,9', 'style': {'italic': True, 'fontSize': 9, 'bg': '#0F172A', 'color': '#94A3B8'}},
            '4,1': {'row': 4, 'col': 1, 'value': 'AVG (avg_oee_pct)', 'style': {'bold': True, 'fontSize': 9, 'bg': '#E2E8F0', 'color': '#334155', 'align': 'center'}},
            '5,1': {'row': 5, 'col': 1, 'value': '={{AVG(avg_oee_pct)}}', 'numberFormat': '#,##0.00',
                    'binding': {'kind': 'summary', 'queryId': py_ref, 'field': 'avg_oee_pct', 'operation': 'AVG'},
                    'style': {'bold': True, 'fontSize': 11, 'bg': '#F0F9FF', 'color': '#0369A1', 'align': 'center'}},
            '4,2': {'row': 4, 'col': 2, 'value': 'SUM (total_produced)', 'style': {'bold': True, 'fontSize': 9, 'bg': '#E2E8F0', 'color': '#334155', 'align': 'center'}},
            '5,2': {'row': 5, 'col': 2, 'value': '={{SUM(total_produced)}}', 'numberFormat': '#,##0',
                    'binding': {'kind': 'summary', 'queryId': py_ref, 'field': 'total_produced', 'operation': 'SUM'},
                    'style': {'bold': True, 'fontSize': 11, 'bg': '#F0F9FF', 'color': '#0369A1', 'align': 'center'}},
            '4,3': {'row': 4, 'col': 3, 'value': 'SUM (total_scrap)', 'style': {'bold': True, 'fontSize': 9, 'bg': '#E2E8F0', 'color': '#334155', 'align': 'center'}},
            '5,3': {'row': 5, 'col': 3, 'value': '={{SUM(total_scrap)}}', 'numberFormat': '#,##0',
                    'binding': {'kind': 'summary', 'queryId': py_ref, 'field': 'total_scrap', 'operation': 'SUM'},
                    'style': {'bold': True, 'fontSize': 11, 'bg': '#FEF2F2', 'color': '#B91C1C', 'align': 'center'}},
            '4,4': {'row': 4, 'col': 4, 'value': 'AVG (yield_pct)', 'style': {'bold': True, 'fontSize': 9, 'bg': '#E2E8F0', 'color': '#334155', 'align': 'center'}},
            '5,4': {'row': 5, 'col': 4, 'value': '={{AVG(yield_pct)}}', 'numberFormat': '#,##0.00',
                    'binding': {'kind': 'summary', 'queryId': py_ref, 'field': 'yield_pct', 'operation': 'AVG'},
                    'style': {'bold': True, 'fontSize': 11, 'bg': '#ECFDF5', 'color': '#047857', 'align': 'center'}},
        }
        field_map = {}
        for idx, (f_key, f_label, is_num) in enumerate(cols, start=1):
            cells[f'7,{idx}'] = {'row': 7, 'col': idx, 'value': f_label, 'style': header_style}
            cell_def = {
                'row': 8, 'col': idx,
                'value': f'{{{{{f_key}}}}}',
                'binding': {'kind': 'query_field', 'queryId': py_ref, 'field': f_key},
                'style': {'fontSize': 10, 'color': '#0F172A', 'align': 'right' if is_num else 'left'},
            }
            if is_num:
                cell_def['numberFormat'] = '#,##0.00' if 'pct' in f_key else '#,##0'
            cells[f'8,{idx}'] = cell_def
            field_map[str(idx)] = f_key

        return {
            'id': 'tpl_python_oee_esg',
            'name': 'Python Analytics — Hat Bazlı OEE & Fire (Scrap) Raporu',
            'description': 'py_oee_pareto Python scriptinin line_summary veri setine bağlı dinamik üretim verimlilik raporu.',
            'sheets': [{
                'id': 'sh_py',
                'name': 'OEE Python Özeti',
                'rowCount': 32,
                'columnCount': 12,
                'columnWidths': {str(i): 18 for i in range(1, 10)},
                'cells': cells,
                'bands': [{
                    'id': 'b_py_oee',
                    'queryId': py_ref,
                    'range': {'startRow': 8, 'startCol': 1, 'endRow': 8, 'endCol': 9},
                    'fieldMap': field_map,
                }],
                'charts': [{
                    'id': 'ch_py_oee',
                    'type': 'bar',
                    'title': 'Hat Bazlı OEE % ve Kalite Oranı %',
                    'queryId': py_ref,
                    'xAxis': 'line_id',
                    'yAxis': ['avg_oee_pct', 'yield_pct'],
                    'anchor': {'row': 12, 'col': 1, 'widthCols': 8, 'heightRows': 12},
                }],
            }],
            'version': 1,
        }

    def _repair_existing_templates(self, conn):
        """Mevcut şablonlarda eksik hücre value'larını, band fieldMap'lerini ve statik metinleri düzeltir."""
        import re as _re
        rows = conn.execute('SELECT id, model FROM report_templates').fetchall()
        for r in rows:
            tid = r['id']
            try:
                model = json.loads(r['model'] or '{}')
            except Exception:
                continue
            changed = False
            for sh in model.get('sheets') or []:
                cells = sh.get('cells') or {}
                bands = sh.get('bands') or []

                # 1. Statik '(\d+ Kayıt)' alt başlığını dinamik {{report_datetime}} ile değiştir
                c21 = cells.get('2,1')
                if isinstance(c21, dict) and isinstance(c21.get('value'), str):
                    old_v = c21['value']
                    new_v = _re.sub(r'\(\d+\s*Kayıt\)', '— Canlı Çalıştırma: {{report_datetime}}', old_v)
                    if new_v != old_v:
                        c21['value'] = new_v
                        changed = True

                # 2. Band fieldMap varsa ama hücre yoksa hücreleri oluştur; hücre varsa fieldMap'i tamamla
                for b in bands:
                    rng = b.get('range') or {}
                    sr = int(rng.get('startRow') or 5)
                    er = int(rng.get('endRow') or sr)
                    qid = b.get('queryId') or ''
                    fmap = b.get('fieldMap') or {}

                    if fmap and isinstance(fmap, dict):
                        for col_str, field_name in list(fmap.items()):
                            col_idx = int(col_str)
                            ck = f'{sr},{col_idx}'
                            if ck not in cells:
                                cells[ck] = {
                                    'row': sr,
                                    'col': col_idx,
                                    'value': f'{{{{{field_name}}}}}',
                                    'binding': {'kind': 'query_field', 'queryId': qid, 'field': field_name},
                                }
                                changed = True
                    else:
                        new_fmap = {}
                        max_c = 1
                        for ck, cval in cells.items():
                            if isinstance(cval, dict) and int(cval.get('row') or 0) == sr:
                                cb = cval.get('binding') or {}
                                if cb.get('kind') == 'query_field' and cb.get('field'):
                                    c_idx = int(cval.get('col') or 1)
                                    new_fmap[str(c_idx)] = cb['field']
                                    if c_idx > max_c:
                                        max_c = c_idx
                        if new_fmap:
                            b['fieldMap'] = new_fmap
                            rng['startCol'] = 1
                            rng['endCol'] = max_c
                            b['range'] = rng
                            changed = True

                # 3. Binding'i olan ama value'su boş olan tüm hücrelere anlamlı gösterim ekle
                for ck, cval in cells.items():
                    if not isinstance(cval, dict):
                        continue
                    cb = cval.get('binding')
                    if isinstance(cb, dict):
                        kind = cb.get('kind')
                        cur_val = cval.get('value')
                        if kind == 'query_field' and cb.get('field') and not cur_val:
                            cval['value'] = f"{{{{{cb['field']}}}}}"
                            changed = True
                        elif kind == 'summary' and cb.get('field') and not cur_val:
                            op = (cb.get('operation') or 'SUM').upper()
                            cval['value'] = f"={{{{{op}({cb['field']})}}}}"
                            changed = True
                        elif kind == 'builtin' and cb.get('builtin') and not cur_val:
                            cval['value'] = f"{{{{{cb['builtin']}}}}}"
                            changed = True
                sh['cells'] = cells
            if changed:
                conn.execute(
                    'UPDATE report_templates SET model=? WHERE id=?',
                    (json.dumps(model, ensure_ascii=False), tid)
                )

    def _repair_and_enrich_path_defs(self, conn, default_roles_json: str, now: str):
        """Path tanımlarını (Space Map profillerini) zenginleştirir, ikon/tema eksiklerini onarır."""
        # 1. Tekrarlı eski kaydı temizle
        conn.execute("DELETE FROM path_defs WHERE id = 'pth_ca1db9319f'")

        # 2. Python script tabanlı Space Map örneği ekle
        py_path_cfg = {
            'group_col': 'performance_status',
            'id_col': 'line_id',
            'label_col': 'line_id',
            'health_col': 'avg_oee_pct',
            'status_col': 'performance_status',
            'spaceMapConfig': {
                'theme': 'cyber',
                'nodeShape': 'cyber',
                'layout': 'radial',
                'color1': '#00FF9D',
                'color2': '#00F0FF',
                'color3': '#F59E0B',
                'level1Icon': 'fa-microchip',
                'level2Icon': 'fa-industry',
                'level3Icon': 'fa-robot',
                'level4Icon': 'fa-gauge-high',
                'autoTypeIcons': True,
                'showOrbits': True,
                'showGrid': True,
            },
        }
        conn.execute(
            '''INSERT OR IGNORE INTO path_defs
               (id, name, description, query_id, structure, config, owner_id, allowed_roles, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'grouped', ?, 'system', ?, 1, ?, ?)''',
            (
                'pth_py_oee_lines',
                'Python Analytics — Hat Bazlı OEE & Performans Kümeleri',
                'py_oee_pareto Python scriptinin canlı çıktısını kullanarak üretim hatlarını performans durumuna ve OEE skoruna göre haritalar.',
                'py:py_oee_pareto:line_summary',
                json.dumps(py_path_cfg, ensure_ascii=False),
                default_roles_json,
                now,
                now,
            )
        )

        # 3. Mevcut path_defs kayıtlarına uygun endüstriyel tema/ikon/layout profilleri ata
        default_profiles = {
            'pth_factory_tree': {
                'theme': 'factory', 'nodeShape': 'hexagon', 'layout': 'radial',
                'color1': '#F59E0B', 'color2': '#10B981', 'color3': '#06B6D4',
                'level1Icon': 'fa-building', 'level2Icon': 'fa-industry', 'level3Icon': 'fa-cogs', 'level4Icon': 'fa-gauge-high',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
            'pth_ed8830832d': {
                'theme': 'factory', 'nodeShape': 'hexagon', 'layout': 'hierarchy-tb',
                'color1': '#F59E0B', 'color2': '#3B82F6', 'color3': '#10B981',
                'level1Icon': 'fa-industry', 'level2Icon': 'fa-sitemap', 'level3Icon': 'fa-cogs', 'level4Icon': 'fa-robot',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
            'pth_factory_sequence': {
                'theme': 'blueprint', 'nodeShape': 'blueprint', 'layout': 'flow-lr',
                'color1': '#38BDF8', 'color2': '#818CF8', 'color3': '#F472B6',
                'level1Icon': 'fa-industry', 'level2Icon': 'fa-cogs', 'level3Icon': 'fa-robot', 'level4Icon': 'fa-circle-check',
                'autoTypeIcons': True, 'showOrbits': False, 'showGrid': True,
            },
            'pth_factory_grouped': {
                'theme': 'factory', 'nodeShape': 'hexagon', 'layout': 'grid',
                'color1': '#EF4444', 'color2': '#F59E0B', 'color3': '#10B981',
                'level1Icon': 'fa-layer-group', 'level2Icon': 'fa-industry', 'level3Icon': 'fa-cogs', 'level4Icon': 'fa-wrench',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
            'pth_de81c0a103': {
                'theme': 'cyber', 'nodeShape': 'cyber', 'layout': 'flow-lr',
                'color1': '#00FF9D', 'color2': '#00F0FF', 'color3': '#FF007F',
                'level1Icon': 'fa-project-diagram', 'level2Icon': 'fa-cogs', 'level3Icon': 'fa-robot', 'level4Icon': 'fa-microchip',
                'autoTypeIcons': True, 'showOrbits': False, 'showGrid': True,
            },
            'pth_quality_defect_tree': {
                'theme': 'crystal', 'nodeShape': 'diamond', 'layout': 'hierarchy-tb',
                'color1': '#EC4899', 'color2': '#8B5CF6', 'color3': '#06B6D4',
                'level1Icon': 'fa-shield-alt', 'level2Icon': 'fa-clipboard-check', 'level3Icon': 'fa-triangle-exclamation', 'level4Icon': 'fa-wrench',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
            'pth_facility_energy_grouped': {
                'theme': 'cyber', 'nodeShape': 'hexagon', 'layout': 'radial',
                'color1': '#10B981', 'color2': '#06B6D4', 'color3': '#F59E0B',
                'level1Icon': 'fa-bolt', 'level2Icon': 'fa-industry', 'level3Icon': 'fa-plug', 'level4Icon': 'fa-leaf',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
            'pth_downtime_pareto_sequence': {
                'theme': 'factory', 'nodeShape': 'hexagon', 'layout': 'flow-lr',
                'color1': '#EF4444', 'color2': '#F59E0B', 'color3': '#3B82F6',
                'level1Icon': 'fa-wrench', 'level2Icon': 'fa-cogs', 'level3Icon': 'fa-triangle-exclamation', 'level4Icon': 'fa-gauge-high',
                'autoTypeIcons': True, 'showOrbits': False, 'showGrid': True,
            },
            'pth_smart_grid_dag': {
                'theme': 'blueprint', 'nodeShape': 'blueprint', 'layout': 'flow-lr',
                'color1': '#38BDF8', 'color2': '#F59E0B', 'color3': '#10B981',
                'level1Icon': 'fa-bolt', 'level2Icon': 'fa-plug', 'level3Icon': 'fa-industry', 'level4Icon': 'fa-gauge-high',
                'autoTypeIcons': True, 'showOrbits': False, 'showGrid': True,
            },
            'pth_25a0010779': {
                'theme': 'blueprint', 'nodeShape': 'blueprint', 'layout': 'radial',
                'color1': '#38BDF8', 'color2': '#818CF8', 'color3': '#22D3EE',
                'level1Icon': 'fa-server', 'level2Icon': 'fa-network-wired', 'level3Icon': 'fa-gauge-high', 'level4Icon': 'fa-microchip',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
            'pth_c72d514d93': {
                'theme': 'factory', 'nodeShape': 'hexagon', 'layout': 'radial',
                'color1': '#34D399', 'color2': '#60A5FA', 'color3': '#F59E0B',
                'level1Icon': 'fa-building', 'level2Icon': 'fa-warehouse', 'level3Icon': 'fa-cogs', 'level4Icon': 'fa-microchip',
                'autoTypeIcons': True, 'showOrbits': True, 'showGrid': True,
            },
        }

        rows = conn.execute('SELECT id, config FROM path_defs').fetchall()
        for r in rows:
            pid = r['id']
            try:
                cfg = json.loads(r['config'] or '{}')
            except Exception:
                cfg = {}
            changed = False
            smc = cfg.get('spaceMapConfig')
            prof = default_profiles.get(pid)
            if prof and (not smc or not smc.get('level1Icon') or smc.get('theme') == 'cosmic'):
                merged_smc = {**prof, **(smc or {})}
                for k in ('theme', 'nodeShape', 'layout', 'level1Icon', 'level2Icon', 'level3Icon', 'level4Icon', 'autoTypeIcons'):
                    if not (smc or {}).get(k):
                        merged_smc[k] = prof[k]
                cfg['spaceMapConfig'] = merged_smc
                changed = True
            if pid == 'pth_facility_energy_grouped' and cfg.get('group_col') == 'Plant Area':
                cfg['root_label'] = 'Apex Smart Factory — Enerji & Karbon (ESG) Kümeleri'
                changed = True
            if changed:
                conn.execute(
                    'UPDATE path_defs SET config=?, materialized=NULL WHERE id=?',
                    (json.dumps(cfg, ensure_ascii=False), pid)
                )

# Global instance pattern similar to original
_db_instance = None
def get_db():
    global _db_instance
    if _db_instance is None:
        _db_instance = Database()
    return _db_instance
