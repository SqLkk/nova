import { Injectable } from '@angular/core';
import { Observable, of, forkJoin } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { ApiService } from './api.service';
import { QueryService } from './query.service';

export interface SavedExploration {
  id: string;
  name: string;
  description?: string;
  source?: 'sql' | 'python';
  sql?: string;
  code?: string;
  dataSourceId?: string;
  columns?: any[];
  datasetNames?: string[];
  sqlQueryIds?: string[];
  owner?: string;
  allowedRoles?: string[];
  allowedUsers?: string[];
  [key: string]: any;
}

@Injectable({
  providedIn: 'root'
})
export class TableExplorerService {
  constructor(
    private apiService: ApiService,
    private queryService: QueryService
  ) {}

  getDatasets(): Observable<any[]> {
    return this.queryService.listDatasources().pipe(
      map(res => res?.data || []),
      catchError(() => of([]))
    );
  }

  listSaved(): Observable<SavedExploration[]> {
    return forkJoin({
      sql: this.queryService.list().pipe(catchError(() => of({ success: true, data: [] as any[] }))),
      py: this.queryService.listPythonScripts().pipe(catchError(() => of({ success: true, data: [] as any[] })))
    }).pipe(
      map(({ sql, py }) => {
        const sqlItems: SavedExploration[] = (sql?.data || []).map((q: any) => ({
          id: q.id,
          name: q.name,
          description: q.description || '',
          source: 'sql',
          sql: q.sql || '',
          dataSourceId: q.dataSourceId || '',
          columns: q.columns || [],
          owner: q.owner || '',
          allowedRoles: q.allowedRoles || [],
          allowedUsers: q.allowedUsers || [],
        }));
        const pyItems: SavedExploration[] = (py?.data || []).map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          source: 'python',
          code: s.code || '',
          sqlQueryIds: s.sqlQueryIds || [],
          datasetNames: s.datasetNames || [],
          columns: s.datasetsMeta?.[0]?.columns || [],
          owner: s.owner || '',
          allowedRoles: s.allowedRoles || [],
          allowedUsers: s.allowedUsers || [],
        }));
        return [...sqlItems, ...pyItems];
      })
    );
  }

  getTables(): Observable<any[]> {
    return of([{ name: 'users', type: 'system' }, { name: 'reports', type: 'system' }]);
  }

  getTableData(tableName: string): Observable<any[]> {
    return of([]);
  }
}
