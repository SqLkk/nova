import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { v4 as uuidv4 } from 'uuid';
import { Subscription } from 'rxjs';
import { DashboardEditService, Widget } from '../../services/dashboard-edit.service';

export interface DataConnection {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'degraded';
  latencyMs: number;
}

export interface MetricCard {
  id: string;
  title: string;
  value: string;
  unit: string;
  trend: 'up' | 'down' | 'stable';
  trendValue: string;
  icon: string;
  colorClass: string;
}

export { Widget };

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class DashboardComponent implements OnInit, OnDestroy {
  editMode = false;

  // Generic Data Connections
  connections: DataConnection[] = [
    { id: 'db-main', name: 'Primary Database', status: 'online', latencyMs: 12 },
    { id: 'db-analytics', name: 'Analytics Engine', status: 'online', latencyMs: 45 },
    { id: 'api-gateway', name: 'API Gateway', status: 'degraded', latencyMs: 250 },
  ];

  // Generic Business Metrics
  metrics: MetricCard[] = [
    { id: 'revenue', title: 'Total Revenue', value: '$124,500', unit: 'USD', trend: 'up', trendValue: '+14%', icon: 'fas fa-chart-line', colorClass: 'blue' },
    { id: 'users', title: 'Active Users', value: '45,231', unit: 'Users', trend: 'up', trendValue: '+5.2%', icon: 'fas fa-users', colorClass: 'emerald' },
    { id: 'latency', title: 'Avg Latency', value: '112', unit: 'ms', trend: 'down', trendValue: '-12ms', icon: 'fas fa-bolt', colorClass: 'amber' },
    { id: 'errors', title: 'Error Rate', value: '0.04', unit: '%', trend: 'stable', trendValue: '0%', icon: 'fas fa-shield-alt', colorClass: 'purple' }
  ];

  activeWidgets: Widget[] = [];
  private originalWidgets: Widget[] = [];
  private subs: Subscription[] = [];

  // Config Modal State
  showConfigModal = false;
  configuringWidget: Widget | null = null;
  availableSqlQueries: any[] = [];
  availablePythonScripts: any[] = [];

  constructor(
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    public dashEdit: DashboardEditService
  ) {}

  ngOnInit(): void {
    // Load dashboard from API
    this.subs.push(
      this.dashEdit.loadMyDashboard().subscribe({
        next: (res) => {
          if (res.success && res.data.layout && res.data.layout.length > 0) {
            this.activeWidgets = res.data.layout;
          } else {
            // Initialize with some default widgets for WOW factor if layout is empty
            const catalog = this.dashEdit.getWidgetCatalog();
            const production = catalog.find(c => c.category === 'Production');
            const analytics = catalog.find(c => c.category === 'Analytics');
            const energy = catalog.find(c => c.category === 'Energy');

            this.activeWidgets = [
              { ...(production?.widgets[0] || catalog[0].widgets[0]), id: uuidv4() },
              { ...(analytics?.widgets[0] || catalog[0].widgets[0]), id: uuidv4() },
              { ...(energy?.widgets[0] || catalog[0].widgets[0]), id: uuidv4() },
            ];
          }
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Failed to load dashboard', err);
        }
      })
    );

    // Listen for edit mode changes from service
    this.subs.push(
      this.dashEdit.editMode$.subscribe(mode => {
        this.editMode = mode;
        if (mode) {
          this.originalWidgets = JSON.parse(JSON.stringify(this.activeWidgets));
        }
        this.cdr.detectChanges();
      })
    );

    // Listen for widget add requests from navigation sidebar
    this.subs.push(
      this.dashEdit.addWidget$.subscribe(widget => {
        const newWidget = { ...widget, id: uuidv4() };
        this.activeWidgets = [...this.activeWidgets, newWidget];
        this.cdr.detectChanges();
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    // Ensure edit mode is off when leaving dashboard
    this.dashEdit.setEditMode(false);
  }

  toggleEditMode(): void {
    this.dashEdit.toggleEditMode();
  }

  finishEditing(): void {
    this.dashEdit.saveMyDashboard(this.activeWidgets).subscribe({
      next: (res) => {
        if (res.success) {
          this.dashEdit.setEditMode(false);
        }
      },
      error: (err) => {
        console.error('Failed to save dashboard', err);
        this.dashEdit.setEditMode(false); // still close on error for now
      }
    });
  }

  cancelEditing(): void {
    this.activeWidgets = JSON.parse(JSON.stringify(this.originalWidgets));
    this.dashEdit.setEditMode(false);
    this.cdr.detectChanges();
  }

  removeWidget(id: string): void {
    this.activeWidgets = this.activeWidgets.filter(w => w.id !== id);
    this.cdr.detectChanges();
  }

  onDragDrop(event: CdkDragDrop<Widget[]>): void {
    moveItemInArray(this.activeWidgets, event.previousIndex, event.currentIndex);
    this.cdr.detectChanges();
  }

  // --- Configuration Modal Methods ---

  openWidgetConfig(widget: Widget): void {
    // Clone to avoid live-updating until saved
    this.configuringWidget = JSON.parse(JSON.stringify(widget));
    if (!this.configuringWidget!.dataSourceType) {
      this.configuringWidget!.dataSourceType = 'sql';
    }
    this.showConfigModal = true;
    
    // Load available queries and scripts
    this.subs.push(
      this.dashEdit.getAvailableQueries().subscribe(res => {
        if (res.success) this.availableSqlQueries = res.data;
        this.cdr.detectChanges();
      })
    );
    
    this.subs.push(
      this.dashEdit.getAvailablePythonScripts().subscribe(res => {
        if (res.success) this.availablePythonScripts = res.data;
        this.cdr.detectChanges();
      })
    );
  }

  closeWidgetConfig(): void {
    this.showConfigModal = false;
    this.configuringWidget = null;
  }

  saveWidgetConfig(): void {
    if (this.configuringWidget) {
      const index = this.activeWidgets.findIndex(w => w.id === this.configuringWidget!.id);
      if (index !== -1) {
        this.activeWidgets[index] = { ...this.configuringWidget };
        // Clean up unused properties based on selection
        if (this.activeWidgets[index].dataSourceType === 'sql') {
          delete this.activeWidgets[index].assignedPythonId;
        } else if (this.activeWidgets[index].dataSourceType === 'python') {
          delete this.activeWidgets[index].assignedQueryId;
        }
      }
    }
    this.closeWidgetConfig();
  }
}
