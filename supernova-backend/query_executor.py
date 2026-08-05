#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Query Executor — saklı SQL sorguları güvenli biçimde çalıştırır.

Tasarım hedefleri (Template Builder "Python query" vizyonu):
  - Parametreli sorgular (:name yer tutucuları) — SQL enjeksiyonuna karşı.
  - Satır limiti (fetchmany) — büyük sonuçları kesme + truncated bayrağı.
  - Salt-okunur koruma — yazıcı anahtar kelimeler reddedilir (defense-in-depth).
  - Sürücü soyutlaması: sqlite (demo/geliştirme) + oracle (oracledb thin).
    sqlserver (pyodbc) / postgres (psycopg2) sonra eklenebilir.

Tüm sürücüler :name isimli parametreleri dict olarak kabul eder.
"""

import os
import re
import time
import logging
import sqlite3
import sqlparse
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)

# Backend dizininin ebeveyni = repo kökü (sqlite göreceli yollarını çözmek için).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Satır sınırı (preview ve render için üst sınır).
DEFAULT_LIMIT = 1000
MAX_LIMIT = 50000

# Salt-okunur guard. BİRİNCİL savunma sqlparse ile deyim sınıflandırmasıdır
# (yorum/dize soyulur, çoklu deyim reddedilir, yalnızca SELECT/WITH'e izin verilir).
# _WRITER_RE ikincil (defense-in-depth) önlemdir.
_WRITER_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|GRANT|REVOKE|REPLACE|ATTACH|DETACH|PRAGMA)\b",
    re.IGNORECASE,
)
# İzin verilen okuma deyim başlangıçları (sqlparse ilk anahtar kelimesi).
_READONLY_STMT_STARTS = {"SELECT", "WITH"}


class QueryExecutionError(Exception):
    """Sorgu çalıştırma sırasındaki hatalar."""


def _resolve_sqlite_path(database_name: str) -> str:
    if os.path.isabs(database_name):
        return database_name
    return os.path.join(REPO_ROOT, database_name)


def _guard_readonly(sql: str) -> None:
    """Salt-okunur zorunluğu.

    Yorumlar soyulur (anahtar kelime gizleme: ``/* INSERT */``), çoklu (stacked)
    deyimler reddedilir ve yalnızca SELECT/WITH başlayan tek deyime izin verilir.
    ``_WRITER_RE`` ikincil bir savunma olarak soyulmuş metinde tekrar denetlenir.
    Bağlantı izinleri her zaman birincil yetki kaynağıdır; burası defense-in-depth.
    """
    if not sql or not sql.strip():
        raise QueryExecutionError("Boş sorgu.")

    stripped = sqlparse.format(sql, strip_comments=True)
    statements = [s for s in sqlparse.split(stripped) if s.strip()]
    if not statements:
        raise QueryExecutionError("Boş sorgu.")
    if len(statements) > 1:
        # Stacked query (";"): ikinci deyim yazıcı olabilir.
        raise QueryExecutionError("Yalnızca tek bir okuma deyimine izin verilir.")

    # İlk anlamlı anahtar kelimeyi bul (CTE: WITH, normal: SELECT).
    stmt = sqlparse.parse(statements[0])[0]
    first_kw = None
    for tok in stmt.flatten():
        if tok.ttype is not None and tok.ttype in sqlparse.tokens.Keyword:
            first_kw = tok.value.upper()
            break
    if first_kw not in _READONLY_STMT_STARTS:
        raise QueryExecutionError("Yalnızca okuma sorgularına (SELECT / WITH) izin verilir.")

    # İkincil savunma (defense-in-depth): deyim içinde hiçbir anahtar-kelime
    # token'ı yazıcı fiil içermemeli. Ham metin yerine token'larda denetlenir →
    # dize/alias içindeki 'update' gibi kelimeler false-positive vermez.
    for tok in stmt.flatten():
        if tok.ttype is not None and tok.ttype in sqlparse.tokens.Keyword \
                and _WRITER_RE.search(tok.value):
            raise QueryExecutionError(
                "Yalnızca okuma sorgularına izin verilir (yazıcı anahtar kelime tespit edildi)."
            )


def _open_sqlite(ds: Dict[str, Any]) -> sqlite3.Connection:
    path = _resolve_sqlite_path(ds.get("database_name") or "")
    if not os.path.exists(path):
        raise QueryExecutionError(f"SQLite database not found: {path}")
    # Salt-okunur mod — URI ile aç, yazmayı fiziksel olarak engelle.
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


_oracle_thick_initialized = False

def _open_oracle(ds: Dict[str, Any]):
    global _oracle_thick_initialized
    try:
        import oracledb
    except ImportError as exc:
        raise QueryExecutionError(
            "Oracle driver (oracledb) is not installed. Run `pip install oracledb`."
        ) from exc
        
    if not _oracle_thick_initialized:
        try:
            # Check if the instant client path exists, otherwise use default
            client_path = "/opt/oracle/instantclient_23_3"
            if os.path.exists(client_path):
                oracledb.init_oracle_client(lib_dir=client_path)
            else:
                oracledb.init_oracle_client()
            logger.info("Oracle Thick mode initialized successfully.")
        except Exception as e:
            logger.warning(f"Could not init Oracle Thick mode: {e}. Using Thin mode.")
        _oracle_thick_initialized = True

    host = ds.get("host") or "localhost"
    port = ds.get("port") or 1521
    service = ds.get("database_name") or ""
    
    user = ds.get("username")
    password = ds.get("password")
    
    try:
        dsn = oracledb.makedsn(host, port, service_name=service)
        return oracledb.connect(user=user, password=password, dsn=dsn)
    except oracledb.DatabaseError as e:
        err_msg = str(e)
        if "ORA-12514" in err_msg or "ORA-12505" in err_msg:
            try:
                dsn_sid = oracledb.makedsn(host, port, sid=service)
                return oracledb.connect(user=user, password=password, dsn=dsn_sid)
            except Exception as e2:
                raise QueryExecutionError(f"Failed to connect via SID: {str(e2)}")
        raise QueryExecutionError(f"Oracle connection error: {err_msg}")


def _open_connection(ds: Dict[str, Any]):
    db_type = (ds.get("db_type") or "").lower()
    if db_type == "sqlite":
        return _open_sqlite(ds)
    if db_type == "oracle":
        return _open_oracle(ds)
    if db_type in ("sqlserver", "postgres"):
        raise QueryExecutionError(f"{db_type} driver is not added yet (coming soon).")
    raise QueryExecutionError(f"Unknown data source type: {db_type}")


def execute_query(
    data_source: Dict[str, Any],
    sql: str,
    params: Dict[str, Any] | None = None,
    limit: int = DEFAULT_LIMIT,
) -> Dict[str, Any]:
    """
    Bir veri kaynağı üzerinde parametreli sorgu çalıştırır.

    Returns:
        {
            "columns": [{"name", "dataType"}],
            "rows": [ {col: value, ...}, ... ],
            "totalRows": int,
            "truncated": bool,
            "executionMs": int
        }
    """
    if not sql or not sql.strip():
        raise QueryExecutionError("Empty SQL.")

    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    _guard_readonly(sql)
    params = params or {}

    started = time.time()
    conn = _open_connection(data_source)
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        # fetchmany ile kes — SQL'i değiştirmeden evrensel limit.
        fetched = cur.fetchmany(limit + 1)
        truncated = len(fetched) > limit
        rows_raw = fetched[:limit]

        columns = []
        if cur.description:
            columns = [
                {"name": d[0], "dataType": (d[1].__name__ if hasattr(d[1], "__name__") else str(d[1])) if d[1] else None}
                for d in cur.description
            ]

        rows: List[Dict[str, Any]] = []
        for r in rows_raw:
            if isinstance(r, dict):
                rows.append(r)
            elif isinstance(r, sqlite3.Row):
                rows.append({k: r[k] for k in r.keys()})
            else:
                rows.append({columns[i]["name"]: v for i, v in enumerate(r)})

        return {
            "columns": columns,
            "rows": rows,
            "totalRows": len(rows),
            "truncated": truncated,
            "executionMs": int((time.time() - started) * 1000),
        }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def test_connection(data_source: Dict[str, Any]) -> bool:
    """Veritabanı bağlantısını test eder."""
    try:
        conn = _open_connection(data_source)
        conn.close()
        return True
    except Exception as e:
        raise QueryExecutionError(f"Connection error: {str(e)}")


# ---------------------------------------------------------------------------
# Metadata (şema + satır sayısı) ve sayfalama — table explorer için.
# Not: execute_query'nin yazıcı-guard'ından ayrı, düşük seviyeli introspection.
# table_name'in güvenliği API katmanında regex ile sağlanır (^[a-zA-Z0-9_]+$).
# ---------------------------------------------------------------------------

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _assert_ident(name: str) -> None:
    """Tanımlayıcı (tablo adı) enjeksiyon koruması."""
    if not name or not _IDENT_RE.match(name):
        raise QueryExecutionError(f"Invalid identifier: {name!r}")


def get_table_schema(data_source: Dict[str, Any], table_name: str) -> Dict[str, Any]:
    """Tablonun sütun şemasını döndürür: name, dataType, nullable, isPrimaryKey.

    Satır verisi içermez — yalnızca metadata (cache için lisans-safe).
    """
    _assert_ident(table_name)
    db_type = (data_source.get("db_type") or "").lower()
    conn = _open_connection(data_source)
    try:
        cur = conn.cursor()
        columns: List[Dict[str, Any]] = []

        if db_type == "sqlite":
            cur.execute(f'PRAGMA table_info("{table_name}")')
            for row in cur.fetchall():
                # sqlite Row değil, tuple: cid, name, type, notnull, dflt_value, pk
                cid, name, ctype, notnull, dflt, pk = row
                columns.append({
                    "name": name,
                    "dataType": (ctype or "").lower() or "string",
                    "nullable": not notnull,
                    "isPrimaryKey": bool(pk),
                })
        elif db_type == "oracle":
            cur.execute(
                "SELECT column_name, data_type, nullable FROM all_tab_columns "
                "WHERE table_name = UPPER(:t) ORDER BY column_id",
                {"t": table_name}
            )
            for name, dtype, nullable in cur.fetchall():
                columns.append({
                    "name": name,
                    "dataType": (dtype or "string").lower(),
                    "nullable": nullable == "Y",
                    "isPrimaryKey": False,
                })
        elif db_type in ("postgres", "sqlserver", "mysql"):
            cur.execute(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                "WHERE table_name = %s ORDER BY ordinal_position",
                (table_name,)
            )
            for name, dtype, is_nullable in cur.fetchall():
                columns.append({
                    "name": name,
                    "dataType": (dtype or "string").lower(),
                    "nullable": is_nullable != "NO",
                    "isPrimaryKey": False,
                })
        else:
            raise QueryExecutionError(f"Schema introspection is not supported: {db_type}")

        # Satır sayısı — en iyi çaba (başarısız olursa None). Satır verisi döndürmez.
        row_count = _safe_row_count(cur, db_type, table_name)
        return {"columns": columns, "rowCount": row_count}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _safe_row_count(cur, db_type: str, table_name: str):
    """Tablo satır sayısını ucuz yoldan tahmin/ölc; başarısızsa None."""
    try:
        if db_type == "sqlite":
            cur.execute(f'SELECT COUNT(*) FROM "{table_name}"')
            return int(cur.fetchone()[0])
        if db_type == "oracle":
            cur.execute(
                "SELECT num_rows FROM all_tables WHERE table_name = UPPER(:t)",
                {"t": table_name}
            )
            row = cur.fetchone()
            return int(row[0]) if row and row[0] is not None else None
        if db_type in ("postgres", "sqlserver", "mysql"):
            # information_schema.tables'a da bakılabilir; COUNT(*) güvenli ama pahalı olabilir.
            cur.execute(f'SELECT COUNT(*) FROM "{table_name}"')
            return int(cur.fetchone()[0])
    except Exception:
        return None
    return None


def get_table_preview(
    data_source: Dict[str, Any],
    table_name: str,
    limit: int = 100,
    offset: int = 0,
) -> Dict[str, Any]:
    """Sayfalı tablo önizlemesi (satır verisi). execute_query'yi dialect-aware
    LIMIT/OFFSET ile sarmalar; tablo adı _assert_ident ile doğrulanır."""
    _assert_ident(table_name)
    db_type = (data_source.get("db_type") or "").lower()
    limit = max(1, min(int(limit or 100), MAX_LIMIT))
    offset = max(0, int(offset or 0))

    if db_type == "oracle":
        sql = f"SELECT * FROM {table_name} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
    else:
        sql = f"SELECT * FROM {table_name} LIMIT {limit} OFFSET {offset}"
    return execute_query(data_source, sql, limit=limit)


def get_tables(data_source: Dict[str, Any]) -> List[str]:
    """Veritabanındaki tablo adlarını getirir."""
    db_type = (data_source.get("db_type") or "").lower()
    
    if db_type == "sqlite":
        sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    elif db_type == "oracle":
        sql = "SELECT table_name FROM user_tables ORDER BY table_name"
    elif db_type == "postgres":
        sql = "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema'"
    elif db_type == "mysql":
        sql = "SHOW TABLES"
    else:
        # Generic fallback or throw error
        return []

    # Execute and extract first column
    result = execute_query(data_source, sql, limit=10000)
    tables = []
    
    # We don't know the exact column name across different DBs, so we take the first column value
    for row in result.get("rows", []):
      if row:
        # list(row.values())[0] gives the first column's value
        tables.append(list(row.values())[0])

    return sorted(tables)


def search_columns_in_db(
    data_source: Dict[str, Any], query_term: str
) -> List[Dict[str, Any]]:
  """Searches for a column name across all tables and returns matching tables and types."""
  db_type = (data_source.get("db_type") or "").lower()
  conn = _open_connection(data_source)
  try:
    cur = conn.cursor()
    results = []
    term = f"%{query_term.upper()}%"

    if db_type == "sqlite":
      tables = get_tables(data_source)
      for t in tables:
        cur.execute(f'PRAGMA table_info("{t}")')
        for row in cur.fetchall():
          cid, col_name, ctype, notnull, dflt, pk = row
          if query_term.lower() in col_name.lower():
            results.append({
                "table_name": t,
                "column_name": col_name,
                "dataType": (ctype or "").lower() or "string",
                "nullable": not notnull,
            })
    elif db_type == "oracle":
      cur.execute(
          "SELECT table_name, column_name, data_type, nullable "
          "FROM all_tab_columns "
          "WHERE column_name LIKE :q "
          "ORDER BY table_name, column_id",
          {"q": term},
      )
      for tname, col_name, dtype, nullable in cur.fetchall():
        results.append({
            "table_name": tname,
            "column_name": col_name,
            "dataType": (dtype or "string").lower(),
            "nullable": nullable == "Y",
        })
    elif db_type in ("postgres", "mysql", "sqlserver"):
      # SQL Server might not support ILIKE, standard LIKE with UPPER is safer or lower
      cur.execute(
          "SELECT table_name, column_name, data_type, is_nullable "
          "FROM information_schema.columns "
          "WHERE LOWER(column_name) LIKE %s "
          "ORDER BY table_name, ordinal_position",
          (f"%{query_term.lower()}%",),
      )
      for tname, col_name, dtype, is_nullable in cur.fetchall():
        results.append({
            "table_name": tname,
            "column_name": col_name,
            "dataType": (dtype or "string").lower(),
            "nullable": is_nullable != "NO",
        })
    return results
  finally:
    try:
      conn.close()
    except Exception:
      pass


def check_relationship(
    data_source: Dict[str, Any], t1: str, c1: str, t2: str, c2: str
) -> Dict[str, Any]:
  """Checks if two columns share values to confirm if they are related."""
  _assert_ident(t1)
  _assert_ident(c1)
  _assert_ident(t2)
  _assert_ident(c2)

  db_type = (data_source.get("db_type") or "").lower()
  conn = _open_connection(data_source)
  try:
    cur = conn.cursor()

    # 1. Fetch sample from t1.c1 (up to 20 distinct values)
    if db_type == "oracle":
      sql_t1 = (
          f"SELECT DISTINCT {c1} FROM {t1} WHERE {c1} IS NOT NULL FETCH FIRST"
          " 20 ROWS ONLY"
      )
    else:
      sql_t1 = f"SELECT DISTINCT {c1} FROM {t1} WHERE {c1} IS NOT NULL LIMIT 20"

    cur.execute(sql_t1)
    sample = [row[0] for row in cur.fetchall() if row[0] is not None]

    if not sample:
      return {
          "overlap_percentage": 0,
          "status": "unrelated",
          "message": f"{t1}.{c1} has no data.",
      }

    # 2. Check existence in t2.c2
    placeholders = []
    params = {}

    if db_type == "oracle":
      for i, val in enumerate(sample):
        placeholders.append(f":v{i}")
        params[f"v{i}"] = val
      sql_t2 = (
          f"SELECT COUNT(DISTINCT {c2}) FROM {t2} WHERE {c2} IN"
          f" ({','.join(placeholders)})"
      )
      cur.execute(sql_t2, params)
    elif db_type in ("postgres", "mysql", "sqlserver", "sqlite"):
      placeholders = [
          f"%s" if db_type != "sqlite" and db_type != "sqlserver" else "?"
          for _ in sample
      ]
      sql_t2 = (
          f"SELECT COUNT(DISTINCT {c2}) FROM {t2} WHERE {c2} IN"
          f" ({','.join(placeholders)})"
      )
      cur.execute(sql_t2, tuple(sample))

    matching_count = cur.fetchone()[0]
    overlap = int((matching_count / len(sample)) * 100)

    status = "unrelated"
    if overlap > 70:
      status = "highly_related"
    elif overlap > 20:
      status = "possibly_related"

    return {
        "overlap_percentage": overlap,
        "status": status,
        "sample_size": len(sample),
        "matching_size": matching_count,
    }
  except Exception as e:
    logger.exception("Error checking relationship")
    return {"error": str(e), "status": "error"}
  finally:
    try:
      conn.close()
    except Exception:
      pass


def get_functions(data_source: Dict[str, Any]) -> List[Dict[str, Any]]:
  """Lists user-defined database functions/packages."""
  db_type = (data_source.get("db_type") or "").lower()
  conn = _open_connection(data_source)
  try:
    cur = conn.cursor()
    results = []

    if db_type == "sqlite":
      # SQLite mock functions for demo (some standalone, some inside HIS_DBC_INTERFACE package)
      return [
          {
              "name": "HIS_DBC_INTERFACE.LogonUser",
              "type": "PROCEDURE",
              "signature": "HIS_DBC_INTERFACE.LogonUser(oReturn, oMessage, iUserName, iConsole)",
              "description": "Sets the environment for the user during session (Access rights, language, timezone) with the preferences from the user.\noReturn: 0 - Login OK\n-1 - Error occurred",
              "packageName": "HIS_DBC_INTERFACE"
          },
          {
              "name": "HIS_DBC_INTERFACE.ReadDataRaw",
              "type": "PROCEDURE",
              "signature": "HIS_DBC_INTERFACE.ReadDataRaw(oHandle, oReturn, oMessage, oViewName, iLocalTimeStampFrom, iHourBFrom, iLocalTimeStampTo, iHourBTo, iPointType, iPointSelection)",
              "description": "Reads raw data from HIS.\noHandle: Handle to read data from return view\noReturn: -1 = Error, 0 = Ok",
              "packageName": "HIS_DBC_INTERFACE"
          },
          {
              "name": "HIS_DBC_INTERFACE.ReadDataAggregated",
              "type": "PROCEDURE",
              "signature": "HIS_DBC_INTERFACE.ReadDataAggregated(oHandle, oReturn, oMessage, oViewName, iLocalTimeStampFrom, iHourBFrom, iLocalTimeStampTo, iHourBTo, iPointType, iPointSelection, iCycle, iCycleUnit)",
              "description": "Reads aggregated data from HIS (Analog or accu).\noHandle: Handle to read data from return view",
              "packageName": "HIS_DBC_INTERFACE"
          },
          {
              "name": "HIS_DBC_INTERFACE.SetUserLanguage",
              "type": "PROCEDURE",
              "signature": "HIS_DBC_INTERFACE.SetUserLanguage(oReturn, oMessage, iLanguage)",
              "description": "Changes the language for this session.\niLanguage: Language in format en-EN, en-US",
              "packageName": "HIS_DBC_INTERFACE"
          },
          {
              "name": "HIS_DBC_INTERFACE.SetTimeZone",
              "type": "PROCEDURE",
              "signature": "HIS_DBC_INTERFACE.SetTimeZone(oReturn, oMessage, iTimezoneID)",
              "description": "Changes the timezone for this session. (Only used for daily values, all timestamps are still in UTC)",
              "packageName": "HIS_DBC_INTERFACE"
          },
          {
              "name": "read_aggregated",
              "type": "FUNCTION",
              "signature": "read_aggregated(path, minutes)",
              "description": "Reads aggregated path values for standard queries.",
              "packageName": None
          },
          {
              "name": "read_raw_his",
              "type": "FUNCTION",
              "signature": "read_raw_his(path, min_ago)",
              "description": "Reads raw values from historical tables.",
              "packageName": None
          },
          {"name": "avg", "type": "AGGREGATE", "signature": "avg(col)", "description": "Returns the average value.", "packageName": None},
          {"name": "sum", "type": "AGGREGATE", "signature": "sum(col)", "description": "Returns the sum of all values.", "packageName": None},
      ]
    elif db_type == "oracle":
      # 1. Fetch standalone objects
      cur.execute(
          "SELECT object_name, object_type FROM user_objects "
          "WHERE object_type IN ('FUNCTION', 'PROCEDURE') "
          "ORDER BY object_name"
      )
      for name, otype in cur.fetchall():
        results.append({
            "name": name,
            "type": otype,
            "signature": f"{name.lower()}()",
            "description": f"Standalone database {otype.lower()}",
            "packageName": None
        })

      # 2. Fetch packages and parse their functions/procedures
      cur.execute(
          "SELECT object_name FROM user_objects "
          "WHERE object_type = 'PACKAGE' "
          "ORDER BY object_name"
      )
      packages = [r[0] for r in cur.fetchall()]

      # Regex to match functions, procedures, parameter blocks, and comments
      pattern = re.compile(
          r'(?:(/\*.*?\*/)\s*)?(PROCEDURE|FUNCTION)\s+(\w+)\s*(?:\((.*?)\))?\s*(?:RETURN\s+(\w+))?\s*;',
          re.DOTALL | re.IGNORECASE
      )

      for pkg in packages:
        cur.execute(
            "SELECT text FROM user_source "
            "WHERE name = :pkg AND type = 'PACKAGE' "
            "ORDER BY line",
            {"pkg": pkg}
        )
        source_lines = [r[0] for r in cur.fetchall()]
        if not source_lines:
          continue

        source_text = "".join(source_lines)

        for match in pattern.finditer(source_text):
          comment, p_type, name, params, ret_type = match.groups()
          
          # Clean parameters
          param_names = []
          if params:
            for p in params.split(","):
              p = p.strip()
              if p:
                parts = p.split()
                if parts:
                  param_names.append(parts[0])

          param_str = ", ".join(param_names)
          full_name = f"{pkg}.{name}"
          sig = f"{full_name}({param_str})"

          # Clean comment
          desc = ""
          if comment:
            cleaned_comment = comment.strip()
            if cleaned_comment.startswith("/*"):
              cleaned_comment = cleaned_comment[2:]
            if cleaned_comment.endswith("*/"):
              cleaned_comment = cleaned_comment[:-2]
            lines = []
            for line in cleaned_comment.split("\n"):
              line_str = line.strip().lstrip("*").strip()
              if line_str:
                lines.append(line_str)
            desc = "\n".join(lines)

          results.append({
              "name": full_name,
              "type": p_type.upper(),
              "signature": sig,
              "description": desc or f"Procedure defined inside package {pkg}",
              "packageName": pkg
          })

    elif db_type == "postgres":
      cur.execute(
          "SELECT p.proname, 'FUNCTION' FROM pg_proc p "
          "JOIN pg_namespace n ON p.pronamespace = n.oid "
          "WHERE n.nspname = 'public'"
      )
      for name, otype in cur.fetchall():
        results.append({
            "name": name,
            "type": otype,
            "signature": f"{name}()",
            "description": "User-defined postgres function",
            "packageName": None
        })
    return results
  finally:
    try:
      conn.close()
    except Exception:
      pass


