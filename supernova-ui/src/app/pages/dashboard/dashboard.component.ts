import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { v4 as uuidv4 } from 'uuid';
import { Subscription } from 'rxjs';
import { DashboardEditService, Widget, DashboardSummary, DashboardDetail } from '../../services/dashboard-edit.service';
import { AuthService } from '../../services/auth.service';
import { AdminService } from '../../services/admin.service';

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

  // Multi-Dashboard State
  dashboards: DashboardSummary[] = [];
  activeDashboard: DashboardDetail | null = null;
  activeDashboardId = '';
  showDashboardSelector = false;
  dashboardSearch = '';
  loadingDashboard = false;

  // Create & Settings Modal
  showCreateModal = false;
  createForm = { name: '', description: '', isDefault: false };
  showSettingsModal = false;
  settingsForm = { name: '', description: '', isDefault: false };

  // Sharing Modal State
  showSharingModal = false;
  sharingDashboard: DashboardSummary | DashboardDetail | null = null;
  shareRoles = new Set<string>();
  shareUsers: string[] = [];
  shareUserInput = '';
  shareSaving = false;
  roleKeys = ['admin', 'engineer', 'operator', 'viewer'];
  shareUsersList: any[] = [];
  loadingUsers = false;

  // Notifications & Confirmations
  notificationMsg = '';
  private notifTimer: any = null;
  confirmDialog: { show: boolean; title: string; message: string; action: () => void } = {
    show: false,
    title: '',
    message: '',
    action: () => {}
  };

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
    public dashEdit: DashboardEditService,
    public auth: AuthService,
    private admin: AdminService
  ) {}

  ngOnInit(): void {
    this.loadRolesList();
    this.loadDashboardsList();

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
    if (this.notifTimer) clearTimeout(this.notifTimer);
    this.dashEdit.setEditMode(false);
  }

  // ---- Multi-Dashboard Lifecycle ----

  loadDashboardsList(selectId?: string): void {
    this.subs.push(
      this.dashEdit.listDashboards().subscribe({
        next: (res) => {
          if (res.success) {
            this.dashboards = res.data || [];
            if (selectId) {
              this.loadDashboard(selectId);
            } else if (this.activeDashboardId && this.dashboards.some(d => d.id === this.activeDashboardId)) {
              this.loadDashboard(this.activeDashboardId);
            } else if (this.dashboards.length > 0) {
              const def = this.dashboards.find(d => d.isDefault) || this.dashboards[0];
              this.loadDashboard(def.id);
            } else {
              this.loadFallbackMyDashboard();
            }
          }
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Failed to list dashboards', err);
          this.loadFallbackMyDashboard();
        }
      })
    );
  }

  loadFallbackMyDashboard(): void {
    this.subs.push(
      this.dashEdit.loadMyDashboard().subscribe({
        next: (res) => {
          if (res.success && res.data) {
            this.activeDashboardId = res.data.id;
            this.activeDashboard = res.data as any;
            if (res.data.layout && res.data.layout.length > 0) {
              this.activeWidgets = res.data.layout;
            } else {
              this.initDefaultWidgets();
            }
          }
          this.cdr.detectChanges();
        },
        error: (err) => console.error('Failed to load my dashboard', err)
      })
    );
  }

  loadDashboard(id: string): void {
    this.loadingDashboard = true;
    this.activeDashboardId = id;
    this.subs.push(
      this.dashEdit.getDashboard(id).subscribe({
        next: (res) => {
          this.loadingDashboard = false;
          if (res.success && res.data) {
            this.activeDashboard = res.data;
            this.activeWidgets = res.data.layout || [];
            if (this.activeWidgets.length === 0) {
              this.initDefaultWidgets();
            }
          }
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.loadingDashboard = false;
          console.error('Failed to load dashboard', err);
          this.notify('Dashboard yüklenirken hata oluştu.');
        }
      })
    );
  }

  initDefaultWidgets(): void {
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

  toggleEditMode(): void {
    this.dashEdit.toggleEditMode();
  }

  finishEditing(): void {
    const saveObs = this.activeDashboardId
      ? this.dashEdit.saveDashboardLayout(this.activeDashboardId, this.activeWidgets)
      : this.dashEdit.saveMyDashboard(this.activeWidgets);

    this.subs.push(
      saveObs.subscribe({
        next: (res) => {
          if (res.success) {
            this.dashEdit.setEditMode(false);
            if (this.activeDashboard) {
              this.activeDashboard.layout = [...this.activeWidgets];
            }
            this.notify('Dashboard düzeni başarıyla kaydedildi.');
          }
        },
        error: (err) => {
          console.error('Failed to save dashboard', err);
          this.dashEdit.setEditMode(false);
          this.notify('Dashboard kaydedilirken hata oluştu.');
        }
      })
    );
  }

  // ---- Dashboard Switching & Selector ----

  toggleDashboardSelector(): void {
    this.showDashboardSelector = !this.showDashboardSelector;
  }

  closeDashboardSelector(): void {
    this.showDashboardSelector = false;
    this.dashboardSearch = '';
  }

  selectDashboard(d: DashboardSummary): void {
    this.closeDashboardSelector();
    if (this.activeDashboardId !== d.id) {
      this.loadDashboard(d.id);
    }
  }

  get currentUserId(): string {
    return this.auth.getCurrentUser()?.id || '';
  }

  isOwner(d: DashboardSummary | DashboardDetail | null): boolean {
    if (!d) return false;
    return !!d.owner && d.owner === this.currentUserId;
  }

  canAllManage(): boolean {
    return this.auth.isAdmin() || this.auth.isSuperUser();
  }

  canModify(d: DashboardSummary | DashboardDetail | null): boolean {
    if (!d) return false;
    return this.isOwner(d) || this.canAllManage();
  }

  canManageVisibility(d: DashboardSummary | DashboardDetail | null): boolean {
    if (!d) return false;
    return this.canModify(d) || this.auth.hasPermission('share:dashboards');
  }

  userChecklistMode(): boolean {
    return this.canAllManage();
  }

  get myDashboards(): DashboardSummary[] {
    const q = this.dashboardSearch.trim().toLowerCase();
    return this.dashboards.filter(d => this.isOwner(d) && (!q || d.name.toLowerCase().includes(q)));
  }

  get sharedDashboards(): DashboardSummary[] {
    const q = this.dashboardSearch.trim().toLowerCase();
    return this.dashboards.filter(d => !this.isOwner(d) && (!q || d.name.toLowerCase().includes(q)));
  }

  // ---- CRUD & Actions ----

  openCreateModal(): void {
    this.createForm = { name: '', description: '', isDefault: false };
    this.showCreateModal = true;
    this.closeDashboardSelector();
  }

  closeCreateModal(): void {
    this.showCreateModal = false;
  }

  submitCreateDashboard(): void {
    const name = this.createForm.name.trim() || 'Yeni Dashboard';
    this.subs.push(
      this.dashEdit.createDashboard({
        name,
        description: this.createForm.description.trim(),
        isDefault: this.createForm.isDefault,
        layout: []
      }).subscribe({
        next: (res) => {
          this.closeCreateModal();
          this.notify(`"${name}" dashboard'ı oluşturuldu.`);
          this.loadDashboardsList(res.data.id);
        },
        error: (err) => {
          console.error('Failed to create dashboard', err);
          this.notify('Dashboard oluşturulamadı.');
        }
      })
    );
  }

  openSettingsModal(): void {
    if (!this.activeDashboard) return;
    this.settingsForm = {
      name: this.activeDashboard.name,
      description: this.activeDashboard.description || '',
      isDefault: this.activeDashboard.isDefault
    };
    this.showSettingsModal = true;
  }

  closeSettingsModal(): void {
    this.showSettingsModal = false;
  }

  saveSettings(): void {
    if (!this.activeDashboard) return;
    const id = this.activeDashboard.id;
    const name = this.settingsForm.name.trim() || this.activeDashboard.name;
    this.subs.push(
      this.dashEdit.updateDashboard(id, {
        name,
        description: this.settingsForm.description.trim(),
        isDefault: this.settingsForm.isDefault
      }).subscribe({
        next: () => {
          this.closeSettingsModal();
          this.notify('Dashboard ayarları güncellendi.');
          this.loadDashboardsList(id);
        },
        error: (err) => {
          console.error('Failed to update dashboard', err);
          this.notify('Ayarlar kaydedilemedi.');
        }
      })
    );
  }

  duplicateActiveDashboard(): void {
    if (!this.activeDashboard) return;
    const id = this.activeDashboard.id;
    this.subs.push(
      this.dashEdit.duplicateDashboard(id).subscribe({
        next: (res) => {
          this.notify(`"${res.data.name}" oluşturuldu.`);
          this.loadDashboardsList(res.data.id);
        },
        error: (err) => {
          console.error('Failed to duplicate dashboard', err);
          this.notify('Kopyalama başarısız oldu.');
        }
      })
    );
  }

  confirmDeleteActiveDashboard(): void {
    if (!this.activeDashboard) return;
    const id = this.activeDashboard.id;
    const name = this.activeDashboard.name;
    this.confirmDialog = {
      show: true,
      title: 'Dashboard Sil',
      message: `"${name}" dashboard'ını silmek istediğinize emin misiniz? Bu işlem geri alınamaz.`,
      action: () => {
        this.confirmDialog.show = false;
        this.subs.push(
          this.dashEdit.deleteDashboard(id).subscribe({
            next: () => {
              this.notify(`"${name}" silindi.`);
              this.activeDashboardId = '';
              this.activeDashboard = null;
              this.loadDashboardsList();
            },
            error: (err) => {
              console.error('Failed to delete dashboard', err);
              this.notify('Dashboard silinemedi.');
            }
          })
        );
      }
    };
  }

  // ---- Paylaşım (Sharing) ----

  loadRolesList(): void {
    this.subs.push(
      this.admin.getRoles().subscribe({
        next: (roles) => {
          if (roles?.length) {
            this.roleKeys = roles.map(r => r.key);
          }
        },
        error: () => {}
      })
    );
  }

  loadUsersList(): void {
    this.loadingUsers = true;
    this.subs.push(
      this.admin.getAdminUsers().subscribe({
        next: (users) => {
          this.shareUsersList = users || [];
          this.loadingUsers = false;
          this.cdr.detectChanges();
        },
        error: () => {
          this.loadingUsers = false;
          this.cdr.detectChanges();
        }
      })
    );
  }

  openSharing(d?: DashboardSummary | DashboardDetail): void {
    const target = d || this.activeDashboard;
    if (!target || !this.canManageVisibility(target)) return;
    this.sharingDashboard = target;
    this.shareRoles = new Set(target.allowedRoles || []);
    this.shareUsers = [...(target.allowedUsers || [])];
    this.shareUserInput = '';
    this.showSharingModal = true;
    if (this.userChecklistMode() && !this.shareUsersList.length && !this.loadingUsers) {
      this.loadUsersList();
    }
  }

  closeSharing(): void {
    this.showSharingModal = false;
    this.sharingDashboard = null;
  }

  toggleShareRole(key: string): void {
    if (this.shareRoles.has(key)) this.shareRoles.delete(key);
    else this.shareRoles.add(key);
  }

  isShareRoleOn(key: string): boolean {
    return this.shareRoles.has(key);
  }

  toggleShareUser(id: string): void {
    const i = this.shareUsers.indexOf(id);
    if (i >= 0) this.shareUsers.splice(i, 1);
    else this.shareUsers.push(id);
  }

  isShareUserOn(id: string): boolean {
    return this.shareUsers.includes(id);
  }

  addShareUserInput(): void {
    const v = this.shareUserInput.trim();
    if (!v) return;
    if (!this.shareUsers.some(u => u.toLowerCase() === v.toLowerCase())) {
      this.shareUsers.push(v);
    }
    this.shareUserInput = '';
  }

  removeShareUser(name: string): void {
    this.shareUsers = this.shareUsers.filter(u => u !== name);
  }

  saveSharing(): void {
    if (!this.sharingDashboard) return;
    this.shareSaving = true;
    const id = this.sharingDashboard.id;
    this.subs.push(
      this.dashEdit.updateSharing(id, [...this.shareRoles], this.shareUsers).subscribe({
        next: () => {
          this.shareSaving = false;
          this.notify('Paylaşım izinleri kaydedildi.');
          this.closeSharing();
          this.loadDashboardsList(id);
        },
        error: (err) => {
          this.shareSaving = false;
          console.error('Failed to update sharing', err);
          this.notify('Paylaşım kaydedilemedi.');
          this.cdr.detectChanges();
        }
      })
    );
  }

  notify(msg: string): void {
    this.notificationMsg = msg;
    if (this.notifTimer) clearTimeout(this.notifTimer);
    this.notifTimer = setTimeout(() => {
      this.notificationMsg = '';
      this.cdr.detectChanges();
    }, 3500);
    this.cdr.detectChanges();
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

  // --- app-widget canlı motor köprüsü ---

  private readonly noPaths: string[] = [];
  private pathsCache = new Map<string, string[]>();

  /** Widget canlı bir SQL/Python kaynağına bağlı mı (yoksa placeholder göster)? */
  hasLiveDataSource(w: Widget): boolean {
    return !!(w && (w.assignedQueryId || w.assignedPythonId));
  }

  /** app-widget dataSourceType girdisi. */
  widgetDataSourceType(w: Widget): 'sql' | 'python' {
    return w.assignedPythonId ? 'python' : 'sql';
  }

  /** app-widget initialPaths girdisi (sql://<queryId> | python://<scriptId>).
   *  Referans-kararlı (cache'li) — change-detection gereksiz re-fetch tetiklemez. */
  widgetInitialPaths(w: Widget): string[] {
    const key = w.id + '::sql:' + (w.assignedQueryId || '') + '::py:' + (w.assignedPythonId || '');
    const cached = this.pathsCache.get(key);
    if (cached) return cached;
    let paths: string[];
    if (w.assignedQueryId) paths = ['sql://' + w.assignedQueryId];
    else if (w.assignedPythonId) paths = ['python://' + w.assignedPythonId];
    else paths = this.noPaths;
    this.pathsCache.set(key, paths);
    return paths;
  }

  /** Katalog visualType → app-widget widgetType eşlemesi. */
  widgetChartType(w: Widget): string {
    const map: Record<string, string> = {
      'Line Chart': 'line-chart',
      'Area Chart': 'area-chart',
      'Bar Chart': 'bar-chart',
      'Donut Chart': 'doughnut',
      'Gauge Chart': 'gauge',
      'Data Grid': 'data-table',
      'List View': 'table',
      'KPI Card': 'value',
      'Scorecard': 'value',
      'Sparkline': 'line-chart',
      'Heatmap': 'heatmap',
      'Live Stream': 'line-chart',
      'Status Board': 'value',
      'Timeline': 'line-chart',
      'Map View': 'table'
    };
    return w?.config?.widgetType || map[w?.config?.visualType] || 'line-chart';
  }
}
