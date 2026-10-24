import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { TemplateDocument } from '../models/template-document.model';
import { ApiEnvelope } from './query.service';

/** Liste/özet görünümünde şablon (model hariç). */
export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  /** Backend `GET /api/templates` yanıtı `owner` (sahip uid) döner. */
  owner?: string;
  /** Eski alan adı — geri uyumluluk için tutuldu. */
  owner_id?: string;
  /** ACL: şablonu görebilen roller. */
  allowedRoles?: string[];
  /** ACL: şablonu görebilen kullanıcılar (username veya uid). */
  allowedUsers?: string[];
  version?: number;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Tam şablon kaydı. */
export interface TemplateRecord extends TemplateSummary {
  model: TemplateDocument;
}

export interface EvaluatedQueryStat {
  queryId: string;
  name: string;
  description?: string;
  kind: 'sql' | 'python';
  rowCount: number;
  executionMs: number;
  error?: string;
}

export interface EvaluatedTemplateResult {
  id?: string;
  name: string;
  description?: string;
  evaluatedAt: string;
  sheets: Array<{
    id: string;
    name: string;
    rowCount: number;
    colCount: number;
    rowHeights?: Record<number, number>;
    colWidths?: Record<number, number>;
    merges?: any[];
    bands?: Array<{
      id: string;
      queryId: string;
      startRow: number;
      endRow: number;
      startCol: number;
      endCol: number;
      rowCount: number;
      totalQueryRows: number;
    }>;
    charts?: any[];
    cells: Record<string, any>;
  }>;
  queryStats: EvaluatedQueryStat[];
}

/**
 * Excel-benzeri şablon servisi.
 * Backend: /api/templates — TemplateDocument JSON olarak saklanır ve
 * /api/templates/<id>/render ile gerçek sorgu verisiyle .xlsx üretilir.
 */
@Injectable({ providedIn: 'root' })
export class TemplateBuilderService {
  private readonly base = `${environment.apiUrl}/templates`;

  constructor(private http: HttpClient) {}

  list(): Observable<ApiEnvelope<TemplateSummary[]>> {
    return this.http.get<ApiEnvelope<TemplateSummary[]>>(this.base);
  }

  get(id: string): Observable<ApiEnvelope<TemplateRecord>> {
    return this.http.get<ApiEnvelope<TemplateRecord>>(`${this.base}/${id}`);
  }

  create(name: string, model: TemplateDocument, description = ''): Observable<ApiEnvelope<{ id: string; name: string }>> {
    return this.http.post<ApiEnvelope<{ id: string; name: string }>>(this.base, { name, description, model });
  }

  update(id: string, model: TemplateDocument, name?: string, description?: string): Observable<ApiEnvelope<{ id: string }>> {
    return this.http.put<ApiEnvelope<{ id: string }>>(`${this.base}/${id}`, { name, description, model });
  }

  remove(id: string): Observable<ApiEnvelope<boolean>> {
    return this.http.delete<ApiEnvelope<boolean>>(`${this.base}/${id}`);
  }

  /**
   * Görünürlük / ACL güncelle → `PUT /api/templates/<id>/sharing`.
   * İzin: sahip VEYA admin/superuser VEYA `share:templates`.
   * (admin sharing endpoint'inden farkı: sahip de kendi şablonunu paylaşabilir.)
   */
  updateSharing(id: string, allowedRoles: string[], allowedUsers: string[]): Observable<ApiEnvelope<boolean>> {
    return this.http.put<ApiEnvelope<boolean>>(`${this.base}/${id}/sharing`, { allowedRoles, allowedUsers });
  }

  /** Şablonu kopyala: modeli çek, id'siz yeni kayıt olarak kaydet. */
  duplicate(id: string, newName: string): Observable<ApiEnvelope<{ id: string; name: string }>> {
    return this.get(id).pipe(
      switchMap((res) => {
        const model: TemplateDocument = res.data.model;
        if (model) { model.id = ''; }
        return this.create(newName, model, res.data.description || '');
      })
    );
  }

  /** Şablonu çalıştır → .xlsx veya .pdf blob (component indirmeyi tetikler). */
  render(id: string, params: Record<string, Record<string, unknown>> = {}, format: 'xlsx' | 'pdf' = 'xlsx'): Observable<Blob> {
    return this.http.post(`${this.base}/${id}/render?format=${format}`, { params }, { responseType: 'blob' });
  }

  /** Şablon modelini canlı çalıştırıp tarayıcı önizlemesi için değerlendirilmiş (expanded) hücre ve satırları getirir. */
  evaluate(
    model: TemplateDocument,
    params: Record<string, Record<string, unknown>> = {},
    maxBandRows = 100
  ): Observable<ApiEnvelope<EvaluatedTemplateResult>> {
    return this.http.post<ApiEnvelope<EvaluatedTemplateResult>>(`${this.base}/evaluate`, {
      model,
      params,
      maxBandRows,
    });
  }

  /** Kayıtlı bir şablonu ID ile canlı çalıştırıp değerlendirilmiş önizlemesini getirir. */
  evaluateById(
    id: string,
    params: Record<string, Record<string, unknown>> = {},
    maxBandRows = 100
  ): Observable<ApiEnvelope<EvaluatedTemplateResult>> {
    return this.http.post<ApiEnvelope<EvaluatedTemplateResult>>(`${this.base}/${id}/evaluate`, {
      params,
      maxBandRows,
    });
  }
}
