import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { ApiService } from './api.service';

export interface DashboardWidgetData {
  id: string;
  title: string;
  type: string;
  value?: number | string;
  data?: any;
}

export interface VoltageData { timestamp: any; voltage: any; [key: string]: any; }
export interface FrequencyData { timestamp: any; frequency: any; [key: string]: any; }

@Injectable({
  providedIn: 'root'
})
export class DataService {
  private dashboardDataSubject = new BehaviorSubject<DashboardWidgetData[]>([]);
  dashboardData$ = this.dashboardDataSubject.asObservable();

  constructor(private apiService: ApiService) {
    this.initializeData();
  }

  private initializeData(): void {
    // Generic initialization logic
    this.apiService.getWidgets().subscribe({
      next: (widgets) => {
        const formatted = widgets.map(w => ({
          id: w.id,
          title: w.title,
          type: w.widget_type,
          value: Math.floor(Math.random() * 100) // Generic stub data
        }));
        this.dashboardDataSubject.next(formatted);
      },
      error: (err) => console.error('Failed to init dashboard data', err)
    });
  }

  getDashboardData(): Observable<DashboardWidgetData[]> {
    return this.dashboardData$;
  }

  loadInitialDataFromApi(historyMinutes?: number): void {}
  getLatestVoltageData(limit?: number): Observable<any[]> { return of([]); }
  getLatestFrequencyData(limit?: number): Observable<any[]> { return of([]); }
}
