import os
import sys
import json
import uuid
import logging
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from io import BytesIO

from flask import Flask, jsonify, request, send_file, g, Response
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

_DM_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_DM_DIR, '..'))

from db.database import get_db, ROLE_LEVELS, ALL_PERMISSION_KEYS, PERMISSION_CATALOG
from query_executor import (
    execute_query, test_connection, get_tables, get_table_schema, get_table_preview,
    search_columns_in_db, check_relationship, get_functions,
    QueryExecutionError,
)
from excel_template_engine import ExcelTemplateEngine
from path_engine import build_structure
import auth as auth_lib
import passwords
import secrets_util
from cache import metadata_cache
from config import config
try:
    from ai_api import register_ai, index_saved_example
except Exception as _ai_import_err:
    logging.getLogger(__name__).warning("Opsiyonel AI modülü yüklenmedi (Tak-Çıkar modu): %s", _ai_import_err)
    def register_ai(*_args, **_kwargs):  # type: ignore[misc]
        return None
    def index_saved_example(*_args, **_kwargs):  # type: ignore[misc]
        return None

app = Flask(__name__)
# Flask/oturum imzası config'ten (NOVA_FLASK_SECRET). Hardcoded DEĞİL.
app.secret_key = config.FLASK_SECRET_KEY
# İstek gövdesi boyut sınırı (DoS koruması): 10 MiB.
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024
# Üretimde debugger/traceback sızıntısı kapalı (yalnızca DEBUG=True iken propagate).
app.config['PROPAGATE_EXCEPTIONS'] = config.DEBUG
# Reverse proxy (nginx) arkasında gerçek IP/şema/host güveni.
app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=config.TRUSTED_PROXY_HOPS, x_proto=1, x_host=1, x_prefix=1)
# Rate limiting / kaba kuvvet tabanı (NIS2 Art.21(1)(c); ISO/IEC 27002:2022 A.8.5).
# Gerçek istemci IP'si ProxyFix tarafından request.remote_addr'a yazılır.
# memory:// (dev) worker başına ayrı sayar; üretimde paylaşımlı redis:// zorunlu.
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[f"{config.RATELIMIT_GLOBAL_PER_MIN} per minute"],
    storage_uri=config.RATELIMIT_STORAGE_URI,
    headers_enabled=True,
)
_engine = ExcelTemplateEngine()

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Token gerektirmeyen (herkese açık) yollar. (refresh/logout kendi içinde
# refresh token'ı doğrular; erişim token'ı gerekmez.)
PUBLIC_PATHS = {'/health', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/ai/health'}

# CORS allowlist config'ten (NOVA_CORS_ORIGINS). Joker ('*') güvenlik açısından reddedilir.
_ALLOWED_ORIGINS = {o for o in config.CORS_ALLOWED_ORIGINS if o and o != '*'}
if config.IS_DEVELOPMENT:
    _ALLOWED_ORIGINS.update({'http://localhost:4200', 'http://127.0.0.1:4200', 'http://localhost:4201', 'http://127.0.0.1:4201'})


@app.after_request
def _after_request(response):
    # --- CORS (allowlist; joker reddedilir) ---
    origin = request.headers.get('Origin')
    if origin in _ALLOWED_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'

    # --- Güvenlik başlıkları (NIS2 Art.21(1)(b); ISO/IEC 27002:2022 A.8.23) ---
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    # API yanıtları (token/rapor içerebilir) ara önbelleğe alınmasın.
    response.headers['Cache-Control'] = 'no-store, no-transform' if response.mimetype == 'text/event-stream' else 'no-store'
    response.headers['Pragma'] = 'no-cache'
    # HSTS yalnızca TLS arkasında ve config açıkken gönderilir (plain HTTP'de
    # asla — ilk ziyarette downgrade tuzağına yol açar).
    if config.HSTS_ENABLED and request.is_secure:
        response.headers['Strict-Transport-Security'] = (
            f'max-age={config.HSTS_MAX_AGE}; includeSubDomains')
    return response


_revoked_user_ids = set()


@app.before_request
def _auth_guard():
    """Her isteği bearer token ile doğrula. g.uid/g.username/g.role doldurur."""
    # CORS preflight — after_request header'ları ekler.
    if request.method == 'OPTIONS':
        return ('', 204)

    # Herkese açık yollar (login, health) ve OPTIONS hariç her şey token gerektirir.
    if request.path in PUBLIC_PATHS:
        return None

    header = request.headers.get('Authorization', '')
    raw_token = ''
    if header.startswith('Bearer '):
        raw_token = header[7:].strip()
    elif request.args.get('token'):
        raw_token = request.args.get('token').strip()
    
    if not raw_token:
        return _err('Authentication required.', 401)
    payload = auth_lib.verify_token(raw_token)
    if not payload:
        return _err('Session invalid or expired.', 401)

    uid = payload.get('uid')
    if uid in _revoked_user_ids:
        return _err('Session invalid or expired.', 401)
    if uid:
        try:
            with get_db()._conn() as conn:
                urow = conn.execute('SELECT is_active FROM users WHERE id = ?', (uid,)).fetchone()
            if urow is not None and not urow['is_active']:
                return _err('Account is deactivated.', 401)
        except Exception:
            pass

    g.uid = uid
    g.username = payload.get('u')
    g.role = payload.get('role')
    g.level = payload.get('level', 0)  # kolaylık için token'dan; güvenlik için DB'den tekrar çözülür
    return None


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------

def _user_id() -> str:
    """Doğrulanan kullanıcının id'si (_auth_guard tarafından g.uid'ye yazılır)."""
    return getattr(g, 'uid', None) or 'system'


def _is_admin() -> bool:
    return getattr(g, 'role', None) in ('admin', 'superuser')


def _allowed_pages_for_role(role: str) -> list:
    """Sayfa erişim matrisi. admin/superuser her şeyi gezebilir."""
    if role in ('admin', 'superuser'):
        return ['*']
    if role == 'engineer':
        # Python Workspace güçlü bir araç — mühendis+ tarafından kullanılabilir.
        return ['dashboard', 'reports', 'alarms', 'table-explorer', 'python-workspace']
    # viewer/user için varsayılan görünebilir sayfalar.
    return ['dashboard', 'reports', 'alarms', 'table-explorer']


def _new_id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}"


def _full_data_source(ds_id: str):
    """data_sources tam satırını (credential dahil, sadece backend içi) döndürür.

    Güvenlik: parola at-rest şifreli saklanır (secrets_util); burada çözülüp
    yalnızca backend içi kullanıma (sorgu çalıştırma) sunulur. İstemciye ASLA
    döndürülmez.
    """
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM data_sources WHERE id = ?', (ds_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d['password'] = secrets_util.decrypt_secret(d.get('password') or '')
    return d


def _load_query_row(qid: str):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            'SELECT id, name, description, data_source_id, sql_text, parameters, columns_meta, owner_id, '
            'allowed_roles, allowed_users '
            'FROM queries WHERE id = ?', (qid,)).fetchone()
    return dict(row) if row else None


def _query_columns(row: dict) -> list:
    """Sorgu sütunlarını döndürür. Kalıcı saklama açıksa DB'den; değilse (lisans-safe
    varsayılan) bu oturumda preview edildiyse RAM önbelleğinden alır."""
    cols = json.loads(row.get('columns_meta') or '[]')
    if cols:
        return cols
    cached = metadata_cache.get(f"qcols:{row.get('id')}")
    if cached:
        return cached
    ds_id = row.get('data_source_id')
    if ds_id and row.get('sql_text'):
        ds = _full_data_source(ds_id)
        if ds and (ds.get('db_type') or '').lower() == 'sqlite':
            try:
                res = execute_query(ds, row['sql_text'], {}, limit=1)
                raw_cols = res.get('columns') or []
                if raw_cols:
                    metadata_cache.set(f"qcols:{row.get('id')}", raw_cols)
                    return raw_cols
            except Exception:
                pass
    return []


def _query_to_dict(row: dict) -> dict:
    return {
        'id': row['id'],
        'name': row['name'],
        'description': row.get('description', ''),
        'dataSourceId': row['data_source_id'],
        'sql': row['sql_text'],
        'parameters': json.loads(row.get('parameters') or '[]'),
        'columns': _query_columns(row),
        'owner': row.get('owner_id', ''),
        'allowedRoles': json.loads(row.get('allowed_roles') or '[]'),
        'allowedUsers': json.loads(row.get('allowed_users') or '[]')
    }


def _can_access_query(row: dict) -> bool:
    """Kullanıcının bu nesneye (sorgu/şablon/dashboard/script/path) erişimi var mı?

    Kural: admin/superuser her şeyi; sahip her zaman; değilse
    rolü allowed_roles içinde veya kimliği (username/uid) allowed_users içinde olmalı.
    """
    role = getattr(g, 'role', None)
    if role in ('admin', 'superuser') or _user_level() >= ROLE_LEVELS.get('admin', 80):
        return True
    owner = row.get('owner_id') or row.get('user_id')
    if not owner or owner == 'system' or owner == getattr(g, 'uid', None):
        return True
    allowed_roles = json.loads(row.get('allowed_roles') or '[]')
    allowed_users = json.loads(row.get('allowed_users') or '[]')
    if role and role in allowed_roles:
        return True
    identity = getattr(g, 'username', None)
    uid = getattr(g, 'uid', None)
    if identity and identity in allowed_users:
        return True
    if uid and uid in allowed_users:
        return True
    return False


def _can_modify_query(row: dict) -> bool:
    """Nesne düzenleme/silme: sahip veya admin."""
    if getattr(g, 'role', None) in ('admin', 'superuser') or _user_level() >= ROLE_LEVELS.get('admin', 80):
        return True
    owner = row.get('owner_id') or row.get('user_id')
    if owner == 'system' and getattr(g, 'role', None) == 'engineer':
        return True
    return bool(owner) and owner == getattr(g, 'uid', None)


# ---------------------------------------------------------------------------
# RBAC yardımcıları: çağıran kullanıcının rolü/seviyesi/izinleri (istek başına,
# DB'den çözülür ve g üzerinde önbelleğe alınır). Hiyerarşi + izin kontrolleri.
# ---------------------------------------------------------------------------

def _current_user_row() -> dict | None:
    """Çağıran kullanıcının users↔roles join'li satırı (g'de önbelleğe alınır)."""
    if hasattr(g, '_me_row'):
        return g._me_row
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            '''SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_id, u.is_active,
                      r.key AS role_key, r.name AS role_name, r.level, r.is_system
               FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?''',
            (_user_id(),)).fetchone()
    g._me_row = dict(row) if row else None
    return g._me_row


def _user_level() -> int:
    me = _current_user_row()
    try:
        return int((me or {}).get('level') or 0)
    except (TypeError, ValueError):
        return 0


def _compute_effective_permissions(uid: str) -> set:
    """Verilen kullanıcının efektif izinleri: role_permissions ∪ user grant-overrides
    − user deny-overrides. superuser → tüm izinler (wildcard). DB'den taze çözülür."""
    db = get_db()
    with db._conn() as conn:
        u = conn.execute(
            'SELECT u.role_id, r.key AS role_key, r.level FROM users u '
            'LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?', (uid,)).fetchone()
        if not u:
            return set()
        if u['role_key'] == 'superuser' or (u['level'] or 0) >= ROLE_LEVELS['superuser']:
            return set(ALL_PERMISSION_KEYS)
        role_perms = {r['permission_key'] for r in conn.execute(
            'SELECT permission_key FROM role_permissions WHERE role_id = ?', (u['role_id'],))}
        overrides = conn.execute(
            'SELECT permission_key, granted FROM user_permissions WHERE user_id = ?', (uid,)).fetchall()
    granted = {o['permission_key'] for o in overrides if o['granted']}
    denied = {o['permission_key'] for o in overrides if not o['granted']}
    return (role_perms | granted) - denied


def _effective_permissions() -> set:
    """Çağıran kullanıcının efektif izinleri (g'de önbelleğe alınır)."""
    if not hasattr(g, '_eff_perms'):
        g._eff_perms = _compute_effective_permissions(_user_id())
    return g._eff_perms


def _has_perm(key: str) -> bool:
    return key in _effective_permissions()


def _require_perm(key: str):
    """İzin yoksa 403 yanıtı döndürür, varsa None. Kullanım:
       denied = _require_perm('user:view'); if denied: return denied"""
    if not _has_perm(key):
        return _err('Forbidden: insufficient permissions.', 403)
    return None


def _can_manage_level(target_level) -> bool:
    """Hiyerarşi: hedef seviye çağıranın seviyesinden DÜŞÜK mü?"""
    try:
        return int(target_level or 0) < _user_level()
    except (TypeError, ValueError):
        return False


def _can_manage_user(target_uid: str) -> bool:
    """Çağıran bu kullanıcıyı yönetebilir mi? user:edit izni + hedef seviye daha düşük.
    Kendi üzerinde yönetim (rol/aktif/silme) engellenir (kilitlenmeyi önler)."""
    if not _has_perm('user:edit'):
        return False
    if target_uid == _user_id():
        return False
    db = get_db()
    with db._conn() as conn:
        t = conn.execute(
            'SELECT r.level FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
            (target_uid,)).fetchone()
    if not t or t['level'] is None:
        return False
    return t['level'] < _user_level()


def _effective_pages(uid: str) -> list:
    """Kullanıcının görebileceği sayfa key'leri (page:* izinlerinden türetilir)."""
    perms = _compute_effective_permissions(uid)
    return sorted(p.split(':', 1)[1] for p in perms if p.startswith('page:'))


def _role_to_dict(row: dict, member_count: int = 0) -> dict:
    return {
        'id': row['id'],
        'key': row['key'],
        'name': row['name'],
        'description': row.get('description', ''),
        'level': row['level'],
        'isSystem': bool(row['is_system']),
        'isActive': bool(row['is_active']),
        'color': row.get('color', ''),
        'memberCount': member_count,
        'createdAt': row.get('created_at', ''),
        'updatedAt': row.get('updated_at', ''),
    }


def _load_role_row(rid: str) -> dict | None:
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM roles WHERE id = ?', (rid,)).fetchone()
    return dict(row) if row else None


def _err(message: str, status: int = 400, **extra):
    payload = {"success": False, "error": message}
    payload.update(extra)
    return jsonify(payload), status


def _audit(action: str, target: str = '', detail=None, status: str = 'success',
           actor_uid: str = '', actor_user: str = '', conn=None):
    """Güvenlik olayını denetim (audit) loguna yazar.

    Best-effort: asla hata fırlatmaz (denetim, istek akışını bozmamalı). Aktör
    verilmezse g (kimliği doğrulanmış kullanıcı) kullanılır; login gibi g'nin
    boş olduğu uçlarda aktör açıkça verilmelidir.

    conn verilirse mevcut (muhtemelen açık) transaction içinde yazar — ikinci bir
    bağlantı açıp SQLite tek-yazıcı kilidinde (database is locked) çıkmaza
    düşmemek için. login/refresh gibi auth olayları açık transaction içinde
    çağrıldığından bunu kullanır (aksi halde denetim kaydı sessizce yazılamaz).
    """
    try:
        d = json.dumps(detail, ensure_ascii=False, default=str) if detail is not None else ''
        uid = actor_uid or getattr(g, 'uid', '') or ''
        uname = actor_user or getattr(g, 'username', '') or ''
        ip = getattr(request, 'remote_addr', '') or ''
        stmt = ("INSERT INTO audit_log (actor_uid, actor_user, action, target, detail, ip, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)")
        params = (uid, uname, action, target, d, ip, status)
        if conn is not None:
            conn.execute(stmt, params)
        else:
            db = get_db()
            with db._conn() as c:
                c.execute(stmt, params)
    except Exception:
        logger.warning("Denetim kaydı yazılamadı (%s).", action)


def _prune_audit(conn) -> None:
    """Saklama süresi (AUDIT_LOG_RETENTION_DAYS) dışındaki denetim kayıtlarını siler."""
    days = int(getattr(config, 'AUDIT_LOG_RETENTION_DAYS', 0) or 0)
    if days > 0:
        conn.execute("DELETE FROM audit_log WHERE ts < datetime('now', ?)", (f"-{days} days",))


# ---------------------------------------------------------------------------
# Kimlik doğrulama (login / profil / izinler)
# ---------------------------------------------------------------------------

_DEFAULT_PREFS = {
    'theme': 'dark', 'language': 'tr',
    'dashboardRefreshInterval': 30,
    'dateFormat': 'DD/MM/YYYY HH:mm', 'timezone': 'Europe/Istanbul',
}


def _user_public_dict(row) -> dict:
    r = dict(row)
    return {
        'id': r['id'],
        'username': r['username'],
        'displayName': r.get('display_name') or r['username'],
        'email': r.get('email', ''),
        'role': r.get('role', 'viewer'),
        'level': r.get('level', 0) or 0,
        'roleId': r.get('role_id', ''),
        'roleName': r.get('role_name', ''),
        'preferences': dict(_DEFAULT_PREFS),
    }


@app.route('/api/auth/login', methods=['POST'])
@limiter.limit(lambda: f"{config.RATELIMIT_LOGIN_PER_MIN} per minute")
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if not username or not password:
        return _err('Username and password are required.', 400)

    db = get_db()
    # naive UTC (SQLite datetime('now') ile aynı zaman dilimi/format); strptime ile uyumlu.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    now_utc = now.strftime('%Y-%m-%d %H:%M:%S')  # SQLite datetime('now') ile aynı UTC formatı
    with db._conn() as conn:
        row = conn.execute(
            'SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_id, '
            'u.password_hash, u.password_salt, u.is_active, '
            'u.failed_login_attempts, u.last_failed_at, u.locked_until, '
            'r.level, r.key AS role_key, r.name AS role_name '
            'FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.username = ?', (username,)
        ).fetchone()
        _prune_audit(conn)  # dönemsel denetim budaması (login başına bir kez)

        # Kaba kuvvet kilidi (Faz 5b): pencere dolana kadar giriş reddet.
        if row and row['is_active'] and row['locked_until'] and row['locked_until'] > now_utc:
            logger.warning("Kilitli hesaba giriş denemesi (uid=%s, kilit=%s).",
                           row['id'], row['locked_until'])
            _audit('auth.login', target=row['username'], status='deny',
                   actor_uid=row['id'], actor_user=row['username'],
                   detail={'locked_until': row['locked_until']}, conn=conn)
            return _err('Hesap geçici olarak kilitli. Lütfen daha sonra tekrar deneyin.', 429)

        # Kullanıcı adı / şifre hatalarını aynı mesajla döndür (user enumeration koruması).
        if not row or not row['is_active'] or not row['password_hash']:
            _audit('auth.login', target=username, status='fail', actor_user=username, conn=conn)
            return _err('Invalid username or password.', 401)

        ok, needs_rehash = passwords.verify(password, row['password_salt'], row['password_hash'])
        if not ok:
            # Başarısız deneme: pencere dışıysa sayacı sıfırla, sonra artır.
            attempts = int(row['failed_login_attempts'] or 0)
            last = row['last_failed_at'] or ''
            if last:
                try:
                    last_dt = datetime.strptime(last, '%Y-%m-%d %H:%M:%S')
                except ValueError:
                    last_dt = None
                if last_dt and (now - last_dt) > timedelta(seconds=int(config.LOGIN_WINDOW_SECONDS)):
                    attempts = 0
            attempts += 1
            if attempts >= int(config.LOGIN_MAX_ATTEMPTS):
                lockout = int(config.LOGIN_LOCKOUT_SECONDS)
                conn.execute(
                    "UPDATE users SET failed_login_attempts=0, last_failed_at='', "
                    "locked_until=datetime('now', ?), updated_at=datetime('now') WHERE id=?",
                    (f"+{lockout} seconds", row['id']))
                logger.warning("Hesap kilitlendi (uid=%s, %s deneme, %ss).",
                               row['id'], attempts, lockout)
                _audit('auth.login', target=row['username'], status='lock',
                       actor_uid=row['id'], actor_user=row['username'], detail={'attempts': attempts}, conn=conn)
            else:
                conn.execute(
                    "UPDATE users SET failed_login_attempts=?, last_failed_at=datetime('now'), "
                    "updated_at=datetime('now') WHERE id=?",
                    (attempts, row['id']))
                _audit('auth.login', target=row['username'], status='fail',
                       actor_uid=row['id'], actor_user=row['username'], detail={'attempts': attempts}, conn=conn)
            return _err('Invalid username or password.', 401)

        # Başarılı giriş: sayacı ve kilidi temizle.
        if int(row['failed_login_attempts'] or 0) or row['locked_until']:
            conn.execute(
                "UPDATE users SET failed_login_attempts=0, last_failed_at='', locked_until='', "
                "updated_at=datetime('now') WHERE id=?",
                (row['id'],))

        # Kademeli göç: legacy sha256 / eski argon2 parametreleri → güçlü argon2id.
        if needs_rehash:
            try:
                new_hash = passwords.hash_password(password)
                conn.execute(
                    "UPDATE users SET password_hash=?, password_salt='', updated_at=datetime('now') WHERE id=?",
                    (new_hash, row['id']))
            except Exception:
                logger.warning("Parola argon2id'ye göç edilemedi (uid=%s).", row['id'])

    # Kısa ömürlü erşim token'ı (stateless) + uzun ömürlü refresh token (DB, rotation).
    access_token = auth_lib.create_token(row['id'], row['username'], row['role'], row['level'] or 0)
    refresh_token, refresh_hash = auth_lib.create_refresh_token()
    try:
        with db._conn() as conn:
            conn.execute(
                "INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at) "
                "VALUES (?, ?, ?, ?, datetime('now', ?))",
                (_new_id('rt_'), row['id'], _new_id('fam_'), refresh_hash,
                 f"+{int(config.TOKEN_REFRESH_TTL)} seconds"))
    except Exception:
        logger.warning("Refresh token kaydedilemedi (uid=%s).", row['id'])
        refresh_token = ''
    _audit('auth.login', target=row['username'], status='success',
           actor_uid=row['id'], actor_user=row['username'])
    return jsonify({
        'success': True,
        'user': _user_public_dict(row),
        'token': access_token,
        'refreshToken': refresh_token,
    })


@app.route('/api/auth/refresh', methods=['POST'])
@limiter.limit(lambda: f"{config.RATELIMIT_LOGIN_PER_MIN} per minute")
def refresh_access():
    """Refresh token ile yeni erişim + refresh çifti döndürür (rotation).

    Yeniden kullanım (iptal edilmiş/döndürülmüş token tekrar sunuldu) → tüm aileyi
    iptal eder (token theft mitigation). Süresi dolmuş refresh token'lar da temizlenir.
    """
    body = request.get_json(silent=True) or {}
    presented = (body.get('refreshToken') or body.get('refresh_token') or '').strip()
    if not presented:
        return _err('Refresh token required.', 400)

    token_hash = auth_lib.hash_refresh_token(presented)
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None).strftime('%Y-%m-%d %H:%M:%S')
    db = get_db()
    with db._conn() as conn:
        rt = conn.execute(
            "SELECT id, user_id, family_id, revoked, expires_at FROM refresh_tokens WHERE token_hash=?",
            (token_hash,)).fetchone()

        # Reuse detection: iptal edilmiş token tekrar sunuldu → aile iptali.
        if rt and rt['revoked']:
            conn.execute("UPDATE refresh_tokens SET revoked=1 WHERE family_id=?", (rt['family_id'],))
            logger.warning("Refresh token yeniden kullanım — aile iptal edildi (family=%s).", rt['family_id'])
            _audit('auth.refresh', target='reuse', status='deny', actor_uid=rt['user_id'],
                   detail={'family': rt['family_id']}, conn=conn)
            return _err('Session invalid.', 401)
        if not rt or rt['expires_at'] <= now_utc:
            return _err('Session invalid or expired.', 401)

        u = conn.execute(
            "SELECT u.id, u.username, u.role, u.is_active, r.level "
            "FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id=?",
            (rt['user_id'],)).fetchone()
        if not u or not u['is_active']:
            conn.execute("UPDATE refresh_tokens SET revoked=1 WHERE family_id=?", (rt['family_id'],))
            return _err('Session invalid.', 401)

        # ROTATION: eski token'ı iptal et, aynı aileden yeni çift üret.
        new_access = auth_lib.create_token(u['id'], u['username'], u['role'], u['level'] or 0)
        new_refresh, new_hash = auth_lib.create_refresh_token()
        new_id = _new_id('rt_')
        conn.execute("UPDATE refresh_tokens SET revoked=1, replaced_by=? WHERE id=?", (new_id, rt['id']))
        conn.execute(
            "INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at) "
            "VALUES (?, ?, ?, ?, datetime('now', ?))",
            (new_id, u['id'], rt['family_id'], new_hash, f"+{int(config.TOKEN_REFRESH_TTL)} seconds"))
        # Temizlik: süresi dolmuş refresh token'ları sil (tablo büyümesini önle).
        conn.execute("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')")

    return jsonify({'success': True, 'token': new_access, 'refreshToken': new_refresh})


@app.route('/api/auth/logout', methods=['POST'])
def revoke_session():
    """Sunulan refresh token'ı iptal eder (yalnızca bu token; diğer cihazlar kalır)."""
    body = request.get_json(silent=True) or {}
    presented = (body.get('refreshToken') or body.get('refresh_token') or '').strip()
    if presented:
        token_hash = auth_lib.hash_refresh_token(presented)
        db = get_db()
        with db._conn() as conn:
            conn.execute("UPDATE refresh_tokens SET revoked=1 WHERE token_hash=?", (token_hash,))
    return jsonify({'success': True})


@app.route('/api/users/<uid>/profile', methods=['GET'])
def get_user_profile(uid):
    # Kendi profili ya da yönetebildiği kullanıcı.
    if g.uid != uid and not _can_manage_user(uid) and not _is_admin():
        return _err('Unauthorized.', 403)
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            'SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_id, '
            'r.level, r.name AS role_name '
            'FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?', (uid,)
        ).fetchone()
    if not row:
        return _err('User not found.', 404)
    return jsonify({'success': True, 'user': _user_public_dict(row)})


@app.route('/api/users/<uid>/permissions', methods=['GET'])
def get_user_permissions(uid):
    # Kendi izinleri ya da yönetebildiği kullanıcının izinleri.
    if g.uid != uid and not _can_manage_user(uid) and not _is_admin():
        return _err('Unauthorized.', 403)
    db = get_db()
    with db._conn() as conn:
        u = conn.execute(
            'SELECT u.role, r.key AS role_key, r.level FROM users u '
            'LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?', (uid,)).fetchone()
    if not u:
        return _err('User not found.', 404)
    perms = sorted(_compute_effective_permissions(uid))
    pages = sorted(p.split(':', 1)[1] for p in perms if p.startswith('page:'))
    return jsonify({
        'user_id': uid,
        'role': u['role_key'] or u['role'],
        'level': u['level'] or 0,
        'permissions': perms,
        'allowed_pages': pages,
    })


# ---------------------------------------------------------------------------
# Health & mevcut varlıklar
# ---------------------------------------------------------------------------

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "Nov4 API",
        "connections": {"database": "connected"}
    })


@app.route('/api/users', methods=['GET'])
def get_users():
    db = get_db()
    with db._conn() as conn:
        if _has_perm('user:view'):
            users = [dict(row) for row in conn.execute(
                '''SELECT u.id, u.username, u.display_name, u.email, u.role, u.is_active,
                          r.key AS role_key, r.level
                   FROM users u LEFT JOIN roles r ON r.id = u.role_id
                   ORDER BY r.level DESC, u.username''')]
        else:
            # Paylaşım seçicileri için aktif kullanıcıların temel kimlik bilgilerini döndür (e-posta hariç).
            users = [dict(row) for row in conn.execute(
                '''SELECT u.id, u.username, u.display_name, '' AS email, u.role, u.is_active,
                          r.key AS role_key, r.level
                   FROM users u LEFT JOIN roles r ON r.id = u.role_id
                   WHERE u.is_active = 1
                   ORDER BY r.level DESC, u.username''')]
    return jsonify({"success": True, "data": users})


@app.route('/api/sharing/options', methods=['GET'])
def get_sharing_options():
    """Sorgu, Python script, şablon ve dashboard paylaşım pencereleri için aktif rol ve kullanıcı listesi."""
    db = get_db()
    with db._conn() as conn:
        roles = [dict(r) for r in conn.execute(
            'SELECT id, key, name, color, level FROM roles WHERE is_active = 1 ORDER BY level DESC')]
        users = [dict(u) for u in conn.execute(
            '''SELECT id, username, display_name AS displayName, role
               FROM users WHERE is_active = 1 ORDER BY username''')]
    return jsonify({"success": True, "data": {"roles": roles, "users": users}})


@app.route('/api/datasources', methods=['GET'])
def get_datasources():
    db = get_db()
    with db._conn() as conn:
        sources = [dict(row) for row in conn.execute(
            'SELECT id, name, db_type, host, port, database_name, is_active FROM data_sources')]
    return jsonify({"success": True, "data": sources})


@app.route('/api/datasources', methods=['POST'])
def create_datasource():
    denied = _require_perm('datasource:manage')
    if denied:
        return denied
    try:
        data = request.json or {}
        name = data.get('name', '').strip()
        db_type = data.get('db_type', '').strip().lower()
        
        if not name or not db_type:
            return _err("Name and DB Type are required.", 400)
            
        ds_id = _new_id('ds_')
        now = datetime.now().isoformat()
        
        db = get_db()
        with db._conn() as conn:
            conn.execute('''
                INSERT INTO data_sources 
                (id, name, db_type, host, port, username, password, database_name, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ''', (
                ds_id, name, db_type,
                data.get('host', ''),
                int(data.get('port') or 0),
                data.get('username', ''),
                # Parola DB'de ASLA düz metin; at-rest Fernet ile şifrelenir (F6).
                secrets_util.encrypt_secret(data.get('password', '')),
                data.get('database_name', ''),
                now, now
            ))
            
        _audit('datasource.create', target=ds_id, detail={'name': name})
        return jsonify({"success": True, "data": {"id": ds_id, "name": name}})
    except Exception as e:
        logger.exception("Error creating data source")
        return _err("İç sunucu hatası.", 500)


@app.route('/api/datasources/test', methods=['POST'])
def api_test_connection():
    denied = _require_perm('datasource:manage')
    if denied:
        return denied
    try:
        data = request.json or {}
        # Prepare a mock data source dict
        ds = {
            "db_type": data.get('db_type', ''),
            "host": data.get('host', ''),
            "port": int(data.get('port') or 0),
            "username": data.get('username', ''),
            "password": data.get('password', ''),
            "database_name": data.get('database_name', '')
        }
        test_connection(ds)
        return jsonify({"success": True, "message": "Connection successful"})
    except QueryExecutionError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("Unexpected error testing connection")
        return _err("An unexpected error occurred", 500)


def _update_datasource_cached_tables(ds_id: str, tables: list):
    db = get_db()
    with db._conn() as conn:
        conn.execute(
            'UPDATE data_sources SET cached_tables = ? WHERE id = ?',
            (json.dumps(tables), ds_id)
        )


@app.route('/api/datasources/<ds_id>/tables', methods=['GET'])
def api_get_tables(ds_id):
    try:
        ds = _full_data_source(ds_id)
        if not ds:
            return _err("Data source not found", 404)

        cache_key = f"tables:{ds_id}"
        force_refresh = request.args.get('refresh') == '1'
        if force_refresh:
            metadata_cache.invalidate(cache_key)

        # 1. Eğer zorunlu yenileme istenmediyse ve SQLite cache'inde veri varsa, direkt dön (bağlantı deneme!)
        cached_val = ds.get('cached_tables')
        if cached_val and not force_refresh:
            try:
                tables = json.loads(cached_val)
                metadata_cache.set(cache_key, tables)
                return jsonify({"success": True, "data": tables})
            except Exception:
                pass

        # 2. Eğer cache yoksa veya zorunlu yenileme ise bağlantı kurmayı dene
        try:
            tables = get_tables(ds)
            # Başarılı olursa SQLite cache'ine kaydet
            _update_datasource_cached_tables(ds_id, tables)
            metadata_cache.set(cache_key, tables)
            return jsonify({"success": True, "data": tables})
        except Exception as conn_err:
            # 3. Eğer bağlantı başarısız olursa ve refresh=1 DEĞİLSE, eski cache varsa onu dön
            if not force_refresh and cached_val:
                try:
                    tables = json.loads(cached_val)
                    logger.warning(f"Connection failed to remote database {ds_id}, fallback to cached tables: {conn_err}")
                    return jsonify({"success": True, "data": tables})
                except Exception:
                    pass
            # 4. Eğer refresh=1 ise hatayı fırlat veya cache de yoksa boş dön
            if force_refresh:
                return _err(f"Remote database connection failed: {str(conn_err)}", 400)
            else:
                logger.warning(f"Connection failed and no cache for {ds_id}, returning empty list: {conn_err}")
                return jsonify({"success": True, "data": []})
    except Exception as e:
        logger.exception("Error fetching tables")
        return _err("İç sunucu hatası.", 500)


@app.route('/api/datasources/<ds_id>/tables/<table_name>', methods=['GET'])
def api_get_table_preview(ds_id, table_name):
    try:
        ds = _full_data_source(ds_id)
        if not ds:
            return _err("Data source not found", 404)

        # Sayfalama parametreleri (limit/offset) — güvenli int ayrıştırma.
        limit = request.args.get('limit', default=100, type=int)
        offset = request.args.get('offset', default=0, type=int)
        if limit <= 0 or limit > 1000:
            limit = 100
        if offset < 0:
            offset = 0

        # Şemadan rowCount'u da al (aynı istekte, metadata cache'ten).
        schema = _get_cached_schema(ds, ds_id, table_name)

        # Sayfalı satır verisi (satır verisi ASLA önbelleğe alınmaz).
        result = get_table_preview(ds, table_name, limit=limit, offset=offset)
        result['rowCount'] = schema.get('rowCount')
        result['pageSize'] = limit
        result['offset'] = offset

        return jsonify({"success": True, "data": result})
    except QueryExecutionError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("Error previewing table")
        return _err("İç sunucu hatası.", 500)


def _get_cached_schema(ds: dict, ds_id: str, table_name: str) -> dict:
    """Sütun şemasını RAM TTL cache'ten döndürür (yalnızca metadata)."""
    cache_key = f"schema:{ds_id}:{table_name}"
    schema = metadata_cache.get(cache_key)
    if schema is None:
        schema = get_table_schema(ds, table_name)
        metadata_cache.set(cache_key, schema)
    return schema


@app.route('/api/datasources/<ds_id>/tables/<table_name>/schema', methods=['GET'])
def api_get_table_schema(ds_id, table_name):
    """Tablo şeması (gerçek nullable/tip/PK + rowCount). Cache'li."""
    try:
        ds = _full_data_source(ds_id)
        if not ds:
            return _err("Data source not found", 404)
        schema = _get_cached_schema(ds, ds_id, table_name)
        return jsonify({"success": True, "data": schema})
    except QueryExecutionError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("Error fetching schema")
        return _err("İç sunucu hatası.", 500)


@app.route('/api/datasources/<ds_id>/search-columns', methods=['GET'])
def api_search_columns(ds_id):
    try:
        q = request.args.get('q', default='').strip()
        if not q:
            return jsonify({"success": True, "data": []})
        ds = _full_data_source(ds_id)
        if not ds:
            return _err("Data source not found", 404)
        results = search_columns_in_db(ds, q)
        return jsonify({"success": True, "data": results})
    except Exception as e:
        logger.exception("Error searching columns")
        return _err("İç sunucu hatası.", 500)


@app.route('/api/datasources/<ds_id>/check-relationship', methods=['POST'])
def api_check_relationship(ds_id):
    try:
        body = request.json or {}
        t1 = body.get('t1')
        c1 = body.get('c1')
        t2 = body.get('t2')
        c2 = body.get('c2')
        if not (t1 and c1 and t2 and c2):
            return _err("Missing parameters t1, c1, t2, c2", 400)
        ds = _full_data_source(ds_id)
        if not ds:
            return _err("Data source not found", 404)
        result = check_relationship(ds, t1, c1, t2, c2)
        return jsonify({"success": True, "data": result})
    except Exception as e:
        logger.exception("Error checking relationship")
        return _err("İç sunucu hatası.", 500)


@app.route('/api/datasources/<ds_id>/functions', methods=['GET'])
def api_get_functions(ds_id):
    try:
        ds = _full_data_source(ds_id) or {'type': 'sqlite'}
        results = get_functions(ds)
        return jsonify({"success": True, "data": results})
    except Exception as e:
        logger.exception("Error fetching functions")
        return _err("İç sunucu hatası.", 500)



# ---------------------------------------------------------------------------
# Dashboards — Çoklu dashboard CRUD, ACL paylaşım, kopyalama, varsayılan
# ---------------------------------------------------------------------------

@app.route('/api/dashboards', methods=['GET'])
def list_dashboards():
    """Kullanıcının erişebildiği tüm aktif dashboard'ları listeler (ACL korumalı)."""
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            '''SELECT d.id, d.name, d.description, d.user_id, d.owner_id,
                      u.display_name AS owner_name,
                      d.is_default, d.allowed_roles, d.allowed_users,
                      d.layout, d.is_active, d.created_at, d.updated_at
               FROM dashboards d
               LEFT JOIN users u ON u.id = COALESCE(NULLIF(d.owner_id, ''), d.user_id)
               WHERE d.is_active = 1
               ORDER BY d.is_default DESC, datetime(d.updated_at) DESC''')]
    visible = []
    for r in rows:
        r['owner_id'] = r.get('owner_id') or r.get('user_id') or ''
        if not _can_access_query(r):
            continue
        layout_raw = r.get('layout') or '[]'
        if isinstance(layout_raw, str):
            try:
                layout_list = json.loads(layout_raw)
            except Exception:
                layout_list = []
        else:
            layout_list = layout_raw or []
        widget_count = len(layout_list) if isinstance(layout_list, list) else 0
        visible.append({
            'id': r['id'],
            'name': r['name'],
            'description': r.get('description', '') or '',
            'owner': r['owner_id'],
            'ownerName': r.get('owner_name') or '',
            'isDefault': bool(r.get('is_default')),
            'allowedRoles': json.loads(r.get('allowed_roles') or '[]'),
            'allowedUsers': json.loads(r.get('allowed_users') or '[]'),
            'widgetCount': widget_count,
            'createdAt': r.get('created_at'),
            'updatedAt': r.get('updated_at'),
        })
    return jsonify({"success": True, "data": visible})


@app.route('/api/dashboards/<did>', methods=['GET'])
def get_dashboard(did):
    """Tekil dashboard getirir (layout + ACL; yetki kontrolü)."""
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            '''SELECT d.*, u.display_name AS owner_name
               FROM dashboards d
               LEFT JOIN users u ON u.id = COALESCE(NULLIF(d.owner_id, ''), d.user_id)
               WHERE d.id = ? AND d.is_active = 1''',
            (did,)).fetchone()
    if not row:
        return _err("Dashboard bulunamadı.", 404)
    data = dict(row)
    data['owner_id'] = data.get('owner_id') or data.get('user_id') or ''
    if not _can_access_query(data):
        return _err("Erişim yetkiniz yok.", 403)
    layout = data.get('layout') or '[]'
    if isinstance(layout, str):
        try:
            layout = json.loads(layout)
        except Exception:
            layout = []
    data['layout'] = layout
    data['owner'] = data['owner_id']
    data['isDefault'] = bool(data.get('is_default'))
    data['allowedRoles'] = json.loads(data.get('allowed_roles') or '[]')
    data['allowedUsers'] = json.loads(data.get('allowed_users') or '[]')
    return jsonify({"success": True, "data": data})


@app.route('/api/dashboards', methods=['POST'])
def create_dashboard():
    """Yeni dashboard oluşturur."""
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip() or "Yeni Dashboard"
    description = (body.get('description') or '').strip()
    did = (body.get('id') or '').strip() or ('d_' + uuid.uuid4().hex[:12])
    layout = body.get('layout') or []
    if isinstance(layout, str):
        try:
            layout = json.loads(layout)
        except Exception:
            layout = []
    is_default = 1 if (body.get('is_default') or body.get('isDefault')) else 0
    allowed_roles = body.get('allowedRoles') or body.get('allowed_roles') or []
    allowed_users = body.get('allowedUsers') or body.get('allowed_users') or []
    uid = _user_id()
    now = datetime.now().isoformat()
    db = get_db()
    with db._conn() as conn:
        if is_default:
            conn.execute('UPDATE dashboards SET is_default = 0 WHERE (user_id = ? OR owner_id = ?)', (uid, uid))
        conn.execute(
            '''INSERT INTO dashboards
               (id, user_id, owner_id, name, description, layout, is_default, allowed_roles, allowed_users, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)''',
            (did, uid, uid, name, description, json.dumps(layout, ensure_ascii=False),
             is_default, json.dumps(allowed_roles), json.dumps(allowed_users), now, now)
        )
    _audit('dashboard.create', target=did)
    return jsonify({"success": True, "data": {"id": did, "name": name}}), 201


@app.route('/api/dashboards/<did>', methods=['PUT'])
def update_dashboard(did):
    """Dashboard başlık, açıklama, düzen (layout) veya varsayılanlık durumunu günceller."""
    body = request.get_json(silent=True) or {}
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, user_id, owner_id FROM dashboards WHERE id = ?', (did,)).fetchone()
        if not row:
            return _err("Dashboard bulunamadı.", 404)
        r = dict(row)
        r['owner_id'] = r.get('owner_id') or r.get('user_id') or ''
        if not _can_modify_query(r):
            return _err("Bu dashboard'ı düzenleme yetkiniz yok.", 403)
        
        uid = _user_id()
        now = datetime.now().isoformat()
        
        if 'isDefault' in body or 'is_default' in body:
            is_def_val = 1 if (body.get('isDefault') or body.get('is_default')) else 0
            if is_def_val:
                conn.execute('UPDATE dashboards SET is_default = 0 WHERE (user_id = ? OR owner_id = ?) AND id != ?', (uid, uid, did))
            conn.execute('UPDATE dashboards SET is_default = ? WHERE id = ?', (is_def_val, did))

        updates = []
        params = []
        if 'name' in body:
            updates.append('name = ?')
            params.append((body.get('name') or '').strip() or 'Dashboard')
        if 'description' in body:
            updates.append('description = ?')
            params.append((body.get('description') or '').strip())
        if 'layout' in body:
            layout = body.get('layout') or []
            if isinstance(layout, str):
                try:
                    layout = json.loads(layout)
                except Exception:
                    layout = []
            updates.append('layout = ?')
            params.append(json.dumps(layout, ensure_ascii=False))
            
        if updates:
            updates.append('updated_at = ?')
            params.append(now)
            params.append(did)
            conn.execute(f"UPDATE dashboards SET {', '.join(updates)} WHERE id = ?", params)
        
    _audit('dashboard.update', target=did)
    return jsonify({"success": True, "data": {"id": did}})


@app.route('/api/dashboards/<did>/sharing', methods=['PUT'])
def update_dashboard_sharing(did):
    """Dashboard ACL: allowed_roles / allowed_users (sahip / admin / share:dashboards)."""
    body = request.get_json(silent=True) or {}
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, user_id, owner_id FROM dashboards WHERE id = ?', (did,)).fetchone()
        if not row:
            return _err("Dashboard bulunamadı.", 404)
        r = dict(row)
        r['owner_id'] = r.get('owner_id') or r.get('user_id') or ''
        if not (_can_modify_query(r) or _has_perm('share:dashboards')):
            return _err("Paylaşım düzenleme yetkiniz yok.", 403)
        allowed_roles = body.get('allowedRoles') or body.get('allowed_roles') or []
        allowed_users = body.get('allowedUsers') or body.get('allowed_users') or []
        conn.execute(
            '''UPDATE dashboards SET allowed_roles=?, allowed_users=?, updated_at=datetime('now') WHERE id=?''',
            (json.dumps(allowed_roles), json.dumps(allowed_users), did))
    _audit('dashboard.share', target=did)
    return jsonify({"success": True})


@app.route('/api/dashboards/<did>/duplicate', methods=['POST'])
def duplicate_dashboard(did):
    """Mevcut dashboard'ın bir kopyasını oluşturur."""
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM dashboards WHERE id = ?', (did,)).fetchone()
        if not row:
            return _err("Dashboard bulunamadı.", 404)
        r = dict(row)
        r['owner_id'] = r.get('owner_id') or r.get('user_id') or ''
        if not _can_access_query(r):
            return _err("Erişim yetkiniz yok.", 403)
        new_id = 'd_' + uuid.uuid4().hex[:12]
        new_name = f"{r['name']} (Kopya)"
        uid = _user_id()
        now = datetime.now().isoformat()
        conn.execute(
            '''INSERT INTO dashboards
               (id, user_id, owner_id, name, description, layout, is_default, allowed_roles, allowed_users, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, '[]', '[]', 1, ?, ?)''',
            (new_id, uid, uid, new_name, r.get('description', '') or '', r.get('layout', '[]'), now, now)
        )
    _audit('dashboard.duplicate', target=new_id)
    return jsonify({"success": True, "data": {"id": new_id, "name": new_name}}), 201


@app.route('/api/dashboards/<did>', methods=['DELETE'])
def delete_dashboard(did):
    """Dashboard siler (sahip veya admin)."""
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, user_id, owner_id FROM dashboards WHERE id = ?', (did,)).fetchone()
        if not row:
            return _err("Dashboard bulunamadı.", 404)
        r = dict(row)
        r['owner_id'] = r.get('owner_id') or r.get('user_id') or ''
        if not _can_modify_query(r):
            return _err("Bu dashboard'ı silme yetkiniz yok.", 403)
        cur = conn.execute('DELETE FROM dashboards WHERE id = ?', (did,))
    _audit('dashboard.delete', target=did)
    return jsonify({"success": True, "deleted": cur.rowcount > 0})


@app.route('/api/dashboards/me', methods=['GET'])
def get_my_dashboard():
    """Geriye dönük uyumluluk: aktif/varsayılan dashboard'ı getirir veya oluşturur."""
    db = get_db()
    with db._conn() as conn:
        # 1. Varsayılan dashboard
        row = conn.execute(
            '''SELECT id, name, description, layout, is_default, allowed_roles, allowed_users
               FROM dashboards
               WHERE (user_id = ? OR owner_id = ?) AND is_active = 1 AND is_default = 1
               LIMIT 1''',
            (g.uid, g.uid)).fetchone()
        
        # 2. Kullanıcının en son güncellenen herhangi bir dashboard'u
        if not row:
            row = conn.execute(
                '''SELECT id, name, description, layout, is_default, allowed_roles, allowed_users
                   FROM dashboards
                   WHERE (user_id = ? OR owner_id = ?) AND is_active = 1
                   ORDER BY datetime(updated_at) DESC LIMIT 1''',
                (g.uid, g.uid)).fetchone()
        
        # 3. Yoksa yeni bir varsayılan dashboard oluştur
        if not row:
            new_id = 'd_' + uuid.uuid4().hex[:12]
            now = datetime.now().isoformat()
            conn.execute(
                '''INSERT INTO dashboards
                   (id, user_id, owner_id, name, description, layout, is_default, allowed_roles, allowed_users, is_active, created_at, updated_at)
                   VALUES (?, ?, ?, 'My Dashboard', '', '[]', 1, '[]', '[]', 1, ?, ?)''',
                (new_id, g.uid, g.uid, now, now)
            )
            return jsonify({"success": True, "data": {
                "id": new_id, "name": "My Dashboard", "description": "",
                "layout": [], "isDefault": True, "allowedRoles": [], "allowedUsers": []
            }})
        
        drow = dict(row)
        layout_val = drow.get('layout')
        if isinstance(layout_val, str):
            try:
                layout = json.loads(layout_val) if layout_val else []
            except Exception:
                layout = []
        else:
            layout = layout_val or []

        return jsonify({"success": True, "data": {
            "id": drow['id'],
            "name": drow['name'],
            "description": drow.get('description', '') or '',
            "isDefault": bool(drow.get('is_default')),
            "allowedRoles": json.loads(drow.get('allowed_roles') or '[]'),
            "allowedUsers": json.loads(drow.get('allowed_users') or '[]'),
            "layout": layout
        }})


@app.route('/api/dashboards/me', methods=['PUT'])
def update_my_dashboard():
    """Geriye dönük uyumluluk: aktif/varsayılan dashboard layout'unu günceller."""
    req = request.get_json(silent=True) or {}
    layout = req.get('layout', [])
    
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            '''SELECT id FROM dashboards
               WHERE (user_id = ? OR owner_id = ?) AND is_active = 1
               ORDER BY is_default DESC, datetime(updated_at) DESC LIMIT 1''',
            (g.uid, g.uid)).fetchone()
        now = datetime.now().isoformat()
        
        if not row:
            new_id = 'd_' + uuid.uuid4().hex[:12]
            conn.execute(
                '''INSERT INTO dashboards
                   (id, user_id, owner_id, name, description, layout, is_default, allowed_roles, allowed_users, is_active, created_at, updated_at)
                   VALUES (?, ?, ?, 'My Dashboard', '', ?, 1, '[]', '[]', 1, ?, ?)''',
                (new_id, g.uid, g.uid, json.dumps(layout, ensure_ascii=False), now, now)
            )
        else:
            conn.execute(
                'UPDATE dashboards SET layout = ?, updated_at = ? WHERE id = ?',
                (json.dumps(layout, ensure_ascii=False), now, row['id'])
            )
            
    return jsonify({"success": True})


@app.route('/api/dashboards/<did>/export', methods=['GET'])
def export_dashboard(did):
    """Executive Dashboard anlık durumunu PDF raporu olarak dışa aktarır."""
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            '''SELECT d.*, u.display_name AS owner_name
               FROM dashboards d
               LEFT JOIN users u ON u.id = COALESCE(NULLIF(d.owner_id, ''), d.user_id)
               WHERE d.id = ? AND d.is_active = 1''',
            (did,)).fetchone()
    if not row:
        return _err("Dashboard bulunamadı.", 404)
    data = dict(row)
    data['owner_id'] = data.get('owner_id') or data.get('user_id') or ''
    if not _can_access_query(data):
        return _err("Erişim yetkiniz yok.", 403)
    
    layout = data.get('layout') or '[]'
    if isinstance(layout, str):
        try:
            data['layout'] = json.loads(layout)
        except Exception:
            data['layout'] = []

    from pdf_template_renderer import render_dashboard_to_pdf
    try:
        pdf_bytes = render_dashboard_to_pdf(data)
        slug = re.sub(r'[^a-zA-Z0-9_-]+', '_', data.get('name') or 'Dashboard')
        filename = f"{slug}_Executive_Report_{datetime.now().strftime('%Y%m%d')}.pdf"
        return send_file(
            BytesIO(pdf_bytes),
            mimetype='application/pdf',
            as_attachment=True,
            download_name=filename
        )
    except Exception as exc:
        logger.exception("Dashboard PDF export failed: %s", exc)
        return _err(f"PDF oluşturulamadı: {str(exc)}", 500)


# ---------------------------------------------------------------------------
# Queries (Template Builder sol panel) — saklı SQL sorgular
# ---------------------------------------------------------------------------

@app.route('/api/queries', methods=['GET'])
def list_queries():
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT id, name, description, data_source_id, sql_text, parameters, columns_meta, owner_id, '
            'allowed_roles, allowed_users, is_active, created_at, updated_at '
            'FROM queries ORDER BY name')]
    # RBAC: kullanıcı yalnızca erişebildiği sorguları görür (SQL metni dahil).
    visible = [r for r in rows if _can_access_query(r)]
    return jsonify({"success": True, "data": [_query_to_dict(r) for r in visible]})


@app.route('/api/queries/<qid>', methods=['GET'])
def get_query(qid):
    row = _load_query_row(qid)
    if not row:
        return _err("Query not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this query.", 403)
    return jsonify({"success": True, "data": _query_to_dict(row)})


@app.route('/api/queries', methods=['POST'])
def create_query():
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err("Query name is required.")
    if not body.get('sql') or not str(body['sql']).strip():
        return _err("SQL is required.")
    ds_id = body.get('dataSourceId')
    if not ds_id or not _full_data_source(ds_id):
        return _err("Invalid data source.")

    qid = (body.get('id') or '').strip() or _new_id('q_')
    params = json.dumps(body.get('parameters') or [])
    default_roles = ['admin', 'superuser', 'engineer', 'operator', 'viewer']
    allowed_roles = json.dumps(body.get('allowedRoles') if body.get('allowedRoles') is not None else default_roles)
    allowed_users = json.dumps(body.get('allowedUsers') or [])

    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO queries (id, name, description, data_source_id, sql_text, parameters, columns_meta, owner_id, allowed_roles, allowed_users, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1)''',
                (qid, name, body.get('description', ''), ds_id, body['sql'], params, _user_id(), allowed_roles, allowed_users))
        except Exception as exc:
            return _err("Sorgu oluşturulamadı (isim benzersiz olmalı).", 409)
    index_saved_example(config, db, 'sql', _load_query_row(qid))
    return jsonify({"success": True, "data": _query_to_dict(_load_query_row(qid))}), 201


@app.route('/api/queries/<qid>', methods=['PUT'])
def update_query(qid):
    body = request.get_json(silent=True) or {}
    existing = _load_query_row(qid)
    if not existing:
        return _err("Query not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to edit this query.", 403)

    name = (body.get('name') or existing['name']).strip()
    sql = body.get('sql', existing['sql_text'])
    ds_id = body.get('dataSourceId', existing['data_source_id'])
    params_raw = body.get('parameters') if body.get('parameters') is not None else json.loads(existing.get('parameters') or '[]')
    roles_raw = body.get('allowedRoles') if body.get('allowedRoles') is not None else json.loads(existing.get('allowed_roles') or '[]')
    users_raw = body.get('allowedUsers') if body.get('allowedUsers') is not None else json.loads(existing.get('allowed_users') or '[]')
    params = json.dumps(params_raw)
    allowed_roles = json.dumps(roles_raw)
    allowed_users = json.dumps(users_raw)

    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE queries SET name=?, description=?, data_source_id=?, sql_text=?, parameters=?, allowed_roles=?, allowed_users=?, updated_at=datetime('now')
               WHERE id=?''',
            (name, body.get('description', existing.get('description', '')), ds_id, sql, params, allowed_roles, allowed_users, qid))
    index_saved_example(config, db, 'sql', _load_query_row(qid))
    return jsonify({"success": True, "data": _query_to_dict(_load_query_row(qid))})


@app.route('/api/queries/<qid>/sharing', methods=['PUT'])
def update_query_sharing(qid):
    """Sorgu ACL: allowed_roles / allowed_users (sahip / admin / share:queries)."""
    body = request.get_json(silent=True) or {}
    existing = _load_query_row(qid)
    if not existing:
        return _err("Query not found.", 404)
    if not (_can_modify_query(existing) or _has_perm('share:queries')):
        return _err("Paylaşım düzenleme yetkiniz yok.", 403)
    allowed_roles = body.get('allowedRoles') or body.get('allowed_roles') or []
    allowed_users = body.get('allowedUsers') or body.get('allowed_users') or []
    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE queries SET allowed_roles=?, allowed_users=?, updated_at=datetime('now') WHERE id=?''',
            (json.dumps(allowed_roles), json.dumps(allowed_users), qid))
    return jsonify({"success": True})


@app.route('/api/queries/<qid>', methods=['DELETE'])
def delete_query(qid):
    existing = _load_query_row(qid)
    if not existing:
        return _err("Query not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to delete this query.", 403)
    db = get_db()
    with db._conn() as conn:
        cur = conn.execute('DELETE FROM queries WHERE id=?', (qid,))
    return jsonify({"success": True, "deleted": cur.rowcount > 0})


@app.route('/api/queries/<qid>/preview', methods=['POST'])
def preview_query(qid):
    """Kayıtlı sorguyu çalıştır (sütun/örnek satır). columns_meta günceller."""
    row = _load_query_row(qid)
    if not row:
        return _err("Query not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to execute this query.", 403)
    body = request.get_json(silent=True) or {}
    ds = _full_data_source(row['data_source_id'])
    try:
        result = execute_query(ds, row['sql_text'], body.get('params') or {}, body.get('limit', 100))
    except QueryExecutionError as exc:
        return _err(str(exc), 422)

    result['name'] = row.get('name') or qid
    result['description'] = row.get('description') or ''
    result['dataSourceId'] = row.get('data_source_id') or ''

    if result.get('columns'):
        cols_json = json.dumps(result['columns'], ensure_ascii=False)
        existing_meta = row.get('columns_meta') or ''
        if getattr(config, 'PERSIST_QUERY_COLUMNS_META', False) or existing_meta in ('', '[]'):
            db = get_db()
            with db._conn() as conn:
                conn.execute('UPDATE queries SET columns_meta=?, updated_at=datetime(\'now\') WHERE id=?',
                             (cols_json, qid))
        metadata_cache.set(f'qcols:{qid}', result['columns'])
    return jsonify({"success": True, "data": result})


@app.route('/api/queries/preview', methods=['POST'])
def preview_adhoc():
    """Kaydetmeden SQL dene (data source + sql gövdesi)."""
    body = request.get_json(silent=True) or {}

    ds_id = body.get('dataSourceId')
    ds = _full_data_source(ds_id) if ds_id else None
    if not ds:
        return _err("Invalid data source.")
    try:
        result = execute_query(ds, body.get('sql', ''), body.get('params') or {}, body.get('limit', 100))
    except QueryExecutionError as exc:
        return _err(str(exc), 422)
    return jsonify({"success": True, "data": result})


@app.route('/api/queries/<qid>/columns', methods=['GET'])
def get_query_columns(qid):
    """Sorgunun sütun listesini döndürür (Widget kolon eşleme dropdown seçicisi için)."""
    row = _load_query_row(qid)
    if not row:
        return _err("Query not found.", 404)
    if not _can_access_query(row):
        return _err("Bu sorgunun sütunlarını görme yetkiniz yok.", 403)
    cols = _query_columns(row)
    if cols:
        col_names = [c['name'] if isinstance(c, dict) else str(c) for c in cols]
        return jsonify({"success": True, "data": col_names})
    # Önbellekte yoksa limit 1 ile hızlıca çalıştırıp sütunları tespit et
    ds = _full_data_source(row['data_source_id'])
    if ds:
        try:
            res = execute_query(ds, row['sql_text'], {}, limit=1)
            raw_cols = res.get('columns') or []
            if raw_cols:
                metadata_cache.set(f'qcols:{qid}', raw_cols)
                col_names = [c['name'] if isinstance(c, dict) else str(c) for c in raw_cols]
                return jsonify({"success": True, "data": col_names})
        except Exception as e:
            logger.warning("Failed to auto-detect columns for query %s: %s", qid, e)
    return jsonify({"success": True, "data": []})


def _collect_sql_data(sql_query_ids: list, filters: dict, bypass_query_acl: bool = False) -> dict:
    """Bağımlı SQL sorgularını çalıştırıp satırları topla.

    Güvenlik: ad-hoc çalıştırmada yalnızca kullanıcının erişebildiği sorguların verisi
    inject edilir (RBAC). Kayıtlı ve paylaşılan script çalıştırılırken (bypass_query_acl=True),
    script'e erişim zaten doğrulanmıştır ve script'in bağlı olduğu sorgular çözülür.
    """
    sql_data = {}
    for q_id in sql_query_ids or []:
        q_row = _load_query_row(q_id)
        if not q_row:
            continue
        if not bypass_query_acl and not _can_access_query(q_row):
            continue
        q_ds = _full_data_source(q_row['data_source_id'])
        if q_ds:
            try:
                q_res = execute_query(q_ds, q_row['sql_text'], filters, 5000)
                sql_data[q_row['name']] = q_res.get('rows', [])
                sql_data[q_row['id']] = q_res.get('rows', [])
            except Exception as e:
                logger.error(f"Error executing dependent query {q_id}: {e}")
    return sql_data


# İzole sandbox ortamı: minimal env, geçici cwd, dosya yazma yok.
_SANDBOX_ENV = {
    'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
    'PYTHONUNBUFFERED': '1',
    'LC_ALL': 'C.UTF-8',
}

# Opsiyonel OS-kullanıcı izolasyonu (Faz 8, defense-in-depth): yorumlayıcı ayrı
# düşük-ayrıcalıklı bir kullanıcı altında koşar. AST sandbox'a ek olarak süreç,
# uygulamanın dosyalarına/anahtarlarına erişemez. Boşsa aynı kullanıcıda koşar.
_SANDBOX_USER = (config.SANDBOX_USER or '').strip()


def _sandbox_argv():
    """Yorumlayıcı süreç komutunu döndür; SANDBOX_USER tanımlıysa onun altında."""
    base = [sys.executable, _INTERPRETER_PATH]
    if not _SANDBOX_USER:
        return base
    # runuser (Linux, root'tan) tercih edilir; yoksa sudo -u. İlki yoksa uyar.
    runuser = shutil.which('runuser')
    if runuser:
        return [runuser, '-u', _SANDBOX_USER, '--'] + base
    sudo = shutil.which('sudo')
    if sudo:
        return [sudo, '-u', _SANDBOX_USER] + base
    logger.warning("NOVA_SANDBOX_USER=%s ayarlı ama runuser/sudo bulunamadı; "
                   "sandbox aynı kullanıcıda koşuyor.", _SANDBOX_USER)
    return base
_INTERPRETER_PATH = os.path.join(_DM_DIR, 'safe_interpreter', 'interpreter.py')


def _run_python_raw(code: str, sql_data: dict, filters: dict):
    """Python kodunu izole subprocess'te çalıştır ve ham sonucu döndür.

    Flask yanıtı üretmez — hem ad-hoc uç nokta hem render motoru kullanır.
    Dönüş: (ok, result) — ok True ise result=datasetler dict'i
    ({'isim': {columns,rows}}); False ise result=hata mesajı (str).
    """
    payload = json.dumps({'code': code, 'queries_data': sql_data, 'filters': filters})
    try:
        with tempfile.TemporaryDirectory(prefix='nov4_sandbox_') as tmpdir:
            if _SANDBOX_USER:
                os.chmod(tmpdir, 0o777)
            result = subprocess.run(
                _sandbox_argv(),
                input=payload, text=True, capture_output=True,
                timeout=10.0, cwd=tmpdir, env=_SANDBOX_ENV, close_fds=True,
            )
        if result.returncode != 0:
            err_msg = result.stdout.strip() or result.stderr.strip() or f"Process exited with code {result.returncode}"
            return False, err_msg
        output_json = json.loads(result.stdout)
        if not output_json.get('success'):
            return False, output_json.get('error', 'Unknown execution error')
        return True, output_json.get('results', {})
    except subprocess.TimeoutExpired:
        return False, "Python execution timed out (maximum 10 seconds)."
    except Exception as exc:
        logger.exception("Sandbox execution failed")
        return False, f"Interpreter execution failed: {exc}"


def _run_sandboxed_python(code: str, sql_data: dict, filters: dict):
    """Python kodunu izole subprocess'te çalıştır → Flask yanıtı.

    render motoru dahili olarak _run_python_raw'u kullanır."""
    ok, result = _run_python_raw(code, sql_data, filters)
    if not ok:
        return _err(result, 400)
    return jsonify({"success": True, "data": result})


def _can_use_python_workspace() -> bool:
    return (
        getattr(g, 'role', None) in ('admin', 'superuser', 'engineer')
        or _has_perm('page:python-workspace')
        or _user_level() >= ROLE_LEVELS.get('engineer', 60)
    )


@app.route('/api/python/run', methods=['POST'])
def run_python_adhoc():
    """Ayrı Python Workspace sayfası için ad-hoc Python çalıştırma.

    Gövde: { code, sqlQueryIds, params } veya kayıtlı script için { scriptId }.
    Bağımlı SQL sorguları (yalnızca kullanıcının erişebildikleri) sql_data olarak
    inject edilir; kod izole sandbox'ta koşar. Satır verisi önbelleğe alınmaz.
    """
    body = request.get_json(silent=True) or {}
    saved_sid = (body.get('scriptId') or body.get('script_id') or '').strip()
    code = body.get('code', '')
    if saved_sid and not str(code).strip():
        return run_saved_python_script(saved_sid)
    if not _can_use_python_workspace():
        return _err("You do not have permission to run ad-hoc Python code.", 403)
    if not str(code).strip():
        return _err("Python code is empty.", 400)
    sql_query_ids = body.get('sqlQueryIds', []) or []
    filters = body.get('params') or body.get('filters') or {}
    sql_data = _collect_sql_data(sql_query_ids, filters)
    return _run_sandboxed_python(code, sql_data, filters)


# ---------------------------------------------------------------------------
# Python Scripts (Python Workspace)
# ---------------------------------------------------------------------------

def _load_script_row(sid: str):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            'SELECT id, name, description, code, sql_query_ids, owner_id, '
            'allowed_roles, allowed_users, created_at, updated_at FROM python_scripts WHERE id = ?', (sid,)).fetchone()
    return dict(row) if row else None


def _extract_script_dataset_names(code: str) -> list:
    """Script içindeki out('dataset_name', ...) çağrılarını statik olarak tespit eder."""
    if not code:
        return []
    found = []
    for m in re.finditer(r"""\bout\s*\(\s*['"]([^'"]+)['"]""", code):
        ds_name = m.group(1).strip()
        if ds_name and ds_name not in found:
            found.append(ds_name)
    return found


def _script_to_dict(row: dict) -> dict:
    sid = row['id']
    cached_meta = metadata_cache.get(f"pycols:{sid}") or []
    ds_names = _extract_script_dataset_names(row.get('code') or '')
    return {
        'id': sid,
        'name': row['name'],
        'description': row.get('description', ''),
        'code': row['code'],
        'sqlQueryIds': json.loads(row.get('sql_query_ids') or '[]'),
        'datasetNames': ds_names,
        'datasetsMeta': cached_meta,
        'owner': row.get('owner_id', ''),
        'allowedRoles': json.loads(row.get('allowed_roles') or '[]'),
        'allowedUsers': json.loads(row.get('allowed_users') or '[]'),
        'createdAt': row.get('created_at', ''),
        'updatedAt': row.get('updated_at', ''),
    }


@app.route('/api/python/scripts', methods=['GET'])
def list_scripts():
    """Kullanıcının erişim yetkisi olan kayıtlı Python script'lerini listeler.
    (Dashboard, Template Builder, Query Viewer ve Python Workspace tarafından kullanılır.)
    """
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT id, name, description, code, sql_query_ids, owner_id, '
            'allowed_roles, allowed_users, is_active, created_at, updated_at '
            'FROM python_scripts WHERE is_active = 1 ORDER BY name')]
    visible = [r for r in rows if _can_access_query(r)]
    return jsonify({"success": True, "data": [_script_to_dict(r) for r in visible]})


@app.route('/api/python/scripts/<sid>', methods=['GET'])
def get_script(sid):
    row = _load_script_row(sid)
    if not row:
        return _err("Script not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this script.", 403)
    return jsonify({"success": True, "data": _script_to_dict(row)})


@app.route('/api/python/scripts', methods=['POST'])
def create_script():
    if not _can_use_python_workspace():
        return _err("You do not have permission to create Python scripts.", 403)
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err("Script name is required.")
    if not body.get('code') or not str(body['code']).strip():
        return _err("Code is required.")

    sid = (body.get('id') or '').strip() or _new_id('ps_')
    sql_query_ids = json.dumps(body.get('sqlQueryIds') or [])
    default_roles = ['admin', 'superuser', 'engineer', 'operator', 'viewer']
    allowed_roles = json.dumps(body.get('allowedRoles') if body.get('allowedRoles') is not None else default_roles)
    allowed_users = json.dumps(body.get('allowedUsers') or [])

    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO python_scripts (id, name, description, code, sql_query_ids, owner_id, allowed_roles, allowed_users, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)''',
                (sid, name, body.get('description', ''), body['code'], sql_query_ids, _user_id(), allowed_roles, allowed_users))
        except Exception as exc:
            return _err("Script oluşturulamadı (isim benzersiz olmalı).", 409)
    index_saved_example(config, db, 'python', _load_script_row(sid))
    return jsonify({"success": True, "data": _script_to_dict(_load_script_row(sid))}), 201


@app.route('/api/python/scripts/<sid>', methods=['PUT'])
def update_script(sid):
    if not _can_use_python_workspace():
        return _err("You do not have permission to edit Python scripts.", 403)
    body = request.get_json(silent=True) or {}
    existing = _load_script_row(sid)
    if not existing:
        return _err("Script not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to edit this script.", 403)

    name = (body.get('name') or existing['name']).strip()
    code = body.get('code', existing['code'])
    sqids_raw = body.get('sqlQueryIds') if body.get('sqlQueryIds') is not None else json.loads(existing.get('sql_query_ids') or '[]')
    roles_raw = body.get('allowedRoles') if body.get('allowedRoles') is not None else json.loads(existing.get('allowed_roles') or '[]')
    users_raw = body.get('allowedUsers') if body.get('allowedUsers') is not None else json.loads(existing.get('allowed_users') or '[]')
    sql_query_ids = json.dumps(sqids_raw)
    allowed_roles = json.dumps(roles_raw)
    allowed_users = json.dumps(users_raw)

    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE python_scripts SET name=?, description=?, code=?, sql_query_ids=?, allowed_roles=?, allowed_users=?, updated_at=datetime('now')
               WHERE id=?''',
            (name, body.get('description', existing.get('description', '')), code, sql_query_ids, allowed_roles, allowed_users, sid))
    metadata_cache.invalidate(f"pycols:{sid}")
    index_saved_example(config, db, 'python', _load_script_row(sid))
    return jsonify({"success": True, "data": _script_to_dict(_load_script_row(sid))})


@app.route('/api/python/scripts/<sid>/sharing', methods=['PUT'])
def update_script_sharing(sid):
    """Python Script ACL: allowed_roles / allowed_users (sahip / admin / share:python_scripts)."""
    body = request.get_json(silent=True) or {}
    existing = _load_script_row(sid)
    if not existing:
        return _err("Script not found.", 404)
    if not (_can_modify_query(existing) or _has_perm('share:python_scripts')):
        return _err("Paylaşım düzenleme yetkiniz yok.", 403)
    allowed_roles = body.get('allowedRoles') or body.get('allowed_roles') or []
    allowed_users = body.get('allowedUsers') or body.get('allowed_users') or []
    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE python_scripts SET allowed_roles=?, allowed_users=?, updated_at=datetime('now') WHERE id=?''',
            (json.dumps(allowed_roles), json.dumps(allowed_users), sid))
    return jsonify({"success": True})


@app.route('/api/python/scripts/<sid>', methods=['DELETE'])
def delete_script(sid):
    if not _can_use_python_workspace():
        return _err("You do not have permission to delete Python scripts.", 403)
    existing = _load_script_row(sid)
    if not existing:
        return _err("Script not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to delete this script.", 403)
    db = get_db()
    with db._conn() as conn:
        cur = conn.execute('DELETE FROM python_scripts WHERE id=?', (sid,))
    return jsonify({"success": True, "deleted": cur.rowcount > 0})


@app.route('/api/python/scripts/<sid>/run', methods=['POST', 'GET'])
def run_saved_python_script(sid):
    """Kayıtlı Python script'ini izole sandbox'ta çalıştır → widget / önizleme verisi.

    Nesne-seviyesi ACL (_can_access_query) ile korunur; paylaşılan script'ler
    operatör/viewer dahil yetkili tüm kullanıcıların dashboard ve raporlarında çalışır.
    """
    row = _load_script_row(sid)
    if not row:
        return _err("Script not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to run this script.", 403)
    body = request.get_json(silent=True) or {}
    filters = body.get('params') or body.get('filters') or {}
    requested_ds = (body.get('dataset') or request.args.get('dataset') or '').strip()

    t0 = datetime.now()
    sql_data = _collect_sql_data(json.loads(row.get('sql_query_ids') or '[]'), filters, bypass_query_acl=True)
    ok, result = _run_python_raw(row['code'], sql_data, filters)
    exec_ms = int((datetime.now() - t0).total_seconds() * 1000)
    if not ok:
        return _err(str(result), 422)

    # result: {'dataset_adı': {'columns': [...], 'rows': [...]}, ...}
    rows, columns, dataset_name = [], [], ''
    datasets_meta = []
    normalized_datasets = {}
    if isinstance(result, dict) and result:
        for ds_k, ds_v in result.items():
            ds_obj = ds_v or {}
            ds_rows = ds_obj.get('rows') or []
            raw_cols = ds_obj.get('columns') or (list(ds_rows[0].keys()) if ds_rows else [])
            col_objs = [c if isinstance(c, dict) else {'name': str(c), 'dataType': 'string'} for c in raw_cols]
            normalized_datasets[str(ds_k)] = {
                'columns': col_objs,
                'rows': ds_rows,
                'totalRows': len(ds_rows),
                'truncated': False,
                'executionMs': exec_ms,
            }
            datasets_meta.append({'name': str(ds_k), 'columns': col_objs, 'rowCount': len(ds_rows)})

        metadata_cache.set(f"pycols:{sid}", datasets_meta)
        chosen_key = requested_ds if (requested_ds and requested_ds in normalized_datasets) else next(iter(normalized_datasets))
        chosen = normalized_datasets[chosen_key]
        rows = chosen['rows']
        columns = chosen['columns']
        dataset_name = chosen_key

    return jsonify({
        "success": True,
        "status": "success",
        "data": {
            "id": sid,
            "rows": rows,
            "columns": columns,
            "totalRows": len(rows),
            "datasetName": dataset_name,
            "datasetNames": list(normalized_datasets.keys()),
            "datasets": normalized_datasets,
            "source": "python",
            "name": row.get('name') or dataset_name or 'Python Script',
            "description": row.get('description') or '',
            "executionMs": exec_ms,
        }
    })


@app.route('/api/python/scripts/<sid>/columns', methods=['GET'])
def get_script_columns(sid):
    """Python script'inin ürettiği sütun listesini döndürür (Widget kolon eşleme & Template Builder için)."""
    row = _load_script_row(sid)
    if not row:
        return _err("Script not found.", 404)
    if not _can_access_query(row):
        return _err("Yetkiniz yok.", 403)
    requested_ds = (request.args.get('dataset') or '').strip()
    cached = metadata_cache.get(f"pycols:{sid}")
    if not cached:
        sql_data = _collect_sql_data(json.loads(row.get('sql_query_ids') or '[]'), {}, bypass_query_acl=True)
        ok, result = _run_python_raw(row['code'], sql_data, {})
        if ok and isinstance(result, dict):
            cached = []
            for ds_k, ds_v in result.items():
                ds_rows = (ds_v or {}).get('rows') or []
                raw_cols = (ds_v or {}).get('columns') or (list(ds_rows[0].keys()) if ds_rows else [])
                col_objs = [c if isinstance(c, dict) else {'name': str(c), 'dataType': 'string'} for c in raw_cols]
                cached.append({'name': str(ds_k), 'columns': col_objs, 'rowCount': len(ds_rows)})
            metadata_cache.set(f"pycols:{sid}", cached)
    if cached:
        target = next((d for d in cached if d['name'] == requested_ds), cached[0])
        col_names = [c['name'] if isinstance(c, dict) else str(c) for c in (target.get('columns') or [])]
        return jsonify({"success": True, "data": col_names, "datasets": cached})
    return jsonify({"success": True, "data": [], "datasets": []})


# ---------------------------------------------------------------------------
# Templates (Excel-benzeri grid şablon)
# ---------------------------------------------------------------------------

@app.route('/api/templates', methods=['GET'])
def list_templates():
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT id, name, description, owner_id, allowed_roles, allowed_users, '
            'version, is_active, created_at, updated_at '
            'FROM report_templates ORDER BY datetime(updated_at) DESC')]
    visible = []
    for r in rows:
        # _can_access_query generic'tir: owner_id/allowed_roles/allowed_users okur.
        if not _can_access_query(r):
            continue
        r['owner'] = r.pop('owner_id', '')
        r['allowedRoles'] = json.loads(r.pop('allowed_roles', '[]') or '[]')
        r['allowedUsers'] = json.loads(r.pop('allowed_users', '[]') or '[]')
        visible.append(r)
    return jsonify({"success": True, "data": visible})


@app.route('/api/templates/<tid>', methods=['GET'])
def get_template(tid):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM report_templates WHERE id=?', (tid,)).fetchone()
    if not row:
        return _err("Template not found.", 404)
    if not _can_access_query(dict(row)):
        return _err("Erişim yetkiniz yok.", 403)
    data = dict(row)
    data['model'] = json.loads(data.get('model') or '{}')
    data['owner'] = data.pop('owner_id', '')
    data['allowedRoles'] = json.loads(data.pop('allowed_roles', '[]') or '[]')
    data['allowedUsers'] = json.loads(data.pop('allowed_users', '[]') or '[]')
    return jsonify({"success": True, "data": data})


@app.route('/api/templates', methods=['POST'])
def create_template():
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip() or "Untitled Template"
    tid = (body.get('id') or '').strip() or _new_id('tpl_')
    model = body.get('model') if body.get('model') is not None else (body.get('design') or {})
    if isinstance(model, str):
        model = json.loads(model)
    default_roles = ['admin', 'superuser', 'engineer', 'operator', 'viewer']
    allowed_roles = body.get('allowedRoles') if body.get('allowedRoles') is not None else (body.get('allowed_roles') if body.get('allowed_roles') is not None else default_roles)
    allowed_users = body.get('allowedUsers') or body.get('allowed_users') or []
    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO report_templates (id, name, description, model, owner_id, allowed_roles, allowed_users, version, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)''',
                (tid, name, body.get('description', ''), json.dumps(model, ensure_ascii=False),
                 _user_id(), json.dumps(allowed_roles), json.dumps(allowed_users)))
        except Exception as exc:
            return _err("Template oluşturulamadı (isim benzersiz olmalı).", 409)
    return jsonify({"success": True, "data": {"id": tid, "name": name}}), 201


@app.route('/api/templates/<tid>', methods=['PUT'])
def update_template(tid):
    body = request.get_json(silent=True) or {}
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, owner_id FROM report_templates WHERE id=?', (tid,)).fetchone()
        if not row:
            return _err("Template not found.", 404)
        if not _can_modify_query(dict(row)):
            return _err("Bu template'ı düzenleme yetkiniz yok.", 403)
        model = body.get('model')
        if model is None:
            conn.execute(
                '''UPDATE report_templates SET name=?, description=?, updated_at=datetime('now') WHERE id=?''',
                (body.get('name'), body.get('description'), tid))
        else:
            if isinstance(model, str):
                model = json.loads(model)
            conn.execute(
                '''UPDATE report_templates SET name=?, description=?, model=?, version=version+1, updated_at=datetime('now') WHERE id=?''',
                (body.get('name'), body.get('description'), json.dumps(model, ensure_ascii=False), tid))
    return jsonify({"success": True, "data": {"id": tid}})


@app.route('/api/templates/<tid>/sharing', methods=['PUT'])
def update_template_sharing(tid):
    """Template ACL: allowed_roles / allowed_users (sahip / admin / share:templates)."""
    body = request.get_json(silent=True) or {}
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, owner_id FROM report_templates WHERE id=?', (tid,)).fetchone()
        if not row:
            return _err("Template not found.", 404)
        if not (_can_modify_query(dict(row)) or _has_perm('share:templates')):
            return _err("Paylaşım düzenleme yetkiniz yok.", 403)
        allowed_roles = body.get('allowedRoles') or body.get('allowed_roles') or []
        allowed_users = body.get('allowedUsers') or body.get('allowed_users') or []
        conn.execute(
            '''UPDATE report_templates SET allowed_roles=?, allowed_users=?, updated_at=datetime('now') WHERE id=?''',
            (json.dumps(allowed_roles), json.dumps(allowed_users), tid))
    return jsonify({"success": True})


@app.route('/api/templates/<tid>', methods=['DELETE'])
def delete_template(tid):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, owner_id FROM report_templates WHERE id=?', (tid,)).fetchone()
        if not row:
            return _err("Template not found.", 404)
        if not _can_modify_query(dict(row)):
            return _err("Bu template'ı silme yetkiniz yok.", 403)
        cur = conn.execute('DELETE FROM report_templates WHERE id=?', (tid,))
    return jsonify({"success": True, "deleted": cur.rowcount > 0})


def _resolve_python_dataset(ref: str, params_by_query: dict) -> dict:
    """'py:<scriptId>:<datasetName>' veya 'py:<scriptId>' başvurusunu sandbox'ta çalıştırıp dataseti döndürür.

    Güvenlik: script görünürlüğü (_can_access_query). Erişim yoksa/hata verirse
    sessizce boş dataset döner → render asla patlamaz, sadece o hücre boş kalır.
    """
    parts = ref.split(':', 2)
    if len(parts) < 2:
        return {"columns": [], "rows": []}
    script_id = parts[1].strip()
    ds_name = parts[2].strip() if len(parts) > 2 else ''
    row = _load_script_row(script_id)
    if not row or not _can_access_query(row):
        return {"columns": [], "rows": []}
    sql_data = _collect_sql_data(
        json.loads(row.get('sql_query_ids') or '[]'),
        params_by_query.get(ref, {}),
        bypass_query_acl=True,
    )
    ok, datasets = _run_python_raw(row['code'], sql_data, {})
    if not ok or not isinstance(datasets, dict) or not datasets:
        logger.warning("Template Python script error (%s): %s", ref, datasets)
        return {"columns": [], "rows": []}
    if ds_name and ds_name in datasets:
        chosen = datasets[ds_name] or {}
    else:
        chosen = datasets[next(iter(datasets))] or {}
    rows = chosen.get('rows') or []
    raw_cols = chosen.get('columns') or (list(rows[0].keys()) if rows else [])
    cols = [c if isinstance(c, dict) else {'name': str(c), 'dataType': 'string'} for c in raw_cols]
    return {"columns": cols, "rows": rows, "name": row.get('name') or script_id}


def _execute_template_queries(model: dict, params_by_query: dict):
    """Şablon modelinde başvurulan tüm SQL sorgularını ve Python scriptlerini CANLI çalıştırır."""
    query_ids = set()
    for sheet in model.get('sheets', []):
        for cell in (sheet.get('cells') or {}).values():
            b = cell.get('binding') or {}
            if b.get('queryId'):
                query_ids.add(b['queryId'])
        for band in (sheet.get('bands') or []):
            if band.get('queryId'):
                query_ids.add(band['queryId'])
        for chart in (sheet.get('charts') or []):
            if chart.get('queryId'):
                query_ids.add(chart['queryId'])

    sql_ids = {qid for qid in query_ids if not qid.startswith('py:')}
    py_refs = {qid for qid in query_ids if qid.startswith('py:')}

    query_results = {}
    query_stats = []

    for qid in sorted(sql_ids):
        t0 = datetime.now()
        q = _load_query_row(qid)
        if not q or not _can_access_query(q):
            query_results[qid] = {"columns": [], "rows": []}
            query_stats.append({"queryId": qid, "name": qid, "kind": "sql", "rowCount": 0, "executionMs": 0, "error": "Query not found or inaccessible"})
            continue
        ds = _full_data_source(q['data_source_id'])
        try:
            res = execute_query(ds, q['sql_text'], params_by_query.get(qid, {}), 5000)
            ms = int((datetime.now() - t0).total_seconds() * 1000)
            query_results[qid] = res
            query_stats.append({
                "queryId": qid,
                "name": q.get('name') or qid,
                "description": q.get('description') or '',
                "kind": "sql",
                "rowCount": len(res.get('rows') or []),
                "executionMs": ms,
            })
        except Exception as exc:
            logger.warning("Query error (%s): %s", qid, exc)
            query_results[qid] = {"columns": [], "rows": []}
            query_stats.append({
                "queryId": qid,
                "name": q.get('name') or qid,
                "kind": "sql",
                "rowCount": 0,
                "executionMs": 0,
                "error": str(exc),
            })

    for ref in sorted(py_refs):
        t0 = datetime.now()
        res = _resolve_python_dataset(ref, params_by_query)
        ms = int((datetime.now() - t0).total_seconds() * 1000)
        query_results[ref] = res
        query_stats.append({
            "queryId": ref,
            "name": res.get('name') or ref,
            "kind": "python",
            "rowCount": len(res.get('rows') or []),
            "executionMs": ms,
        })

    return query_results, query_stats


@app.route('/api/templates/evaluate', methods=['POST'])
def evaluate_template_adhoc():
    """Şablon modelini (veya templateId'yi) veritabanı ve Python sandbox üzerinde CANLI çalıştırıp
    tarayıcıda anlık önizleme için genişletilmiş hücre/satır/özet verisini döndürür.
    """
    body = request.get_json(silent=True) or {}
    model = body.get('model')
    tid = (body.get('templateId') or '').strip()
    if not model and tid:
        db = get_db()
        with db._conn() as conn:
            row = conn.execute('SELECT * FROM report_templates WHERE id=?', (tid,)).fetchone()
        if not row:
            return _err("Template not found.", 404)
        if not _can_access_query(dict(row)):
            return _err("Erişim yetkiniz yok.", 403)
        model = json.loads(dict(row).get('model') or '{}')
    if isinstance(model, str):
        model = json.loads(model)
    if not isinstance(model, dict) or not model.get('sheets'):
        return _err("Geçerli bir şablon modeli gerekli.", 400)

    params_by_query = body.get('params') or {}
    max_band_rows = min(max(int(body.get('maxBandRows') or 100), 1), 500)

    query_results, query_stats = _execute_template_queries(model, params_by_query)
    evaluated = _engine.evaluate_model_preview(model, query_results, max_band_rows=max_band_rows)
    evaluated['queryStats'] = query_stats
    return jsonify({"success": True, "data": evaluated})


@app.route('/api/templates/<tid>/evaluate', methods=['POST'])
def evaluate_saved_template(tid):
    """Kayıtlı bir şablonu canlı çalıştırıp JSON önizlemesini döndürür."""
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM report_templates WHERE id=?', (tid,)).fetchone()
    if not row:
        return _err("Template not found.", 404)
    if not _can_access_query(dict(row)):
        return _err("Erişim yetkiniz yok.", 403)
    model = json.loads(dict(row).get('model') or '{}')
    body = request.get_json(silent=True) or {}
    params_by_query = body.get('params') or {}
    max_band_rows = min(max(int(body.get('maxBandRows') or 100), 1), 500)

    query_results, query_stats = _execute_template_queries(model, params_by_query)
    evaluated = _engine.evaluate_model_preview(model, query_results, max_band_rows=max_band_rows)
    evaluated['queryStats'] = query_stats
    return jsonify({"success": True, "data": evaluated})


@app.route('/api/templates/<tid>/render', methods=['POST'])
def render_template(tid):
    """Şablonu çalıştır: bağlı query ve Python script'leri CANLI koş, modeli doldur, .xlsx veya .pdf döndür."""
    fmt = (request.args.get('format') or 'xlsx').lower()
    if fmt not in ('xlsx', 'pdf', 'excel'):
        return _err("Only xlsx and pdf formats are supported for now.", 400)

    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM report_templates WHERE id=?', (tid,)).fetchone()
    if not row:
        return _err("Template not found.", 404)
    if not _can_access_query(dict(row)):
        return _err("Erişim yetkiniz yok.", 403)

    model = json.loads(dict(row).get('model') or '{}')
    body = request.get_json(silent=True) or {}
    params_by_query = body.get('params') or {}

    query_results, _stats = _execute_template_queries(model, params_by_query)

    try:
        out = _engine.render_from_model(model, query_results)
    except Exception as exc:
        logger.exception("Render error")
        return _err("Şablon işlenirken hata oluştu.", 500)

    safe_name = (row['name'] or 'template').replace(' ', '_')

    if fmt == 'pdf':
        try:
            from pdf_template_renderer import render_template_to_pdf
            pdf_bytes = render_template_to_pdf(model, query_results, excel_bytes=out, report_title=row['name'])
            download = f"{safe_name}.pdf"
            return send_file(
                BytesIO(pdf_bytes),
                mimetype="application/pdf",
                as_attachment=True,
                download_name=download,
            )
        except Exception as p_exc:
            logger.exception("PDF render error")
            return _err(f"PDF oluşturulurken hata oluştu: {str(p_exc)}", 500)

    download = f"{safe_name}.xlsx"
    return send_file(
        BytesIO(out),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=download,
    )


# ---------------------------------------------------------------------------
# Path Defs (Path Definer — hiyerarşik navigasyon tanımları)
# ---------------------------------------------------------------------------

_VALID_STRUCTURES = ('tree', 'binary_tree', 'sequence', 'grouped', 'dag', 'multi_level')


def _load_path_row(pid: str):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            'SELECT id, name, description, query_id, structure, config, '
            'owner_id, allowed_roles, allowed_users, materialized, materialized_at, '
            'is_active, created_at, updated_at FROM path_defs WHERE id = ?', (pid,)).fetchone()
    return dict(row) if row else None


def _path_to_dict(row: dict) -> dict:
    return {
        'id': row['id'],
        'name': row['name'],
        'description': row.get('description', ''),
        'queryId': row.get('query_id', ''),
        'structure': row.get('structure', ''),
        'config': json.loads(row.get('config') or '{}'),
        'owner': row.get('owner_id', ''),
        'allowedRoles': json.loads(row.get('allowed_roles') or '[]'),
        'allowedUsers': json.loads(row.get('allowed_users') or '[]'),
        'materialized': json.loads(row['materialized']) if row.get('materialized') else None,
        'materializedAt': row.get('materialized_at', ''),
        'createdAt': row.get('created_at', ''),
        'updatedAt': row.get('updated_at', ''),
    }


def _run_path_query(query_id: str, params: dict = None, limit: int = 5000):
    """Bir path'i besleyen sorguyu veya Python scriptini koş → (rows, columns, error). Erişim dahil."""
    if not query_id:
        return [], [], "Query ID is required."
    if str(query_id).startswith('py:'):
        try:
            ds_out = _resolve_python_dataset(str(query_id), {str(query_id): params or {}})
            rows = (ds_out.get('rows') or [])[:limit]
            cols = [c.get('name') for c in (ds_out.get('columns') or []) if isinstance(c, dict)]
            if not cols and rows:
                cols = list(rows[0].keys())
            return rows, cols, None
        except Exception as exc:
            logger.warning("Path python script error (%s): %s", query_id, exc)
            return [], [], f"Python script error: {exc}"

    q = _load_query_row(query_id)
    if not q:
        return [], [], "Query not found."
    if not _can_access_query(q):
        return [], [], "You do not have permission to access this query."
    ds = _full_data_source(q['data_source_id'])
    if not ds:
        return [], [], "Data source is not configured."
    try:
        result = execute_query(ds, q['sql_text'], params or {}, limit)
        rows = result.get('rows') or []
        cols = [c.get('name') for c in (result.get('columns') or []) if isinstance(c, dict)]
        if not cols and rows:
            cols = list(rows[0].keys())
        return rows, cols, None
    except QueryExecutionError as exc:
        logger.warning("Path query error (%s): %s", query_id, exc)
        return [], [], f"Query error: {exc}"
    except Exception as exc:
        logger.warning("Path query unexpected error (%s): %s", query_id, exc)
        return [], [], f"Query error: {exc}"


def _breadcrumb(nodes: list, path_ids: list) -> list:
    """path id listesini label listesine çevir (okunabilir yol)."""
    by_id = {n['id']: n for n in nodes}
    return [by_id[i]['label'] for i in path_ids if i in by_id]


@app.route('/api/paths', methods=['GET'])
def list_paths():
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT id, name, description, query_id, structure, config, owner_id, '
            'allowed_roles, allowed_users, materialized_at, is_active, created_at, updated_at '
            'FROM path_defs ORDER BY datetime(updated_at) DESC')]
    visible = [r for r in rows if _can_access_query(r)]
    return jsonify({"success": True, "data": [_path_to_dict(r) for r in visible]})


@app.route('/api/paths/<pid>', methods=['GET'])
def get_path(pid):
    row = _load_path_row(pid)
    if not row:
        return _err("Path not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this path.", 403)
    return jsonify({"success": True, "data": _path_to_dict(row)})


@app.route('/api/paths', methods=['POST'])
def create_path():
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to create paths.", 403)
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err("Path name is required.")
    query_id = (body.get('queryId') or '').strip()
    structure = (body.get('structure') or '').strip()
    if structure not in _VALID_STRUCTURES:
        return _err(f"Invalid structure type: {structure}")
    if not query_id:
        return _err("You must select a query.")
    config = body.get('config') or {}
    pid = (body.get('id') or '').strip() or _new_id('pth_')
    default_roles = ['admin', 'superuser', 'engineer', 'operator', 'viewer']
    allowed_roles = json.dumps(body.get('allowedRoles') if body.get('allowedRoles') is not None else default_roles)
    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO path_defs
                   (id, name, description, query_id, structure, config, owner_id,
                    allowed_roles, allowed_users, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)''',
                (pid, name, body.get('description', ''), query_id, structure,
                 json.dumps(config, ensure_ascii=False), _user_id(),
                 allowed_roles,
                 json.dumps(body.get('allowedUsers') or [])))
        except Exception as exc:
            return _err("Path oluşturulamadı.", 409)
    return jsonify({"success": True, "data": _path_to_dict(_load_path_row(pid))}), 201


@app.route('/api/paths/<pid>', methods=['PUT'])
def update_path(pid):
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to edit paths.", 403)
    existing = _load_path_row(pid)
    if not existing:
        return _err("Path not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to edit this path.", 403)
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or existing['name']).strip()
    structure = (body.get('structure') or existing['structure']).strip()
    if structure not in _VALID_STRUCTURES:
        return _err(f"Invalid structure type: {structure}")
    query_id = body.get('queryId') or existing['query_id']
    config = body.get('config')
    config_json = json.dumps(config, ensure_ascii=False) if config is not None else existing['config']
    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE path_defs SET name=?, description=?, query_id=?, structure=?, config=?,
               allowed_roles=?, allowed_users=?, updated_at=datetime('now') WHERE id=?''',
            (name, body.get('description', existing.get('description', '')), query_id, structure,
             config_json,
             json.dumps(body.get('allowedRoles') or json.loads(existing.get('allowed_roles') or '[]')),
             json.dumps(body.get('allowedUsers') or json.loads(existing.get('allowed_users') or '[]')), pid))
    return jsonify({"success": True, "data": _path_to_dict(_load_path_row(pid))})


@app.route('/api/paths/<pid>', methods=['DELETE'])
def delete_path(pid):
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to delete paths.", 403)
    existing = _load_path_row(pid)
    if not existing:
        return _err("Path not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to delete this path.", 403)
    db = get_db()
    with db._conn() as conn:
        cur = conn.execute('DELETE FROM path_defs WHERE id=?', (pid,))
    return jsonify({"success": True, "deleted": cur.rowcount > 0})


@app.route('/api/paths/preview', methods=['POST'])
def preview_path():
    """Kaydetmeden yapı önizlemesi: {queryId, structure, config} → build_structure."""
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to preview paths.", 403)
    body = request.get_json(silent=True) or {}
    structure = (body.get('structure') or '').strip()
    if structure not in _VALID_STRUCTURES:
        return _err(f"Invalid structure type: {structure}")
    rows, cols, err = _run_path_query(body.get('queryId'), body.get('params') or {})
    if err:
        return _err(err, 400)
    built = build_structure(structure, rows, body.get('config') or {})
    return jsonify({"success": True, "data": {"columns": cols, "structure": built}})


@app.route('/api/paths/<pid>/build', methods=['POST'])
def build_path(pid):
    """Path'i canlı koşup materialized cache'e yazar."""
    row = _load_path_row(pid)
    if not row:
        return _err("Path not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this path.", 403)
    can_compile = getattr(g, 'role', None) in ('admin', 'superuser', 'engineer')
    body = request.get_json(silent=True) or {}
    # Büyük hiyerarşilerde kesilme olmasın diye build yüksek satır cap'i kullanır
    # (varsayılan 5000). İstemci body.limit ile geçersiz kılabilir.
    build_limit = int(body.get('limit') or 20000)
    rows, _cols, err = _run_path_query(row['query_id'], body.get('params') or {}, limit=build_limit)
    if err:
        # Canlı sorgu başarısızsa ve önbellek varsa, önbellekten sun
        if row.get('materialized'):
            try:
                cached = json.loads(row['materialized'])
                if isinstance(cached, dict):
                    cached.setdefault('stats', {})['warnings'] = [f"Canlı sorgu hatası ({err}). Önbellekteki hiyerarşi gösteriliyor."]
                    return jsonify({"success": True, "data": cached, "warning": str(err)})
            except Exception:
                pass
        return _err(err, 400)
    built = build_structure(row['structure'], rows, json.loads(row.get('config') or '{}'))
    if can_compile:
        from datetime import datetime as _dt
        stamp = _dt.now().isoformat()
        db = get_db()
        with db._conn() as conn:
            conn.execute(
                "UPDATE path_defs SET materialized=?, materialized_at=?, updated_at=datetime('now') WHERE id=?",
                (json.dumps(built, ensure_ascii=False), stamp, pid))
    return jsonify({"success": True, "data": built})


@app.route('/api/paths/<pid>/search', methods=['POST'])
def search_path(pid):
    """Path içinde terim ara → eşleşen düğümler + breadcrumb yollar."""
    row = _load_path_row(pid)
    if not row:
        return _err("Path not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this path.", 403)
    body = request.get_json(silent=True) or {}
    term = (body.get('term') or '').strip().lower()
    rows, _cols, err = _run_path_query(row['query_id'], body.get('params') or {})
    if err:
        return _err(err, 400)
    built = build_structure(row['structure'], rows, json.loads(row.get('config') or '{}'))
    hits = []
    if term:
        for node in built['nodes']:
            haystacks = [str(node.get('id', '')), str(node.get('label', '')), str(node.get('type', ''))]
            for v in (node.get('row') or {}).values():
                if v is not None:
                    haystacks.append(str(v))
            if any(term in h.lower() for h in haystacks):
                hits.append({
                    'id': node['id'], 'label': node['label'], 'type': node.get('type', ''),
                    'depth': node.get('depth', 0), 'path': node.get('path', []),
                    'breadcrumb': _breadcrumb(built['nodes'], node.get('path', [])),
                })
    return jsonify({"success": True, "data": {"hits": hits, "stats": built['stats']}})


# ---------------------------------------------------------------------------
# High-Frequency Industrial Telemetry Stream (SSE - Server Sent Events)
# ---------------------------------------------------------------------------

@app.route('/api/telemetry/stream', methods=['GET'])
def stream_telemetry():
    """Yüksek hızlı endüstriyel telemetri akışı (Server-Sent Events / SSE).
    Sensör değerlerini (titreşim RMS, hidrolik basınç, tork, sıcaklık, hız, optik güç)
    yüksek frekanslı akış olarak sunar.
    """
    sensor_filter = request.args.get('sensor_id')
    machine_filter = request.args.get('machine_id')

    def event_stream():
        import time
        import random
        db_path = os.path.join(os.path.dirname(__file__), '..', 'db', 'apex_smart_factory_prod.db')
        readings = []
        if os.path.exists(db_path):
            try:
                import sqlite3
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                query = "SELECT reading_id, timestamp, machine_id, sensor_id, metric_name, value, unit, lsl, usl, warning_threshold, alarm_status FROM machine_telemetry_timeseries ORDER BY reading_id DESC LIMIT 150"
                rows = cur.execute(query).fetchall()
                readings = [dict(r) for r in rows]
                conn.close()
            except Exception as e:
                logger.warning("Telemetry db read error: %s", e)

        sensors = [
            {"sensor_id": "SNS-DMG-SPINDLE-VIB", "machine_id": "MCH-DMG-DMC-85", "metric_name": "Spindle Bearing Vibration RMS", "unit": "mm/s", "base": 1.25, "warn": 2.6, "crit": 3.5},
            {"sensor_id": "SNS-SCHULER-HYD-PRESS", "machine_id": "MCH-SCHULER-2500", "metric_name": "Hydraulic Cushion Pressure", "unit": "bar", "base": 220.0, "warn": 260.0, "crit": 280.0},
            {"sensor_id": "SNS-AVL-DYNO-TORQUE", "machine_id": "MCH-AVL-DYNO-400", "metric_name": "Dynamic Shaft Torque", "unit": "Nm", "base": 340.0, "warn": 480.0, "crit": 550.0},
            {"sensor_id": "SNS-TRUMPF-LASER-PWR", "machine_id": "MCH-TRUMPF-LASER-01", "metric_name": "Fiber Laser Optical Power", "unit": "kW", "base": 5.92, "warn": 6.15, "crit": 6.3},
            {"sensor_id": "SNS-AVL-DYNO-SPEED", "machine_id": "MCH-AVL-DYNO-400", "metric_name": "Shaft Angular Speed", "unit": "RPM", "base": 12500.0, "warn": 21000.0, "crit": 24000.0},
            {"sensor_id": "SNS-DMG-SPINDLE-TEMP", "machine_id": "MCH-DMG-DMC-85", "metric_name": "Spindle Ceramic Bearing Temp", "unit": "°C", "base": 42.5, "warn": 60.0, "crit": 72.0},
        ]
        
        idx = 0
        while True:
            now_iso = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
            if readings:
                item = dict(readings[idx % len(readings)])
                idx += 1
                noise = (random.random() - 0.5) * (item.get('value', 1.0) * 0.04)
                item['value'] = round(item.get('value', 0) + noise, 2)
                item['timestamp'] = now_iso
                if sensor_filter and item.get('sensor_id') != sensor_filter:
                    continue
                if machine_filter and item.get('machine_id') != machine_filter:
                    continue
                payload = json.dumps(item)
            else:
                s = random.choice(sensors)
                noise = (random.random() - 0.5) * (s["base"] * 0.08)
                val = round(s["base"] + noise, 2)
                status = "CRITICAL" if val >= s["crit"] else ("WARNING" if val >= s["warn"] else "NORMAL")
                payload = json.dumps({
                    "timestamp": now_iso,
                    "sensor_id": s["sensor_id"],
                    "machine_id": s["machine_id"],
                    "metric_name": s["metric_name"],
                    "value": val,
                    "unit": s["unit"],
                    "warning_threshold": s["warn"],
                    "alarm_status": status
                })
            yield f"data: {payload}\n\n"
            time.sleep(0.5)

    return Response(event_stream(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
    })


# ---------------------------------------------------------------------------
# RBAC yönetim uçları: izin kataloğu, roller, kullanıcı yönetimi, paylaşım.
# Hiyerarşi: çağıran sadece kendi seviyesinden DÜŞÜK kullanıcı/rolleri yönetir.
# ---------------------------------------------------------------------------

_SHARING_TABLES = {
    'templates': ('report_templates', 'share:templates'),
    'paths': ('path_defs', 'share:paths'),
    'queries': ('queries', 'share:queries'),
    'scripts': ('python_scripts', 'share:scripts'),
    'dashboards': ('dashboards', 'share:dashboards'),
}


@app.route('/api/permissions', methods=['GET'])
def get_permission_catalog():
    return jsonify({'success': True, 'data': PERMISSION_CATALOG})


# ---- Roller -----------------------------------------------------------------

@app.route('/api/roles', methods=['GET'])
def list_roles():
    denied = _require_perm('role:view')
    if denied:
        return denied
    me_level = _user_level()
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute('SELECT * FROM roles ORDER BY level DESC, name')]
        counts = {r['role_id']: r['c'] for r in conn.execute(
            "SELECT role_id, COUNT(*) c FROM users WHERE role_id IS NOT NULL AND role_id != '' GROUP BY role_id")}
        perms = {}
        for r in conn.execute('SELECT role_id, permission_key FROM role_permissions'):
            perms.setdefault(r['role_id'], []).append(r['permission_key'])
    result = []
    for row in rows:
        d = _role_to_dict(row, counts.get(row['id'], 0))
        d['permissions'] = sorted(perms.get(row['id'], []))
        d['canManage'] = (row['level'] or 0) < me_level
        result.append(d)
    return jsonify({'success': True, 'data': result})


@app.route('/api/roles', methods=['POST'])
def create_role():
    denied = _require_perm('role:create')
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err('Rol adı zorunludur.', 400)
    key = (body.get('key') or '').strip().lower().replace(' ', '_') or ('role_' + uuid.uuid4().hex[:8])
    try:
        level = int(body.get('level', 20))
    except (TypeError, ValueError):
        return _err('Geçersiz seviye.', 400)
    if not _can_manage_level(level):
        return _err('Sadece kendi seviyenizden düşük bir rol oluşturabilirsiniz.', 403)
    color = (body.get('color') or '#7C8DB5').strip()
    perms = [p for p in (body.get('permissions') or []) if p in ALL_PERMISSION_KEYS]
    rid = _new_id('r_')
    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO roles (id, key, name, description, level, is_system, is_active, color)
                   VALUES (?, ?, ?, ?, ?, 0, 1, ?)''',
                (rid, key, name, body.get('description', ''), level, color))
        except Exception as exc:
            return _err('Rol oluşturulamadı (anahtar benzersiz olmalı).', 409)
        for p in perms:
            conn.execute('INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)', (rid, p))
    _audit('role.create', target=rid, detail={'key': key, 'name': name})
    return jsonify({'success': True, 'data': {'id': rid, 'key': key, 'name': name}}), 201


@app.route('/api/roles/<rid>', methods=['PUT'])
def update_role(rid):
    denied = _require_perm('role:edit')
    if denied:
        return denied
    row = _load_role_row(rid)
    if not row:
        return _err('Rol bulunamadı.', 404)
    if not _can_manage_level(row['level']):
        return _err('Bu rolü düzenleme yetkiniz yok (seviye çok yüksek).', 403)
    body = request.get_json(silent=True) or {}
    name = body.get('name', row['name'])
    description = body.get('description', row['description'])
    color = body.get('color', row['color'])
    level = row['level']
    # Sistem rollerinin key/level'ı kilitli; özel rollerin seviyesi değişebilir.
    if not row['is_system'] and body.get('level') is not None:
        try:
            new_level = int(body['level'])
        except (TypeError, ValueError):
            return _err('Geçersiz seviye.', 400)
        if not _can_manage_level(new_level):
            return _err('Rol seviyesi kendi seviyenizden düşük olmalı.', 403)
        level = new_level
    perms = body.get('permissions')  # None = dokunma; list = tam seti değiştir
    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE roles SET name=?, description=?, color=?, level=?, updated_at=datetime('now') WHERE id=?''',
            (name, description, color, level, rid))
        if perms is not None:
            conn.execute('DELETE FROM role_permissions WHERE role_id=?', (rid,))
            for p in perms:
                if p in ALL_PERMISSION_KEYS:
                    conn.execute('INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)', (rid, p))
    return jsonify({'success': True, 'data': {'id': rid}})


@app.route('/api/roles/<rid>', methods=['DELETE'])
def delete_role(rid):
    denied = _require_perm('role:delete')
    if denied:
        return denied
    row = _load_role_row(rid)
    if not row:
        return _err('Rol bulunamadı.', 404)
    if row['is_system']:
        return _err('Sistem rolleri silinemez.', 400)
    if not _can_manage_level(row['level']):
        return _err('Bu rolü silme yetkiniz yok.', 403)
    db = get_db()
    with db._conn() as conn:
        cnt = conn.execute('SELECT COUNT(*) c FROM users WHERE role_id=?', (rid,)).fetchone()['c']
        if cnt > 0:
            return _err(f'Bu role atanmış {cnt} kullanıcı var; önce kullanıcıları başka role taşıyın.', 409)
        conn.execute('DELETE FROM roles WHERE id=?', (rid,))
    _audit('role.delete', target=rid)
    return jsonify({'success': True, 'deleted': True})


# ---- Kullanıcı yönetimi -----------------------------------------------------

@app.route('/api/admin/users', methods=['GET'])
def admin_list_users():
    denied = _require_perm('user:view')
    if denied:
        return denied
    me_level = _user_level()
    me_id = _user_id()
    db = get_db()
    with db._conn() as conn:
        users = [dict(r) for r in conn.execute(
            '''SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_id, u.is_active,
                      u.created_at, u.updated_at, r.key AS role_key, r.name AS role_name,
                      r.level, r.color AS role_color
               FROM users u LEFT JOIN roles r ON r.id = u.role_id
               ORDER BY r.level DESC, u.username''')]
    for u in users:
        u['displayName'] = u.pop('display_name', '')
        u['roleId'] = u.pop('role_id', '')
        u['roleKey'] = u.pop('role_key', '')
        u['roleName'] = u.pop('role_name', '')
        u['isActive'] = bool(u.pop('is_active', 1))
        u['createdAt'] = u.pop('created_at', '')
        u['updatedAt'] = u.pop('updated_at', '')
        u['canManage'] = (u.get('level') or 0) < me_level and u['id'] != me_id
    return jsonify({'success': True, 'data': users})


@app.route('/api/admin/users/<uid>', methods=['GET'])
def admin_get_user(uid):
    denied = _require_perm('user:view')
    if denied:
        return denied
    if g.uid != uid and not _can_manage_user(uid) and not _is_admin():
        return _err('Unauthorized.', 403)
    db = get_db()
    with db._conn() as conn:
        u = conn.execute(
            '''SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_id, u.is_active,
                      u.created_at, u.updated_at, r.key AS role_key, r.name AS role_name,
                      r.level, r.color AS role_color
               FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?''', (uid,)).fetchone()
        if not u:
            return _err('User not found.', 404)
        u = dict(u)
        perms = sorted(_compute_effective_permissions(uid))
        overrides = [dict(r) for r in conn.execute(
            'SELECT permission_key, granted FROM user_permissions WHERE user_id=?', (uid,))]
        counts = {
            'templates': conn.execute('SELECT COUNT(*) c FROM report_templates WHERE owner_id=?', (uid,)).fetchone()['c'],
            'paths': conn.execute('SELECT COUNT(*) c FROM path_defs WHERE owner_id=?', (uid,)).fetchone()['c'],
            'queries': conn.execute('SELECT COUNT(*) c FROM queries WHERE owner_id=?', (uid,)).fetchone()['c'],
            'scripts': conn.execute('SELECT COUNT(*) c FROM python_scripts WHERE owner_id=?', (uid,)).fetchone()['c'],
            'dashboards': conn.execute('SELECT COUNT(*) c FROM dashboards WHERE (owner_id=? OR user_id=?) AND is_active=1', (uid, uid)).fetchone()['c'],
        }
    u['permissions'] = perms
    u['allowedPages'] = sorted(p.split(':', 1)[1] for p in perms if p.startswith('page:'))
    u['overrides'] = overrides
    u['ownedCounts'] = counts
    u['canManage'] = (u.get('level') or 0) < _user_level() and u['id'] != _user_id()
    return jsonify({'success': True, 'data': u})


@app.route('/api/admin/users', methods=['POST'])
def admin_create_user():
    denied = _require_perm('user:create')
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    username = (body.get('username') or '').strip()
    password = body.get('password') or ''
    if not username or not password:
        return _err('Kullanıcı adı ve şifre zorunludur.', 400)
    policy_issues = passwords.validate_password_policy(password, username=username)
    if policy_issues:
        return _err(' '.join(policy_issues), 400)
    role_id = (body.get('role_id') or body.get('roleId') or '').strip()
    role_row = _load_role_row(role_id) if role_id else None
    if not role_row:
        return _err('Geçerli bir rol seçin.', 400)
    if not _can_manage_level(role_row['level']):
        return _err('Bu rolü atayamazsınız (seviye çok yüksek).', 403)
    display_name = (body.get('display_name') or body.get('displayName') or '').strip()
    email = (body.get('email') or '').strip()
    is_active = 1 if body.get('is_active', body.get('isActive', True)) else 0
    pw_hash = passwords.hash_password(password)  # argon2id; tuz PHC içinde (salt='')
    uid = _new_id('u_')
    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO users (id, username, display_name, email, password_hash, password_salt, role, role_id, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (uid, username, display_name, email, pw_hash, '', role_row['key'], role_id, is_active))
        except Exception as exc:
            return _err('Kullanıcı oluşturulamadı (kullanıcı adı benzersiz olmalı).', 409)
    _audit('user.create', target=uid, detail={'username': username})
    return jsonify({'success': True, 'data': {'id': uid, 'username': username}}), 201


@app.route('/api/admin/users/<uid>', methods=['PUT'])
def admin_update_user(uid):
    denied = _require_perm('user:edit')
    if denied:
        return denied
    if not _can_manage_user(uid):
        return _err('Bu kullanıcıyı düzenleme yetkiniz yok.', 403)
    body = request.get_json(silent=True) or {}
    sets, params = [], []
    dn = body.get('display_name', body.get('displayName'))
    if dn is not None:
        sets.append('display_name=?'); params.append(dn)
    if 'email' in body:
        sets.append('email=?'); params.append(body['email'] or '')
    ia = body.get('is_active', body.get('isActive'))
    if ia is not None:
        sets.append('is_active=?'); params.append(1 if ia else 0)
    role_id = body.get('role_id', body.get('roleId'))
    if role_id is not None:
        role_row = _load_role_row(role_id) if role_id else None
        if not role_row:
            return _err('Geçersiz rol.', 400)
        if not _can_manage_level(role_row['level']):
            return _err('Bu rolü atayamazsınız (seviye çok yüksek).', 403)
        sets.append('role_id=?'); params.append(role_id)
        sets.append('role=?'); params.append(role_row['key'])
    if not sets:
        return _err('Güncellenecek alan yok.', 400)
    sets.append("updated_at=datetime('now')")
    params.append(uid)
    db = get_db()
    with db._conn() as conn:
        cur = conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", params)
        if cur.rowcount == 0:
            return _err('User not found.', 404)
        if ia is not None and not ia:
            conn.execute('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?', (uid,))
    return jsonify({'success': True})


@app.route('/api/admin/users/<uid>', methods=['DELETE'])
def admin_delete_user(uid):
    denied = _require_perm('user:delete')
    if denied:
        return denied
    if not _can_manage_user(uid):
        return _err('Bu kullanıcıyı silme yetkiniz yok.', 403)
    db = get_db()
    with db._conn() as conn:
        conn.execute('DELETE FROM refresh_tokens WHERE user_id=?', (uid,))
        conn.execute('DELETE FROM user_permissions WHERE user_id=?', (uid,))
        cur = conn.execute('DELETE FROM users WHERE id=?', (uid,))
    if cur.rowcount > 0:
        _revoked_user_ids.add(uid)
    _audit('user.delete', target=uid)
    return jsonify({'success': True, 'deleted': cur.rowcount > 0})


@app.route('/api/admin/users/<uid>/password', methods=['PUT'])
def admin_reset_password(uid):
    denied = _require_perm('user:reset-password')
    if denied:
        return denied
    if not _can_manage_user(uid):
        return _err('Yetkiniz yok.', 403)
    body = request.get_json(silent=True) or {}
    password = body.get('password') or ''
    db = get_db()
    with db._conn() as conn:
        urow = conn.execute('SELECT username FROM users WHERE id=?', (uid,)).fetchone()
        if not urow:
            return _err('User not found.', 404)
        policy_issues = passwords.validate_password_policy(password, username=urow['username'])
        if policy_issues:
            return _err(' '.join(policy_issues), 400)
        pw_hash = passwords.hash_password(password)  # argon2id; tuz PHC içinde
        cur = conn.execute(
            "UPDATE users SET password_hash=?, password_salt='', updated_at=datetime('now') WHERE id=?",
            (pw_hash, uid))
    _audit('user.reset_password', target=uid)
    return jsonify({'success': True})


@app.route('/api/admin/users/<uid>/permissions', methods=['PUT'])
def admin_set_user_permissions(uid):
    """Kullanıcı başına izin override'ları (grant/deny). Rol izinlerinin üzerine uygulanır."""
    denied = _require_perm('user:edit')
    if denied:
        return denied
    if not _can_manage_user(uid):
        return _err('Yetkiniz yok.', 403)
    body = request.get_json(silent=True) or {}
    overrides = body.get('overrides') or []
    db = get_db()
    with db._conn() as conn:
        conn.execute('DELETE FROM user_permissions WHERE user_id=?', (uid,))
        for o in overrides:
            key = o.get('permission_key') or o.get('key')
            granted = 1 if o.get('granted', True) else 0
            if key in ALL_PERMISSION_KEYS:
                conn.execute(
                    'INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted) VALUES (?, ?, ?)',
                    (uid, key, granted))
    return jsonify({'success': True})


# ---- Nesne yetkilendirme (paylaşım) ----------------------------------------

@app.route('/api/admin/sharing/<otype>', methods=['GET'])
def admin_list_sharing(otype):
    spec = _SHARING_TABLES.get(otype)
    if not spec:
        return _err('Bilinmeyen nesne tipi.', 400)
    table, perm = spec
    denied = _require_perm(perm)
    if denied:
        return denied
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            f'''SELECT t.id, t.name, t.owner_id, u.display_name AS owner_name,
                       t.allowed_roles, t.allowed_users
                FROM {table} t LEFT JOIN users u ON u.id = t.owner_id
                ORDER BY t.name''')]
    out = []
    for r in rows:
        out.append({
            'id': r['id'], 'name': r['name'],
            'owner': r['owner_id'], 'ownerName': r['owner_name'] or '',
            'allowedRoles': json.loads(r.get('allowed_roles') or '[]'),
            'allowedUsers': json.loads(r.get('allowed_users') or '[]'),
        })
    return jsonify({'success': True, 'data': out})


@app.route('/api/admin/sharing/<otype>/<oid>', methods=['PUT'])
def admin_update_sharing(otype, oid):
    spec = _SHARING_TABLES.get(otype)
    if not spec:
        return _err('Bilinmeyen nesne tipi.', 400)
    table, perm = spec
    denied = _require_perm(perm)
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    allowed_roles = body.get('allowedRoles') or []
    allowed_users = body.get('allowedUsers') or []
    db = get_db()
    with db._conn() as conn:
        cur = conn.execute(
            f"UPDATE {table} SET allowed_roles=?, allowed_users=?, updated_at=datetime('now') WHERE id=?",
            (json.dumps(allowed_roles), json.dumps(allowed_users), oid))
        if cur.rowcount == 0:
            return _err('Nesne bulunamadı.', 404)
    _audit('share.update', target=f'{otype}:{oid}')
    return jsonify({'success': True})


@app.route('/api/admin/audit', methods=['GET'])
def admin_audit_log():
    """Denetim günlüğünü listeler (yalnızca admin/superuser). Filtre: action."""
    if not _is_admin():
        return _err('Yetkisiz.', 403)
    try:
        limit = min(int(request.args.get('limit', 200)), 1000)
        offset = max(int(request.args.get('offset', 0)), 0)
    except ValueError:
        limit, offset = 200, 0
    action = (request.args.get('action') or '').strip()
    db = get_db()
    with db._conn() as conn:
        if action:
            rows = conn.execute(
                "SELECT id,ts,actor_uid,actor_user,action,target,detail,ip,status "
                "FROM audit_log WHERE action=? ORDER BY id DESC LIMIT ? OFFSET ?",
                (action, limit, offset)).fetchall()
        else:
            rows = conn.execute(
                "SELECT id,ts,actor_uid,actor_user,action,target,detail,ip,status "
                "FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?",
                (limit, offset)).fetchall()
    return jsonify({'success': True, 'data': [dict(r) for r in rows]})


# ---------------------------------------------------------------------------
# Report Schedules (Universal Dynamic Report Scheduler)
# ---------------------------------------------------------------------------

@app.route('/api/schedules', methods=['GET'])
def list_schedules():
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT s.*, t.name as template_name '
            'FROM report_schedules s '
            'LEFT JOIN report_templates t ON s.template_id = t.id '
            'ORDER BY datetime(s.updated_at) DESC'
        ).fetchall()]

    visible = []
    for r in rows:
        if not _can_access_query(r):
            continue
        r['allowedRoles'] = json.loads(r.get('allowed_roles') or '[]')
        r['allowedUsers'] = json.loads(r.get('allowed_users') or '[]')
        r['recipients'] = json.loads(r.get('recipients') or '[]')
        r['customWindowConfig'] = json.loads(r.get('custom_window_config') or '{}')
        r['paramsOverride'] = json.loads(r.get('params_override') or '{}')
        visible.append(r)
    return jsonify({"success": True, "data": visible})


@app.route('/api/schedules/<sid>', methods=['GET'])
def get_schedule(sid):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            'SELECT s.*, t.name as template_name '
            'FROM report_schedules s '
            'LEFT JOIN report_templates t ON s.template_id = t.id '
            'WHERE s.id = ?', (sid,)
        ).fetchone()
    if not row:
        return _err("Schedule not found.", 404)
    data = dict(row)
    if not _can_access_query(data):
        return _err("Erişim yetkiniz yok.", 403)
    data['allowedRoles'] = json.loads(data.get('allowed_roles') or '[]')
    data['allowedUsers'] = json.loads(data.get('allowed_users') or '[]')
    data['recipients'] = json.loads(data.get('recipients') or '[]')
    data['customWindowConfig'] = json.loads(data.get('custom_window_config') or '{}')
    data['paramsOverride'] = json.loads(data.get('params_override') or '{}')
    return jsonify({"success": True, "data": data})


@app.route('/api/schedules', methods=['POST'])
def create_schedule():
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err("Schedule name is required.", 400)
    template_id = (body.get('template_id') or body.get('templateId') or '').strip()
    if not template_id:
        return _err("template_id is required.", 400)

    db = get_db()
    with db._conn() as conn:
        tpl = conn.execute('SELECT id FROM report_templates WHERE id=?', (template_id,)).fetchone()
        if not tpl:
            return _err("Referenced template does not exist.", 404)

    sid = (body.get('id') or '').strip() or _new_id('sched_')
    frequency = body.get('frequency', 'daily')
    cron_expr = body.get('cron_expression', '')
    window_type = body.get('window_type', 'yesterday')
    custom_cfg = json.dumps(body.get('custom_window_config') or body.get('customWindowConfig') or {})
    params_override = json.dumps(body.get('params_override') or body.get('paramsOverride') or {})
    output_format = body.get('output_format', 'xlsx')
    recipients = json.dumps(body.get('recipients') or [])
    allowed_roles = json.dumps(body.get('allowedRoles') or body.get('allowed_roles') or [])
    allowed_users = json.dumps(body.get('allowedUsers') or body.get('allowed_users') or [])

    with db._conn() as conn:
        conn.execute(
            '''INSERT INTO report_schedules
               (id, name, description, template_id, frequency, cron_expression,
                window_type, custom_window_config, params_override, output_format,
                recipients, is_active, owner_id, allowed_roles, allowed_users)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)''',
            (sid, name, body.get('description', ''), template_id, frequency, cron_expr,
             window_type, custom_cfg, params_override, output_format, recipients,
             _user_id(), allowed_roles, allowed_users)
        )
    return jsonify({"success": True, "data": {"id": sid, "name": name}}), 201


@app.route('/api/schedules/<sid>', methods=['PUT'])
def update_schedule(sid):
    body = request.get_json(silent=True) or {}
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM report_schedules WHERE id=?', (sid,)).fetchone()
        if not row:
            return _err("Schedule not found.", 404)
        if not _can_modify_query(dict(row)):
            return _err("Bu zamanlayıcıyı düzenleme yetkiniz yok.", 403)

        fields = []
        vals = []
        for col, key in [
            ('name', 'name'),
            ('description', 'description'),
            ('frequency', 'frequency'),
            ('cron_expression', 'cron_expression'),
            ('window_type', 'window_type'),
            ('output_format', 'output_format'),
            ('is_active', 'is_active'),
        ]:
            if key in body:
                fields.append(f"{col}=?")
                vals.append(body[key])

        if 'template_id' in body or 'templateId' in body:
            fields.append("template_id=?")
            vals.append(body.get('template_id') or body.get('templateId'))
        if 'custom_window_config' in body or 'customWindowConfig' in body:
            fields.append("custom_window_config=?")
            vals.append(json.dumps(body.get('custom_window_config') or body.get('customWindowConfig') or {}))
        if 'params_override' in body or 'paramsOverride' in body:
            fields.append("params_override=?")
            vals.append(json.dumps(body.get('params_override') or body.get('paramsOverride') or {}))
        if 'recipients' in body:
            fields.append("recipients=?")
            vals.append(json.dumps(body['recipients']))

        if fields:
            fields.append("updated_at=datetime('now')")
            vals.append(sid)
            conn.execute(f"UPDATE report_schedules SET {', '.join(fields)} WHERE id=?", vals)

    return jsonify({"success": True, "data": {"id": sid}})


@app.route('/api/schedules/<sid>', methods=['DELETE'])
def delete_schedule(sid):
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM report_schedules WHERE id=?', (sid,)).fetchone()
        if not row:
            return _err("Schedule not found.", 404)
        if not _can_modify_query(dict(row)):
            return _err("Bu zamanlayıcıyı silme yetkiniz yok.", 403)
        conn.execute('DELETE FROM report_schedules WHERE id=?', (sid,))
    return jsonify({"success": True})


@app.route('/api/schedules/<sid>/run', methods=['POST'])
def run_schedule_now(sid):
    """Zamanlayıcıyı anında çalıştırır. İsteğe bağlı 'reference_date' alır."""
    body = request.get_json(silent=True) or {}
    ref_date = body.get('reference_date') or body.get('referenceDate')
    try:
        from scheduler_engine import execute_schedule_run
        result = execute_schedule_run(sid, reference_date_str=ref_date, executed_by=_user_id())
        return jsonify({"success": result.get("success", False), "data": result})
    except Exception as exc:
        logger.exception("Error triggering schedule run")
        return _err(f"Zamanlayıcı çalıştırılırken hata: {str(exc)}", 500)


@app.route('/api/schedules/<sid>/runs', methods=['GET'])
def list_schedule_runs(sid):
    """Belirli bir zamanlayıcının geçmiş çalışmalarını döndürür."""
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT * FROM report_schedule_runs WHERE schedule_id=? ORDER BY datetime(created_at) DESC LIMIT 50',
            (sid,)
        ).fetchall()]
    for r in rows:
        r['resolvedParams'] = json.loads(r.get('resolved_params') or '{}')
    return jsonify({"success": True, "data": rows})


@app.route('/api/schedules/runs/<run_id>/download', methods=['GET'])
def download_schedule_run_file(run_id):
    """Çalıştırma sonucunda üretilen rapor dosyasını indirir."""
    db = get_db()
    with db._conn() as conn:
        run_row = conn.execute('SELECT * FROM report_schedule_runs WHERE id=?', (run_id,)).fetchone()
    if not run_row:
        return _err("Run not found.", 404)
    run_dict = dict(run_row)
    file_path = run_dict.get('output_file_path')
    if not file_path or not os.path.exists(file_path):
        return _err("Generated report file not found on disk.", 404)

    fmt = run_dict.get('output_format', 'xlsx').lower()
    real_base = os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    real_target = os.path.realpath(file_path)
    if not (real_target.startswith(real_base + os.sep) or real_target.startswith('/tmp' + os.sep) or real_target.startswith('/private/tmp' + os.sep) or real_target.startswith('/var/folders' + os.sep) or real_target.startswith('/private/var/folders' + os.sep)):
        return _err("Invalid report file path.", 403)
    mimetype = 'application/pdf' if fmt == 'pdf' else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    filename = os.path.basename(real_target)
    return send_file(real_target, mimetype=mimetype, as_attachment=True, download_name=filename)


# ---------------------------------------------------------------------------
# Endüstriyel Alarmlar (SQLite kalıcı + canlı telemetri uyumlu)
# ---------------------------------------------------------------------------

def _ensure_alarms_table(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS system_alarms (
            id TEXT PRIMARY KEY,
            severity TEXT NOT NULL DEFAULT 'warning',
            source TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            location TEXT NOT NULL DEFAULT '',
            value TEXT DEFAULT '',
            threshold TEXT DEFAULT '',
            acknowledged_by TEXT DEFAULT '',
            resolved_by TEXT DEFAULT ''
        )
    ''')
    cnt = conn.execute('SELECT COUNT(*) AS c FROM system_alarms').fetchone()['c']
    if cnt == 0:
        now_dt = datetime.now(timezone.utc)
        seeds = [
            ('alm_1', 'critical', 'CNC İşleme Merkezi E1', 'Ana iş mili (spindle) sıcaklığı kritik eşiği aştı: 95.4°C (Limit: 85°C)', (now_dt - timedelta(minutes=8)).isoformat(), 'active', 'Tesis Alpha - Motor Montaj Hattı', '95.4 °C', '85.0 °C', '', ''),
            ('alm_2', 'critical', 'KUKA Robot KR-210 (Pano 03)', 'Aks 4 redüktör tork sapması (+%28). Aşırı mekanik sürtünme veya yük algılandı', (now_dt - timedelta(minutes=22)).isoformat(), 'active', 'Tesis Alpha - Gövde Kaynak İstasyonu', '128 %', '100 %', '', ''),
            ('alm_3', 'critical', 'Enjeksiyon Pres Makinesi B2', 'Kalıp hidrolik yağ basıncı 135 bar seviyesine düştü (Gereken minimum: 180 bar)', (now_dt - timedelta(minutes=45)).isoformat(), 'active', 'Tesis Beta - Plastik Enjeksiyon Hattı', '135 bar', '180 bar', '', ''),
            ('alm_4', 'warning', 'Apex AX-1500 Master PLC', 'Endüstriyel Ethernet I/O istasyon 08 yanıt süresi gecikmesi (45ms). Paket kaybı riski', (now_dt - timedelta(minutes=65)).isoformat(), 'active', 'Tesis Alpha - Hat Otomasyonu', '45 ms', '20 ms', '', ''),
            ('alm_5', 'warning', 'SMD Reflow Fırın Tüneli', 'Bölge 3 ön ısıtma profili sapması: +5.8°C termal dalgalanma', (now_dt - timedelta(minutes=95)).isoformat(), 'acknowledged', 'Tesis Gamma - Elektronik Kart Montajı', '245.8 °C', '240.0 °C', 'engineer', ''),
            ('alm_6', 'warning', 'Konveyör Bandı C-Main', 'Bant tahrik motorunda titreşim artışı: 2.1 mm/s (Eşik: 1.5 mm/s)', (now_dt - timedelta(minutes=130)).isoformat(), 'active', 'Tesis Alpha - Şasi Taşıma Hattı', '2.1 mm/s', '1.5 mm/s', '', ''),
            ('alm_7', 'info', 'Enerji Dağıtım Panosu ADP-01', 'Vardiya reaktif güç kompanzasyonu devrede (Güç Faktörü cos φ = 0.98)', (now_dt - timedelta(minutes=210)).isoformat(), 'resolved', 'Tesis Alpha - Trafo Merkezi', '0.98 cos φ', '0.90 cos φ', 'operator', 'Sistem Otomasyonu'),
        ]
        conn.executemany(
            '''INSERT INTO system_alarms
               (id, severity, source, message, timestamp, status, location, value, threshold, acknowledged_by, resolved_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            seeds
        )


def _alarm_row_to_dict(r) -> dict:
    d = {
        'id': r['id'],
        'severity': r['severity'],
        'source': r['source'],
        'message': r['message'],
        'timestamp': r['timestamp'],
        'status': r['status'],
        'location': r['location'] or '',
    }
    if r['value']:
        d['value'] = r['value']
    if r['threshold']:
        d['threshold'] = r['threshold']
    if r['acknowledged_by']:
        d['acknowledgedBy'] = r['acknowledged_by']
    if r['resolved_by']:
        d['resolvedBy'] = r['resolved_by']
    return d


@app.route('/api/alarms', methods=['GET'])
def list_alarms():
    db = get_db()
    with db._conn() as conn:
        _ensure_alarms_table(conn)
        rows = conn.execute('SELECT * FROM system_alarms ORDER BY timestamp DESC').fetchall()
    return jsonify({'success': True, 'data': [_alarm_row_to_dict(r) for r in rows]})


@app.route('/api/alarms/<aid>/acknowledge', methods=['POST'])
def acknowledge_alarm(aid):
    actor = getattr(g, 'username', None) or 'operator'
    db = get_db()
    with db._conn() as conn:
        _ensure_alarms_table(conn)
        cur = conn.execute(
            "UPDATE system_alarms SET status='acknowledged', acknowledged_by=? WHERE id=?",
            (actor, aid)
        )
        if cur.rowcount == 0:
            return _err('Alarm not found.', 404)
    return jsonify({'success': True})


@app.route('/api/alarms/<aid>/resolve', methods=['POST'])
def resolve_alarm(aid):
    actor = getattr(g, 'username', None) or 'engineer'
    db = get_db()
    with db._conn() as conn:
        _ensure_alarms_table(conn)
        cur = conn.execute(
            "UPDATE system_alarms SET status='resolved', resolved_by=? WHERE id=?",
            (actor, aid)
        )
        if cur.rowcount == 0:
            return _err('Alarm not found.', 404)
    return jsonify({'success': True})


# ---------------------------------------------------------------------------
# Global hata işleyiciler — tutarlı JSON yanıtı + iç detay sızıntısı yok.
# ---------------------------------------------------------------------------

@app.errorhandler(500)
def _handle_500(e):
    logger.exception("Unhandled server error")
    return _err("İç sunucu hatası.", 500)


@app.errorhandler(404)
def _handle_404(e):
    return _err("Kaynak bulunamadı.", 404)


@app.errorhandler(405)
def _handle_405(e):
    return _err("Metoda izin verilmiyor.", 405)


@app.errorhandler(413)
def _handle_413(e):
    return _err("İstek gövdesi çok büyük.", 413)


@app.errorhandler(429)
def _handle_429(e):
    # Rate limit aşıldı (Flask-Limiter). _err (Response, status) döndürür —
    # başlık eklemek için Response'u açıp Retry-After koyarız, sonra status ile döneriz.
    body, status = _err("Çok fazla istek. Lütfen daha sonra tekrar deneyin.", 429)
    body.headers['Retry-After'] = '60'
    return body, status


try:
    register_ai(app, config, get_db, _can_access_query, _has_perm, _query_columns, metadata_cache, limiter)
except Exception:
    logger.warning("Opsiyonel AI servisi devre dışı; çekirdek SuperNova tam kapasite çalışmaya devam ediyor.", exc_info=True)


if __name__ == '__main__':
    if config.IS_PRODUCTION or config.IS_STAGING:
        logger.error(
            "Üretim/staging ortamında `python api_server.py` (Flask dev sunucusu) KULLANMAYIN. "
            "Bunun yerine gunicorn ile çalıştırın: gunicorn -c deploy/gunicorn.conf.py 'api_server:app'")
    logger.info("Starting Nov4 API (env=%s, debug=%s, bind=%s:%s)...",
                config.ENV, config.DEBUG, config.BIND_HOST, config.BIND_PORT)
    app.run(host=config.BIND_HOST, port=config.BIND_PORT, debug=config.DEBUG)
