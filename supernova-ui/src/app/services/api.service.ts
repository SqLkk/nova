import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, throwError, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface ReportFile { name: string; url?: string; [key: string]: any; }

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private baseUrl = environment.apiUrl || 'http://localhost:5000/api';
  
  private get defaultHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    });
  }

  constructor(private http: HttpClient) { }

  private get<T>(endpoint: string, params?: any): Observable<T> {
    const options = { 
      headers: this.defaultHeaders,
      params: new HttpParams({ fromObject: params || {} })
    };
    
    return this.http.get<ApiResponse<T>>(`${this.baseUrl}/${endpoint}`, options)
      .pipe(
        map(response => {
          if (!response || !response.success) {
            throw new Error(response?.message || 'API Error');
          }
          return response.data;
        }),
        catchError(error => throwError(() => error))
      );
  }

  private post<T>(endpoint: string, data: any): Observable<T> {
    return this.http.post<ApiResponse<T>>(`${this.baseUrl}/${endpoint}`, data, { headers: this.defaultHeaders })
      .pipe(
        map(response => {
          if (!response || !response.success) throw new Error(response?.message || 'API Error');
          return response.data;
        }),
        catchError(error => throwError(() => error))
      );
  }

  // --- GENERIC RESOURCES ---
  getUsers(): Observable<any[]> {
    return this.get<any[]>('users');
  }

  getDatasources(): Observable<any[]> {
    return this.get<any[]>('datasources');
  }

  getDashboards(): Observable<any[]> {
    return this.get<any[]>('dashboards');
  }

  getWidgets(): Observable<any[]> {
    return this.get<any[]>('widgets');
  }

  // --- REPORT STUBS TO FIX COMPILATION ---
  getReports(): Observable<any[]> { return of([]); }
  startReport(id: string): Observable<any> { return of({}); }
  pollReportCompletion(id: string): Observable<any> { return of({}); }
  getReportOutput(id: string): Observable<any> { return of({}); }
  saveUserTemplate(data: any): Observable<any> { return of({}); }
  listUserTemplates(userId: string): Observable<any> { return of({data: []}); }
  deleteUserTemplate(id: string, userId: string): Observable<any> { return of({}); }
  updateReportSharing(id: string, isShared: boolean, sharedWith: any): Observable<any> { return of({}); }
  createReport(data: any): Observable<any> { return of({}); }
  getGeneratedReports(): Observable<any> { return of([]); }
  deleteGeneratedReports(files: any[]): Observable<any> { return of({}); }
  updateReport(id: string, data: any): Observable<any> { return of({}); }
  addWidgetToDashboard(userId: string, data: any): Observable<any> { return of({}); }
  downloadReport(id: string, format: string): Observable<Blob> { return of(new Blob()); }
  deleteReport(id: string): Observable<any> { return of({}); }
  generateCombinedReport(): Observable<any> { return of({}); }
  downloadCombinedReport(filename: string): void {}

  // --- REPORT FILES STUBS ---
  getReportFiles(id: any): Observable<any> { return of([]); }
  previewReportFile(id: any, file: any): Observable<any> { return of({}); }
  deleteReportFile(id: any, file: any): Observable<any> { return of({}); }

  // --- PATH/HIERARCHY STUBS ---
  getPathsLevel1(dst: any): Observable<any> { return of({data: []}); }
  getPathsLevel2(p1: any, dst: any): Observable<any> { return of({data: []}); }
  getPathsLevel3(p1: any, p2: any, dst: any): Observable<any> { return of({data: []}); }
  getPathsElements(id: any, dst: any): Observable<any> { return of({data: []}); }
  getPathsInfo(id: any, dst: any): Observable<any> { return of({data: []}); }
  searchHistoricalPaths(q: any, limit?: any, mode?: any): Observable<any> { return of({data: []}); }
  getRealTimeHierarchyStructure(): Observable<any> { return of({data: []}); }
  getRealTimeElementsStructure(): Observable<any> { return of({data: []}); }
  getSavedExplorationData(id: any): Observable<any> {
    if (!id) {
      return of({ status: 'error', data: null, message: 'No query id provided.' });
    }
    const rawId = String(id).trim();
    if (rawId.startsWith('py:') || rawId.startsWith('py_') || rawId.startsWith('ps_')) {
      return this.runSavedPythonScript(rawId);
    }
    return this.post<any>(`queries/${rawId}/preview`, { limit: 250 }).pipe(
      map((result: any) => ({
        status: 'success',
        data: {
          rows: result?.rows || [],
          columns: result?.columns || [],
          source: 'sql',
          name: result?.name || 'Saved SQL Query',
          description: result?.description || '',
          executionMs: result?.executionMs || 0
        }
      })),
      catchError((err) => of({ status: 'error', data: null, message: err?.error?.error || 'SQL preview failed.' }))
    );
  }

  runSavedPythonScript(id: any, dataset = ''): Observable<any> {
    if (!id) {
      return of({ status: 'error', data: null, message: 'No script id provided.' });
    }
    let scriptId = String(id).trim();
    let ds = dataset;
    if (scriptId.startsWith('py:')) {
      const parts = scriptId.split(':');
      scriptId = parts[1] || scriptId;
      if (!ds && parts[2]) {
        ds = parts[2];
      }
    }
    return this.post<any>(`python/scripts/${scriptId}/run`, { dataset: ds }).pipe(
      map((result: any) => ({
        status: 'success',
        data: {
          rows: result?.rows || [],
          columns: result?.columns || [],
          datasetName: result?.datasetName || ds || '',
          datasetNames: result?.datasetNames || [],
          datasets: result?.datasets || {},
          source: 'python',
          name: result?.name || 'Python Script',
          description: result?.description || '',
          executionMs: result?.executionMs || 0
        }
      })),
      catchError((err) => of({ status: 'error', data: null, message: err?.error?.error || 'Python run failed.' }))
    );
  }

  // --- MORE STUBS ---
  previewReport(reportId: any, options: any): Observable<any> { return of({}); }
  generateFinalReport(reportId: any, options: any): Observable<any> { return of({}); }
  updateRawReport(reportId: any, options: any): Observable<any> { return of({}); }
  getReportSchedule(reportId: any): Observable<any> { return of({}); }
  saveReportSchedule(reportId: any, payload: any): Observable<any> { return of({}); }
  // SCADA/historian entegrasyonu bu kod tabanında yok — nazik hata zarfı döner
  // (widget çökmez; canlı veri SQL/Python modundan gelir). Historian ileride.
  readRawDataHIS(path: any, mins: any): Observable<any> {
    return of({ status: 'error', data: null, message: 'SCADA historian not configured.' });
  }
  readRawDataWithSatz(path: any, satz: any): Observable<any> {
    return of({ status: 'error', data: null, message: 'SCADA historian not configured.' });
  }
  readRawData(path: any): Observable<any> {
    return of({ status: 'error', data: null, message: 'SCADA historian not configured.' });
  }
  getHistoricalData(params: any): Observable<any> {
    return of({ status: 'error', data: null, message: 'Historical source not configured.' });
  }
  analyzeReport(id: any): Observable<any> { return of({}); }
  getUserTemplate(id: any, userId: any): Observable<any> { return of({}); }
}
