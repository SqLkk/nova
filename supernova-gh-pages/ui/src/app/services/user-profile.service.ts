import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { AuthService, User } from './auth.service';
import { TranslateService } from '@ngx-translate/core';

export interface Dashboard {
  id: string;
  name: string;
  description: string;
  layout: any;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Widget {
  id: string;
  type: string;
  title: string;
  dataPath: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  config: any;
  dashboardId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataPath {
  id: string;
  pathName: string;
  dataPath: string;
  description: string;
  createdAt: string;
}

export interface UserStats {
  totalReports: number;
  activeAlarms: number;
  dashboardViews: number;
  lastLogin: Date;
}

export interface UserActivity {
  action: string;
  timestamp: Date;
  icon: string;
  color: string;
  details?: string;
}

@Injectable({
  providedIn: 'root'
})
export class UserProfileService {
  private rtApiUrl = environment.apiUrl || 'http://localhost:28080';

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private translate: TranslateService
  ) {}

  /**
   * Kullanıcının dashboard'larını getir
   */
  getUserDashboards(): Observable<Dashboard[]> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of([]);
    }

    return this.http.get<{ dashboards: Dashboard[] }>(`${this.rtApiUrl}/api/users/${user.id}/dashboards`).pipe(
      map((response: { dashboards: Dashboard[] }) => response.dashboards),
      catchError(error => {
        console.error('Get dashboards API error:', error);
        // Fallback: Demo dashboard döndür
        return of(this.getDemoDashboards(user.id));
      })
    );
  }

  /**
   * Yeni dashboard oluştur
   */
  createDashboard(dashboardData: {
    name: string;
    description?: string;
    layout?: any;
    isDefault?: boolean;
  }): Observable<any> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    return this.http.post<any>(`${this.rtApiUrl}/api/users/${user.id}/dashboards`, dashboardData).pipe(
      catchError(error => {
        console.error('Create dashboard API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.DASHBOARD_CREATE_FAILED') });
      })
    );
  }

  /**
   * Kullanıcının widget'larını getir
   */
  getUserWidgets(dashboardId?: string): Observable<Widget[]> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of([]);
    }

    const params = dashboardId ? `?dashboard_id=${dashboardId}` : '';
    
    return this.http.get<{ widgets: Widget[] }>(`${this.rtApiUrl}/api/users/${user.id}/widgets${params}`).pipe(
      map((response: { widgets: Widget[] }) => response.widgets),
      catchError(error => {
        console.error('Get widgets API error:', error);
        // Fallback: Demo widget'lar döndür
        return of(this.getDemoWidgets(user.id, dashboardId));
      })
    );
  }

  /**
   * Yeni widget oluştur
   */
  createWidget(widgetData: {
    type: string;
    title: string;
    dataPath: string;
    position: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    config: any;
    dashboardId: string;
  }): Observable<any> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    return this.http.post<any>(`${this.rtApiUrl}/api/users/${user.id}/widgets`, widgetData).pipe(
      catchError(error => {
        console.error('Create widget API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.WIDGET_CREATE_FAILED') });
      })
    );
  }

  /**
   * Widget'ı güncelle
   */
  updateWidget(widgetId: string, updates: Partial<Widget>): Observable<any> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    return this.http.put<any>(`${this.rtApiUrl}/api/users/${user.id}/widgets/${widgetId}`, updates).pipe(
      catchError(error => {
        console.error('Update widget API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.WIDGET_UPDATE_FAILED') });
      })
    );
  }

  /**
   * Kullanıcının data path'lerini getir
   */
  getUserDataPaths(): Observable<DataPath[]> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of([]);
    }

    return this.http.get<{ dataPaths: DataPath[] }>(`${this.rtApiUrl}/api/users/${user.id}/data-paths`).pipe(
      map((response: { dataPaths: DataPath[] }) => response.dataPaths),
      catchError(error => {
        console.error('Get data paths API error:', error);
        // Fallback: Demo data path'ler döndür
        return of(this.getDemoDataPaths(user.id));
      })
    );
  }

  /**
   * Yeni data path ekle
   */
  addDataPath(pathData: {
    pathName: string;
    dataPath: string;
    description?: string;
  }): Observable<any> {
    const user = this.authService.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    return this.http.post<any>(`${this.rtApiUrl}/api/users/${user.id}/data-paths`, pathData).pipe(
      catchError(error => {
        console.error('Add data path API error:', error);
        return of({ success: false, message: this.translate.instant('HARDCODED.PATH_ADD_FAILED') });
      })
    );
  }

  // Fallback data methods
  private getDemoDashboards(userId: string): Dashboard[] {
    return [
      {
        id: `dashboard-${userId}-001`,
        name: this.translate.instant('HARDCODED.MAIN_DASHBOARD'),
        description: this.translate.instant('HARDCODED.DEFAULT_DASHBOARD'),
        layout: { columns: 12, rows: 10, gridSize: 10 },
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
  }

  private getDemoWidgets(userId: string, dashboardId?: string): Widget[] {
    const widgets: Widget[] = [
      {
        id: `widget-${userId}-001`,
        type: 'chart',
        title: this.translate.instant('HARDCODED.TEMP_CHART'),
        dataPath: 'sensors.temperature.main',
        position: { x: 0, y: 0, width: 6, height: 4 },
        config: {
          chartType: 'line',
          refreshInterval: 5000,
          dataPoints: 50
        },
        dashboardId: dashboardId || `dashboard-${userId}-001`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: `widget-${userId}-002`,
        type: 'gauge',
        title: this.translate.instant('HARDCODED.PRESSURE_GAUGE'),
        dataPath: 'sensors.pressure.main',
        position: { x: 6, y: 0, width: 3, height: 4 },
        config: {
          minValue: 0,
          maxValue: 100,
          unit: 'bar',
          thresholds: [
            { value: 80, color: 'orange' },
            { value: 90, color: 'red' }
          ]
        },
        dashboardId: dashboardId || `dashboard-${userId}-001`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    return dashboardId ? widgets.filter(w => w.dashboardId === dashboardId) : widgets;
  }

  private getDemoDataPaths(userId: string): DataPath[] {
    return [
      {
        id: `path-${userId}-001`,
        pathName: this.translate.instant('HARDCODED.MAIN_TEMP_SENSOR'),
        dataPath: 'sensors.temperature.main',
        description: this.translate.instant('HARDCODED.MAIN_TEMP_DESC'),
        createdAt: new Date().toISOString()
      },
      {
        id: `path-${userId}-002`,
        pathName: this.translate.instant('HARDCODED.MAIN_PRESSURE_SENSOR'),
        dataPath: 'sensors.pressure.main',
        description: this.translate.instant('HARDCODED.MAIN_PRESSURE_DESC'),
        createdAt: new Date().toISOString()
      },
      {
        id: `path-${userId}-003`,
        pathName: this.translate.instant('HARDCODED.MOTOR_RPM'),
        dataPath: 'motors.main.rpm',
        description: this.translate.instant('HARDCODED.MOTOR_RPM_DESC'),
        createdAt: new Date().toISOString()
      }
    ];
  }

  /**
   * Kullanıcı istatistiklerini getir
   */
  getUserStats(userId: string): Observable<UserStats | null> {
    return this.http.get<UserStats>(`${this.rtApiUrl}/api/users/${userId}/stats`).pipe(
      catchError(error => {
        console.warn('Failed to fetch user stats from API, returning null', error);
        return of(null);
      })
    );
  }

  /**
   * Kullanıcının son aktivitelerini getir
   */
  getRecentActivity(userId: string, limit: number = 10): Observable<UserActivity[]> {
    return this.http.get<UserActivity[]>(`${this.rtApiUrl}/api/users/${userId}/activity?limit=${limit}`).pipe(
      map((activities: UserActivity[]) => activities.map((activity: UserActivity) => ({
        ...activity,
        timestamp: new Date(activity.timestamp)
      }))),
      catchError(error => {
        console.warn('Failed to fetch recent activity from API, returning empty array', error);
        return of([]);
      })
    );
  }

  /**
   * Kullanıcı aktivitesi kaydet
   */
  logActivity(userId: string, action: string, details?: string): Observable<any> {
    return this.http.post(`${this.rtApiUrl}/api/users/${userId}/activity`, {
      action,
      details,
      timestamp: new Date()
    }).pipe(
      catchError(error => {
        console.warn('Failed to log activity', error);
        return of({ success: false });
      })
    );
  }
}
