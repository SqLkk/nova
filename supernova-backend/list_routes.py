import ast
with open('api_server.py', 'r') as f:
    source = f.read()
tree = ast.parse(source)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        for dec in node.decorator_list:
            if isinstance(dec, ast.Call) and getattr(dec.func, 'attr', '') == 'route':
                if dec.args and isinstance(dec.args[0], ast.Constant):
                    print(dec.args[0].value)
