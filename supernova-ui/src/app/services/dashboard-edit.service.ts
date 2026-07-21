import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Widget {
  id: string;
  type: string;
  title: string;
  icon: string;
  w: number;
  h: number;
  category: string;
  description?: string;
  config?: any;
  dataSourceType?: 'sql' | 'python';
  assignedQueryId?: string;
  assignedPythonId?: string;
}

/**
 * Dashboard ↔ Navigation haberleşme servisi.
 * Edit modu açıldığında navigation sidebar'ı widget kataloğuna dönüşür.
 */
@Injectable({ providedIn: 'root' })
export class DashboardEditService {
  private apiUrl = environment.apiUrl || 'http://localhost:5000/api';

  /** Edit mode durumu. */
  private _editMode = new BehaviorSubject<boolean>(false);
  editMode$ = this._editMode.asObservable();

  /** Navigation'dan dashboard'a: "bu widget'ı ekle" eventi. */
  private _addWidget = new Subject<Widget>();
  addWidget$ = this._addWidget.asObservable();

  constructor(private http: HttpClient) {}

  get isEditMode(): boolean {
    return this._editMode.value;
  }

  toggleEditMode(): void {
    this._editMode.next(!this._editMode.value);
  }

  setEditMode(value: boolean): void {
    this._editMode.next(value);
  }

  requestAddWidget(widget: Widget): void {
    this._addWidget.next(widget);
  }

  // --- API ---

  loadMyDashboard(): Observable<{ success: boolean; data: { id: string; name: string; layout: Widget[] } }> {
    return this.http.get<any>(`${this.apiUrl}/dashboards/me`);
  }

  saveMyDashboard(layout: Widget[]): Observable<{ success: boolean }> {
    return this.http.put<any>(`${this.apiUrl}/dashboards/me`, { layout });
  }

  getAvailableQueries(): Observable<{ success: boolean; data: any[] }> {
    return this.http.get<any>(`${this.apiUrl}/queries`);
  }

  getAvailablePythonScripts(): Observable<{ success: boolean; data: any[] }> {
    return this.http.get<any>(`${this.apiUrl}/python/scripts`);
  }

  // --- Profesyonel Widget Kataloğu (Fabrika / Şirket uyumlu) ---
  getWidgetCatalog(): { category: string; icon: string; widgets: Widget[] }[] {
    return [
      {
        category: 'Production',
        icon: 'fas fa-industry',
        widgets: [
          { id: 'oee-monitor', type: 'oee', title: 'OEE Monitor', icon: 'fas fa-tachometer-alt', w: 2, h: 2, category: 'Production', description: 'Overall Equipment Effectiveness', config: { visualType: 'Gauge Chart' } },
          { id: 'production-line', type: 'line-status', title: 'Production Line Status', icon: 'fas fa-conveyor-belt', w: 2, h: 1, category: 'Production', description: 'Hat durumu ve kapasite kullanımı', config: { visualType: 'Status Board' } },
          { id: 'shift-overview', type: 'shift', title: 'Shift Overview', icon: 'fas fa-clock', w: 1, h: 1, category: 'Production', description: 'Vardiya bazında üretim özeti', config: { visualType: 'KPI Card' } },
          { id: 'downtime-tracker', type: 'downtime', title: 'Downtime Tracker', icon: 'fas fa-pause-circle', w: 2, h: 1, category: 'Production', description: 'Duruş süreleri ve nedenleri', config: { visualType: 'Timeline' } },
        ]
      },
      {
        category: 'Quality',
        icon: 'fas fa-award',
        widgets: [
          { id: 'defect-rate', type: 'defect', title: 'Defect Rate', icon: 'fas fa-bug', w: 1, h: 1, category: 'Quality', description: 'Hata oranı ve trend analizi', config: { visualType: 'Sparkline' } },
          { id: 'spc-chart', type: 'spc', title: 'SPC Chart', icon: 'fas fa-chart-area', w: 2, h: 2, category: 'Quality', description: 'İstatistiksel proses kontrol', config: { visualType: 'Area Chart' } },
          { id: 'quality-gate', type: 'gate', title: 'Quality Gate', icon: 'fas fa-check-double', w: 1, h: 1, category: 'Quality', description: 'Kalite kapısı durumları', config: { visualType: 'Donut Chart' } },
        ]
      },
      {
        category: 'Energy',
        icon: 'fas fa-bolt',
        widgets: [
          { id: 'energy-consumption', type: 'energy', title: 'Energy Consumption', icon: 'fas fa-plug', w: 2, h: 2, category: 'Energy', description: 'Enerji tüketim haritası', config: { visualType: 'Heatmap' } },
          { id: 'power-factor', type: 'power', title: 'Power Factor', icon: 'fas fa-car-battery', w: 1, h: 1, category: 'Energy', description: 'Güç faktörü izleme', config: { visualType: 'Gauge Chart' } },
          { id: 'carbon-footprint', type: 'carbon', title: 'Carbon Footprint', icon: 'fas fa-leaf', w: 1, h: 1, category: 'Energy', description: 'CO₂ emisyon takibi', config: { visualType: 'KPI Card' } },
        ]
      },
      {
        category: 'Logistics',
        icon: 'fas fa-truck',
        widgets: [
          { id: 'inventory-level', type: 'inventory', title: 'Inventory Level', icon: 'fas fa-boxes-stacked', w: 2, h: 1, category: 'Logistics', description: 'Stok seviyesi ve alarmlar', config: { visualType: 'Bar Chart' } },
          { id: 'shipment-tracker', type: 'shipment', title: 'Shipment Tracker', icon: 'fas fa-truck-fast', w: 2, h: 1, category: 'Logistics', description: 'Sevkiyat durumu izleme', config: { visualType: 'Map View' } },
        ]
      },
      {
        category: 'Analytics',
        icon: 'fas fa-chart-pie',
        widgets: [
          { id: 'trend-analysis', type: 'line', title: 'Trend Analysis', icon: 'fas fa-chart-line', w: 2, h: 2, category: 'Analytics', description: 'Zaman serisi trend görüntüleme', config: { visualType: 'Line Chart' } },
          { id: 'category-breakdown', type: 'bar', title: 'Category Breakdown', icon: 'fas fa-chart-bar', w: 2, h: 2, category: 'Analytics', description: 'Kategori bazlı karşılaştırma', config: { visualType: 'Bar Chart' } },
          { id: 'data-explorer', type: 'grid', title: 'Data Explorer', icon: 'fas fa-table', w: 4, h: 2, category: 'Analytics', description: 'Tablo veri gezgini', config: { visualType: 'Data Grid' } },
          { id: 'kpi-summary', type: 'kpi', title: 'KPI Summary', icon: 'fas fa-layer-group', w: 1, h: 1, category: 'Analytics', description: 'Anahtar performans göstergeleri', config: { visualType: 'Scorecard' } },
        ]
      },
      {
        category: 'Realtime',
        icon: 'fas fa-satellite-dish',
        widgets: [
          { id: 'live-sensor', type: 'sensor', title: 'Live Sensor Feed', icon: 'fas fa-wave-square', w: 2, h: 1, category: 'Realtime', description: 'Gerçek zamanlı sensör verisi', config: { visualType: 'Live Stream' } },
          { id: 'alert-timeline', type: 'alerts', title: 'Alert Timeline', icon: 'fas fa-bell', w: 2, h: 2, category: 'Realtime', description: 'Alarm geçmişi ve ciddiyeti', config: { visualType: 'List View' } },
          { id: 'system-health', type: 'health', title: 'System Health', icon: 'fas fa-heartbeat', w: 1, h: 1, category: 'Realtime', description: 'Sistem sağlık durumu', config: { visualType: 'Status Board' } },
        ]
      }
    ];
  }
}
