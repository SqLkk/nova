import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

export interface SavedExploration { id: string; [key: string]: any; }
import { ApiService } from './api.service';

@Injectable({
  providedIn: 'root'
})
export class TableExplorerService {
  constructor(private apiService: ApiService) {}

  getDatasets(): Observable<any[]> {
    return of([]);
  }

  listSaved(): Observable<any[]> {
    return of([]);
  }

  getTables(): Observable<any[]> {
    return of([{ name: 'users', type: 'system' }, { name: 'reports', type: 'system' }]);
  }

  getTableData(tableName: string): Observable<any[]> {
    return of([]);
  }
}
