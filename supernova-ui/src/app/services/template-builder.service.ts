import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { TemplateDocument } from '../models/template-document.model';
import { ApiEnvelope } from './query.service';

/** Liste/özet görünümünde şablon (model hariç). */
export interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  owner_id?: string;
  version?: number;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Tam şablon kaydı. */
export interface TemplateRecord extends TemplateSummary {
  model: TemplateDocument;
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

  /** Şablonu çalıştır → .xlsx blob (component indirmeyi tetikler). */
  render(id: string, params: Record<string, Record<string, unknown>> = {}): Observable<Blob> {
    return this.http.post(`${this.base}/${id}/render?format=xlsx`, { params }, { responseType: 'blob' });
  }
}
