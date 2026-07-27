import os
import sys
import json
import uuid
import logging
import re
import subprocess
import tempfile
from datetime import datetime
from io import BytesIO

from flask import Flask, jsonify, request, send_file, g

_DM_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_DM_DIR, '..'))

from db.database import get_db, ROLE_LEVELS, ALL_PERMISSION_KEYS, PERMISSION_CATALOG, _hash_password
from query_executor import (
    execute_query, test_connection, get_tables, get_table_schema, get_table_preview,
    search_columns_in_db, check_relationship, get_functions,
    QueryExecutionError,
)
from excel_template_engine import ExcelTemplateEngine
from path_engine import build_structure
import auth as auth_lib
from cache import metadata_cache
from config import config

app = Flask(__name__)
_engine = ExcelTemplateEngine()

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Token gerektirmeyen (herkese açık) yollar.
PUBLIC_PATHS = {'/health', '/api/auth/login'}

# CORS: sadece bilinen frontend kökenlerine izin ver (önceden '*' idi).
_ALLOWED_ORIGINS = {
    'http://localhost:4201', 'http://127.0.0.1:4201',
    'http://localhost:4200', 'http://127.0.0.1:4200',
}


@app.after_request
def _add_cors(response):
    origin = request.headers.get('Origin')
    if origin in _ALLOWED_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response


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
    if not header.startswith('Bearer '):
        return _err('Authentication required.', 401)
    payload = auth_lib.verify_token(header[7:].strip())
    if not payload:
        return _err('Session invalid or expired.', 401)

    g.uid = payload.get('uid')
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
    """data_sources tam satırını (credential dahil, sadece backend içi) döndürür."""
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT * FROM data_sources WHERE id = ?', (ds_id,)).fetchone()
    return dict(row) if row else None


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
    return metadata_cache.get(f"qcols:{row.get('id')}") or []


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
    """Kullanıcının bu sorguya erişimi var mı?

    Kural: admin/superuser her şeyi; sahip her zaman; değilse
    rolü allowed_roles içinde veya kimliği (username/uid) allowed_users içinde olmalı.
    Fail-closed: ACL boşsa ve sahip değilse erişim yok.
    """
    role = getattr(g, 'role', None)
    if role in ('admin', 'superuser'):
        return True
    if row.get('owner_id') and row['owner_id'] == getattr(g, 'uid', None):
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
    """Sorgu düzenleme/silme: sahip veya admin."""
    if getattr(g, 'role', None) in ('admin', 'superuser'):
        return True
    return bool(row.get('owner_id')) and row['owner_id'] == getattr(g, 'uid', None)


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
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if not username or not password:
        return _err('Username and password are required.', 400)

    db = get_db()
    with db._conn() as conn:
        row = conn.execute(
            'SELECT u.id, u.username, u.display_name, u.email, u.role, u.role_id, '
            'u.password_hash, u.password_salt, u.is_active, '
            'r.level, r.key AS role_key, r.name AS role_name '
            'FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.username = ?', (username,)
        ).fetchone()

    # Kullanıcı adı / şifre hatalarını aynı mesajla döndür (user enumeration koruması).
    if not row or not row['is_active'] or not row['password_hash']:
        return _err('Invalid username or password.', 401)
    if not auth_lib.verify_password(password, row['password_salt'], row['password_hash']):
        return _err('Invalid username or password.', 401)

    token = auth_lib.create_token(row['id'], row['username'], row['role'], row['level'] or 0)
    return jsonify({
        'success': True,
        'user': _user_public_dict(row),
        'token': token,
    })


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
            # user:view izni yoksa sadece kendi kaydını döndür (paylaşım seçicileri için).
            users = [dict(row) for row in conn.execute(
                '''SELECT u.id, u.username, u.display_name, u.email, u.role, u.is_active,
                          r.key AS role_key, r.level
                   FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?''',
                (_user_id(),))]
    return jsonify({"success": True, "data": users})


@app.route('/api/datasources', methods=['GET'])
def get_datasources():
    db = get_db()
    with db._conn() as conn:
        sources = [dict(row) for row in conn.execute(
            'SELECT id, name, db_type, host, port, database_name, is_active FROM data_sources')]
    return jsonify({"success": True, "data": sources})


@app.route('/api/datasources', methods=['POST'])
def create_datasource():
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
                data.get('password', ''), 
                data.get('database_name', ''), 
                now, now
            ))
            
        return jsonify({"success": True, "data": {"id": ds_id, "name": name}})
    except Exception as e:
        logger.exception("Error creating data source")
        return _err(str(e), 500)


@app.route('/api/datasources/test', methods=['POST'])
def api_test_connection():
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
        return _err(str(e), 500)


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
        return _err(str(e), 500)


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
        return _err(str(e), 500)


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
        return _err(str(e), 500)


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
        return _err(str(e), 500)


@app.route('/api/datasources/<ds_id>/functions', methods=['GET'])
def api_get_functions(ds_id):
    try:
        ds = _full_data_source(ds_id)
        if not ds:
            return _err("Data source not found", 404)
        results = get_functions(ds)
        return jsonify({"success": True, "data": results})
    except Exception as e:
        logger.exception("Error fetching functions")
        return _err(str(e), 500)



@app.route('/api/dashboards/me', methods=['GET'])
def get_my_dashboard():
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id, name, layout FROM dashboards WHERE user_id = ?', (g.uid,)).fetchone()
        if not row:
            # Create a default dashboard for the user
            new_id = 'd_' + uuid.uuid4().hex[:12]
            now = datetime.now().isoformat()
            conn.execute(
                '''INSERT INTO dashboards (id, user_id, name, layout, is_active, created_at, updated_at)
                   VALUES (?, ?, 'My Dashboard', '[]', 1, ?, ?)''',
                (new_id, g.uid, now, now)
            )
            return jsonify({"success": True, "data": {"id": new_id, "name": "My Dashboard", "layout": []}})
        
        layout = json.loads(row['layout']) if row['layout'] else []
        return jsonify({"success": True, "data": {"id": row['id'], "name": row['name'], "layout": layout}})

@app.route('/api/dashboards/me', methods=['PUT'])
def update_my_dashboard():
    req = request.get_json() or {}
    layout = req.get('layout', [])
    
    db = get_db()
    with db._conn() as conn:
        row = conn.execute('SELECT id FROM dashboards WHERE user_id = ?', (g.uid,)).fetchone()
        now = datetime.now().isoformat()
        
        if not row:
            new_id = 'd_' + uuid.uuid4().hex[:12]
            conn.execute(
                '''INSERT INTO dashboards (id, user_id, name, layout, is_active, created_at, updated_at)
                   VALUES (?, ?, 'My Dashboard', ?, 1, ?, ?)''',
                (new_id, g.uid, json.dumps(layout, ensure_ascii=False), now, now)
            )
        else:
            conn.execute(
                'UPDATE dashboards SET layout = ?, updated_at = ? WHERE user_id = ?',
                (json.dumps(layout, ensure_ascii=False), now, g.uid)
            )
            
    return jsonify({"success": True})


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
    allowed_roles = json.dumps(body.get('allowedRoles') or [])
    allowed_users = json.dumps(body.get('allowedUsers') or [])

    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO queries (id, name, description, data_source_id, sql_text, parameters, columns_meta, owner_id, allowed_roles, allowed_users, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1)''',
                (qid, name, body.get('description', ''), ds_id, body['sql'], params, _user_id(), allowed_roles, allowed_users))
        except Exception as exc:
            return _err(f"Could not create query: {exc}", 409)
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
    params = json.dumps(body.get('parameters') or json.loads(existing.get('parameters') or '[]'))
    allowed_roles = json.dumps(body.get('allowedRoles') or json.loads(existing.get('allowed_roles') or '[]'))
    allowed_users = json.dumps(body.get('allowedUsers') or json.loads(existing.get('allowed_users') or '[]'))

    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE queries SET name=?, description=?, data_source_id=?, sql_text=?, parameters=?, allowed_roles=?, allowed_users=?, updated_at=datetime('now')
               WHERE id=?''',
            (name, body.get('description', existing.get('description', '')), ds_id, sql, params, allowed_roles, allowed_users, qid))
    return jsonify({"success": True, "data": _query_to_dict(_load_query_row(qid))})


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

    # Sütun metadatası: lisans politikasına göre ya kalıcı yaz ya da RAM'de tut.
    # Varsayılan (config.PERSIST_QUERY_COLUMNS_META=False) DB'ye YAZMAZ; bunun
    # yerine process-içi önbellekte tutar (kaynak DB verisi çoğaltılmaz).
    if result.get('columns'):
        cols_json = json.dumps(result['columns'])
        if getattr(config, 'PERSIST_QUERY_COLUMNS_META', False):
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


def _collect_sql_data(sql_query_ids: list, filters: dict) -> dict:
    """Bağımlı SQL sorgularını çalıştırıp satırları topla.

    Güvenlik: yalnızca mevcut kullanıcının ERİŞEBİLDİĞİ sorguların verisi inject
    edilir (RBAC). Erişilemeyen sorgu sessizce atlanır → veri sızıntısı yok.
    """
    sql_data = {}
    for q_id in sql_query_ids or []:
        q_row = _load_query_row(q_id)
        if not q_row or not _can_access_query(q_row):
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
            result = subprocess.run(
                [sys.executable, _INTERPRETER_PATH],
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




@app.route('/api/python/run', methods=['POST'])
def run_python_adhoc():
    """Ayrı Python Workspace sayfası için ad-hoc Python çalıştırma.

    Gövde: { code, sqlQueryIds, params }. Bağımlı SQL sorguları (yalnızca
    kullanıcının erişebildikleri) sql_data olarak inject edilir; kod izole
    sandbox'ta koşar. Satır verisi önbelleğe alınmaz.
    """
    # Savunma derinliği: Python Workspace admin/mühendis ayrıcalığı (UI pageKey
    # guard'ı ile tutarlı).
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to run Python code.", 403)
    body = request.get_json(silent=True) or {}
    code = body.get('code', '')
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
            'allowed_roles, allowed_users FROM python_scripts WHERE id = ?', (sid,)).fetchone()
    return dict(row) if row else None

def _script_to_dict(row: dict) -> dict:
    return {
        'id': row['id'],
        'name': row['name'],
        'description': row.get('description', ''),
        'code': row['code'],
        'sqlQueryIds': json.loads(row.get('sql_query_ids') or '[]'),
        'owner': row.get('owner_id', ''),
        'allowedRoles': json.loads(row.get('allowed_roles') or '[]'),
        'allowedUsers': json.loads(row.get('allowed_users') or '[]')
    }

@app.route('/api/python/scripts', methods=['GET'])
def list_scripts():
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to view Python scripts.", 403)
    db = get_db()
    with db._conn() as conn:
        rows = [dict(r) for r in conn.execute(
            'SELECT id, name, description, code, sql_query_ids, owner_id, '
            'allowed_roles, allowed_users, is_active, created_at, updated_at '
            'FROM python_scripts ORDER BY name')]
    visible = [r for r in rows if _can_access_query(r)]
    return jsonify({"success": True, "data": [_script_to_dict(r) for r in visible]})

@app.route('/api/python/scripts/<sid>', methods=['GET'])
def get_script(sid):
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to view Python scripts.", 403)
    row = _load_script_row(sid)
    if not row:
        return _err("Script not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this script.", 403)
    return jsonify({"success": True, "data": _script_to_dict(row)})

@app.route('/api/python/scripts', methods=['POST'])
def create_script():
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to create Python scripts.", 403)
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err("Script name is required.")
    if not body.get('code') or not str(body['code']).strip():
        return _err("Code is required.")

    sid = (body.get('id') or '').strip() or _new_id('ps_')
    sql_query_ids = json.dumps(body.get('sqlQueryIds') or [])
    allowed_roles = json.dumps(body.get('allowedRoles') or [])
    allowed_users = json.dumps(body.get('allowedUsers') or [])

    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO python_scripts (id, name, description, code, sql_query_ids, owner_id, allowed_roles, allowed_users, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)''',
                (sid, name, body.get('description', ''), body['code'], sql_query_ids, _user_id(), allowed_roles, allowed_users))
        except Exception as exc:
            return _err(f"Could not create script: {exc}", 409)
    return jsonify({"success": True, "data": _script_to_dict(_load_script_row(sid))}), 201

@app.route('/api/python/scripts/<sid>', methods=['PUT'])
def update_script(sid):
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to edit Python scripts.", 403)
    body = request.get_json(silent=True) or {}
    existing = _load_script_row(sid)
    if not existing:
        return _err("Script not found.", 404)
    if not _can_modify_query(existing):
        return _err("You do not have permission to edit this script.", 403)

    name = (body.get('name') or existing['name']).strip()
    code = body.get('code', existing['code'])
    sql_query_ids = json.dumps(body.get('sqlQueryIds') or json.loads(existing.get('sql_query_ids') or '[]'))
    allowed_roles = json.dumps(body.get('allowedRoles') or json.loads(existing.get('allowed_roles') or '[]'))
    allowed_users = json.dumps(body.get('allowedUsers') or json.loads(existing.get('allowed_users') or '[]'))

    db = get_db()
    with db._conn() as conn:
        conn.execute(
            '''UPDATE python_scripts SET name=?, description=?, code=?, sql_query_ids=?, allowed_roles=?, allowed_users=?, updated_at=datetime('now')
               WHERE id=?''',
            (name, body.get('description', existing.get('description', '')), code, sql_query_ids, allowed_roles, allowed_users, sid))
    return jsonify({"success": True, "data": _script_to_dict(_load_script_row(sid))})

@app.route('/api/python/scripts/<sid>', methods=['DELETE'])
def delete_script(sid):
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
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
    model = body.get('model') or {}
    if isinstance(model, str):
        model = json.loads(model)
    allowed_roles = body.get('allowedRoles') or body.get('allowed_roles') or []
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
            return _err(f"Could not create template: {exc}", 409)
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
    """'py:<scriptId>:<datasetName>' başvurusunu sandbox'ta çalıştırıp dataseti döndürür.

    Güvenlik: script görünürlüğü (_can_access_query) + execute rolü
    (admin/superuser/engineer). Erişim yoksa/hata verirse sessizce boş dataset
    döner → render asla patlamaz, sadece o hücre boş kalır.
    """
    try:
        _, script_id, ds_name = ref.split(':', 2)
    except ValueError:
        return {"columns": [], "rows": []}
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return {"columns": [], "rows": []}
    row = _load_script_row(script_id)
    if not row or not _can_access_query(row):
        return {"columns": [], "rows": []}
    sql_data = _collect_sql_data(
        json.loads(row.get('sql_query_ids') or '[]'),
        params_by_query.get(ref, {}))
    ok, datasets = _run_python_raw(row['code'], sql_data, {})
    if not ok:
        logger.warning("Template Python script error (%s): %s", ref, datasets)
        return {"columns": [], "rows": []}
    return datasets.get(ds_name) or {"columns": [], "rows": []}


@app.route('/api/templates/<tid>/render', methods=['POST'])
def render_template(tid):
    """Şablonu çalıştır: bağlı query'leri koş, modeli doldur, .xlsx döndür."""
    fmt = (request.args.get('format') or 'xlsx').lower()
    if fmt != 'xlsx':
        return _err("Only xlsx is supported for now.", 501)

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

    # Modelde başvurulan tüm query'leri topla ve çalıştır.
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

    # SQL sorgu id'leri ile Python dataset başvurularını (py:<sid>:<ds>) ayır.
    sql_ids = {qid for qid in query_ids if not qid.startswith('py:')}
    py_refs = {qid for qid in query_ids if qid.startswith('py:')}

    query_results = {}
    for qid in sql_ids:
        q = _load_query_row(qid)
        if not q:
            query_results[qid] = {"columns": [], "rows": []}
            continue
        ds = _full_data_source(q['data_source_id'])
        try:
            query_results[qid] = execute_query(ds, q['sql_text'], params_by_query.get(qid, {}), 5000)
        except QueryExecutionError as exc:
            logger.warning("Query error (%s): %s", qid, exc)
            query_results[qid] = {"columns": [], "rows": []}

    # Python script çıktıları: py:<scriptId>:<dataset> → sandbox'ta çalıştır.
    for ref in py_refs:
        query_results[ref] = _resolve_python_dataset(ref, params_by_query)

    try:
        out = _engine.render_from_model(model, query_results)
    except Exception as exc:
        logger.exception("Render error")
        return _err(f"Render error: {exc}", 500)

    download = f"{(row['name'] or 'template').replace(' ', '_')}.xlsx"
    return send_file(
        BytesIO(out),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=download,
    )


# ---------------------------------------------------------------------------
# Path Defs (Path Definer — hiyerarşik navigasyon tanımları)
# ---------------------------------------------------------------------------

_VALID_STRUCTURES = ('tree', 'binary_tree', 'sequence', 'grouped')


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
    """Bir path'i besleyen sorguyu koş → (rows, columns, error). Erişim dahil."""
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
                 json.dumps(body.get('allowedRoles') or []),
                 json.dumps(body.get('allowedUsers') or [])))
        except Exception as exc:
            return _err(f"Could not create path: {exc}", 409)
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
    """Path'i canlı koşup materialized cache'e yazar (engineer+)."""
    if getattr(g, 'role', None) not in ('admin', 'superuser', 'engineer'):
        return _err("You do not have permission to compile paths.", 403)
    row = _load_path_row(pid)
    if not row:
        return _err("Path not found.", 404)
    if not _can_access_query(row):
        return _err("You do not have permission to view this path.", 403)
    body = request.get_json(silent=True) or {}
    # Büyük hiyerarşilerde kesilme olmasın diye build yüksek satır cap'i kullanır
    # (varsayılan 5000). İstemci body.limit ile geçersiz kılabilir.
    build_limit = int(body.get('limit') or 20000)
    rows, _cols, err = _run_path_query(row['query_id'], body.get('params') or {}, limit=build_limit)
    if err:
        return _err(err, 400)
    built = build_structure(row['structure'], rows, json.loads(row.get('config') or '{}'))
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
# RBAC yönetim uçları: izin kataloğu, roller, kullanıcı yönetimi, paylaşım.
# Hiyerarşi: çağıran sadece kendi seviyesinden DÜŞÜK kullanıcı/rolleri yönetir.
# ---------------------------------------------------------------------------

_SHARING_TABLES = {
    'templates': ('report_templates', 'share:templates'),
    'paths': ('path_defs', 'share:paths'),
    'queries': ('queries', 'share:queries'),
    'scripts': ('python_scripts', 'share:scripts'),
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
            return _err(f'Rol oluşturulamadı (anahtar benzersiz olmalı): {exc}', 409)
        for p in perms:
            conn.execute('INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)', (rid, p))
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
    role_id = (body.get('role_id') or body.get('roleId') or '').strip()
    role_row = _load_role_row(role_id) if role_id else None
    if not role_row:
        return _err('Geçerli bir rol seçin.', 400)
    if not _can_manage_level(role_row['level']):
        return _err('Bu rolü atayamazsınız (seviye çok yüksek).', 403)
    display_name = (body.get('display_name') or body.get('displayName') or '').strip()
    email = (body.get('email') or '').strip()
    is_active = 1 if body.get('is_active', body.get('isActive', True)) else 0
    pw_hash, pw_salt = _hash_password(password)
    uid = _new_id('u_')
    db = get_db()
    with db._conn() as conn:
        try:
            conn.execute(
                '''INSERT INTO users (id, username, display_name, email, password_hash, password_salt, role, role_id, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (uid, username, display_name, email, pw_hash, pw_salt, role_row['key'], role_id, is_active))
        except Exception as exc:
            return _err(f'Kullanıcı oluşturulamadı (kullanıcı adı benzersiz olmalı): {exc}', 409)
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
        cur = conn.execute('DELETE FROM users WHERE id=?', (uid,))
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
    if len(password) < 4:
        return _err('Şifre en az 4 karakter olmalı.', 400)
    pw_hash, pw_salt = _hash_password(password)
    db = get_db()
    with db._conn() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash=?, password_salt=?, updated_at=datetime('now') WHERE id=?",
            (pw_hash, pw_salt, uid))
        if cur.rowcount == 0:
            return _err('User not found.', 404)
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
    return jsonify({'success': True})


if __name__ == '__main__':
    logger.info("Starting Nov4 API...")
    app.run(host='0.0.0.0', port=5001, debug=True)
