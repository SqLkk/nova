import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import {
  SavedQuery,
  QueryResult,
  SavedPythonScript,
  SharingOptions,
  PythonScriptRunResult,
} from '../models/query.model';
import { DataSource } from '../models/data-source.model';

/** Api yanıtı zarfı. */
export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

/**
 * Saklı SQL sorgu servisi (Template Builder sol paneli).
 * Backend: /api/queries — Python backend'in koştuğu parametreli sorgular.
 */
@Injectable({ providedIn: 'root' })
export class QueryService {
  private readonly base = `${environment.apiUrl}/queries`;

  constructor(private http: HttpClient) {}

  /** Kullanılabilir veri kaynakları (şifreler hariç). */
  listDatasources(): Observable<ApiEnvelope<DataSource[]>> {
    return this.http.get<ApiEnvelope<DataSource[]>>(`${environment.apiUrl}/datasources`);
  }

  searchColumns(dsId: string, q: string): Observable<ApiEnvelope<any[]>> {
    return this.http.get<ApiEnvelope<any[]>>(`${environment.apiUrl}/datasources/${dsId}/search-columns`, {
      params: { q }
    });
  }

  checkRelationship(dsId: string, t1: string, c1: string, t2: string, c2: string): Observable<ApiEnvelope<any>> {
    return this.http.post<ApiEnvelope<any>>(`${environment.apiUrl}/datasources/${dsId}/check-relationship`, {
      t1, c1, t2, c2
    });
  }

  getFunctions(dsId: string): Observable<ApiEnvelope<any[]>> {
    return this.http.get<ApiEnvelope<any[]>>(`${environment.apiUrl}/datasources/${dsId}/functions`);
  }

  list(): Observable<ApiEnvelope<SavedQuery[]>> {
    return this.http.get<ApiEnvelope<SavedQuery[]>>(this.base);
  }

  get(id: string): Observable<ApiEnvelope<SavedQuery>> {
    return this.http.get<ApiEnvelope<SavedQuery>>(`${this.base}/${id}`);
  }

  create(query: Partial<SavedQuery>): Observable<ApiEnvelope<SavedQuery>> {
    return this.http.post<ApiEnvelope<SavedQuery>>(this.base, query);
  }

  update(id: string, query: Partial<SavedQuery>): Observable<ApiEnvelope<SavedQuery>> {
    return this.http.put<ApiEnvelope<SavedQuery>>(`${this.base}/${id}`, query);
  }

  remove(id: string): Observable<ApiEnvelope<boolean>> {
    return this.http.delete<ApiEnvelope<boolean>>(`${this.base}/${id}`);
  }

  /** Kayıtlı sorguyu çalıştır (preview). */
  preview(id: string, params: Record<string, unknown> = {}, limit = 100): Observable<ApiEnvelope<QueryResult>> {
    return this.http.post<ApiEnvelope<QueryResult>>(`${this.base}/${id}/preview`, { params, limit });
  }

  /** Kaydetmeden SQL dene (SQL Workspace — ad-hoc). Python için runPython() kullanın. */
  previewAdhoc(
    dataSourceId: string,
    sql: string,
    params: Record<string, unknown> = {},
    limit = 100
  ): Observable<ApiEnvelope<QueryResult>> {
    return this.http.post<ApiEnvelope<QueryResult>>(`${this.base}/preview`, {
      dataSourceId,
      sql,
      params,
      limit
    });
  }

  /** Ayrı Python Workspace: kodu izole sandbox'ta çalıştır.
   *  sqlQueryIds: sql_data olarak inject edilecek (kullanıcının erişebildiği) sorgular. */
  runPython(code: string, sqlQueryIds: string[] = [], params: Record<string, unknown> = {}): Observable<ApiEnvelope<Record<string, QueryResult>>> {
    return this.http.post<ApiEnvelope<Record<string, QueryResult>>>(
      `${environment.apiUrl}/python/run`,
      { code, sqlQueryIds, params }
    );
  }

  // --- Python Scripts CRUD ---
  listPythonScripts(): Observable<ApiEnvelope<SavedPythonScript[]>> {
    return this.http.get<ApiEnvelope<SavedPythonScript[]>>(`${environment.apiUrl}/python/scripts`);
  }

  getPythonScript(id: string): Observable<ApiEnvelope<SavedPythonScript>> {
    return this.http.get<ApiEnvelope<SavedPythonScript>>(`${environment.apiUrl}/python/scripts/${id}`);
  }

  createPythonScript(script: Partial<SavedPythonScript>): Observable<ApiEnvelope<SavedPythonScript>> {
    return this.http.post<ApiEnvelope<SavedPythonScript>>(`${environment.apiUrl}/python/scripts`, script);
  }

  updatePythonScript(id: string, script: Partial<SavedPythonScript>): Observable<ApiEnvelope<SavedPythonScript>> {
    return this.http.put<ApiEnvelope<SavedPythonScript>>(`${environment.apiUrl}/python/scripts/${id}`, script);
  }

  removePythonScript(id: string): Observable<ApiEnvelope<boolean>> {
    return this.http.delete<ApiEnvelope<boolean>>(`${environment.apiUrl}/python/scripts/${id}`);
  }

  /** Kayıtlı bir Python script'ini çalıştırıp tüm çıktı datasetlerini ve satırları getirir. */
  runSavedPythonScript(
    id: string,
    params: Record<string, unknown> = {},
    dataset = ''
  ): Observable<ApiEnvelope<PythonScriptRunResult>> {
    return this.http.post<ApiEnvelope<PythonScriptRunResult>>(
      `${environment.apiUrl}/python/scripts/${id}/run`,
      { params, dataset }
    );
  }

  /** Kayıtlı Python script'inin sütun listesini ve dataset metadatasını getirir. */
  getPythonScriptColumns(
    id: string,
    dataset = ''
  ): Observable<{ success: boolean; data: string[]; datasets?: any[] }> {
    const q = dataset ? `?dataset=${encodeURIComponent(dataset)}` : '';
    return this.http.get<{ success: boolean; data: string[]; datasets?: any[] }>(
      `${environment.apiUrl}/python/scripts/${id}/columns${q}`
    );
  }

  /** Kayıtlı SQL sorgusunun sütun isimlerini getirir. */
  getQueryColumns(id: string): Observable<ApiEnvelope<string[]>> {
    return this.http.get<ApiEnvelope<string[]>>(`${this.base}/${id}/columns`);
  }

  /** Paylaşım penceresi için aktif rol ve kullanıcı seçeneklerini getirir. */
  getSharingOptions(): Observable<ApiEnvelope<SharingOptions>> {
    return this.http.get<ApiEnvelope<SharingOptions>>(`${environment.apiUrl}/sharing/options`);
  }

  /** Kayıtlı SQL sorgusunun paylaşım izinlerini (roller + kullanıcılar) günceller. */
  updateQuerySharing(
    id: string,
    allowedRoles: string[],
    allowedUsers: string[]
  ): Observable<ApiEnvelope<boolean>> {
    return this.http.put<ApiEnvelope<boolean>>(`${this.base}/${id}/sharing`, {
      allowedRoles,
      allowedUsers,
    });
  }

  /** Kayıtlı Python script'inin paylaşım izinlerini (roller + kullanıcılar) günceller. */
  updatePythonScriptSharing(
    id: string,
    allowedRoles: string[],
    allowedUsers: string[]
  ): Observable<ApiEnvelope<boolean>> {
    return this.http.put<ApiEnvelope<boolean>>(
      `${environment.apiUrl}/python/scripts/${id}/sharing`,
      { allowedRoles, allowedUsers }
    );
  }
}
