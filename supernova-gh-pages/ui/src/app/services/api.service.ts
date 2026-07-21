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
  getReports(): Observable<any[]> {
    return of([
      {
        id: 'rep_oee_1',
        name: 'Weekly Factory OEE Analysis',
        description: 'Analysis of Overall Equipment Effectiveness across all production lines.',
        type: 'custom',
        createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
        createdBy: 'admin',
        startDate: '2026-07-13T00:00:00Z',
        endDate: '2026-07-20T00:00:00Z',
        status: 'ready',
        fileType: 'excel',
        fileSize: '2.4 MB'
      },
      {
        id: 'rep_energy_1',
        name: 'Hourly Energy Consumption Log',
        description: 'Power usage log for Plant Alpha, Plant Beta, and Plant Gamma.',
        type: 'energy',
        createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
        createdBy: 'admin',
        startDate: '2026-07-19T00:00:00Z',
        endDate: '2026-07-20T00:00:00Z',
        status: 'ready',
        fileType: 'pdf',
        fileSize: '1.1 MB'
      },
      {
        id: 'rep_alarms_1',
        name: 'Active Machine Alarms Log',
        description: 'Downtime and alarm timeline log compiled from PLCs.',
        type: 'messages',
        createdAt: new Date(Date.now() - 1800000).toISOString(),
        createdBy: 'admin',
        startDate: '2026-07-20T00:00:00Z',
        endDate: '2026-07-20T23:59:59Z',
        status: 'ready',
        fileType: 'csv',
        fileSize: '450 KB'
      }
    ]);
  }
  startReport(id: string): Observable<any> { return of({}); }
  pollReportCompletion(id: string): Observable<any> { return of({}); }
  getReportOutput(id: string): Observable<any> { return of({}); }
  saveUserTemplate(data: any): Observable<any> { return of({}); }
  listUserTemplates(userId: string): Observable<any> { return of({data: []}); }
  deleteUserTemplate(id: string, userId: string): Observable<any> { return of({}); }
  updateReportSharing(id: string, isShared: boolean, sharedWith: any): Observable<any> { return of({}); }
  createReport(data: any): Observable<any> { return of({}); }
  getGeneratedReports(): Observable<any> {
    return of({
      success: true,
      data: [
        { name: 'Weekly_Factory_OEE_Analysis_20260720.xlsx', url: '#', size: '2.4 MB', date: new Date().toISOString() },
        { name: 'Hourly_Energy_Consumption_Log_20260720.pdf', url: '#', size: '1.1 MB', date: new Date().toISOString() },
        { name: 'Active_Machine_Alarms_Log_20260720.csv', url: '#', size: '450 KB', date: new Date().toISOString() }
      ]
    });
  }
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
    const rows = [];
    const now = new Date();
    for (let i = 20; i >= 0; i--) {
      const t = new Date(now.getTime() - i * 60000);
      const val = 50 + Math.sin(i * 0.5) * 15 + Math.random() * 5;
      rows.push({
        TIMESTAMP: t.toISOString(),
        VALUE_CUR: parseFloat(val.toFixed(2))
      });
    }
    return of({
      status: 'success',
      data: {
        name: 'Factory OEE SQL Exploration',
        rows: rows
      }
    });
  }

  // --- MORE STUBS ---
  previewReport(reportId: any, options: any): Observable<any> { return of({}); }
  generateFinalReport(reportId: any, options: any): Observable<any> { return of({}); }
  updateRawReport(reportId: any, options: any): Observable<any> { return of({}); }
  getReportSchedule(reportId: any): Observable<any> { return of({}); }
  saveReportSchedule(reportId: any, payload: any): Observable<any> { return of({}); }

  readRawDataHIS(path: any, mins: any): Observable<any> {
    const data = [];
    const now = new Date();
    const count = 30; // 30 data points
    const step = (mins * 60 * 1000) / count;
    
    let baseVal = 70;
    if (String(path).toLowerCase().includes('oee')) baseVal = 82;
    else if (String(path).toLowerCase().includes('energy') || String(path).toLowerCase().includes('power')) baseVal = 320;
    else if (String(path).toLowerCase().includes('temp')) baseVal = 68;
    else if (String(path).toLowerCase().includes('carbon')) baseVal = 14;

    for (let i = count; i >= 0; i--) {
      const t = new Date(now.getTime() - i * step);
      // Generate realistic sine wave + noise curve
      const factor = baseVal === 14 ? 2 : (baseVal > 100 ? 50 : 10);
      const val = baseVal + Math.sin(i * 0.4) * factor + (Math.random() - 0.5) * (factor * 0.3);
      data.push({
        TIMESTAMP: t.toISOString(),
        VALUE_CUR: parseFloat(val.toFixed(2))
      });
    }

    return of({
      status: 'success',
      data: data
    });
  }

  readRawDataWithSatz(path: any, satz: any): Observable<any> {
    const now = new Date();
    const val = 50 + Math.random() * 20;
    return of({
      status: 'success',
      data: {
        TIMESTAMP: now.toISOString(),
        VALUE_CUR: parseFloat(val.toFixed(2))
      }
    });
  }

  readRawData(path: any): Observable<any> {
    const now = new Date();
    const val = 50 + Math.random() * 20;
    return of({
      status: 'success',
      data: {
        TIMESTAMP: now.toISOString(),
        VALUE_CUR: parseFloat(val.toFixed(2))
      }
    });
  }

  getHistoricalData(params: any): Observable<any> {
    return this.readRawDataHIS(params?.path || 'generic', 10);
  }

  analyzeReport(id: any): Observable<any> { return of({}); }
  getUserTemplate(id: any, userId: any): Observable<any> { return of({}); }
}
