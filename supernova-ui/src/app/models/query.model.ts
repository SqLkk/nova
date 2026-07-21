/**
 * Saklı SQL sorgu modeli.
 *
 * Oracle/SQL Server/Postgres gibi kaynaklara karşı saklanan SQL sorgular;
 * Python backend (oracledb/pyodbc) tarafından parametreli ve satır-limitli
 * çalıştırılır. Şablon (template) bu sorgulara hücre/aralık üzerinden bağlanır.
 *
 * Not: Python çalıştırma artık ayrı bir alan (Python Workspace → /api/python/run).
 * Bu model yalnızca SQL sorgularını temsil eder.
 */

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  /** data_sources tablosundaki kaynakin id'si. */
  dataSourceId: string;
  /** Çalıştırılacak SQL (:param / %(name)s yer tutucuları parametreli). */
  sql: string;
  parameters?: QueryParameter[];
  /** Backend'den dönen sütun metadatası (preview sonrası doldurulur). */
  columns?: QueryColumn[];
  owner?: string;
  allowedRoles?: string[];
  allowedUsers?: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QueryParameter {
  name: string;
  type: 'string' | 'number' | 'date' | 'datetime' | 'path';
  pathId?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface QueryColumn {
  name: string;
  dataType?: string;
  label?: string;
}

/** Sorgu preview / çalıştırma sonucu. */
export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  truncated: boolean;
  executionMs?: number;
}

export interface SavedPythonScript {
  id: string;
  name: string;
  description?: string;
  code: string;
  sqlQueryIds?: string[];
  owner?: string;
  allowedRoles?: string[];
  allowedUsers?: string[];
  createdAt?: string;
  updatedAt?: string;
}
