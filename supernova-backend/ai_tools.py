"""Pure validation tools. Generated artifacts are never executed by the model."""
import ast
import json

from ai_prompts import PYTHON_PROMPT

PATH_FIELDS = {'id_col', 'parent_col', 'parents_col', 'label_col', 'type_col',
               'root_value', 'next_col', 'order_col', 'group_col', 'target_col',
               'health_col', 'status_col', 'badge_col', 'color_col', 'icon_col',
               'level1_col', 'level2_col', 'level3_col', 'level4_col', 'level_cols',
               'spaceMapConfig'}


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
    if not isinstance(artifact, dict) or set(artifact) - {'charts', 'cells'}:
        raise ValueError('Use a charts/cells fragment.')
    charts, cells = artifact.get('charts', []), artifact.get('cells', [])
    if not isinstance(charts, list) or not isinstance(cells, list) or len(charts) > 20 or len(cells) > 200:
        raise ValueError('Invalid or oversized template fragment.')
    if not charts and not cells:
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
    return json.loads(json.dumps({'charts': charts, 'cells': cells}))


def dispatch(name, arguments, schema):
    if not isinstance(arguments, dict):
        raise ValueError('Tool arguments must be an object.')
    if name == 'tool_get_database_schema':
        return schema
    if name == 'tool_generate_python_script':
        return validate_python(arguments.get('code'))
    if name == 'tool_generate_path_config':
        return {'valid': True, 'artifact': validate_path(arguments, schema['queries'])}
    if name == 'tool_generate_template_widget':
        return {'valid': True, 'artifact': validate_template(arguments, schema['queries'])}
    raise ValueError('Unknown tool.')
