#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Güvenli Python AST yorumlayıcısı (sandbox).

Güvenlik katmanları (defense-in-depth):
  1. AST-tabanlı beyaz liste — yalnızca bilinen node tipleri işlenir.
  2. Attribute çözümleme beyaz listesi — getattr yalnızca izinli (tip, attr)
     çiftleri ve küratörlü modüller için çağrılır. str.format / dunder kaçışı
     ve "attribute → değişkene ata → çağır" bypass'ı kapatıldı.
  3. Bellek korumaları — range, dizi çoğaltma (str/list * n) vePow için üst sınır.
  4. Statement sayacı — sonsuz döngü / DoS koruması.
  5. Çıktı limiti — OutHelper ile üretilen toplam satır sınırı.
  6. OS seviyesi resource limitleri (RLIMIT_AS/CPU/FSIZE/NPROC) — süreç başlarken.
  7. Traceback sızıntısı yok — istemciye sadece hata mesajı döner.

Bilinen kısıtlar: import yok, eval/exec yok, açık dosya/ağ yok. Bu yorumlayıcı
tek başına güvenlik sınırı DEĞİLDİR; süreç izolasyonu (api_server'da subprocess +
cwd/env izolasyonu) ile birlikte çalışır.
"""

import sys
import json
import ast
import math
import datetime
import os
import traceback

# ---------------------------------------------------------------------------
# Kaynak limitleri (OS seviyesi, süreç başında uygulanır).
# ---------------------------------------------------------------------------

def _apply_resource_limits():
    try:
        import resource
        soft, hard = 256 * 1024 * 1024, 256 * 1024 * 1024  # ~256 MB adres uzayı
        as_limit = getattr(resource, "RLIMIT_AS", None) or getattr(resource, "RLIMIT_DATA", None)
        if as_limit is not None:
            resource.setrlimit(as_limit, (soft, hard))
        resource.setrlimit(resource.RLIMIT_CPU, (5, 5))      # 5 sn CPU
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))    # dosyaya yazma yok
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))  # alt süreç sınırı
    except Exception:
        # Platforma bağlı; sessizce devam (diğer katmanlar yine de aktif).
        pass


# ---------------------------------------------------------------------------
# Güvenlik sabitleri.
# ---------------------------------------------------------------------------

MAX_STATEMENTS = 300_000
MAX_OUTPUT_ITEMS = 100_000
MAX_RANGE = 1_000_000          # range(...) üst sınırı
MAX_SEQ_MULT = 100_000         # "a" * n / [x] * n üst sınırı
MAX_POW_BITS = 1_000_000       #Pow sonuç tahmini bit üst sınırı


class SecurityError(Exception):
    pass


class LoopContinue(Exception):
    pass


class LoopBreak(Exception):
    pass


class ReturnException(Exception):
    def __init__(self, value):
        self.value = value


# ---------------------------------------------------------------------------
# Çıktı yardımcısı — üretilen satırları toplayan güvenli konteyner.
# ---------------------------------------------------------------------------

class OutHelper:
    def __init__(self, max_items=MAX_OUTPUT_ITEMS):
        self._columns = {}
        self._max_items = max_items
        self._total_items = 0

    def __call__(self, name):
        if name not in self._columns:
            self._columns[name] = []
        outer = self

        class SafeList:
            def __init__(self, lst):
                self._lst = lst

            def append(self, val):
                if outer._total_items >= outer._max_items:
                    raise SecurityError("Maximum output limit exceeded.")
                self._lst.append(val)
                outer._total_items += 1

            def extend(self, val_list):
                for v in val_list:
                    self.append(v)

            def __len__(self):
                return len(self._lst)

            def __iter__(self):
                return iter(self._lst)

            def __getitem__(self, i):
                return self._lst[i]

        return SafeList(self._columns[name])

    def get_results(self):
        return self._columns


# ---------------------------------------------------------------------------
# Attribute çözümleme beyaz listesi (tek doğruluk kaynağı).
# ---------------------------------------------------------------------------

# Konteyner tipleri → izinli metod/özellik kümesi.
# Önemli: 'format' / 'format_map' KASITLI YOK — str.format attribute erişimi
# ile sandbox kaçışı sağlar ("{0.__class__.__init__.__globals__}".format(x)).
_ALLOWED_ATTRS = {
    list: {'append', 'extend', 'insert', 'pop', 'remove', 'clear', 'index',
           'count', 'sort', 'reverse', 'copy'},
    dict: {'get', 'keys', 'values', 'items', 'update', 'clear', 'pop',
           'popitem', 'setdefault', 'copy'},
    str: {'strip', 'lstrip', 'rstrip', 'split', 'rsplit', 'splitlines', 'replace',
          'lower', 'upper', 'capitalize', 'title', 'swapcase', 'startswith',
          'endswith', 'find', 'rfind', 'index', 'rindex', 'join', 'isdigit',
          'isalpha', 'isalnum', 'isspace', 'isnumeric', 'count', 'zfill',
          'ljust', 'rjust', 'center'},
    set: {'add', 'remove', 'discard', 'union', 'intersection', 'difference',
          'symmetric_difference', 'update', 'copy'},
    tuple: {'count', 'index', 'count'},
    bytes: {'decode'},
    int: {'bit_length', 'bit_count', 'to_bytes', 'conjugate'},
    float: {'is_integer', 'as_integer_ratio', 'conjugate'},
}

# Küratörlü modül attribute'ları (math/datetime/json). Modülün tamamı serbest
# DEĞİL; yalnızca aşağıdaki isimler erişilebilir.
_MATH_SAFE = {
    'pi', 'e', 'tau', 'inf', 'nan', 'sqrt', 'isqrt', 'floor', 'ceil', 'fabs',
    'copysign', 'fmod', 'frexp', 'ldexp', 'modf', 'trunc', 'log', 'log2',
    'log10', 'log1p', 'exp', 'expm1', 'hypot', 'sin', 'cos', 'tan', 'asin',
    'acos', 'atan', 'atan2', 'degrees', 'radians', 'cosh', 'sinh', 'tanh',
    'erf', 'erfc', 'gamma', 'lgamma', 'fsum', 'gcd', 'lcm', 'isnan', 'isinf',
    'isfinite', 'isclose', 'remainder', 'dist', 'nextafter', 'ulp', 'prod',
}
# Not: factorial/comb/perm bilinçli yok (dev tamsayı → bellek DoS).
_SAFE_MODULE_ATTRS = {
    math: _MATH_SAFE,
    json: {'loads', 'dumps'},
    datetime: {'datetime', 'date', 'time', 'timedelta', 'timezone',
               'MAXYEAR', 'MINYEAR'},
}

# datetime sonuç tipleri üzerinde izinli metodlar.
_DT = datetime
_ALLOWED_ATTRS[_DT.datetime] = {
    'now', 'today', 'utcnow', 'fromtimestamp', 'fromisoformat', 'strptime',
    'strftime', 'isoformat', 'date', 'time', 'timestamp', 'weekday',
    'isoweekday', 'year', 'month', 'day', 'hour', 'minute', 'second',
}
_ALLOWED_ATTRS[_DT.date] = {'today', 'fromisoformat', 'isoformat', 'weekday',
                            'isoweekday', 'year', 'month', 'day'}
_ALLOWED_ATTRS[_DT.timedelta] = {'total_seconds', 'days', 'seconds', 'microseconds'}

# datetime sınıflarının kendisi üzerinde izinli (classmethod) attribute'lar.
# isinstance(cls, datetime) False döner; bu yüzden sınıf kimliğiyle eşleştiririz.
_SAFE_CLASS_ATTRS = {
    _DT.datetime: {'now', 'today', 'utcnow', 'fromtimestamp', 'fromisoformat', 'strptime'},
    _DT.date: {'today', 'fromisoformat', 'fromtimestamp'},
    _DT.time: {'fromisoformat', 'strptime'},
    _DT.timedelta: set(),
}


def _resolve_attr(obj, name):
    """Güvenli attribute çözümleme — getattr yerine bu kullanılır."""
    # 1) Alt çizgiyle başlayan (dunder dahil) hiçbir attribute'a erişim yok.
    if not name or name.startswith('_'):
        raise SecurityError(f"Accessing attribute '{name}' is disabled.")
    # 2) SafeList (OutHelper çıktısı) — sadece append/extend.
    if type(obj).__name__ == 'SafeList' and name in {'append', 'extend'}:
        return getattr(obj, name)
    # 3) Küratörlü modüller.
    for mod, allowed in _SAFE_MODULE_ATTRS.items():
        if obj is mod:
            if name in allowed:
                return getattr(obj, name)
            raise SecurityError(f"Module attribute '{name}' is disabled.")
    # 4) Bilinen güvenli sınıflar (classmethod erişimi).
    for cls, allowed in _SAFE_CLASS_ATTRS.items():
        if obj is cls:
            if name in allowed:
                return getattr(obj, name)
            raise SecurityError(f"Class attribute '{name}' is disabled.")
    # 5) Konteyner tipleri → tip tabanlı beyaz liste.
    for t, allowed in _ALLOWED_ATTRS.items():
        if isinstance(obj, t) and name in allowed:
            return getattr(obj, name)
    raise SecurityError(
        f"Attribute '{name}' on {type(obj).__name__} is disabled.")


# ---------------------------------------------------------------------------
# Bellek korumalı yardımcılar.
# ---------------------------------------------------------------------------

def _safe_range(*args, **kwargs):
    r = range(*args, **kwargs)
    try:
        n = len(r)
    except (OverflowError, ValueError):
        raise SecurityError("range too large.")
    if n > MAX_RANGE:
        raise SecurityError(f"range exceeds limit ({MAX_RANGE}).")
    return r


def _check_seq_mult(n):
    if isinstance(n, int) and n > MAX_SEQ_MULT:
        raise SecurityError(f"Sequence repetition exceeds limit ({MAX_SEQ_MULT}).")


def _safe_pow(base, exp):
    if isinstance(base, int) and isinstance(exp, int):
        if base in (-1, 0, 1) or exp < 0:
            return base ** exp
        est_bits = exp * max(1, base.bit_length())
        if est_bits > MAX_POW_BITS:
            raise SecurityError("Pow result too large (memory protection).")
    return base ** exp


# ---------------------------------------------------------------------------
# AST yorumlayıcı.
# ---------------------------------------------------------------------------

class SafeASTInterpreter:
    def __init__(self, safe_globals, local_vars, max_statements=MAX_STATEMENTS):
        self.globals = safe_globals
        self.locals = local_vars
        self.statement_count = 0
        self.max_statements = max_statements

    def _tick(self):
        self.statement_count += 1
        if self.statement_count > self.max_statements:
            raise SecurityError(
                "Execution exceeded the maximum allowed instruction count "
                "(infinite loop / DoS protection).")

    def evaluate(self, node):
        self._tick()
        method_name = f'eval_{type(node).__name__}'
        visitor = getattr(self, method_name, None)
        if visitor is None:
            raise SecurityError(
                f"Operation '{type(node).__name__}' is disabled in this secure environment.")
        return visitor(node)

    # --- Modül / ifadeler ---
    def eval_Module(self, node):
        last = None
        for stmt in node.body:
            last = self.evaluate(stmt)
        return last

    def eval_Expr(self, node):
        return self.evaluate(node.value)

    def eval_Pass(self, node):
        return None

    # --- Atama ---
    def eval_Assign(self, node):
        val = self.evaluate(node.value)
        for target in node.targets:
            self.assign_to_target(target, val)
        return val

    def eval_AnnAssign(self, node):
        if node.value is not None:
            val = self.evaluate(node.value)
            self.assign_to_target(node.target, val)
            return val
        return None

    def eval_AugAssign(self, node):
        current = self.evaluate(node.target)
        value = self.evaluate(node.value)
        op = type(node.op)
        if op == ast.Add: new = current + value
        elif op == ast.Sub: new = current - value
        elif op == ast.Mult:
            if isinstance(current, (str, list, tuple, bytes)) and isinstance(value, int):
                _check_seq_mult(value)
            new = current * value
        elif op == ast.Div: new = current / value if value != 0 else 0
        elif op == ast.Mod: new = current % value if value != 0 else 0
        elif op == ast.Pow: new = _safe_pow(current, value)
        elif op == ast.FloorDiv: new = current // value if value != 0 else 0
        else:
            raise SecurityError(f"Augmented operator {op.__name__} is disabled.")
        self.assign_to_target(node.target, new)
        return new

    def assign_to_target(self, target, val):
        if isinstance(target, ast.Name):
            self.locals[target.id] = val
        elif isinstance(target, (ast.Tuple, ast.List)):
            values = list(val)
            for t, v in zip(target.elts, values):
                self.assign_to_target(t, v)
        elif isinstance(target, ast.Subscript):
            obj = self.evaluate(target.value)
            idx = self._slice(target.slice)
            obj[idx] = val
        else:
            raise SecurityError(f"Assignment to {type(target).__name__} is disabled.")

    # --- İsim / sabit ---
    def eval_Name(self, node):
        if node.id in self.locals:
            return self.locals[node.id]
        if node.id in self.globals:
            return self.globals[node.id]
        raise NameError(f"Name '{node.id}' is not defined.")

    def eval_Constant(self, node):
        return node.value

    # --- İşleçler ---
    def eval_BinOp(self, node):
        left = self.evaluate(node.left)
        right = self.evaluate(node.right)
        op = type(node.op)
        if op == ast.Add:
            return left + right
        if op == ast.Sub:
            return left - right
        if op == ast.Mult:
            if isinstance(left, (str, list, tuple, bytes)) and isinstance(right, int):
                _check_seq_mult(right)
            elif isinstance(right, (str, list, tuple, bytes)) and isinstance(left, int):
                _check_seq_mult(left)
            return left * right
        if op == ast.Div:
            return left / right if right != 0 else 0
        if op == ast.FloorDiv:
            return left // right if right != 0 else 0
        if op == ast.Mod:
            return left % right if right != 0 else 0
        if op == ast.Pow:
            return _safe_pow(left, right)
        raise SecurityError(f"Binary operator {op.__name__} is disabled.")

    def eval_UnaryOp(self, node):
        operand = self.evaluate(node.operand)
        op = type(node.op)
        if op == ast.USub:
            return -operand
        if op == ast.UAdd:
            return +operand
        if op == ast.Not:
            return not operand
        if op == ast.Invert:
            return ~operand
        raise SecurityError(f"Unary operator {op.__name__} is disabled.")

    def eval_BoolOp(self, node):
        if isinstance(node.op, ast.And):
            result = True
            for v in node.values:
                result = self.evaluate(v)
                if not result:
                    return result
            return result
        else:  # Or
            for v in node.values:
                result = self.evaluate(v)
                if result:
                    return result
            return result

    def eval_Compare(self, node):
        left = self.evaluate(node.left)
        for op, comparator in zip(node.ops, node.comparators):
            right = self.evaluate(comparator)
            t = type(op)
            if t == ast.Eq:
                left = (left == right)
            elif t == ast.NotEq:
                left = (left != right)
            elif t == ast.Lt:
                left = (left < right)
            elif t == ast.LtE:
                left = (left <= right)
            elif t == ast.Gt:
                left = (left > right)
            elif t == ast.GtE:
                left = (left >= right)
            elif t == ast.In:
                left = (left in right)
            elif t == ast.NotIn:
                left = (left not in right)
            else:
                raise SecurityError(f"Comparison {t.__name__} is disabled.")
            if not left:
                return False
        return left

    # --- Kolleksiyon literalleri ---
    def eval_List(self, node):
        return [self.evaluate(e) for e in node.elts]

    def eval_Tuple(self, node):
        return tuple(self.evaluate(e) for e in node.elts)

    def eval_Set(self, node):
        return {self.evaluate(e) for e in node.elts}

    def eval_Dict(self, node):
        return {self.evaluate(k): self.evaluate(v) for k, v in zip(node.keys, node.values)}

    # --- Alt indis ---
    def _slice(self, node):
        if isinstance(node, ast.Slice):
            lower = self.evaluate(node.lower) if node.lower is not None else None
            upper = self.evaluate(node.upper) if node.upper is not None else None
            step = self.evaluate(node.step) if node.step is not None else None
            return slice(lower, upper, step)
        return self.evaluate(node)

    def eval_Subscript(self, node):
        value = self.evaluate(node.value)
        return value[self._slice(node.slice)]

    def eval_Attribute(self, node):
        obj = self.evaluate(node.value)
        return _resolve_attr(obj, node.attr)

    # --- Çağrı ---
    def eval_Call(self, node):
        # Çözülen çağrılabilir (artık attribute çözümleme beyaz listeyle korumalı).
        func = self.evaluate(node.func)
        args = [self.evaluate(a) for a in node.args]
        kwargs = {kw.arg: self.evaluate(kw.value) for kw in node.keywords if kw.arg}
        return func(*args, **kwargs)

    # --- Kontrol akışı ---
    def eval_If(self, node):
        if self.evaluate(node.test):
            for s in node.body:
                self.evaluate(s)
        else:
            for s in node.orelse:
                self.evaluate(s)
        return None

    def eval_For(self, node):
        iterable = self.evaluate(node.iter)
        broke = False
        for val in iterable:
            self.assign_to_target(node.target, val)
            try:
                for s in node.body:
                    self.evaluate(s)
            except LoopContinue:
                continue
            except LoopBreak:
                broke = True
                break
        if not broke:
            for s in node.orelse:
                self.evaluate(s)
        return None

    def eval_While(self, node):
        broke = False
        while self.evaluate(node.test):
            try:
                for s in node.body:
                    self.evaluate(s)
            except LoopContinue:
                continue
            except LoopBreak:
                broke = True
                break
        if not broke:
            for s in node.orelse:
                self.evaluate(s)
        return None

    def eval_Break(self, node):
        raise LoopBreak()

    def eval_Continue(self, node):
        raise LoopContinue()

    # --- Fonksiyon tanımı / return ---
    def eval_FunctionDef(self, node):
        interp = self

        def user_func(*args, **kwargs):
            saved = interp.locals
            interp.locals = dict(saved)  # yeni kapsam (kapanım sızıntısı yok)
            try:
                for arg, val in zip(node.args.args, args):
                    interp.locals[arg.arg] = val
                for kw in node.args.kwonlyargs:
                    if kw.arg in kwargs:
                        interp.locals[kw.arg] = kwargs[kw.arg]
                try:
                    for s in node.body:
                        interp.evaluate(s)
                except ReturnException as r:
                    return r.value
                return None
            finally:
                interp.locals = saved

        self.locals[node.name] = user_func
        return None

    def eval_Return(self, node):
        value = self.evaluate(node.value) if node.value is not None else None
        raise ReturnException(value)


# ---------------------------------------------------------------------------
# Giriş noktası.
# ---------------------------------------------------------------------------

def _safe_builtins(out_instance):
    return {
        'abs': abs, 'int': int, 'float': float, 'str': str, 'list': list,
        'dict': dict, 'set': set, 'len': len, 'sum': sum, 'range': _safe_range,
        'enumerate': enumerate, 'zip': zip, 'min': min, 'max': max, 'round': round,
        'any': any, 'all': all, 'bool': bool, 'tuple': tuple, 'sorted': sorted,
        'reversed': reversed, 'map': map, 'filter': filter, 'json': json,
        'out': out_instance, 'math': math, 'datetime': datetime,
        'True': True, 'False': False, 'None': None,
    }


def main():
    _apply_resource_limits()
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON payload: {str(e)}"}))
        sys.exit(1)

    code = payload.get('code', '')
    sql_data = payload.get('queries_data', {}) or {}
    filters = payload.get('filters', {}) or {}

    out_instance = OutHelper()
    local_vars = {'sql_data': sql_data, 'queries': sql_data, 'filters': filters}
    # SQL verisini isim uzayına kolay erişim için doğrudan aç.
    for q_name, q_data in sql_data.items():
        local_vars[q_name] = q_data

    try:
        tree = ast.parse(code)
        interp = SafeASTInterpreter(_safe_builtins(out_instance), local_vars)
        interp.evaluate(tree)

        results = out_instance.get_results()
        formatted = {}
        for name, rows in results.items():
            if not isinstance(rows, list):
                continue
            if rows and isinstance(rows[0], dict):
                cols = [{'name': k, 'dataType': type(v).__name__} for k, v in rows[0].items()]
                formatted[name] = {'columns': cols, 'rows': rows,
                                   'totalRows': len(rows), 'executionMs': 0}
            else:
                formatted[name] = {
                    'columns': [{'name': 'value', 'dataType': 'string'}],
                    'rows': [{'value': str(v)} for v in rows],
                    'totalRows': len(rows), 'executionMs': 0}
        print(json.dumps({"success": True, "results": formatted}))
        sys.exit(0)

    except SyntaxError as e:
        print(json.dumps({"success": False, "error": f"Syntax Error: {str(e)}"}))
        sys.exit(1)
    except SecurityError as e:
        print(json.dumps({"success": False, "error": f"Security Policy Violation: {str(e)}"}))
        sys.exit(1)
    except RecursionError:
        print(json.dumps({"success": False, "error": "Maximum recursion depth exceeded."}))
        sys.exit(1)
    except Exception as e:
        # Detaylı traceback'i yalnızca sunucu tarafına logla; istemciye mesaj döner
        # (yol/satır sızıntısını önler).
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": f"Execution Error: {str(e)}"}))
        sys.exit(1)


if __name__ == '__main__':
    main()
