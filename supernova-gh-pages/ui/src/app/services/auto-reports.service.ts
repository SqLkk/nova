import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { TranslateService } from '@ngx-translate/core';
import { 
  ReportTemplate, 
  GeneratedReport, 
  ReportGenerationRequest,
  DataPathMapping 
} from '../models/report-template.model';

@Injectable({
  providedIn: 'root'
})
export class AutoReportsService {
  private apiUrl = environment.apiUrl || 'http://localhost:28081/api';
  private rtApiUrl = environment.apiUrl || 'http://localhost:28080';

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private translate: TranslateService
  ) {}

  /**
   * Tüm report template'lerini getir
   */
  getTemplates(): Observable<ReportTemplate[]> {
    return this.http.get<any>(`${this.apiUrl}/api/auto-reports/templates`).pipe(
      map((response: any) => {
        if (!response?.templates) return [];
        return response.templates.map((t: any) => {
          // Backend format: { name, info: { description, name, ... } }
          // Frontend format: ReportTemplate { id, name, description, type, ... }
          if (t.info) {
            return {
              id: t.name,
              name: t.info.name || t.name,
              description: t.info.description || '',
              type: 'custom' as const,
              format: 'xlsx' as const,
              isActive: true,
              sections: [],
              createdAt: new Date(),
              updatedAt: new Date(),
              createdBy: 'system'
            };
          }
          // Already in ReportTemplate format
          return {
            ...t,
            createdAt: new Date(t.createdAt),
            updatedAt: new Date(t.updatedAt),
            schedule: t.schedule ? {
              ...t.schedule,
              lastRun: t.schedule.lastRun ? new Date(t.schedule.lastRun) : undefined,
              nextRun: t.schedule.nextRun ? new Date(t.schedule.nextRun) : undefined
            } : undefined
          };
        });
      }),
      catchError(error => {
        console.warn('Failed to fetch templates from API, returning demo data', error);
        return of(this.getDemoTemplates());
      })
    );
  }

  /**
   * Belirli bir template'i getir
   */
  getTemplate(id: string): Observable<ReportTemplate | null> {
    return this.http.get<ReportTemplate>(`${this.apiUrl}/api/auto-reports/templates/${id}`).pipe(
      map((template: ReportTemplate) => ({
        ...template,
        createdAt: new Date(template.createdAt),
        updatedAt: new Date(template.updatedAt)
      })),
      catchError(error => {
        console.warn('Failed to fetch template from API', error);
        const demoTemplates = this.getDemoTemplates();
        return of(demoTemplates.find(t => t.id === id) || null);
      })
    );
  }

  /**
   * Yeni template oluştur
   */
  createTemplate(template: Partial<ReportTemplate>): Observable<any> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    const newTemplate = {
      ...template,
      createdBy: user.id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    return this.http.post<any>(`${this.apiUrl}/api/auto-reports/templates`, newTemplate).pipe(
      catchError(error => {
        console.error('Create template API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.TEMPLATE_CREATE_FAILED') });
      })
    );
  }

  /**
   * Template güncelle
   */
  updateTemplate(id: string, updates: Partial<ReportTemplate>): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/api/auto-reports/templates/${id}`, {
      ...updates,
      updatedAt: new Date()
    }).pipe(
      catchError(error => {
        console.error('Update template API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.TEMPLATE_UPDATE_FAILED') });
      })
    );
  }

  /**
   * Template sil
   */
  deleteTemplate(id: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/api/auto-reports/templates/${id}`).pipe(
      catchError(error => {
        console.error('Delete template API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.TEMPLATE_DELETE_FAILED') });
      })
    );
  }

  /**
   * Rapor oluştur
   */
  generateReport(request: ReportGenerationRequest): Observable<any> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    return this.http.post<any>(`${this.apiUrl}/api/reports/generate`, {
      ...request,
      generatedBy: user.id,
      generatedAt: new Date()
    }).pipe(
      catchError(error => {
        console.error('Generate report API error:', error);
        return of({ 
          success: false, 
          message: this.translate.instant('HARDCODED.REPORT_CREATE_FAILED'),
          error: error.message 
        });
      })
    );
  }

  /**
   * Oluşturulan raporları getir
   */
  getGeneratedReports(limit: number = 50): Observable<GeneratedReport[]> {
    return this.http.get<{ reports: GeneratedReport[] }>(`${this.apiUrl}/api/reports/generated?limit=${limit}`).pipe(
      map((response: { reports: GeneratedReport[] }) => response.reports.map((report: GeneratedReport) => ({
        ...report,
        generatedAt: new Date(report.generatedAt),
        period: {
          startDate: new Date(report.period.startDate),
          endDate: new Date(report.period.endDate)
        }
      }))),
      catchError(error => {
        console.warn('Failed to fetch generated reports from API, returning empty array', error);
        return of([]);
      })
    );
  }

  /**
   * Rapor indir
   */
  downloadReport(reportId: string): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/api/reports/download/${reportId}`, {
      responseType: 'blob'
    }).pipe(
      catchError(error => {
        console.error('Download report API error:', error);
        throw error;
      })
    );
  }

  /**
   * Kullanılabilir data path'leri getir
   */
  getAvailableDataPaths(): Observable<DataPathMapping[]> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of(this.getDemoDataPaths());
    }

    return this.http.get<{ dataPaths: DataPathMapping[] }>(`${this.rtApiUrl}/api/users/${user.id}/data-paths`).pipe(
      map((response: { dataPaths: DataPathMapping[] }) => response.dataPaths || []),
      catchError(error => {
        console.warn('Failed to fetch data paths from API, returning demo data', error);
        return of(this.getDemoDataPaths());
      })
    );
  }

  /**
   * Template'i kopyala
   */
  duplicateTemplate(id: string, newName: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/api/auto-reports/templates/${id}/duplicate`, {
      name: newName
    }).pipe(
      catchError(error => {
        console.error('Duplicate template API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.TEMPLATE_DUPLICATE_FAILED') });
      })
    );
  }

  // Demo data methods
  private getDemoTemplates(): ReportTemplate[] {
    const user = this.authService.getCurrentUser();
    return [
      {
        id: 'template-001',
        name: 'Daily Energy Report',
        description: this.translate.instant('HARDCODED.DAILY_ENERGY_DESC'),
        type: 'daily',
        format: 'xlsx',
        isActive: true,
        sections: [
          {
            id: 'section-001',
            title: 'Energy Consumption Summary',
            type: 'summary',
            order: 1,
            dataPaths: [
              {
                id: 'dp-001',
                label: 'Total Active Energy',
                dataPath: 'energy.active.total',
                aggregation: 'sum',
                unit: 'kWh',
                format: '0,0.00'
              },
              {
                id: 'dp-002',
                label: 'Total Reactive Energy',
                dataPath: 'energy.reactive.total',
                aggregation: 'sum',
                unit: 'kVArh',
                format: '0,0.00'
              }
            ],
            config: {
              showTotals: true,
              showAverages: true
            }
          },
          {
            id: 'section-002',
            title: 'Hourly Consumption',
            type: 'chart',
            order: 2,
            dataPaths: [
              {
                id: 'dp-003',
                label: 'Active Power',
                dataPath: 'power.active',
                aggregation: 'avg',
                unit: 'kW'
              }
            ],
            config: {
              chartType: 'line',
              xAxis: 'time',
              yAxis: ['power']
            }
          }
        ],
        schedule: {
          enabled: true,
          frequency: 'daily',
          time: '06:00',
          timezone: 'Europe/Istanbul',
          nextRun: new Date(Date.now() + 24 * 60 * 60 * 1000)
        },
        recipients: ['admin@example.com'],
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        createdBy: user?.id || 'system'
      },
      {
        id: 'template-002',
        name: 'Weekly Performance Report',
        description: this.translate.instant('HARDCODED.WEEKLY_PERF_DESC'),
        type: 'weekly',
        format: 'pdf',
        isActive: true,
        sections: [
          {
            id: 'section-003',
            title: 'System Performance KPIs',
            type: 'kpi',
            order: 1,
            dataPaths: [
              {
                id: 'dp-004',
                label: 'System Uptime',
                dataPath: 'system.uptime',
                aggregation: 'avg',
                unit: '%',
                format: '0.00',
                threshold: {
                  warning: 95,
                  critical: 90
                }
              },
              {
                id: 'dp-005',
                label: 'Average Power Factor',
                dataPath: 'power.factor',
                aggregation: 'avg',
                format: '0.000',
                threshold: {
                  warning: 0.85,
                  critical: 0.80
                }
              }
            ],
            config: {
              target: 98,
              comparison: 'previous_period'
            }
          }
        ],
        schedule: {
          enabled: true,
          frequency: 'weekly',
          time: '08:00',
          dayOfWeek: 1, // Monday
          timezone: 'Europe/Istanbul'
        },
        recipients: ['manager@example.com'],
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        createdBy: user?.id || 'system'
      }
    ];
  }

  private getDemoDataPaths(): DataPathMapping[] {
    return [
      {
        id: 'dp-energy-001',
        label: 'Total Active Energy',
        dataPath: 'energy.active.total',
        unit: 'kWh',
        format: '0,0.00'
      },
      {
        id: 'dp-energy-002',
        label: 'Total Reactive Energy',
        dataPath: 'energy.reactive.total',
        unit: 'kVArh',
        format: '0,0.00'
      },
      {
        id: 'dp-power-001',
        label: 'Active Power',
        dataPath: 'power.active',
        unit: 'kW',
        format: '0,0.00'
      },
      {
        id: 'dp-power-002',
        label: 'Reactive Power',
        dataPath: 'power.reactive',
        unit: 'kVAr',
        format: '0,0.00'
      },
      {
        id: 'dp-voltage-001',
        label: 'Phase A Voltage',
        dataPath: 'voltage.phase.a',
        unit: 'V',
        format: '0.0'
      },
      {
        id: 'dp-voltage-002',
        label: 'Phase B Voltage',
        dataPath: 'voltage.phase.b',
        unit: 'V',
        format: '0.0'
      },
      {
        id: 'dp-voltage-003',
        label: 'Phase C Voltage',
        dataPath: 'voltage.phase.c',
        unit: 'V',
        format: '0.0'
      },
      {
        id: 'dp-current-001',
        label: 'Phase A Current',
        dataPath: 'current.phase.a',
        unit: 'A',
        format: '0.00'
      },
      {
        id: 'dp-pf-001',
        label: 'Power Factor',
        dataPath: 'power.factor',
        format: '0.000'
      },
      {
        id: 'dp-freq-001',
        label: 'Frequency',
        dataPath: 'frequency',
        unit: 'Hz',
        format: '0.00'
      },
      {
        id: 'dp-thd-001',
        label: 'Voltage THD',
        dataPath: 'thd.voltage',
        unit: '%',
        format: '0.00'
      },
      {
        id: 'dp-alarm-001',
        label: 'Active Alarms Count',
        dataPath: 'alarms.active.count',
        aggregation: 'count'
      }
    ];
  }
}
