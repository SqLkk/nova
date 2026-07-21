import { Component, OnInit, OnDestroy, HostListener, ElementRef, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { TranslateService } from '@ngx-translate/core';
import { ThemeService } from '../../services/theme.service';
import { DashboardEditService, Widget } from '../../services/dashboard-edit.service';
import { DataSourceSelectionService, SourceStatus } from '../../services/data-source-selection.service';
import { DataSource } from '../../models/data-source.model';

interface NavItem {
  key: string;
  title: string;
  icon: string;
  route: string;
  pageKey: string;
}

/**
 * Uygulamanın tek navigasyonu: daraltılabilir sol sidebar.
 *
 * Token-tabanlıdır (styles.scss / tailwind.config.js anlamsal renkleri).
 * Yetkilendirme authService.hasPageAccess(pageKey) üzerinden yapılır;
 * özellikle Admin yalnızca yetkili rollere gösterilir.
 */
@Component({
  standalone: false,
  selector: 'app-navigation',
  templateUrl: './navigation.component.html',
  styleUrl: './navigation.component.scss'
})
export class NavigationComponent implements OnInit, OnDestroy {
  @ViewChild('userMenuRef') userMenuRef!: ElementRef;
  @ViewChild('languageMenuRef') languageMenuRef!: ElementRef;

  /** Dashboard edit mode — sidebar widget kataloğuna dönüşür. */
  dashboardEditMode = false;
  widgetCatalog: { category: string; icon: string; widgets: Widget[] }[] = [];
  expandedCategory: string | null = null;
  catalogSearchTerm = '';
  private editSub?: Subscription;

  /** Table Explorer accordion: altında DB listesi açılır. */
  expandedTableExplorer = false;
  navDataSources: DataSource[] = [];
  navStatuses: Record<string, SourceStatus> = {};
  navSelectedId: string | null = null;
  private dssListSub?: Subscription;
  private dssStatusSub?: Subscription;
  private dssSelectedSub?: Subscription;

  /** Sidebar daraltılmış mı? */
  isExpanded = true;
  private wasManuallyCollapsed = false;

  theme: 'light' | 'dark' = 'dark';

  /** Ana navigasyon öğeleri (başlıklar i18n'den beslenir). */
  navigationItems: NavItem[] = [...NavigationComponent.BASE_NAV];

  /** Admin paneli (yönetici yetkisiyle görünüp görünür). */
  readonly adminItem: NavItem = {
    key: 'NAV.ADMIN',
    title: 'Admin Panel',
    icon: 'fas fa-user-shield',
    route: '/admin',
    pageKey: 'admin'
  };

  /** Table Explorer (admin panelinin yanında). */
  readonly tableExplorerItem: NavItem = {
    key: 'NAV.TABLE_EXPLORER',
    title: 'Table Explorer',
    icon: 'fas fa-table',
    route: '/table-explorer',
    pageKey: 'table-explorer'
  };



  currentUser: any = null;
  isUserMenuOpen = false;
  isLanguageMenuOpen = false;
  currentLanguage = 'en';

  languages = [
    { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' }
  ];

  // Çıkış onay modalı
  showLogoutModal = false;

  private static readonly BASE_NAV: NavItem[] = [
    { key: 'NAV.DASHBOARD', title: 'Dashboard', icon: 'fas fa-chart-line', route: '/dashboard', pageKey: 'dashboard' },
    { key: 'NAV.NETWORK_MAP', title: 'Network Map', icon: 'fas fa-space-shuttle', route: '/network-map', pageKey: 'network-map' },
    { key: 'NAV.TEMPLATE_BUILDER', title: 'Template Builder', icon: 'fas fa-file-spreadsheet', route: '/template-builder', pageKey: 'template-builder' },
    { key: 'NAV.REPORTS', title: 'Reports', icon: 'fas fa-file-lines', route: '/reports', pageKey: 'reports' },
    { key: 'NAV.ALARMS', title: 'Alarms', icon: 'fas fa-bell', route: '/alarms', pageKey: 'alarms' }
  ];

  constructor(
    private router: Router,
    private authService: AuthService,
    public translate: TranslateService,
    private themeService: ThemeService,
    public dashEdit: DashboardEditService,
    public dss: DataSourceSelectionService
  ) {
    const savedLang = localStorage.getItem('selectedLanguage') || 'en';
    this.currentLanguage = savedLang;
    translate.setDefaultLang('en');
    translate.use(savedLang);
  }

  ngOnInit(): void {
    this.currentUser = this.authService.getCurrentUser();
    this.checkScreenSize();

    // Tema ikonu tek kaynak (ThemeService) üzerinden senkron kalsın.
    // AppComponent zaten ThemeService.init() çağırır.
    this.themeService.themeChanges$.subscribe(theme => (this.theme = theme));
    this.theme = this.themeService.current;

    this.applyTranslations();
    this.translate.onLangChange.subscribe(() => this.applyTranslations());

    // Dashboard edit mode dinle
    this.widgetCatalog = this.dashEdit.getWidgetCatalog();
    this.editSub = this.dashEdit.editMode$.subscribe(mode => {
      this.dashboardEditMode = mode;
      if (mode) {
        this.isExpanded = true; // Edit modda sidebar'ı aç
      }
    });

    // Table Explorer altındaki DB listesi (paylaşılan seçim servisi).
    if (this.hasAccess('table-explorer')) {
      this.dss.load();
      this.dssListSub = this.dss.dataSources$.subscribe(list => (this.navDataSources = list));
      this.dssStatusSub = this.dss.statuses$.subscribe(st => (this.navStatuses = st));
      this.dssSelectedSub = this.dss.selectedId$.subscribe(id => (this.navSelectedId = id));
    }
  }

  ngOnDestroy(): void {
    this.editSub?.unsubscribe();
    this.dssListSub?.unsubscribe();
    this.dssStatusSub?.unsubscribe();
    this.dssSelectedSub?.unsubscribe();
  }

  // --- Layout ---

  toggleSidebar(): void {
    this.isExpanded = !this.isExpanded;
    if (window.innerWidth > 768) {
      this.wasManuallyCollapsed = !this.isExpanded;
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.checkScreenSize();
  }

  private checkScreenSize(): void {
    if (window.innerWidth <= 768) {
      this.isExpanded = false;
    } else if (!this.wasManuallyCollapsed) {
      this.isExpanded = true;
    }
  }

  // --- Tema ---

  toggleTheme(): void {
    this.themeService.toggle();
  }

  // --- Kullanıcı menüsü ---

  toggleUserMenu(): void {
    this.isUserMenuOpen = !this.isUserMenuOpen;
    this.isLanguageMenuOpen = false;
  }

  closeUserMenu(): void {
    this.isUserMenuOpen = false;
  }

  // --- Dil ---

  toggleLanguageMenu(): void {
    this.isLanguageMenuOpen = !this.isLanguageMenuOpen;
    this.isUserMenuOpen = false;
  }

  closeLanguageMenu(): void {
    this.isLanguageMenuOpen = false;
  }

  changeLanguage(langCode: string): void {
    this.currentLanguage = langCode;
    this.translate.use(langCode);
    localStorage.setItem('selectedLanguage', langCode);
    this.closeLanguageMenu();
  }

  getCurrentLanguageFlag(): string {
    const lang = this.languages.find(l => l.code === this.currentLanguage);
    return lang ? lang.flag : '🇬🇧';
  }

  // --- Çıkış ---

  logout(): void {
    this.showLogoutModal = true;
    this.isUserMenuOpen = false;
  }

  confirmLogout(): void {
    this.showLogoutModal = false;
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  cancelLogout(): void {
    this.showLogoutModal = false;
  }

  // --- Yetki ---

  hasAccess(pageKey: string): boolean {
    return this.authService.hasPageAccess(pageKey);
  }

  // --- Widget Catalog (Edit Mode) ---

  toggleCategory(cat: string): void {
    this.expandedCategory = this.expandedCategory === cat ? null : cat;
  }

  // --- Table Explorer DB accordion ---

  toggleTableExplorerGroup(): void {
    this.expandedTableExplorer = !this.expandedTableExplorer;
  }

  /** DB alt item'ına tıkla → paylaşılan seçimi güncelle + table-explorer'a git. */
  selectSource(id: string): void {
    this.dss.select(id);
  }

  /** Table Explorer parent, /table-explorer rotasındayken aktif highlight alsın. */
  isTableExplorerActive(): boolean {
    return this.router.url.startsWith('/table-explorer');
  }

  /** Template için durum sınıfı (status noktası rengi). */
  statusFor(id: string): SourceStatus {
    return this.navStatuses[id] || 'checking';
  }

  addWidgetToDashboard(widget: Widget): void {
    this.dashEdit.requestAddWidget(widget);
  }

  get filteredCatalog(): { category: string; icon: string; widgets: Widget[] }[] {
    const term = this.catalogSearchTerm.trim().toLowerCase();
    if (!term) return this.widgetCatalog;
    return this.widgetCatalog
      .map(cat => ({
        ...cat,
        widgets: cat.widgets.filter(w =>
          w.title.toLowerCase().includes(term) ||
          w.category.toLowerCase().includes(term) ||
          (w.description || '').toLowerCase().includes(term)
        )
      }))
      .filter(cat => cat.widgets.length > 0);
  }

  // --- Dahili ---

  private applyTranslations(): void {
    const keys = this.navigationItems.map(i => i.key).concat(
      this.adminItem.key, this.tableExplorerItem.key);
    this.translate.get(keys).subscribe(t => {
      this.navigationItems = NavigationComponent.BASE_NAV.map(i => ({
        ...i,
        title: t[i.key] || i.title
      }));
      this.adminItem.title = t[this.adminItem.key] || this.adminItem.title;
      this.tableExplorerItem.title = t[this.tableExplorerItem.key] || this.tableExplorerItem.title;
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.userMenuRef && !this.userMenuRef.nativeElement.contains(event.target)) {
      this.isUserMenuOpen = false;
    }
    if (this.languageMenuRef && !this.languageMenuRef.nativeElement.contains(event.target)) {
      this.isLanguageMenuOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.isUserMenuOpen = false;
    this.isLanguageMenuOpen = false;
  }
}
