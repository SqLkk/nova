import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ApiEnvelope } from './query.service';
import {
  PathDef, PathStructure, PathConfig, PreviewResult, SearchResult, BuiltStructure,
} from '../models/path-def.model';

/**
 * Path Definer servisi.
 * Backend: /api/paths — hiyerarşik path tanımlarının CRUD + preview/build/search.
 */
@Injectable({ providedIn: 'root' })
export class PathService {
  private readonly base = `${environment.apiUrl}/paths`;

  constructor(private http: HttpClient) {}

  list(): Observable<ApiEnvelope<PathDef[]>> {
    return this.http.get<ApiEnvelope<PathDef[]>>(this.base);
  }

  get(id: string): Observable<ApiEnvelope<PathDef>> {
    return this.http.get<ApiEnvelope<PathDef>>(`${this.base}/${id}`);
  }

  create(def: Partial<PathDef>): Observable<ApiEnvelope<PathDef>> {
    return this.http.post<ApiEnvelope<PathDef>>(this.base, def);
  }

  update(id: string, def: Partial<PathDef>): Observable<ApiEnvelope<PathDef>> {
    return this.http.put<ApiEnvelope<PathDef>>(`${this.base}/${id}`, def);
  }

  remove(id: string): Observable<ApiEnvelope<boolean>> {
    return this.http.delete<ApiEnvelope<boolean>>(`${this.base}/${id}`);
  }

  /** Kaydetmeden yapı önizlemesi: sorguyu koş + yapıyı kur. */
  preview(
    queryId: string, structure: PathStructure, config: PathConfig,
    params: Record<string, unknown> = {},
  ): Observable<ApiEnvelope<PreviewResult>> {
    return this.http.post<ApiEnvelope<PreviewResult>>(`${this.base}/preview`, {
      queryId, structure, config, params,
    });
  }

  /** Path'i canlı koşup cache'le → materialized yapı döner. */
  build(id: string, params: Record<string, unknown> = {}): Observable<ApiEnvelope<BuiltStructure>> {
    return this.http.post<ApiEnvelope<BuiltStructure>>(`${this.base}/${id}/build`, { params });
  }

  /** Path içinde terim ara → eşleşen düğümler + breadcrumb yollar. */
  search(id: string, term: string, params: Record<string, unknown> = {}): Observable<ApiEnvelope<SearchResult>> {
    return this.http.post<ApiEnvelope<SearchResult>>(`${this.base}/${id}/search`, { term, params });
  }
}
