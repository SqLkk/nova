"""Pure validation tools. Generated artifacts are never executed by the model."""
import ast
import json
import re

from ai_prompts import PYTHON_PROMPT

PATH_FIELDS = {'id_col', 'parent_col', 'parents_col', 'label_col', 'type_col',
               'root_value', 'next_col', 'order_col', 'group_col', 'target_col',
               'health_col', 'status_col', 'badge_col', 'color_col', 'icon_col',
               'level1_col', 'level2_col', 'level3_col', 'level4_col', 'level_cols',
               'spaceMapConfig'}

VALID_PERMISSION_KEYS = {
    'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
    'page:table-explorer', 'page:template-builder', 'page:query-creator',
    'page:python-workspace', 'page:schedules', 'page:admin', 'page:settings', 'page:profile',
    'user:view', 'user:create', 'user:edit', 'user:delete', 'user:reset-password', 'user:activate',
    'role:view', 'role:create', 'role:edit', 'role:delete',
    'share:templates', 'share:paths', 'share:queries', 'share:scripts', 'share:dashboards', 'share:schedules',
    'datasource:view', 'datasource:manage',
}
SYSTEM_ROLE_LEVELS = {'superuser': 100, 'admin': 80, 'engineer': 60, 'operator': 40, 'viewer': 20}
SHARING_RESOURCE_TYPES = {'templates', 'paths', 'queries', 'scripts', 'dashboards', 'schedules'}


def validate_python(code):
    if not isinstance(code, str) or not code.strip() or len(code) > 24000:
        raise ValueError('Python code is empty or too long.')
    tree = ast.parse(code)
    # Match the interpreter's supported node handlers, without running code.
    from safe_interpreter.interpreter import SafeASTInterpreter
    ignored = (ast.expr_context, ast.operator, ast.unaryop, ast.boolop, ast.cmpop, ast.arguments, ast.arg, ast.keyword, ast.Slice)
    banned = {'open', 'eval', 'exec', 'getattr', 'setattr', 'globals', 'locals',
              '__import__', 'compile', 'os', 'sys', 'subprocess', 'input'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(a.name not in ('math', 'json', 'datetime') or a.asname is not None for a in node.names):
                raise ValueError('Unsupported sandbox syntax: Import')
            continue
        if isinstance(node, ast.alias):
            continue
        if not isinstance(node, ignored) and not hasattr(SafeASTInterpreter, 'eval_' + type(node).__name__):
            raise ValueError('Unsupported sandbox syntax: ' + type(node).__name__)
        if isinstance(node, ast.Name) and (node.id in banned or node.id.startswith('_')):
            raise ValueError('Forbidden sandbox identifier: ' + node.id)
        if isinstance(node, ast.Attribute) and (node.attr.startswith('_') or node.attr in ('format', 'format_map')):
            raise ValueError('Forbidden sandbox attribute.')
    return {'valid': True, 'language': 'python', 'code': code,
            'note': 'Static syntax check only; Test uses the isolated runtime sandbox.',
            'rules': PYTHON_PROMPT}


def _positive_int(value, label, maximum=10000):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(label + ' must be a positive bounded integer.')


def _query(query_id, queries):
    found = next((q for q in queries if q['id'] == query_id), None)
    if not found:
        raise ValueError('Select an accessible saved query.')
    return found


def _column(column, query):
    if not isinstance(column, str) or not column or len(column) > 256:
        raise ValueError('Invalid column name.')
    columns = [c.get('name') if isinstance(c, dict) else c for c in query.get('columns', [])]
    if not columns:
        raise ValueError('Preview the selected query first to discover its columns.')
    if column not in columns:
        raise ValueError('Unknown query column: ' + column)


def validate_path(artifact, queries):
    if not isinstance(artifact, dict):
        raise ValueError('Path must be an object.')
    structure = artifact.get('structure')
    if structure not in ('tree', 'parent_child', 'binary_tree', 'sequence', 'grouped', 'dag', 'multi_level'):
        raise ValueError('Unsupported path structure.')
    query = _query(artifact.get('queryId'), queries)
    config = artifact.get('config', {k: v for k, v in artifact.items() if k in PATH_FIELDS})
    if not isinstance(config, dict) or set(config) - PATH_FIELDS:
        raise ValueError('Invalid path config fields.')
    required = {
        'tree': ['id_col', 'parent_col'],
        'parent_child': ['id_col', 'parent_col'],
        'binary_tree': ['id_col', 'parent_col'],
        'sequence': ['id_col'],
        'grouped': ['group_col'],
        'dag': ['id_col'],
        'multi_level': [],
    }[structure]
    if any(not config.get(k) for k in required):
        raise ValueError('Missing required path mapping.')
    if structure == 'multi_level' and not (config.get('level1_col') or config.get('level_cols')):
        raise ValueError('Multi-level structure requires level1_col or level_cols.')
    if structure == 'sequence' and not (config.get('next_col') or config.get('order_col')):
        raise ValueError('Sequence requires next_col or order_col.')
    if structure == 'dag' and not (config.get('parent_col') or config.get('parents_col')):
        raise ValueError('DAG requires parent_col or parents_col.')
    for key, value in config.items():
        if key in ('root_value', 'spaceMapConfig'):
            if key == 'root_value' and value is not None and not isinstance(value, (str, int, float)):
                raise ValueError('Invalid root value.')
        elif key == 'level_cols' and isinstance(value, list):
            for col in value:
                if col:
                    _column(col, query)
        elif value:
            _column(value, query)
    return {'structure': structure, 'queryId': query['id'], 'config': config}


def validate_template(artifact, queries):
    if not isinstance(artifact, dict) or set(artifact) - {'charts', 'cells', 'bands'}:
        raise ValueError('Use a charts/cells/bands fragment.')
    charts, cells = artifact.get('charts', []), artifact.get('cells', [])
    has_bands = 'bands' in artifact
    bands = artifact.get('bands', []) if has_bands else []
    if (not isinstance(charts, list) or not isinstance(cells, list) or not isinstance(bands, list)
            or len(charts) > 20 or len(cells) > 200 or len(bands) > 20):
        raise ValueError('Invalid or oversized template fragment.')
    if not charts and not cells and not bands:
        raise ValueError('Template fragment is empty.')
    for chart in charts:
        if not isinstance(chart, dict) or set(chart) - {'id', 'type', 'anchor', 'queryId', 'xAxis', 'yAxis', 'title'}:
            raise ValueError('Invalid chart fields.')
        if chart.get('type') not in ('line', 'bar', 'pie', 'area'):
            raise ValueError('Unsupported chart type.')
        if not isinstance(chart.get('id'), str) or not chart['id'] or len(chart['id']) > 100:
            raise ValueError('Chart id is required.')
        query = _query(chart.get('queryId'), queries)
        anchor = chart.get('anchor')
        if not isinstance(anchor, dict) or set(anchor) != {'row', 'col', 'widthCols', 'heightRows'}:
            raise ValueError('Invalid chart anchor.')
        for key, value in anchor.items():
            _positive_int(value, key, 1000)
        _column(chart.get('xAxis'), query)
        if not isinstance(chart.get('yAxis'), list) or not chart['yAxis'] or len(chart['yAxis']) > 10:
            raise ValueError('Chart requires yAxis columns.')
        for column in chart['yAxis']:
            _column(column, query)
        if chart.get('title') is not None and not isinstance(chart['title'], str):
            raise ValueError('Invalid chart title.')
    for cell in cells:
        if not isinstance(cell, dict) or set(cell) - {'row', 'col', 'value', 'binding', 'numberFormat', 'style', 'mergeAnchor'}:
            raise ValueError('Invalid cell fields.')
        _positive_int(cell.get('row'), 'row', 1000)
        _positive_int(cell.get('col'), 'col', 1000)
        if 'value' not in cell or cell['value'] is None:
            cell['value'] = ''
        elif isinstance(cell['value'], (int, float)) and not isinstance(cell['value'], bool):
            cell['value'] = str(cell['value'])
        elif not isinstance(cell['value'], str):
            raise ValueError('Cell value must be text.')
        if 'numberFormat' in cell and not isinstance(cell['numberFormat'], str):
            raise ValueError('Number format must be text.')
        binding = cell.get('binding')
        if binding is not None:
            if not isinstance(binding, dict):
                raise ValueError('Invalid cell binding.')
            if 'value' in binding:
                if not cell.get('value') and isinstance(binding['value'], str):
                    cell['value'] = binding['value']
                binding = {k: v for k, v in binding.items() if k != 'value'}
                cell['binding'] = binding
            if set(binding) - {'kind', 'queryId', 'field', 'operation', 'builtin', 'formula'}:
                raise ValueError('Invalid cell binding.')
            kind = binding.get('kind')
            if kind not in ('text', 'query_field', 'summary', 'builtin', 'formula'):
                raise ValueError('Invalid binding kind.')
            if kind in ('query_field', 'summary'):
                query = _query(binding.get('queryId'), queries)
                if kind == 'query_field' or binding.get('field'):
                    _column(binding.get('field'), query)
            if kind == 'summary' and binding.get('operation') not in ('SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'STDEV', 'MEDIAN', 'VARIANCE', 'FIRST', 'LAST'):
                raise ValueError('Invalid summary operation.')
            if kind == 'builtin' and binding.get('builtin') not in ('report_date', 'report_name', 'report_datetime'):
                raise ValueError('Unsupported builtin.')
            if kind == 'formula' and not isinstance(binding.get('formula'), str):
                raise ValueError('Formula text is required.')
    for band in bands:
        if not isinstance(band, dict) or set(band) - {'id', 'queryId', 'range', 'fieldMap'}:
            raise ValueError('Invalid band fields.')
        if not isinstance(band.get('id'), str) or not band['id'] or len(band['id']) > 100:
            raise ValueError('Band id is required.')
        query = _query(band.get('queryId'), queries)
        rng = band.get('range')
        if not isinstance(rng, dict) or set(rng) != {'startRow', 'startCol', 'endRow', 'endCol'}:
            raise ValueError('Invalid band range.')
        for key, value in rng.items():
            _positive_int(value, key, 1000)
        if rng['startRow'] > rng['endRow'] or rng['startCol'] > rng['endCol']:
            raise ValueError('Band start must not exceed band end.')
        fmap = band.get('fieldMap')
        if not isinstance(fmap, dict) or not fmap or len(fmap) > 50:
            raise ValueError('Band requires a non-empty fieldMap.')
        normalized_fmap = {}
        for col_idx, col_name in fmap.items():
            key_str = str(col_idx)
            if not key_str.isdigit() or not 1 <= int(key_str) <= 1000:
                raise ValueError('Band fieldMap keys must be 1-indexed column numbers.')
            _column(col_name, query)
            normalized_fmap[key_str] = col_name
        band['fieldMap'] = normalized_fmap
    out_obj = {'charts': charts, 'cells': cells}
    if has_bands:
        out_obj['bands'] = bands
    return json.loads(json.dumps(out_obj))


def validate_admin_action(artifact, caller_level=100, known_roles=None):
    if not isinstance(artifact, dict):
        raise ValueError('Admin draft must be an object.')
    action = artifact.get('action')
    if action not in ('create_user', 'create_role', 'update_sharing', 'set_user_overrides'):
        raise ValueError('Unsupported admin action.')
    role_levels = dict(SYSTEM_ROLE_LEVELS)
    if isinstance(known_roles, list):
        for r in known_roles:
            if isinstance(r, dict) and r.get('key') and isinstance(r.get('level'), int):
                role_levels[r['key']] = r['level']

    if action == 'create_user':
        if set(artifact) - {'action', 'user'}:
            raise ValueError('Invalid create_user draft fields.')
        user = artifact.get('user')
        if not isinstance(user, dict) or set(user) - {'username', 'displayName', 'email', 'roleKey', 'isActive'}:
            raise ValueError('Invalid user fields; never include passwords or credentials in AI drafts.')
        username = (user.get('username') or '').strip()
        if not re.match(r'^[a-zA-Z0-9_.-]{2,64}$', username):
            raise ValueError('Invalid username.')
        role_key = (user.get('roleKey') or '').strip()
        if not role_key or role_key == 'superuser':
            raise ValueError('Assignable roleKey is required and cannot be superuser.')
        if role_key in role_levels and role_levels[role_key] >= caller_level:
            raise ValueError('Cannot assign a role at or above caller level.')
        display_name = str(user.get('displayName') or username)[:120]
        email = str(user.get('email') or '')[:160]
        is_active = bool(user.get('isActive', True))
        return {
            'action': 'create_user',
            'user': {
                'username': username,
                'displayName': display_name,
                'email': email,
                'roleKey': role_key,
                'isActive': is_active,
            },
        }

    if action == 'create_role':
        if set(artifact) - {'action', 'role'}:
            raise ValueError('Invalid create_role draft fields.')
        role = artifact.get('role')
        if not isinstance(role, dict) or set(role) - {'key', 'name', 'description', 'level', 'permissions', 'color'}:
            raise ValueError('Invalid role fields.')
        rkey = (role.get('key') or '').strip()
        if not re.match(r'^[a-z][a-z0-9_-]{1,31}$', rkey) or rkey in SYSTEM_ROLE_LEVELS:
            raise ValueError('Custom role key must be lowercase alphanumeric and cannot shadow a system role.')
        rname = (role.get('name') or '').strip()
        if not rname or len(rname) > 100:
            raise ValueError('Role name is required.')
        level = role.get('level')
        _positive_int(level, 'level', 99)
        if level >= caller_level:
            raise ValueError('Role level must be strictly below caller level.')
        perms = role.get('permissions')
        if not isinstance(perms, list) or not perms or len(perms) > len(VALID_PERMISSION_KEYS):
            raise ValueError('Role permissions must be a non-empty list.')
        clean_perms = []
        for p in perms:
            if not isinstance(p, str) or p not in VALID_PERMISSION_KEYS:
                raise ValueError(f'Unknown permission key: {p}')
            if p not in clean_perms:
                clean_perms.append(p)
        out_role = {
            'key': rkey,
            'name': rname,
            'description': str(role.get('description') or '')[:240],
            'level': level,
            'permissions': clean_perms,
        }
        if isinstance(role.get('color'), str) and re.match(r'^#[0-9a-fA-F]{6}$', role['color']):
            out_role['color'] = role['color']
        return {'action': 'create_role', 'role': out_role}

    if action == 'update_sharing':
        if set(artifact) - {'action', 'resourceType', 'resourceId', 'allowedRoles', 'allowedUsers'}:
            raise ValueError('Invalid update_sharing draft fields.')
        rtype = artifact.get('resourceType')
        if rtype not in SHARING_RESOURCE_TYPES:
            raise ValueError('Invalid sharing resourceType.')
        rid = (artifact.get('resourceId') or '').strip()
        if not rid or len(rid) > 128:
            raise ValueError('resourceId is required.')
        roles = artifact.get('allowedRoles', [])
        users = artifact.get('allowedUsers', [])
        if not isinstance(roles, list) or any(not isinstance(r, str) or not r for r in roles):
            raise ValueError('allowedRoles must be a list of role keys.')
        if not isinstance(users, list) or any(not isinstance(u, str) or not u for u in users):
            raise ValueError('allowedUsers must be a list of user identifiers.')
        return {
            'action': 'update_sharing',
            'resourceType': rtype,
            'resourceId': rid,
            'allowedRoles': list(dict.fromkeys(roles)),
            'allowedUsers': list(dict.fromkeys(users)),
        }

    # set_user_overrides
    if set(artifact) - {'action', 'username', 'overrides'}:
        raise ValueError('Invalid set_user_overrides draft fields.')
    username = (artifact.get('username') or '').strip()
    if not username or len(username) > 64:
        raise ValueError('username is required.')
    overrides = artifact.get('overrides')
    if not isinstance(overrides, list) or not overrides or len(overrides) > len(VALID_PERMISSION_KEYS):
        raise ValueError('overrides must be a non-empty list.')
    clean_ov = []
    seen = set()
    for item in overrides:
        if not isinstance(item, dict) or set(item) != {'permission_key', 'granted'}:
            raise ValueError('Invalid override entry.')
        pkey = item.get('permission_key')
        granted = item.get('granted')
        if pkey not in VALID_PERMISSION_KEYS:
            raise ValueError(f'Unknown permission key: {pkey}')
        if isinstance(granted, bool):
            granted = 1 if granted else 0
        if granted not in (0, 1):
            raise ValueError('granted must be 0 or 1.')
        if pkey not in seen:
            seen.add(pkey)
            clean_ov.append({'permission_key': pkey, 'granted': granted})
    return {'action': 'set_user_overrides', 'username': username, 'overrides': clean_ov}


def dispatch(name, arguments, schema):
    if not isinstance(arguments, dict):
        raise ValueError('Tool arguments must be an object.')
    if name == 'tool_get_database_schema':
        return {k: v for k, v in schema.items() if k != 'rbac'}
    if name == 'tool_get_rbac_info':
        return schema.get('rbac') or {'roles': [], 'permissionKeys': sorted(VALID_PERMISSION_KEYS)}
    if name == 'tool_generate_python_script':
        return validate_python(arguments.get('code'))
    if name == 'tool_generate_path_config':
        return {'valid': True, 'artifact': validate_path(arguments, schema['queries'])}
    if name == 'tool_generate_template_widget':
        return {'valid': True, 'artifact': validate_template(arguments, schema['queries'])}
    if name == 'tool_generate_admin_draft':
        rbac = schema.get('rbac') or {}
        return {'valid': True, 'artifact': validate_admin_action(
            arguments, caller_level=rbac.get('callerLevel', 80), known_roles=rbac.get('roles')
        )}
    raise ValueError('Unknown tool.')
