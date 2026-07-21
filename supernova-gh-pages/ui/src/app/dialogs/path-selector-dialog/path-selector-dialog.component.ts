import { Component, EventEmitter, Input, OnInit, Output, OnChanges, SimpleChanges, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { forkJoin } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { TableExplorerService } from '../../services/table-explorer.service';
import { TranslateService } from '@ngx-translate/core';
import { validateFormula, extractVariables } from '../../utils/formula-engine';
import { CHART_PALETTE } from '../../shared/theme/palette';

export interface PathSelectorDialogResult {
  paths: string[];
  updateInterval: number;
  animationsEnabled: boolean;
  dataSourceType?: 'realtime' | 'historical' | 'app' | 'sql' | 'python' | 'python';
  startDate?: string;
  endDate?: string;
  thresholds?: { 
    warning?: number; 
    danger?: number; 
    unit?: string;
    thresholdsEnabled: boolean; 
  };
  seriesColors?: string[];
  customTitle?: string;
  formula?: string;
  decimalPlaces?: number;
  decimalPlacesEnabled?: boolean;
  activePaths?: { [path: string]: boolean };
  sqlValueColumn?: string;
  sqlLabelColumn?: string;
}

export interface PathInfo {
  id: string;
  name: string;
  parent_id?: string;
  path_id?: string;
  combination_id?: number; // Realtime B3 için combination_id
  nim_satz?: number; // Element için nim_satz değeri
}

@Component({
  standalone: false,
  selector: 'app-path-selector-dialog',
  templateUrl: './path-selector-dialog.component.html',
  styleUrls: ['./path-selector-dialog.component.scss']
})
export class PathSelectorDialogComponent implements OnInit, OnChanges {
  @ViewChild('dialogContent') dialogContent!: ElementRef<HTMLDivElement>;
  @Input() visible = false;
  @Input() currentPaths: string[] = [];
  @Input() currentActivePaths: { [path: string]: boolean } = {};
  @Input() dataSourceType: 'realtime' | 'historical' | 'app' | 'sql' | 'python' | 'python' = 'historical';
  @Input() startDate: string = '';
  @Input() endDate: string = '';
  @Input() currentRefreshRate?: number; // Mevcut refresh rate'i dialog'a geç
  @Input() currentDecimalPlaces?: number; // Mevcut decimal places değerini dialog'a geç
  @Input() currentDecimalPlacesEnabled?: boolean; // Mevcut decimal places aktiflik durumu
  @Input() mode: 'report' | 'widget' = 'widget'; // report modunda widget alanları gizlenir
  @Input() widgetType = 'line-chart'; // Widget type for dynamic column mappings
  @Input() pathSelectedCallback?: (result: PathSelectorDialogResult) => void; // Direct callback bypass
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() pathSelected = new EventEmitter<PathSelectorDialogResult>();
  
  // Debug mode - Production'da false yapın
  private DEBUG_MODE = false; // Logları açmak için true yapın (şu anda test için true)
  
  // Path seçim değişkenleri (Sadece B1 için basitleştirildi)
  selectedPath = '';
  selectedB1Id = '';
  
  // Gereksiz değişkenler (ileride kullanım için bırakıldı)
  selectedB2Id = '';
  selectedB3Id = '';
  selectedElemId = '';
  selectedInfoId = '';
  selectedPaths: string[] = [];
  activePaths: { [path: string]: boolean } = {};
  showOnlyFormula = false;
  
  // Path listeleri (Sadece B1 için)
  pathsLevel1: PathInfo[] = [];
  
  // Gereksiz listeler (ileride kullanım için boş bırakıldı)
  pathsLevel2: PathInfo[] = [];
  pathsLevel3: PathInfo[] = [];
  pathsElem: PathInfo[] = [];
  pathsInfo: PathInfo[] = [];
  
  // Grafik ayarları
  updateInterval = 10000;
  animationsEnabled = true;
  decimalPlaces = 2;
  decimalPlacesEnabled = false;
  
  // Custom widget title
  customTitle = '';
  
  // Series colors per path
  seriesColors: string[] = [];
  defaultColorPalette = [...CHART_PALETTE];
  
  // Path selector mode: 'bulk' (quick search) vs 'tree' (hierarchical)
  pathSelectorMode: 'bulk' | 'tree' = 'bulk';
  
  // Eşik değerleri (şimdilik kullanılmıyor)
  thresholdsEnabled = false;
  warningThreshold: number | null = null;
  dangerThreshold: number | null = null;
  thresholdUnit = '';
  activeTab = 'paths';
  
  // Arama (Sadece B1 için)
  searchQuery = {
    b1: '',
    b2: '',
    b3: '',
    elem: '',
    info: ''
  };
  
  // Loading states
  loading = {
    b1: false,
    b2: false,
    b3: false,
    elem: false,
    info: false,
    graph: false
  };
  
  // Saved SQL Query variables
  savedExplorations: any[] = [];
  selectedSqlExpId = '';
  sqlSearchQuery = '';
  loadingSavedExplorations = false;
  sqlColumns: string[] = [];
  selectedSqlValueCol = '';
  selectedSqlLabelCol = '';
  loadingSqlColumns = false;
  sqlFoldersOpen: { [packageName: string]: boolean } = {};

  get filteredSavedExplorations(): any[] {
    if (!this.sqlSearchQuery || !this.sqlSearchQuery.trim()) {
      return this.savedExplorations;
    }
    const q = this.sqlSearchQuery.toLowerCase().trim();
    return this.savedExplorations.filter(e => 
      (e.name && e.name.toLowerCase().includes(q)) ||
      (e.table_name && e.table_name.toLowerCase().includes(q)) ||
      (e.source && e.source.toLowerCase().includes(q))
    );
  }

  // Grouped explorations by package name
  get groupedSavedExplorations(): { [packageName: string]: any[] } {
    const groups: { [packageName: string]: any[] } = {};
    const filtered = this.filteredSavedExplorations;
    
    filtered.forEach(exp => {
      const pkg = exp.package_name || 'General';
      if (!groups[pkg]) {
        groups[pkg] = [];
      }
      groups[pkg].push(exp);
    });
    
    return groups;
  }
  
  toggleSqlFolder(packageName: string): void {
    if (this.sqlFoldersOpen[packageName] === undefined) {
      this.sqlFoldersOpen[packageName] = false; // Collapse if it was open (default is open)
    } else {
      this.sqlFoldersOpen[packageName] = !this.sqlFoldersOpen[packageName];
    }
  }
  
  isSqlFolderOpen(packageName: string): boolean {
    if (this.sqlFoldersOpen[packageName] === undefined) {
      return true; // Default to open
    }
    return this.sqlFoldersOpen[packageName];
  }
  
  error = '';
  successMessage = '';

  // Formula support
  @Input() currentFormula: string = '';
  formula = '';
  formulaApplied = false;
  formulaError: string | null = null;
  formulaPresets = [
    { label: 'P1 + P2', formula: 'P1 + P2', desc: 'Sum two paths' },
    { label: 'P1 - P2', formula: 'P1 - P2', desc: 'Difference' },
    { label: 'AVG(P1, P2)', formula: 'AVG(P1, P2)', desc: 'Average' },
    { label: 'SUM(P1, P2, P3)', formula: 'SUM(P1, P2, P3)', desc: 'Sum multiple' },
    { label: 'MAX(P1, P2)', formula: 'MAX(P1, P2)', desc: 'Maximum' },
    { label: 'MIN(P1, P2)', formula: 'MIN(P1, P2)', desc: 'Minimum' },
    { label: 'P1 * 100 / P2', formula: 'P1 * 100 / P2', desc: 'Percentage' },
    { label: 'ABS(P1 - P2)', formula: 'ABS(P1 - P2)', desc: 'Abs diff' },
    { label: 'IF(P1 > P2, P1, P2)', formula: 'IF(P1 > P2, P1, P2)', desc: 'Conditional (max)' },
    { label: 'IF(P1 > 100, P1, 0)', formula: 'IF(P1 > 100, P1, 0)', desc: 'Threshold filter' },
    { label: 'ROUND(P1 / P2, 2)', formula: 'ROUND(P1 / P2, 2)', desc: 'Round result' },
    { label: 'CLAMP(P1, 0, 100)', formula: 'CLAMP(P1, 0, 100)', desc: 'Clamp range' },
  ];

  onFormulaChange(value: string): void {
    this.formula = value;
    // Reset "Added" state so user can re-apply with updated formula
    this.formulaApplied = false;
    if (!value || !value.trim()) {
      this.formulaError = null;
      return;
    }
    this.formulaError = validateFormula(value, this.selectedPaths.length);
    console.log(`📐 [FORMULA] onFormulaChange: "${value}" | paths: ${this.selectedPaths.length} | error: ${this.formulaError || 'none'}`);
  }

  applyFormulaPreset(preset: { formula: string }): void {
    this.formula = preset.formula;
    this.onFormulaChange(this.formula);
  }

  addFormulaToList(): void {
    if (this.formula && !this.formulaError) {
      this.formulaApplied = true;
      console.log(`📐 [FORMULA] addFormulaToList: formula="${this.formula}" applied=${this.formulaApplied}`);
    }
  }

  removeFormulaFromList(): void {
    this.formulaApplied = false;
    this.formula = '';
    this.formulaError = null;
  }

  // Formula tab: inline path search
  formulaSearchQuery = '';
  formulaSearchResults: Array<{ path: string; b1: string; b2: string; b3: string; elem: string; info: string; nimSatz?: number }> = [];
  formulaSearchLoading = false;

  runFormulaSearch(): void {
    const query = this.formulaSearchQuery.trim().toLowerCase();
    console.log(`📐 [FORMULA] runFormulaSearch: query="${query}" dataSourceType=${this.dataSourceType}`);
    if (query.length < 1) return;
    this.formulaSearchLoading = true;
    this.formulaSearchResults = [];

    if (this.dataSourceType === 'historical') {
      this.apiService.searchHistoricalPaths(query, 50, 'all').subscribe({
        next: (response) => {
          this.formulaSearchResults = (response?.data || []).map((r: any) => ({
            path: r.path, b1: r.b1, b2: r.b2, b3: r.b3, elem: r.elem, info: r.info
          }));
          console.log(`📐 [FORMULA] SYS search results: ${this.formulaSearchResults.length}`, this.formulaSearchResults.slice(0, 3));
          this.formulaSearchLoading = false;
          this.cdr.markForCheck();
        },
        error: (err) => { console.error('📐 [FORMULA] SYS search error:', err); this.formulaSearchLoading = false; this.cdr.markForCheck(); }
      });
      return;
    }

    // LIVE: reuse quick search logic
    const hierarchyObs = this.apiService.getRealTimeHierarchyStructure();
    const elementsObs = this.apiService.getRealTimeElementsStructure();
    forkJoin({ hierarchy: hierarchyObs, elements: elementsObs }).subscribe({
      next: ({ hierarchy, elements }) => {
        const comboMap = this.buildCombinationMap(hierarchy?.data || []);
        const results: Array<{ path: string; b1: string; b2: string; b3: string; elem: string; info: string; nimSatz?: number }> = [];
        for (const combo of comboMap.values()) {
          const text = `${combo.b1Name} ${combo.b2Name} ${combo.b3Name}`.toLowerCase();
          if (!text.includes(query)) continue;
          const elementMatches = this.findElementsByCombination(elements?.data || [], combo.combinationId);
          for (const elementMatch of elementMatches) {
            const infoOptions = this.getInfoOptionsForNoElType(elementMatch.noElType, elementMatch.name);
            for (const info of infoOptions) {
              const infoLabel = elementMatch.nimSatz ? `${info.name}[${elementMatch.nimSatz}]` : info.name;
              results.push({
                path: `${combo.b1Name}/${combo.b2Name}/${combo.b3Name}/${elementMatch.name}/${infoLabel}`,
                b1: combo.b1Name, b2: combo.b2Name, b3: combo.b3Name,
                elem: elementMatch.name, info: info.name, nimSatz: elementMatch.nimSatz
              });
              if (results.length >= 50) break;
            }
            if (results.length >= 50) break;
          }
          if (results.length >= 50) break;
        }
        this.formulaSearchResults = results;
        console.log(`📐 [FORMULA] LIVE search results: ${results.length}`, results.slice(0, 3));
        this.formulaSearchLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => { console.error('📐 [FORMULA] LIVE search error:', err); this.formulaSearchLoading = false; this.cdr.markForCheck(); }
    });
  }

  addFormulaSearchPath(path: string): void {
    console.log(`📐 [FORMULA] addFormulaSearchPath: "${path}" | already exists: ${this.selectedPaths.includes(path)}`);
    if (!this.selectedPaths.includes(path)) {
      this.selectedPaths.push(path);
      this.activePaths[path] = !this.showOnlyFormula;
      console.log(`📐 [FORMULA] Path added! selectedPaths now: ${this.selectedPaths.length}`, this.selectedPaths);
      // Re-validate formula with new path count
      if (this.formula) {
        this.formulaError = validateFormula(this.formula, this.selectedPaths.length);
        console.log(`📐 [FORMULA] Re-validated formula: error=${this.formulaError || 'none'}`);
      }
    }
  }

  clearFormula(): void {
    this.formula = '';
    this.formulaError = null;
    this.formulaApplied = false;
  }

  insertVariable(index: number): void {
    const varName = `P${index + 1}`;
    // Smart insert: add a space before if formula doesn't end with space/operator/paren
    if (this.formula && this.formula.trim() && !/[\s+\-*/,(]$/.test(this.formula)) {
      this.formula += ' + ';
    }
    this.formula += varName;
    this.onFormulaChange(this.formula);
  }

  insertOperator(op: string): void {
    const spaced = ['+', '-', '*', '/', '>', '<', '>=', '<=', '==', '!='];
    if (spaced.includes(op)) {
      this.formula = this.formula.trimEnd() + ' ' + op + ' ';
    } else {
      this.formula += op;
    }
    this.onFormulaChange(this.formula);
  }

  insertIfTemplate(): void {
    const a = this.selectedPaths.length >= 1 ? 'P1' : '0';
    const b = this.selectedPaths.length >= 2 ? 'P2' : '0';
    this.formula = (this.formula.trim() ? this.formula.trimEnd() + ' ' : '') + `IF(${a} > ${b}, ${a}, ${b})`;
    this.onFormulaChange(this.formula);
  }

  insertFunction(fn: string): void {
    // Build function with all path variables as arguments
    const args = this.selectedPaths.map((_, i) => `P${i + 1}`).join(', ');
    this.formula = `${fn}(${args})`;
    this.onFormulaChange(this.formula);
  }

  // Quick search + bulk add (realtime only for now)
  quickSearchMode: 'b1' | 'b2' | 'b3' | 'elem' | 'all' = 'all';
  quickSearchQuery = '';
  quickSearchFilter = '';
  quickFilterLevel: string = 'all';
  quickFilterMode: 'contains' | 'startsWith' | 'exact' = 'contains';
  quickSearchResults: Array<{
    path: string;
    b1: string;
    b2: string;
    b3: string;
    elem: string;
    info: string;
    nimSatz?: number;
  }> = [];
  quickSearchSelected = new Set<string>();
  quickSearchLoading = false;
  quickSearchError = '';
  quickSearchLimit = 200;
  quickSearchExpanded = false;

  get filteredQuickSearchResults() {
    if (!this.quickSearchFilter || !this.quickSearchFilter.trim()) return this.quickSearchResults;
    const filter = this.quickSearchFilter.toLowerCase().trim();
    return this.quickSearchResults.filter(r => {
      if (!r) return false;
      // Determine which field to match against based on level
      let value: string;
      switch (this.quickFilterLevel) {
        case 'b1':   value = String(r.b1 || '').toLowerCase(); break;
        case 'b2':   value = String(r.b2 || '').toLowerCase(); break;
        case 'b3':   value = String(r.b3 || '').toLowerCase(); break;
        case 'elem': value = String(r.elem || '').toLowerCase(); break;
        case 'info': value = String(r.info || '').toLowerCase(); break;
        default:     value = String(r.path || '').toLowerCase(); break;
      }
      // Apply match mode
      switch (this.quickFilterMode) {
        case 'startsWith': return value.startsWith(filter);
        case 'exact':      return value === filter;
        default:           return value.includes(filter);
      }
    });
  }

  getFilterPlaceholder(): string {
    const level = this.quickFilterLevel === 'all' ? 'path' : this.quickFilterLevel.toUpperCase();
    const modeLabel = this.quickFilterMode === 'startsWith' ? 'starts with' : this.quickFilterMode;
    return `Filter by ${level} (${modeLabel})...`;
  }

  constructor(
    private apiService: ApiService, 
    private translate: TranslateService, 
    private cdr: ChangeDetectorRef,
    private tableExplorerService: TableExplorerService
  ) {}

  /**
   * Debug log helper - DEBUG_MODE=true olduğunda logları gösterir
   */
  private debugLog(message: string, ...args: any[]): void {
    if (this.DEBUG_MODE) {
      console.log(message, ...args);
    }
  }

  /**
   * Debug warn helper - DEBUG_MODE=true olduğunda warn loglarını gösterir
   */
  private debugWarn(message: string, ...args: any[]): void {
    if (this.DEBUG_MODE) {
      console.warn(message, ...args);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    const logPrefix = this.dataSourceType === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    this.debugLog(`🔄 ${logPrefix} ngOnChanges çağrıldı:`, changes);
    
    // Dialog açıldığında B1 verilerini yükle ve mevcut path'leri yükle
    if (changes['visible'] && changes['visible'].currentValue === true && !changes['visible'].previousValue) {
      ////console.log(`📂 ${logPrefix} Dialog açıldı`);
      
      // Scroll pozisyonunu sıfırla (önceki oturumdan kalan scroll'u temizle)
      setTimeout(() => {
        if (this.dialogContent?.nativeElement) {
          this.dialogContent.nativeElement.scrollTop = 0;
        }
      });
      
      // Mevcut path'leri selectedPaths'e yükle (sadece dialog açıldığında)
      ////console.log(`📝 ${logPrefix} Mevcut path'ler dialog açılışında yükleniyor:`, this.currentPaths);
      this.selectedPaths = this.currentPaths ? [...this.currentPaths] : [];
      
      // Initialize activePaths from currentActivePaths
      this.activePaths = this.currentActivePaths ? { ...this.currentActivePaths } : {};
      this.selectedPaths.forEach(path => {
        if (this.activePaths[path] === undefined) {
          this.activePaths[path] = true;
        }
      });
      
      // Mevcut formülü yükle
      this.formula = this.currentFormula || '';
      this.formulaError = null;
      this.formulaApplied = !!this.currentFormula;
      
      // Initialize showOnlyFormula mode
      if (this.formula) {
        const activeCount = this.selectedPaths.filter(p => this.activePaths[p] !== false).length;
        this.showOnlyFormula = (activeCount === 0);
      } else {
        this.showOnlyFormula = false;
      }
      
      // Decimal places ayarlarını ilgili widget'tan yükle
      this.decimalPlaces = this.currentDecimalPlaces ?? 2;
      this.decimalPlacesEnabled = this.currentDecimalPlacesEnabled ?? false;
      
      if (this.dataSourceType === 'sql') {
        this.loadSavedExplorations();
      } else {
        if (this.dataSourceType === 'historical') {
          if (!this.startDate) {
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            this.startDate = this.toLocalDatetimeString(weekAgo);
          }
          if (!this.endDate) {
            this.endDate = this.toLocalDatetimeString(new Date());
          }
        }
        if (this.pathsLevel1.length === 0) {
          ////console.log(`🔄 ${logPrefix} B1 verileri yükleniyor...`);
          this.loadB1Paths();
        }
      }
    }
    
    // currentPaths değişimini sadece dialog açık değilken handle et (dialog açılışı zaten yukarıda yapılıyor)
    // Dialog açıkken selectedPaths'i dışarıdan resetleme, kullanıcı düzenleme yapabilir
    
    // currentRefreshRate değişikliğini handle et
    if (changes['currentRefreshRate'] && changes['currentRefreshRate'].currentValue) {
      ////console.log(`🔄 ${logPrefix} currentRefreshRate değişti:`, changes['currentRefreshRate'].currentValue);
      this.updateInterval = changes['currentRefreshRate'].currentValue;
      ////console.log(`⏱️ ${logPrefix} updateInterval güncellendi:`, this.updateInterval);
    }
    
    // currentDecimalPlaces değişikliğini handle et
    if (changes['currentDecimalPlaces'] && changes['currentDecimalPlaces'].currentValue != null) {
      this.decimalPlaces = changes['currentDecimalPlaces'].currentValue;
    }
    if (changes['currentDecimalPlacesEnabled'] && changes['currentDecimalPlacesEnabled'].currentValue != null) {
      this.decimalPlacesEnabled = changes['currentDecimalPlacesEnabled'].currentValue;
    }
  }

  ngOnInit(): void {
    const logPrefix = this.dataSourceType === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🎯 ${logPrefix} ngOnInit çağrıldı`);
    
    // Mevcut refresh rate'i kullan (eğer geçilmişse)
    if (this.currentRefreshRate && this.currentRefreshRate > 0) {
      this.updateInterval = this.currentRefreshRate;
      ////console.log(`⏱️ ${logPrefix} Mevcut refresh rate kullanıldı:`, this.updateInterval);
    }
    
    // Mevcut decimal places'i kullan (eğer geçilmişse)
    if (this.currentDecimalPlaces != null && this.currentDecimalPlaces >= 0) {
      this.decimalPlaces = this.currentDecimalPlaces;
    }
    if (this.currentDecimalPlacesEnabled != null) {
      this.decimalPlacesEnabled = this.currentDecimalPlacesEnabled;
    }
    // selectedPaths'i burada başlatma, ngOnChanges'da yapacağız
  }

  // Custom Confirmation Dialog variables
  showSourceChangeConfirm = false;
  pendingSourceType: 'realtime' | 'historical' | 'app' | 'sql' | 'python' | null = null;

  /**
   * Veri kaynağı tipini değiştirir ve B1 verilerini yeniden yükler
   */
  switchDataSource(newType: 'realtime' | 'historical' | 'app' | 'sql' | 'python'): void {
    if (this.dataSourceType === newType) return;

    // Check if there are already paths selected to prevent mixing
    if (this.selectedPaths.length > 0) {
      this.pendingSourceType = newType;
      this.showSourceChangeConfirm = true;
      this.cdr.markForCheck();
      return;
    }

    this.executeDataSourceSwitch(newType);
  }

  confirmDataSourceSwitch(): void {
    if (this.pendingSourceType) {
      this.selectedPaths = [];
      this.activePaths = {};
      this.formula = '';
      this.formulaApplied = false;
      this.formulaError = null;
      this.executeDataSourceSwitch(this.pendingSourceType);
    }
    this.showSourceChangeConfirm = false;
    this.pendingSourceType = null;
    this.cdr.markForCheck();
  }

  cancelDataSourceSwitch(): void {
    this.showSourceChangeConfirm = false;
    this.pendingSourceType = null;
    this.cdr.markForCheck();
  }

  private executeDataSourceSwitch(newType: 'realtime' | 'historical' | 'app' | 'sql' | 'python'): void {
    this.dataSourceType = newType;
    // Seçimleri sıfırla (path listesi korunsun)
    this.selectedB1Id = '';
    this.selectedB2Id = '';
    this.selectedB3Id = '';
    this.selectedElemId = '';
    this.selectedInfoId = '';
    this.selectedPath = '';
    this.pathsLevel1 = [];
    this.pathsLevel2 = [];
    this.pathsLevel3 = [];
    this.pathsElem = [];
    this.pathsInfo = [];
    this.error = '';

    if (newType === 'sql') {
      this.loadSavedExplorations();
    } else {
      // Historical seçildiğinde ve tarih boşsa varsayılan aralık ata (son 7 gün)
      if (newType === 'historical') {
        if (!this.startDate) {
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          this.startDate = this.toLocalDatetimeString(weekAgo);
        }
        if (!this.endDate) {
          this.endDate = this.toLocalDatetimeString(new Date());
        }
      }

      // B1'i yeniden yükle
      this.loadB1Paths();
    }
  }

  loadSavedExplorations(): void {
    this.loadingSavedExplorations = true;
    this.tableExplorerService.listSaved().subscribe({
      next: data => {
        this.loadingSavedExplorations = false;
        this.savedExplorations = data || [];
        
        // If a saved exploration path was already selected, make sure to set selectedSqlExpId
        if (this.selectedPaths.length > 0 && this.selectedPaths[0].startsWith('sql://')) {
          this.selectedSqlExpId = this.selectedPaths[0].substring(6);
        }
      },
      error: err => {
        console.error('Failed to load saved explorations:', err);
        this.loadingSavedExplorations = false;
        this.savedExplorations = [];
      }
    });
  }

  onSqlExplorationSelected(exp: any): void {
    // Clear selection if clicked again when already selected
    if (this.selectedSqlExpId === exp.id) {
      this.selectedSqlExpId = '';
      this.sqlColumns = [];
      this.selectedSqlValueCol = '';
      this.selectedSqlLabelCol = '';
      // Also clear from selectedPaths if it was added
      const sqlPath = 'sql://' + exp.id;
      const idx = this.selectedPaths.indexOf(sqlPath);
      if (idx > -1) {
        this.selectedPaths.splice(idx, 1);
      }
      this.showTemporaryMessage(`Deselected SQL Query`, 'success');
      return;
    }

    this.selectedSqlExpId = exp.id;
    this.customTitle = exp.name;
    
    // 1. Try parsing from exp.columns metadata first (most reliable and instant!)
    let cols: string[] = [];
    try {
      if (exp.columns) {
        const parsed = typeof exp.columns === 'string' ? JSON.parse(exp.columns) : exp.columns;
        if (Array.isArray(parsed)) {
          cols = parsed.map(c => typeof c === 'object' ? (c.name || c.alias || '') : String(c)).filter(c => c.length > 0);
        }
      }
    } catch (e) {
      console.warn('Failed to parse columns from metadata:', e);
    }

    // 2. Try parsing directly from SQL query string if metadata is empty
    if (cols.length === 0 && exp.sql_query) {
      try {
        const sqlUpper = exp.sql_query.toUpperCase();
        const selectIdx = sqlUpper.indexOf('SELECT');
        const fromIdx = sqlUpper.indexOf('FROM');
        if (selectIdx !== -1 && fromIdx > selectIdx) {
          const colsText = exp.sql_query.substring(selectIdx + 6, fromIdx).trim();
          cols = colsText.split(',').map((c: string) => {
            let col = c.trim();
            const asIdx = col.toUpperCase().lastIndexOf(' AS ');
            if (asIdx !== -1) {
              col = col.substring(asIdx + 4).trim();
            } else {
              const spaceIdx = col.lastIndexOf(' ');
              if (spaceIdx !== -1) {
                col = col.substring(spaceIdx + 1).trim();
              }
            }
            col = col.replace(/[`"']/g, '');
            if (col.includes('.')) {
              col = col.substring(col.indexOf('.') + 1).trim();
            }
            return col;
          }).filter((c: string) => c.length > 0 && c !== '*');
        }
      } catch (e) {
        console.warn('Failed to parse columns from SQL query string:', e);
      }
    }

    // Assign parsed columns instantly so they appear on the screen immediately!
    if (cols.length > 0) {
      this.sqlColumns = cols;
      this.selectedSqlValueCol = cols.find(c => c.toUpperCase() === 'CVMOMENT' || c.toUpperCase() === 'VALUE' || c.toUpperCase() === 'GZAHL') || cols[1] || cols[0];
      this.selectedSqlLabelCol = cols.find(c => c.toUpperCase() === 'PATH' || c.toUpperCase() === 'TIMESTAMP' || c.toUpperCase() === 'CREATED_AT') || cols[0];
    }
    
    // Fetch columns dynamically from the API as a fallback / live update
    this.loadingSqlColumns = true;
    this.apiService.getSavedExplorationData(exp.id).subscribe({
      next: (res: any) => {
        this.loadingSqlColumns = false;
        const rows = res?.data?.rows || res?.rows || [];
        if (Array.isArray(rows) && rows.length > 0) {
          const apiCols = Object.keys(rows[0]);
          if (apiCols.length > 0) {
            this.sqlColumns = apiCols;
            
            // Re-detect defaults if not already chosen by user
            if (!this.selectedSqlValueCol) {
              let numCol = '';
              for (const col of this.sqlColumns) {
                const val = rows[0][col];
                if (typeof val === 'number') {
                  numCol = col;
                  break;
                }
              }
              this.selectedSqlValueCol = numCol || this.sqlColumns[1] || this.sqlColumns[0] || '';
            }
            
            if (!this.selectedSqlLabelCol) {
              let lblCol = '';
              for (const col of this.sqlColumns) {
                const colLower = col.toLowerCase();
                if (col !== this.selectedSqlValueCol && (colLower.includes('time') || colLower.includes('date') || colLower.includes('name') || colLower.includes('label') || colLower.includes('path'))) {
                  lblCol = col;
                  break;
                }
              }
              this.selectedSqlLabelCol = lblCol || this.sqlColumns[0] || '';
            }
          }
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loadingSqlColumns = false;
        console.error('Failed to fetch saved SQL columns via API:', err);
        // We already have the parsed columns as fallback, so do nothing!
      }
    });
    
    this.showTemporaryMessage(`Selected Query: "${exp.name}". Please map columns and add to list.`, 'success');
  }

  addSqlQueryToList(): void {
    if (!this.selectedSqlExpId) return;
    
    const sqlPath = 'sql://' + this.selectedSqlExpId;
    this.selectedPaths = [sqlPath];
    this.activePaths = { [sqlPath]: true };
    
    this.showTemporaryMessage(`Added SQL Query to Widget list successfully!`, 'success');
  }

  /**
   * B1 seviyesi path'leri yükler (Realtime ve Historical için)
   */  
  loadB1Paths(): void {
    if (this.dataSourceType === 'sql') return;
    const dst = this.dataSourceType as 'realtime' | 'historical' | 'app';
    const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🔄 ${logPrefix} B1 verileri yükleniyor...`);
    
    // Loading state'i hemen set et (UI responsive olsun)
    this.loading = { ...this.loading, b1: true };
    this.error = '';
    
    // console.time('B1-Initial-Loading-Time'); // Performance ölçümü
    
    this.apiService.getPathsLevel1(dst).subscribe({
      next: (paths) => {
        // console.timeEnd('B1-Initial-Loading-Time'); // Performance ölçümü
        const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
        ////console.log(`✅ ${logPrefix} B1 verileri alındı: ${paths?.length || 0} kayıt`);
        
        if (!paths || paths.length === 0) {
          console.error(`❌ ${logPrefix} Boş B1 verisi!`);
          this.translate.get('PATH_SELECTOR.B1_NOT_FOUND').subscribe(msg => this.error = msg);
          this.loading = { ...this.loading, b1: false };
          this.cdr.markForCheck();
          return;
        }
        
        this.pathsLevel1 = paths.map(p => ({
          id: p.id,
          name: p.name,
          path_id: p.id
        }));
        
        ////console.log(`📋 ${logPrefix} B1 listesi hazır: ${this.pathsLevel1.length} eleman`);
        this.loading = { ...this.loading, b1: false };
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.timeEnd('B1-Initial-Loading-Time'); // Performance ölçümü
        const logPrefix = this.dataSourceType === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
        console.error(`❌ ${logPrefix} B1 yükleme hatası:`, err);
        this.translate.get('PATH_SELECTOR.B1_ERROR').subscribe(msg => this.error = msg);
        this.loading = { ...this.loading, b1: false };
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * B2 seviyesi path'leri yükler (Parent B1'e göre filtrelenmiş)
   */  
  loadB2Paths(parentB1Id: string): void {
    if (this.dataSourceType === 'sql') return;
    const dst = this.dataSourceType as 'realtime' | 'historical' | 'app';
    const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🔄 ${logPrefix} B2 verileri yükleniyor (Parent B1: ${parentB1Id})...`);
    
    if (!parentB1Id) {
      console.error(`❌ ${logPrefix} B1 ID eksik, B2 yüklenemez!`);
      return;
    }
    
    // Loading state'i hemen set et (UI responsive olsun)
    this.loading = { ...this.loading, b2: true };
    this.error = '';
    
    console.time('B2-Loading-Time'); // Performance ölçümü
    
    this.apiService.getPathsLevel2(parentB1Id, dst).subscribe({
      next: (paths) => {
        console.timeEnd('B2-Loading-Time'); // Performance ölçümü
        const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
        ////console.log(`✅ ${logPrefix} B2 verileri alındı: ${paths?.length || 0} kayıt`);
        
        if (!paths || paths.length === 0) {
          ////console.log(`ℹ️ ${logPrefix} Bu B1 için B2 verisi bulunamadı`);
          this.pathsLevel2 = [];
          this.loading = { ...this.loading, b2: false };
          this.cdr.markForCheck();
          return;
        }
        
        this.pathsLevel2 = paths.map(p => ({
          id: p.id,
          name: p.name,
          path_id: p.id
        }));
        
        ////console.log(`📋 ${logPrefix} B2 listesi hazır: ${this.pathsLevel2.length} eleman`);
        this.loading = { ...this.loading, b2: false };
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.timeEnd('B2-Loading-Time'); // Performance ölçümü
        const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
        console.error(`❌ ${logPrefix} B2 yükleme hatası:`, err);
        this.translate.get('PATH_SELECTOR.B2_ERROR').subscribe(msg => this.error = msg);
        this.pathsLevel2 = [];
        this.loading = { ...this.loading, b2: false };
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * B3 seviyesi path'leri yükler (Parent B1 ve B2'ye göre filtrelenmiş)
   */  
  loadB3Paths(parentB2Id: string): void {
    if (this.dataSourceType === 'sql') return;
    const dst = this.dataSourceType as 'realtime' | 'historical' | 'app';
    const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🔄 ${logPrefix} B3 verileri yükleniyor (Parent B1: ${this.selectedB1Id}, Parent B2: ${parentB2Id})...`);
    
    if (!parentB2Id || !this.selectedB1Id) {
      console.error(`❌ ${logPrefix} B1 veya B2 ID eksik, B3 yüklenemez!`);
      return;
    }
    
    // Loading state'i hemen set et (UI responsive olsun)
    this.loading = { ...this.loading, b3: true };
    this.error = '';
    
    console.time('B3-Loading-Time'); // Performance ölçümü
    
    this.apiService.getPathsLevel3(this.selectedB1Id, parentB2Id, dst).subscribe({
      next: (paths) => {
        console.timeEnd('B3-Loading-Time'); // Performance ölçümü
        ////console.log(`✅ ${logPrefix} B3 verileri alındı: ${paths?.length || 0} kayıt`);
        
        if (!paths || paths.length === 0) {
          ////console.log(`ℹ️ ${logPrefix} Bu B1/B2 kombinasyonu için B3 verisi bulunamadı`);
          this.pathsLevel3 = [];
          this.loading = { ...this.loading, b3: false };
          this.cdr.markForCheck();
          return;
        }
        
        this.pathsLevel3 = paths.map(p => ({
          id: p.id,
          name: p.name,
          path_id: p.id,
          combination_id: (p as any).combination_id // Realtime için combination_id'yi kaydet
        }));
        
        ////console.log(`📋 ${logPrefix} B3 listesi hazır: ${this.pathsLevel3.length} eleman`);
        if (this.dataSourceType === 'realtime') {
          ////console.log(`🔍 ${logPrefix} B3 combination_id'leri:`, this.pathsLevel3.map(p => ({ name: p.name, combination_id: p.combination_id })));
        }
        this.loading = { ...this.loading, b3: false };
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.timeEnd('B3-Loading-Time'); // Performance ölçümü
        console.error(`❌ ${logPrefix} B3 yükleme hatası:`, err);
        this.translate.get('PATH_SELECTOR.B3_ERROR').subscribe(msg => this.error = msg);
        this.pathsLevel3 = [];
        this.loading = { ...this.loading, b3: false };
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Element seviyesi path'leri yükler (Parent B3'e göre filtrelenmiş)
   * Performans için optimizasyonlar: Cache, lazy loading, debouncing
   */  
  loadElemPaths(parentB3Id: string): void {
    if (this.dataSourceType === 'sql') return;
    const dst = this.dataSourceType as 'realtime' | 'historical' | 'app';
    const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🔄 ${logPrefix} Element verileri yükleniyor (Parent B3: ${parentB3Id})...`);
    ////console.log(`🔍 ${logPrefix} Parent B3 ID tipi:`, typeof parentB3Id, 'Değer:', parentB3Id);
    
    if (!parentB3Id) {
      console.error(`❌ ${logPrefix} B3 ID eksik, Element yüklenemez!`);
      return;
    }
    
    // Loading state'i hemen set et (UI responsive olsun)
    this.loading = { ...this.loading, elem: true };
    this.error = '';
    
    console.time('Element-Loading-Time'); // Performance ölçümü
    ////console.log(`🚀 ${logPrefix} Element yükleme başlatılıyor - cache'ten hızlı olmalı`);
    
    // Realtime için string'i number'a çevirmeyi dene
    const idParam = dst === 'realtime' ? parseInt(parentB3Id, 10) : parentB3Id;
    ////console.log(`🔍 ${logPrefix} API'ye gönderilen ID:`, idParam, 'Tipi:', typeof idParam);
    
    this.apiService.getPathsElements(idParam, dst).subscribe({
      next: (paths: {id: string, name: string, elem_type: string, nim_satz: number}[]) => {
        console.timeEnd('Element-Loading-Time'); // Performance ölçümü
        ////console.log(`✅ ${logPrefix} Element verileri alındı: ${paths?.length || 0} kayıt`);
        
        if (!paths || paths.length === 0) {
          ////console.log(`ℹ️ ${logPrefix} Bu B3 için Element verisi bulunamadı`);
          this.pathsElem = [];
          this.loading = { ...this.loading, elem: false };
          this.cdr.markForCheck();
          return;
        }
        
        // Büyük veri setleri için optimizasyon - sadece ilk 100'ü göster, lazy loading
        const INITIAL_ELEMENT_LIMIT = 100;
        const limitedPaths = paths.slice(0, INITIAL_ELEMENT_LIMIT);
        
        this.pathsElem = limitedPaths.map(p => ({
          id: p.id,
          name: p.name,
          path_id: p.id,
          nim_satz: p.nim_satz // API'den gelen nim_satz değerini kaydet
        }));
        
        ////console.log(`📋 ${logPrefix} Element listesi hazır: ${this.pathsElem.length}/${paths.length} eleman gösteriliyor`);
        if (paths.length > INITIAL_ELEMENT_LIMIT) {
          ////console.log(`ℹ️ ${logPrefix} Büyük veri seti! ${INITIAL_ELEMENT_LIMIT} eleman gösteriliyor, toplam: ${paths.length}`);
        }
        
        if (dst === 'realtime') {
          ////console.log(`🔍 ${logPrefix} Element nim_satz değerleri:`, this.pathsElem.map(e => ({ name: e.name, nim_satz: e.nim_satz })).slice(0, 5));
        }
        this.loading = { ...this.loading, elem: false };
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        console.timeEnd('Element-Loading-Time'); // Performance ölçümü
        console.error(`❌ ${logPrefix} Element yükleme hatası:`, err);
        this.translate.get('PATH_SELECTOR.ELEM_ERROR').subscribe(msg => this.error = msg);
        this.pathsElem = [];
        this.loading = { ...this.loading, elem: false };
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Info seviyesi path'leri yükler (Parent Element'e göre filtrelenmiş)
   */  
  loadInfoPaths(parentElemId: string): void {
    if (this.dataSourceType === 'sql') return;
    const dst = this.dataSourceType as 'realtime' | 'historical' | 'app';
    const logPrefix = dst === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🔄 ${logPrefix} Info verileri yükleniyor (Parent Element: ${parentElemId})...`);
    
    if (!parentElemId) {
      console.error(`❌ ${logPrefix} Element ID eksik, Info yüklenemez!`);
      return;
    }
    
    // Loading state'i hemen set et (UI responsive olsun)
    this.loading = { ...this.loading, info: true };
    this.error = '';
    
    console.time('Info-Loading-Time'); // Performance ölçümü
    
    this.apiService.getPathsInfo(parentElemId, dst).subscribe({
      next: (paths: {id: string, name: string}[]) => {
        console.timeEnd('Info-Loading-Time'); // Performance ölçümü
        ////console.log(`✅ ${logPrefix} Info verileri alındı: ${paths?.length || 0} kayıt`);
        
        if (!paths || paths.length === 0) {
          ////console.log(`ℹ️ ${logPrefix} Bu Element için Info verisi bulunamadı`);
          this.pathsInfo = [];
          this.loading = { ...this.loading, info: false };
          this.cdr.markForCheck();
          return;
        }
        
        this.pathsInfo = paths.map(p => ({
          id: p.id,
          name: p.name,
          path_id: p.id
        }));
        
        ////console.log(`📋 ${logPrefix} Info listesi hazır: ${this.pathsInfo.length} eleman`);
        this.loading = { ...this.loading, info: false };
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        console.timeEnd('Info-Loading-Time'); // Performance ölçümü
        console.error(`❌ ${logPrefix} Info yükleme hatası:`, err);
        this.translate.get('PATH_SELECTOR.INFO_ERROR').subscribe(msg => this.error = msg);
        this.pathsInfo = [];
        this.loading = { ...this.loading, info: false };
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * B1 seçildikten sonra gösterge mesajı
   */
  showB1SelectedMessage(selectedName: string): void {
    ////console.log(`🎯 [PATH-SELECTOR] B1 seçildi: ${selectedName}`);
    this.translate.get('PATH_SELECTOR.SELECTED_WAITING', { name: selectedName, next: 'B2' }).subscribe(msg => this.successMessage = `✅ ${msg}`);
    
    // 3 saniye sonra mesajı temizle
    setTimeout(() => {
      this.successMessage = '';
    }, 3000);
  }

  /**
   * B1 seviyesinde bir path seçildiğinde
   */  
  onB1Selected(displayId: string, pathId?: string): void {
    const cleanedDisplayId = displayId.trim();
    const selectedPath = this.pathsLevel1.find(p => p.id.trim() === cleanedDisplayId);

    if (!selectedPath) {
      console.warn(`❌ [PATH-SELECTOR] Seçilen B1 path bulunamadı: ${cleanedDisplayId}`);
      return;
    }

    ////console.log(`✅ [PATH-SELECTOR] B1 seçildi: ${selectedPath.name} (ID: ${selectedPath.id})`);

    // Seçilen B1 ID'sini güncelle
    this.selectedB1Id = cleanedDisplayId;
    
    // Alt seviyeyi temizle
    this.selectedB2Id = '';
    this.selectedB3Id = '';
    this.selectedElemId = '';
    this.selectedInfoId = '';
    this.pathsLevel2 = [];
    this.pathsLevel3 = [];
    
    // Başarı mesajı göster
    this.showB1SelectedMessage(selectedPath.name);
    
    // Basit path string oluştur
    this.selectedPath = selectedPath.name;
    
    // Path'i güncelle
    this.buildAndUpdatePath();
    
    // B2 verilerini yükle
    this.loadB2Paths(cleanedDisplayId);
  }

  /**
   * B2 seviyesinde bir path seçildiğinde
   */  
  onB2Selected(displayId: string, pathId?: string): void {
    const cleanedDisplayId = displayId.trim();
    const selectedPath = this.pathsLevel2.find(p => p.id.trim() === cleanedDisplayId);

    if (!selectedPath) {
      console.warn(`❌ [PATH-SELECTOR] Seçilen B2 path bulunamadı: ${cleanedDisplayId}`);
      return;
    }

    ////console.log(`✅ [PATH-SELECTOR] B2 seçildi: ${selectedPath.name} (ID: ${selectedPath.id})`);

    // Seçilen B2 ID'sini güncelle
    this.selectedB2Id = cleanedDisplayId;
    
    // Alt seviyeyi temizle
    this.selectedB3Id = '';
    this.selectedElemId = '';
    this.selectedInfoId = '';
    this.pathsLevel3 = [];
    
    // Başarı mesajı göster
    this.translate.get('PATH_SELECTOR.SELECTED_WAITING', { name: selectedPath.name, next: 'B3' }).subscribe(msg => this.showTemporaryMessage(`✅ ${msg}`, 'success'));
    
    // Path'i güncelle
    this.buildAndUpdatePath();
    
    // B3 verilerini yükle
    this.loadB3Paths(cleanedDisplayId);
  }

  /**
   * B3 seviyesinde bir path seçildiğinde
   */  
  onB3Selected(displayId: string, pathId?: string): void {
    const cleanedDisplayId = displayId.trim();
    const selectedPath = this.pathsLevel3.find(p => p.id.trim() === cleanedDisplayId);

    if (!selectedPath) {
      console.warn(`❌ [PATH-SELECTOR] Seçilen B3 path bulunamadı: ${cleanedDisplayId}`);
      return;
    }

    ////console.log(`✅ [PATH-SELECTOR] B3 seçildi: ${selectedPath.name} (ID: ${selectedPath.id})`);

    // Seçilen B3 ID'sini güncelle
    this.selectedB3Id = cleanedDisplayId;
    
    // Alt seviyeyi temizle
    this.selectedElemId = '';
    this.selectedInfoId = '';
    this.pathsElem = [];
    this.pathsInfo = [];
    
    // Başarı mesajı göster
    this.translate.get('PATH_SELECTOR.SELECTED_WAITING', { name: selectedPath.name, next: 'Element' }).subscribe(msg => this.showTemporaryMessage(`✅ ${msg}`, 'success'));
    
    // Path'i güncelle
    this.buildAndUpdatePath();
    
    // Element verilerini yükle - Realtime için combination_id kullan
    if (this.dataSourceType === 'realtime') {
      // API'den gelen B3 path'inde combination_id var mı kontrol et
      const apiPath = this.pathsLevel3.find(p => p.id.trim() === cleanedDisplayId) as any;
      const combinationId = apiPath?.combination_id;
      
      if (combinationId) {
        ////console.log(`🔍 [PATH-SELECTOR] Realtime için combination_id kullanılıyor: ${combinationId}`);
        this.loadElemPaths(combinationId.toString());
      } else {
        console.warn(`⚠️ [PATH-SELECTOR] B3 path'inde combination_id bulunamadı:`, apiPath);
        this.loadElemPaths(cleanedDisplayId);
      }
    } else {
      this.loadElemPaths(cleanedDisplayId);
    }
  }

  /**
   * Element seviyesinde bir path seçildiğinde
   */  
  onElemSelected(displayId: string, pathId?: string): void {
    const cleanedDisplayId = displayId.trim();
    const selectedPath = this.pathsElem.find(p => p.id.trim() === cleanedDisplayId);

    if (!selectedPath) {
      console.warn(`❌ [PATH-SELECTOR] Seçilen Element path bulunamadı: ${cleanedDisplayId}`);
      return;
    }

    ////console.log(`✅ [PATH-SELECTOR] Element seçildi: ${selectedPath.name} (ID: ${selectedPath.id})`);
    
    // Realtime için nim_satz değerini kontrol et
    if (this.dataSourceType === 'realtime' && selectedPath.nim_satz) {
      ////console.log(`🔢 [PATH-SELECTOR] Element nim_satz değeri: ${selectedPath.nim_satz}`);
    }

    // Seçilen Element ID'sini güncelle
    this.selectedElemId = cleanedDisplayId;
    
    // Realtime için nim_satz bilgisini de kaydet (widget'ta kullanılacak)
    if (this.dataSourceType === 'realtime' && selectedPath.nim_satz) {
      ////console.log(`🔢 [PATH-SELECTOR] Element ${selectedPath.name} için nim_satz: ${selectedPath.nim_satz}`);
      // Satz bilgisini bir değişkende sakla (path'e eklemek yerine)
      (this as any).selectedElementSatz = selectedPath.nim_satz;
    } else if (this.dataSourceType === 'realtime') {
      console.warn(`⚠️ [PATH-SELECTOR] Element ${selectedPath.name} için nim_satz bulunamadı:`, selectedPath);
    }
    
    // Alt seviyeyi temizle
    this.selectedInfoId = '';
    this.pathsInfo = [];
    
    // Başarı mesajı göster
    this.translate.get('PATH_SELECTOR.SELECTED_WAITING', { name: selectedPath.name, next: 'Info' }).subscribe(msg => this.showTemporaryMessage(`✅ ${msg}`, 'success'));
    
    // Path'i güncelle
    this.buildAndUpdatePath();
    
    // Info verilerini yükle
    this.loadInfoPaths(cleanedDisplayId);
  }

  /**
   * Info seviyesinde bir path seçildiğinde - FINAL SELECTION!
   */  
  onInfoSelected(displayId: string, pathId?: string): void {
    const cleanedDisplayId = displayId.trim();
    const selectedPath = this.pathsInfo.find(p => p.id.trim() === cleanedDisplayId);

    if (!selectedPath) {
      console.warn(`❌ [PATH-SELECTOR] Seçilen Info path bulunamadı: ${cleanedDisplayId}`);
      return;
    }

    ////console.log(`✅ [PATH-SELECTOR] Info seçildi: ${selectedPath.name} (ID: ${selectedPath.id})`);

    // Seçilen Info ID'sini güncelle
    this.selectedInfoId = cleanedDisplayId;
    
    // Path'i güncelle ve otomatik listeye ekle
    this.buildAndUpdatePath();
    
    // Otomatik listeye ekle (tüm seviyeler seçildiğinde)
    if (this.selectedPath && this.selectedB1Id && this.selectedB2Id && 
        this.selectedB3Id && this.selectedElemId && this.selectedInfoId) {
      this.addPathToList();
    }
  }

  /**
   * Tam path'i seçili path listesine ekler
   */
  addPathToList(): void {
    this.debugLog('🔧 [PATH-SELECTOR] addPathToList çağrıldı');
    this.debugLog('📝 [PATH-SELECTOR] Eklenecek path:', this.selectedPath);
    this.debugLog('📋 [PATH-SELECTOR] Mevcut selectedPaths listesi:', this.selectedPaths);
    this.debugLog('🔍 [PATH-SELECTOR] Seçim durumu:', {
      selectedPath: this.selectedPath,
      b1: this.selectedB1Id,
      b2: this.selectedB2Id,
      b3: this.selectedB3Id,
      elem: this.selectedElemId,
      info: this.selectedInfoId
    });
    
    // selectedPath boş mu kontrol et (string olarak kontrol)
    if (!this.selectedPath || this.selectedPath.trim().length === 0) {
      console.error('❌ [PATH-SELECTOR] selectedPath boş!');
      this.translate.get('PATH_SELECTOR.SELECT_ALL_LEVELS').subscribe(msg => this.showTemporaryMessage(`❌ ${msg}`, 'error'));
      return;
    }
    
    // Tam path kontrolü - en azından 5 parçadan oluşmalı (B1/B2/B3/Elem/Info)
    const pathParts = this.selectedPath.split('/');
    if (pathParts.length < 5) {
      console.error('❌ [PATH-SELECTOR] Tam path oluşturulmamış! Parça sayısı:', pathParts.length);
      this.translate.get('PATH_SELECTOR.SELECT_ALL_LEVELS').subscribe(msg => this.showTemporaryMessage(`❌ ${msg}`, 'error'));
      return;
    }
    
    // Duplicate kontrolü
    if (this.selectedPaths.includes(this.selectedPath)) {
      this.translate.get('PATH_SELECTOR.PATH_ALREADY_EXISTS').subscribe(
        msg => this.showTemporaryMessage(`⚠️ ${msg}`, 'error'),
        () => this.showTemporaryMessage('⚠️ Bu path zaten listede!', 'error')
      );
      return;
    }

    // Path'i listeye ekle
    this.selectedPaths.push(this.selectedPath);
    this.activePaths[this.selectedPath] = !this.showOnlyFormula;
    
    this.debugLog(`✅ [PATH-SELECTOR] Path listeye eklendi: ${this.selectedPath}`);
    this.debugLog(`📋 [PATH-SELECTOR] Güncel path listesi: ${this.selectedPaths.length} eleman`, this.selectedPaths);
    
    // Başarı mesajı göster
    this.translate.get('PATH_SELECTOR.PATH_ADDED_TO_LIST', { path: this.selectedPath, count: this.selectedPaths.length }).subscribe(msg => this.showTemporaryMessage(`✅ ${msg}`, 'success'));
    
    // Seçimleri sıfırla (listeyi koruyarak) - Kullanıcı yeni path ekleyebilsin
    this.resetSelectionsKeepList();
  }

  togglePathVisibility(path: string): void {
    if (this.activePaths[path] === undefined) {
      this.activePaths[path] = true;
    }
    this.activePaths[path] = !this.activePaths[path];
    
    if (this.activePaths[path]) {
      this.showOnlyFormula = false;
    } else {
      const activeCount = this.selectedPaths.filter(p => this.activePaths[p] !== false).length;
      if (activeCount === 0 && this.formula) {
        this.showOnlyFormula = true;
      }
    }
  }

  toggleShowOnlyFormula(): void {
    this.showOnlyFormula = !this.showOnlyFormula;
    if (this.showOnlyFormula) {
      this.selectedPaths.forEach(p => {
        this.activePaths[p] = false;
      });
    } else {
      this.selectedPaths.forEach(p => {
        this.activePaths[p] = true;
      });
    }
  }

  /**
   * Tam path'i seçili path listesine ekler (alternative method name)
   */
  addSelectedPathToList(): void {
    this.addPathToList();
  }

  /**
   * Path'leri uygular (onConfirm ile aynı)
   */
  applyPaths(): void {
    this.onConfirm();
  }

  /**
   * Listeden belirtilen path'i siler
   */
  removePathFromList(indexOrPath: string | number): void {
    if (typeof indexOrPath === 'number') {
      // Index ile silme
      if (indexOrPath >= 0 && indexOrPath < this.selectedPaths.length) {
        const pathToRemove = this.selectedPaths[indexOrPath];
        if (pathToRemove && pathToRemove.startsWith('sql://')) {
          this.selectedSqlExpId = '';
        }
        this.selectedPaths.splice(indexOrPath, 1);
        ////console.log(`🗑️ [PATH-SELECTOR] Path listeden silindi (index): ${pathToRemove}`);
        ////console.log(`📋 [PATH-SELECTOR] Güncel path listesi: ${this.selectedPaths.length} eleman`);
        this.translate.get('PATH_SELECTOR.PATH_REMOVED', { path: pathToRemove }).subscribe(msg => this.showTemporaryMessage(`🗑️ ${msg}`, 'success'));
      }
    } else {
      // String path ile silme
      const index = this.selectedPaths.indexOf(indexOrPath);
      if (index > -1) {
        if (indexOrPath && indexOrPath.startsWith('sql://')) {
          this.selectedSqlExpId = '';
        }
        this.selectedPaths.splice(index, 1);
        ////console.log(`🗑️ [PATH-SELECTOR] Path listeden silindi: ${indexOrPath}`);
        ////console.log(`📋 [PATH-SELECTOR] Güncel path listesi: ${this.selectedPaths.length} eleman`);
        this.translate.get('PATH_SELECTOR.PATH_REMOVED', { path: indexOrPath }).subscribe(msg => this.showTemporaryMessage(`🗑️ ${msg}`, 'success'));
      }
    }
  }

  /**
   * Tüm path listesini temizler
   */
  clearAllPaths(): void {
    this.selectedPaths = [];
    this.selectedSqlExpId = '';
    this.seriesColors = [];
    ////console.log('🧹 [PATH-SELECTOR] Tüm path listesi temizlendi');
    this.translate.get('PATH_SELECTOR.ALL_CLEARED').subscribe(msg => this.showTemporaryMessage(`🧹 ${msg}`, 'success'));
  }

  /**
   * Seçilen seviyedeki tüm children'ları listeye ekler (tree modunda "All" butonu)
   */
  addAllChildrenFromLevel(level: 'b2' | 'b3' | 'elem' | 'info'): void {
    let items: PathInfo[] = [];
    switch (level) {
      case 'b2': items = this.filteredPathsB2; break;
      case 'b3': items = this.filteredPathsB3; break;
      case 'elem': items = this.filteredPathsElem; break;
      case 'info': items = this.filteredPathsInfo; break;
    }
    
    if (items.length === 0) return;
    
    // Her bir item için B1/B2/B3/Elem/Info path oluştur ve ekle
    // Sadece info seviyesinde tam path oluşturabiliyoruz
    // Diğer seviyelerde mevcut seçime göre partial path oluştur
    let addedCount = 0;
    
    if (level === 'info') {
      // Info seviyesinde - tam path oluşturabiliriz
      const b1Path = this.pathsLevel1.find(p => p.id === this.selectedB1Id);
      const b2Path = this.pathsLevel2.find(p => p.id === this.selectedB2Id);
      const b3Path = this.pathsLevel3.find(p => p.id === this.selectedB3Id);
      const elemPath = this.pathsElem.find(p => p.id === this.selectedElemId);
      
      if (b1Path && b2Path && b3Path && elemPath) {
        for (const info of items) {
          let fullPath = `${b1Path.name}/${b2Path.name}/${b3Path.name}/${elemPath.name}/${info.name}`;
          // Realtime için nimSatz ekle
          if (this.dataSourceType === 'realtime' && (elemPath as any).nim_satz !== undefined) {
            fullPath += `[${(elemPath as any).nim_satz}]`;
          }
          if (!this.selectedPaths.includes(fullPath)) {
            this.selectedPaths.push(fullPath);
            this.activePaths[fullPath] = !this.showOnlyFormula;
            addedCount++;
          }
        }
      }
    } else if (level === 'elem') {
      // Elem seviyesi - her elem için info'ları da lazım ama toplu ekleme yapalım
      // Sadece path başlangıcını oluştur, info olmadan
      const b1Path = this.pathsLevel1.find(p => p.id === this.selectedB1Id);
      const b2Path = this.pathsLevel2.find(p => p.id === this.selectedB2Id);
      const b3Path = this.pathsLevel3.find(p => p.id === this.selectedB3Id);
      
      if (b1Path && b2Path && b3Path) {
        this.showTemporaryMessage(`Adding elements... Select Info level for complete paths`, 'success');
      }
    }
    
    if (addedCount > 0) {
      this.showTemporaryMessage(`✅ ${addedCount} paths added to list`, 'success');
    }
  }

  /**
   * Series renk değişikliği
   */
  onSeriesColorChange(index: number, color: string): void {
    // Ensure array is large enough
    while (this.seriesColors.length <= index) {
      this.seriesColors.push('');
    }
    this.seriesColors[index] = color;
  }

  /**
   * Series rengini default'a sıfırla
   */
  resetSeriesColor(index: number): void {
    if (index < this.seriesColors.length) {
      this.seriesColors[index] = '';
    }
  }

  /**
   * Path string'ini breadcrumb formatında döndürür
   */
  getPathBreadcrumb(path: string): string {
    if (!path) return '';
    return path;
  }

  isRtPath(path: string): boolean {
    return /\[\d+\]/.test(path);
  }

  /**
   * Seçimleri sıfırla ama mevcut path listesini koru
   */
  resetSelectionsKeepList(): void {
    this.selectedB1Id = '';
    this.selectedB2Id = '';
    this.selectedB3Id = '';
    this.selectedElemId = '';
    this.selectedInfoId = '';
    this.selectedPath = '';
    
    // Realtime için saklanan satz bilgisini de temizle
    (this as any).selectedElementSatz = undefined;
    
    // Listeleri temizle (B1 hariç)
    this.pathsLevel2 = [];
    this.pathsLevel3 = [];
    this.pathsElem = [];
    this.pathsInfo = [];
    
    // Arama sorgularını temizle
    this.searchQuery = {
      b1: '',
      b2: '',
      b3: '',
      elem: '',
      info: ''
    };
    
    this.error = '';
    this.successMessage = '';
  }

  /**
   * Seçilen seviyelere göre path oluşturma (B1/B2/B3/Element/Info tam hiyerarşisi)
   */  
  buildAndUpdatePath(): void {
    ////console.log('🏗️ [PATH-SELECTOR] buildAndUpdatePath çağrıldı:');
    ////console.log('- DataSourceType:', this.dataSourceType);
    ////console.log('- B1 ID:', this.selectedB1Id);
    ////console.log('- B2 ID:', this.selectedB2Id);
    ////console.log('- B3 ID:', this.selectedB3Id);
    ////console.log('- Elem ID:', this.selectedElemId);
    ////console.log('- Info ID:', this.selectedInfoId);
    ////console.log('- Selected element satz:', (this as any).selectedElementSatz);
    
    ////console.log('🔧 [PATH-SELECTOR] Full path oluşturuluyor...');
    
    let pathParts: string[] = [];
    
    // B1 seçimi varsa ekle
    if (this.selectedB1Id) {
      const b1Path = this.pathsLevel1.find(p => p.id === this.selectedB1Id);
      if (b1Path) {
        pathParts.push(b1Path.name);
      }
    }
    
    // B2 seçimi varsa ekle
    if (this.selectedB2Id) {
      const b2Path = this.pathsLevel2.find(p => p.id === this.selectedB2Id);
      if (b2Path) {
        pathParts.push(b2Path.name);
      }
    }
    
    // B3 seçimi varsa ekle
    if (this.selectedB3Id) {
      const b3Path = this.pathsLevel3.find(p => p.id === this.selectedB3Id);
      if (b3Path) {
        pathParts.push(b3Path.name);
      }
    }
    
    // Element seçimi varsa ekle
    if (this.selectedElemId) {
      const elemPath = this.pathsElem.find(p => p.id === this.selectedElemId);
      if (elemPath) {
        pathParts.push(elemPath.name);
        
        // Realtime için nim_satz bilgisini de kaydet (widget'ta kullanılacak)
        if (this.dataSourceType === 'realtime' && elemPath.nim_satz) {
          ////console.log(`🔢 [PATH-SELECTOR] Element ${elemPath.name} için nim_satz: ${elemPath.nim_satz}`);
          // Satz bilgisini bir değişkende sakla (path'e eklemek yerine)
          (this as any).selectedElementSatz = elemPath.nim_satz;
        } else if (this.dataSourceType === 'realtime') {
          console.warn(`⚠️ [PATH-SELECTOR] Element ${elemPath.name} için nim_satz bulunamadı:`, elemPath);
        }
      }
    }
    
    // Info seçimi varsa ekle
    if (this.selectedInfoId) {
      const infoPath = this.pathsInfo.find(p => p.id === this.selectedInfoId);
      if (infoPath) {
        // Realtime için satz bilgisini info'ya ekle
        if (this.dataSourceType === 'realtime' && (this as any).selectedElementSatz) {
          pathParts.push(`${infoPath.name}[${(this as any).selectedElementSatz}]`);
        } else {
          pathParts.push(infoPath.name);
        }
      }
    }
    
    // Path'i birleştir
    this.selectedPath = pathParts.join('/');
        
    // Artık otomatik ekleme yapmıyoruz - kullanıcı "Listeye Ekle" butonuna basmalı
    ////console.log('� [PATH-SELECTOR] Path oluşturuldu:', this.selectedPath);
    ////console.log('📋 [PATH-SELECTOR] Tam path mi?', this.selectedB1Id && this.selectedB2Id && this.selectedB3Id && this.selectedElemId && this.selectedInfoId);
  }

  /**
   * Filtrelenmiş B1 path listesini döndürür
   */
  get filteredPathsB1(): PathInfo[] {
    return this.filterPaths(this.pathsLevel1, this.searchQuery.b1);
  }
  
  /**
   * Filtrelenmiş B2 path listesini döndürür (şimdilik boş - ileride kullanım için)
   */
  get filteredPathsB2(): PathInfo[] {
    return this.filterPaths(this.pathsLevel2, this.searchQuery.b2);
  }
  
  /**
   * Filtrelenmiş B3 path listesini döndürür (şimdilik boş - ileride kullanım için)
   */
  get filteredPathsB3(): PathInfo[] {
    return this.filterPaths(this.pathsLevel3, this.searchQuery.b3);
  }
  
  /**
   * Filtrelenmiş Element path listesini döndürür (şimdilik boş - ileride kullanım için)
   */
  get filteredPathsElem(): PathInfo[] {
    return this.filterPaths(this.pathsElem, this.searchQuery.elem);
  }
  
  /**
   * Filtrelenmiş Info path listesini döndürür (şimdilik boş - ileride kullanım için)
   */
  get filteredPathsInfo(): PathInfo[] {
    return this.filterPaths(this.pathsInfo, this.searchQuery.info);
  }
  
  /**
   * Path listelerini filtreleyen yardımcı fonksiyon
   */
  filterPaths(paths: PathInfo[], query: string): PathInfo[] {
    if (!query || !query.trim() || !paths) {
      return paths || [];
    }
    
    const lowerCaseQuery = query.toLowerCase();
    
    return paths.filter(path => {
      if (!path) return false;
      const name = String(path.name || '').toLowerCase();
      const id = String(path.id || '').toLowerCase();
      return name.includes(lowerCaseQuery) || id.includes(lowerCaseQuery);
    });
  }
  
  /**
   * Belirtilen seviye için arama sorgusunu temizler
   */
  clearSearch(level: string = 'b1'): void {
    switch(level) {
      case 'b1':
        this.searchQuery.b1 = '';
        break;
      case 'b2':
        this.searchQuery.b2 = '';
        break;
      case 'b3':
        this.searchQuery.b3 = '';
        break;
      case 'elem':
        this.searchQuery.elem = '';
        break;
      case 'info':
        this.searchQuery.info = '';
        break;
      default:
        this.searchQuery.b1 = '';
    }
  }

  runQuickSearch(): void {
    const query = this.quickSearchQuery.trim().toLowerCase();
    if (query.length < 1) {
      this.translate.get('PATH_SELECTOR.MIN_CHARS').subscribe(msg => this.quickSearchError = msg);
      return;
    }

    this.quickSearchLoading = true;
    this.quickSearchError = '';
    this.quickSearchResults = [];
    this.quickSearchSelected.clear();
    this.quickSearchExpanded = true;

    // SYS: server-side search (different data structure, no combination_ids)
    if (this.dataSourceType === 'historical') {
      this.apiService.searchHistoricalPaths(query, this.quickSearchLimit, this.quickSearchMode).subscribe({
        next: (response) => {
          this.quickSearchResults = (response?.data || []).map((r: any) => ({
            path: r.path,
            b1: r.b1,
            b2: r.b2,
            b3: r.b3,
            elem: r.elem,
            info: r.info
          }));
          if (!this.quickSearchResults.length) {
            this.translate.get('PATH_SELECTOR.NO_RESULTS').subscribe(msg => this.quickSearchError = msg);
          }
          this.quickSearchLoading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('SYS arama hatasi:', err);
          this.translate.get('PATH_SELECTOR.QUICK_SEARCH_ERROR').subscribe(msg => this.quickSearchError = msg);
          this.quickSearchLoading = false;
          this.cdr.markForCheck();
        }
      });
      return;
    }

    // LIVE: client-side search with cached hierarchy + elements
    const hierarchyObs = this.apiService.getRealTimeHierarchyStructure();
    const elementsObs = this.apiService.getRealTimeElementsStructure();

    forkJoin({
      hierarchy: hierarchyObs,
      elements: elementsObs
    }).subscribe({
      next: ({ hierarchy, elements }) => {
        const comboMap = this.buildCombinationMap(hierarchy?.data || []);
        const results: Array<{
          path: string;
          b1: string;
          b2: string;
          b3: string;
          elem: string;
          info: string;
          nimSatz?: number;
        }> = [];

        if (this.quickSearchMode === 'b1' || this.quickSearchMode === 'b2') {
          const field = this.quickSearchMode === 'b1' ? 'b1Name' : 'b2Name';
          for (const combo of comboMap.values()) {
            if (!(combo as any)[field].toLowerCase().includes(query)) {
              continue;
            }
            const elementMatches = this.findElementsByCombination(elements?.data || [], combo.combinationId);
            for (const elementMatch of elementMatches) {
              const infoOptions = this.getInfoOptionsForNoElType(elementMatch.noElType, elementMatch.name);
              for (const info of infoOptions) {
                const infoLabel = elementMatch.nimSatz ? `${info.name}[${elementMatch.nimSatz}]` : info.name;
                const path = `${combo.b1Name}/${combo.b2Name}/${combo.b3Name}/${elementMatch.name}/${infoLabel}`;
                results.push({
                  path,
                  b1: combo.b1Name,
                  b2: combo.b2Name,
                  b3: combo.b3Name,
                  elem: elementMatch.name,
                  info: info.name,
                  nimSatz: elementMatch.nimSatz
                });
                if (results.length >= this.quickSearchLimit) break;
              }
              if (results.length >= this.quickSearchLimit) break;
            }
            if (results.length >= this.quickSearchLimit) break;
          }
        } else if (this.quickSearchMode === 'b3') {
          for (const combo of comboMap.values()) {
            if (!combo.b3Name.toLowerCase().includes(query)) {
              continue;
            }
            const elementMatches = this.findElementsByCombination(elements?.data || [], combo.combinationId);
            for (const elementMatch of elementMatches) {
              const infoOptions = this.getInfoOptionsForNoElType(elementMatch.noElType, elementMatch.name);
              for (const info of infoOptions) {
                const infoLabel = elementMatch.nimSatz ? `${info.name}[${elementMatch.nimSatz}]` : info.name;
                const path = `${combo.b1Name}/${combo.b2Name}/${combo.b3Name}/${elementMatch.name}/${infoLabel}`;
                results.push({
                  path,
                  b1: combo.b1Name,
                  b2: combo.b2Name,
                  b3: combo.b3Name,
                  elem: elementMatch.name,
                  info: info.name,
                  nimSatz: elementMatch.nimSatz
                });
                if (results.length >= this.quickSearchLimit) {
                  break;
                }
              }
              if (results.length >= this.quickSearchLimit) {
                break;
              }
            }
            if (results.length >= this.quickSearchLimit) {
              break;
            }
          }
        } else if (this.quickSearchMode === 'elem') {
          for (const element of (elements?.data || [])) {
            if (!element.name?.toLowerCase().includes(query)) {
              continue;
            }
            const infoOptions = this.getInfoOptionsForNoElType(element.noElType, element.name);
            if (!infoOptions.length) {
              continue;
            }
            for (const combo of element.combinations || []) {
              const comboInfo = comboMap.get(combo.combination_id);
              if (!comboInfo) {
                continue;
              }
              for (const info of infoOptions) {
                const infoLabel = combo.nimSatz ? `${info.name}[${combo.nimSatz}]` : info.name;
                const path = `${comboInfo.b1Name}/${comboInfo.b2Name}/${comboInfo.b3Name}/${element.name}/${infoLabel}`;
                results.push({
                  path,
                  b1: comboInfo.b1Name,
                  b2: comboInfo.b2Name,
                  b3: comboInfo.b3Name,
                  elem: element.name,
                  info: info.name,
                  nimSatz: combo.nimSatz
                });
                if (results.length >= this.quickSearchLimit) {
                  break;
                }
              }
              if (results.length >= this.quickSearchLimit) {
                break;
              }
            }
            if (results.length >= this.quickSearchLimit) {
              break;
            }
          }
        } else {
          for (const element of (elements?.data || [])) {
            const elemName = (element.name || '').toLowerCase();
            for (const combo of element.combinations || []) {
              const comboInfo = comboMap.get(combo.combination_id);
              if (!comboInfo) {
                continue;
              }
              const b1Name = comboInfo.b1Name.toLowerCase();
              const b2Name = comboInfo.b2Name.toLowerCase();
              const b3Name = comboInfo.b3Name.toLowerCase();
              const infoOptions = this.getInfoOptionsForNoElType(element.noElType, element.name);
              if (!infoOptions.length) {
                continue;
              }

              const baseMatch =
                b1Name.includes(query) ||
                b2Name.includes(query) ||
                b3Name.includes(query) ||
                elemName.includes(query);

              for (const info of infoOptions) {
                const infoName = info.name.toLowerCase();
                if (!baseMatch && !infoName.includes(query)) {
                  continue;
                }
                const infoLabel = combo.nimSatz ? `${info.name}[${combo.nimSatz}]` : info.name;
                const path = `${comboInfo.b1Name}/${comboInfo.b2Name}/${comboInfo.b3Name}/${element.name}/${infoLabel}`;
                results.push({
                  path,
                  b1: comboInfo.b1Name,
                  b2: comboInfo.b2Name,
                  b3: comboInfo.b3Name,
                  elem: element.name,
                  info: info.name,
                  nimSatz: combo.nimSatz
                });
                if (results.length >= this.quickSearchLimit) {
                  break;
                }
              }
              if (results.length >= this.quickSearchLimit) {
                break;
              }
            }
            if (results.length >= this.quickSearchLimit) {
              break;
            }
          }
        }

        this.quickSearchResults = results;
        if (!results.length) {
          this.translate.get('PATH_SELECTOR.NO_RESULTS').subscribe(msg => this.quickSearchError = msg);
        }
        this.quickSearchLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Hizli arama hatasi:', err);
        this.translate.get('PATH_SELECTOR.QUICK_SEARCH_ERROR').subscribe(msg => this.quickSearchError = msg);
        this.quickSearchLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  toggleQuickSearchSelection(path: string): void {
    if (this.quickSearchSelected.has(path)) {
      this.quickSearchSelected.delete(path);
    } else {
      this.quickSearchSelected.add(path);
    }
  }

  addQuickSearchSelections(): void {
    if (!this.quickSearchSelected.size) {
      this.translate.get('PATH_SELECTOR.NO_SELECTION').subscribe(msg => this.showTemporaryMessage(msg, 'error'));
      return;
    }
    for (const path of this.quickSearchSelected) {
      if (!this.selectedPaths.includes(path)) {
        this.selectedPaths.push(path);
        this.activePaths[path] = !this.showOnlyFormula;
      }
    }
    this.quickSearchSelected.clear();
    this.translate.get('PATH_SELECTOR.ADDED_TO_LIST').subscribe(msg => this.showTemporaryMessage(msg, 'success'));
  }

  addAllQuickSearchResults(): void {
    const results = this.filteredQuickSearchResults;
    if (!results.length) {
      this.translate.get('PATH_SELECTOR.NO_ADDABLE').subscribe(msg => this.showTemporaryMessage(msg, 'error'));
      return;
    }
    for (const result of results) {
      if (!this.selectedPaths.includes(result.path)) {
        this.selectedPaths.push(result.path);
        this.activePaths[result.path] = !this.showOnlyFormula;
      }
    }
    this.translate.get('PATH_SELECTOR.ALL_ADDED').subscribe(msg => this.showTemporaryMessage(msg, 'success'));
  }

  private buildCombinationMap(hierarchyData: any[]): Map<number, { b1Name: string; b2Name: string; b3Name: string; combinationId: number }> {
    const map = new Map<number, { b1Name: string; b2Name: string; b3Name: string; combinationId: number }>();
    for (const b1 of hierarchyData || []) {
      for (const b2 of b1.children || []) {
        for (const b3 of b2.children || []) {
          if (typeof b3.combination_id === 'number') {
            map.set(b3.combination_id, {
              b1Name: b1.name,
              b2Name: b2.name,
              b3Name: b3.name,
              combinationId: b3.combination_id
            });
          }
        }
      }
    }
    return map;
  }

  private findElementsByCombination(elements: any[], combinationId: number): Array<{ name: string; noElType: number; nimSatz?: number }> {
    const matches: Array<{ name: string; noElType: number; nimSatz?: number }> = [];
    for (const element of elements || []) {
      for (const combo of element.combinations || []) {
        if (combo.combination_id === combinationId) {
          matches.push({
            name: element.name,
            noElType: element.noElType,
            nimSatz: combo.nimSatz
          });
          break;
        }
      }
    }
    return matches;
  }

  private getInfoOptionsForNoElType(noElType: number, elemName?: string): Array<{ id: string; name: string }> {
    if (elemName && elemName.endsWith('FaultTm')) {
      return [{ id: '1', name: 'CvOptim' }];
    }
    if (elemName && elemName.endsWith('Fault')) {
      return [{ id: '1', name: 'CvSwitch' }];
    }
    if (noElType === 6) {
      return [{ id: '3', name: 'Status' }];
    }
    if (noElType === 2) {
      return [{ id: '1', name: 'MvMoment' }];
    }
    return [];
  }
  
  /**
   * Arka plana tıklandığında diyaloğu kapatır
   */
  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('fixed')) {
      this.onCancel();
    }
  }

  /**
   * İptal butonuna basıldığında diyaloğu kapatır
   */
  onCancel(): void {
    this.visible = false;
    this.visibleChange.emit(this.visible);
  }

  /**
   * Historical veri için full path listesi ile uygulama
   */
  onConfirm(): void {
    this.debugLog('🎯 [PATH-SELECTOR] onConfirm çağrıldı');
    this.debugLog('📋 [PATH-SELECTOR] selectedPaths listesi:', this.selectedPaths.length, 'eleman', this.selectedPaths);
    
    if (this.dataSourceType === 'sql') {
      // Allow empty paths if they want to clear/reset the widget!
    } else {
      // Auto-add any quick search selections if user didn't click "Ekle"
      if (this.selectedPaths.length === 0 && this.quickSearchSelected && this.quickSearchSelected.size > 0) {
        this.debugLog('📝 [PATH-SELECTOR] Quick search selections found but not added, auto-adding...');
        for (const path of this.quickSearchSelected) {
          if (!this.selectedPaths.includes(path)) {
            this.selectedPaths.push(path);
            this.activePaths[path] = !this.showOnlyFormula;
          }
        }
        this.quickSearchSelected.clear();
      }
      
      // Eğer liste boşsa ama seçili bir path varsa (hiyerarşide en azından bir yol oluşturulmuşsa), otomatik olarak ekle
      if (this.selectedPaths.length === 0 && this.selectedPath && this.selectedPath.trim().length > 0) {
        this.debugLog('📝 [PATH-SELECTOR] Seçili path var ama listeye eklenmemiş, otomatik ekleniyor...');
        this.selectedPaths.push(this.selectedPath);
        this.activePaths[this.selectedPath] = !this.showOnlyFormula;
        this.showTemporaryMessage(`✅ "${this.selectedPath}" ${this.translate.instant('HARDCODED.AUTO_ADDED')}`, 'success');
      }
    }
    
    // Auto-apply formula if valid (user doesn't have to click "Add to Path List")
    const formulaToSend = this.formula && this.formula.trim() && !this.formulaError ? this.formula.trim() : '';
    if (formulaToSend && !this.formulaApplied) {
      this.formulaApplied = true;
    }
    
    // console.log(`📐 [FORMULA] onConfirm: formula="${this.formula}" applied=${this.formulaApplied} error=${this.formulaError || 'none'} sending="${formulaToSend}"`);
    // console.log(`📐 [FORMULA] onConfirm: paths=${this.selectedPaths.length}`, this.selectedPaths);
    
    const result: PathSelectorDialogResult = {
      paths: [...this.selectedPaths], // Seçilen tüm path'ler
      updateInterval: this.updateInterval,
      animationsEnabled: this.animationsEnabled,
      dataSourceType: this.dataSourceType,
      seriesColors: this.seriesColors.length > 0 ? [...this.seriesColors] : undefined,
      customTitle: this.customTitle || undefined,
      formula: formulaToSend,
      decimalPlaces: this.decimalPlaces,
      decimalPlacesEnabled: this.decimalPlacesEnabled,
      activePaths: { ...this.activePaths },
      sqlValueColumn: this.selectedSqlValueCol || undefined,
      sqlLabelColumn: this.selectedSqlLabelCol || undefined
    };
      
    // Historical data için tarih aralığını ekle
    if (this.dataSourceType === 'historical') {
      result.startDate = this.startDate;
      result.endDate = this.endDate;
    }

    this.debugLog('✅ [PATH-SELECTOR] Path listesi ile seçim tamamlandı:', result);
    this.debugLog('🔍 [PATH-SELECTOR] Seçilen path sayısı:', this.selectedPaths.length);
    this.debugLog('📋 [PATH-SELECTOR] Path listesi:', this.selectedPaths);

    // CRITICAL: Emit result BEFORE closing dialog!
    // *ngIf destroys the component when visible becomes false,
    // so pathSelected must fire while the component is still alive.
    // DIRECT CALLBACK: bypass Angular EventEmitter entirely
    if (this.pathSelectedCallback) {
      console.log('📐 [FORMULA] Calling pathSelectedCallback directly');
      this.pathSelectedCallback(result);
      console.log('📐 [FORMULA] pathSelectedCallback completed');
    }
    // Also emit for any other listeners
    this.pathSelected.emit(result);
    
    // Delay close to let Angular process
    setTimeout(() => {
      this.visible = false;
      this.visibleChange.emit(this.visible);
    }, 0);
  }
  
  /**
   * Güncelleme aralığı seçimi değiştiğinde çağrılır
   */  
  onIntervalChange(event: Event): void {
    const selectElement = event.target as HTMLSelectElement;
    if (selectElement) {
      this.updateInterval = +selectElement.value;
    }
  }

  /**
   * Verileri yeniden yükle (Sadece B1 için)
   */
  reloadData(): void {
    const logPrefix = this.dataSourceType === 'realtime' ? '[REALTIME-SELECTOR]' : '[HISTORICAL-SELECTOR]';
    ////console.log(`🔄 ${logPrefix} Veriler yeniden yükleniyor...`);
    this.resetSelections();
    this.loadB1Paths();
  }

  /**
   * Seçimleri sıfırla (B1/B2/B3 hiyerarşik yapı için)
   */
  resetSelections(): void {
    this.selectedB1Id = '';
    this.selectedB2Id = '';
    this.selectedB3Id = '';
    this.selectedElemId = '';
    this.selectedInfoId = '';
    this.selectedPath = '';
    this.selectedPaths = [];
    
    // Listeleri temizle (B1 hariç, çünkü yeniden yüklenecek)
    this.pathsLevel2 = [];
    this.pathsLevel3 = [];
    this.pathsElem = [];
    this.pathsInfo = [];
    
    // Arama sorgularını temizle
    this.searchQuery = {
      b1: '',
      b2: '',
      b3: '',
      elem: '',
      info: ''
    };
    
    this.error = '';
    this.successMessage = '';
  }

  /**
   * Geçici mesaj gösterir
   */
  showTemporaryMessage(message: string, type: 'success' | 'error' = 'success'): void {
    if (type === 'success') {
      this.successMessage = message;
      this.error = '';
    } else {
      this.error = message;
      this.successMessage = '';
    }
    
    // 3 saniye sonra mesajı temizle
    setTimeout(() => {
      this.successMessage = '';
      if (type === 'error') {
        this.error = '';
      }
    }, 3000);
  }

  /**
   * Date nesnesini datetime-local input formatına çevirir (YYYY-MM-DDTHH:mm)
   */
  private toLocalDatetimeString(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  getPathDisplayName(path: string): string {
    if (path.startsWith('sql://')) {
      const expId = path.substring(6);
      const exp = this.savedExplorations.find(e => e.id === expId);
      return exp ? `Saved SQL: ${exp.name}` : `Saved SQL Query (${expId.substring(0, 6)}...)`;
    }
    return path;
  }
}
