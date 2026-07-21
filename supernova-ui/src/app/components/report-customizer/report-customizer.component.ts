import { Component, Input, Output, EventEmitter, OnInit, ChangeDetectorRef, NgZone } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { TranslateService } from '@ngx-translate/core';
import { CHART_PALETTE, BRAND, STATUS } from '../../shared/theme/palette';

export interface ChartConfiguration {
  id: string;
  enabled: boolean;
  title: string;
  type: 'line' | 'bar' | 'scatter';
  x_axis: string;
  y_axis: string;
  point_name_filter: string;
  color?: string;
}

export interface ChartOptions {
  include_charts: boolean;
  charts: ChartConfiguration[];
}

export interface ChartConfiguration {
  id: string;
  enabled: boolean;
  title: string;
  type: 'line' | 'bar' | 'scatter';
  x_axis: string;
  y_axis: string;
  point_name_filter: string;
  color?: string;
}

export interface ChartOptions {
  include_charts: boolean;
  charts: ChartConfiguration[];
}

export interface ReportAnalysis {
  available_columns: string[];
  column_types: { [key: string]: string };
  sample_data: any[];
  total_records: number;
  source_groups?: {
    [source: string]: {
      label: string;
      columns: string[];
      paths: any[];
      record_count: number;
      path_count: number;
    };
  };
  customization_defaults: {
    selected_columns: string[];
    column_order: string[];
    primary_column: string;
    sort_by: string;
    sort_ascending: boolean;
    file_format: string;
    report_title: string;
    report_description: string;
    excel_options: {
      include_charts: boolean;
      auto_filter: boolean;
      freeze_panes: boolean;
      colors: {
        header_bg: string;
        header_text: string;
        alternate_row: string;
        border_color?: string;
        accent_color?: string;
      };
      font_styles?: {
        header_size: string;
        data_size: string;
        font_family: string;
      };
    };
  };
}

export interface CustomizationOptions {
  selectedColumns: string[];
  columnOrder: string[];
  primaryColumn: string;
  sortBy: string;
  sortAscending: boolean;
  fileFormat: string;
  reportTitle: string;
  reportDescription: string;
  excelOptions: {
    includeCharts: boolean;
    includeFormulas?: boolean;
    enabledFormulas?: string[];
    includeCombinedAnalysis?: boolean;
    autoFilter: boolean;
    freezePanes: boolean;
    colors: {
      headerBg: string;
      headerText: string;
      alternateRow: string;
      borderColor?: string;
      accentColor?: string;
    };
    fontStyles?: {
      headerSize: string;
      dataSize: string;
      fontFamily: string;
    };
    chartOptions?: ChartOptions;
  };
}

export interface PreviewData {
  report_info: {
    report_id: string;
    report_name: string;
    total_paths: number;
  };
  paths?: Array<{
    path: string;
    source?: string;
    total_records: number;
    preview_data: any[];
    columns: string[];
  }>;
  is_template?: boolean;
  sheets?: Array<{
    name: string;
    rows: Array<Array<{
      value: string;
      bg_color?: string;
      text_color?: string;
      bold?: boolean;
      italic?: boolean;
      align?: string;
    }>>;
  }>;
}

@Component({
  standalone: false,
  selector: 'app-report-customizer',
  templateUrl: './report-customizer.component.html',
  styleUrls: ['./report-customizer.component.scss']
})
export class ReportCustomizerComponent implements OnInit {
  @Input() reportId: string = '';
  @Input() isVisible: boolean = false;
  @Input() presetTemplateId: string = '';
  @Output() close = new EventEmitter<void>();
  @Output() reportGenerated = new EventEmitter<any>();

  shouldAutoPreview: boolean = false;

  // Step management
  currentStep: number = 1;
  analyzing: boolean = false;
  previewLoading: boolean = false;
  generating: boolean = false;
  saving: boolean = false;
  
  // Multi-source tab tracking
  activeSourceTab: string = 'sys';
  
  // Progress tracking
  progressSteps: string[] = [];
  currentProgressStep: string = '';
  progressPercentage: number = 0;
  estimatedTimeRemaining: number = 0;

  // Chart Manager properties
  chartManagerData: any = null;

  // Chart Manager
  showChartManager: boolean = false;

  // Formula Manager
  showFormulaManager: boolean = false;
  formulaManagerPaths: string[] = [];
  reportFormulas: any[] = [];

  // Excel Template Builder
  showTemplateBuilder: boolean = false;
  excelTemplate: any = null;
  savedTemplateId: string = '';
  private userId: string = '';
  templateIsShared: boolean = false;
  templateSharedWith: any[] = [];

  fileTemplateConfig: any = null;
  loadedTemplateName: string = '';

  // Data
  reportAnalysis: ReportAnalysis | null = null;
  previewData: PreviewData | null = null;
  activePreviewSheetIdx: number = 0;

  // Customization options
  customizationOptions: CustomizationOptions = {
    selectedColumns: [],
    columnOrder: [],
    primaryColumn: '',
    sortBy: '',
    sortAscending: true,
    fileFormat: 'excel',
    reportTitle: '',
    reportDescription: '',
    excelOptions: {
      includeCharts: false,
      includeFormulas: true,
      enabledFormulas: ['sum', 'average', 'min', 'max'],
      includeCombinedAnalysis: false,
      autoFilter: true,
      freezePanes: true,
      colors: {
        headerBg: BRAND.primary,
        headerText: '#1A1714',
        alternateRow: '#FBFAF6',
        borderColor: '#E7E2D7',
        accentColor: BRAND.secondary
      },
      fontStyles: {
        headerSize: '14',
        dataSize: '11',
        fontFamily: 'Calibri'
      },
      chartOptions: {
        include_charts: false,
        charts: []
      }
    }
  };

  // UI State
  showAdvancedColors: boolean = false;
  showSuccessToast: boolean = false;
  successMessage: string = '';
  successDetails: string = '';
  reportResult: any = null;
  showChartOptions: boolean = false;
  currentChartIndex: number = -1;

  // Step definitions for progress indicator
  stepDefinitions = [
    { n: 1, key: 'STEP_ANALYSIS' },
    { n: 2, key: 'STEP_CUSTOMIZE' },
    { n: 3, key: 'STEP_PREVIEW' },
    { n: 4, key: 'STEP_GENERATE' }
  ];

  // Formula types available for Excel
  formulaTypes = [
    { key: 'sum', label: 'SUM', excel: '=SUM()' },
    { key: 'average', label: 'AVG', excel: '=AVERAGE()' },
    { key: 'min', label: 'MIN', excel: '=MIN()' },
    { key: 'max', label: 'MAX', excel: '=MAX()' },
    { key: 'count', label: 'COUNT', excel: '=COUNT()' },
    { key: 'stdev', label: 'STDEV', excel: '=STDEV()' }
  ];

  // UI data
  availableFormats = [
    { value: 'excel', labelKey: 'FILE_TYPE_EXCEL', icon: '📊' },
    { value: 'ods', labelKey: 'FILE_TYPE_ODS', icon: '📋' },
    { value: 'pdf', labelKey: 'FILE_TYPE_PDF', icon: '📄' },
    { value: 'csv', labelKey: 'FILE_TYPE_CSV', icon: '📋' }
  ];

  // Professional Color Themes (no hardcoded translations — names are universal)
  businessThemes = [
    { name: 'Nov4 Gold', colors: { headerBg: BRAND.primary, headerText: '#1A1714', alternateRow: '#FBFAF6', borderColor: '#E7E2D7', accentColor: BRAND.secondary } },
    { name: 'Corporate Blue', colors: { headerBg: '#1e40af', headerText: '#ffffff', alternateRow: '#eff6ff', borderColor: '#d1d5db', accentColor: '#3b82f6' } },
    { name: 'Executive Gray', colors: { headerBg: '#374151', headerText: '#ffffff', alternateRow: '#f9fafb', borderColor: '#d1d5db', accentColor: '#6b7280' } },
    { name: 'Success Green', colors: { headerBg: '#059669', headerText: '#ffffff', alternateRow: '#ecfdf5', borderColor: '#d1fae5', accentColor: '#10b981' } },
    { name: 'Finance Dark', colors: { headerBg: '#1f2937', headerText: '#ffffff', alternateRow: '#f3f4f6', borderColor: '#d1d5db', accentColor: '#4b5563' } }
  ];

  modernThemes = [
    { name: 'Neon Blue', colors: { headerBg: '#0ea5e9', headerText: '#ffffff', alternateRow: '#f0f9ff', borderColor: '#bae6fd', accentColor: '#38bdf8' } },
    { name: 'Purple', colors: { headerBg: '#7c3aed', headerText: '#ffffff', alternateRow: '#faf5ff', borderColor: '#e9d5ff', accentColor: '#a855f7' } },
    { name: 'Sunset', colors: { headerBg: '#ea580c', headerText: '#ffffff', alternateRow: '#fff7ed', borderColor: '#fed7aa', accentColor: '#fb923c' } },
    { name: 'Cyan', colors: { headerBg: '#0891b2', headerText: '#ffffff', alternateRow: '#ecfeff', borderColor: '#a5f3fc', accentColor: '#22d3ee' } }
  ];

  dataVizThemes = [
    { name: 'Dashboard', colors: { headerBg: '#1e293b', headerText: '#f1f5f9', alternateRow: '#f8fafc', borderColor: '#cbd5e1', accentColor: '#3b82f6' } },
    { name: 'Analytics', colors: { headerBg: '#1e3a8a', headerText: '#ffffff', alternateRow: '#eff6ff', borderColor: '#bfdbfe', accentColor: '#2563eb' } },
    { name: 'Metric', colors: { headerBg: '#14532d', headerText: '#ffffff', alternateRow: '#f0fdf4', borderColor: '#bbf7d0', accentColor: '#22c55e' } },
    { name: 'Alert Red', colors: { headerBg: '#991b1b', headerText: '#ffffff', alternateRow: '#fef2f2', borderColor: '#fecaca', accentColor: '#ef4444' } }
  ];

  // Combined themes for compact display
  get allThemes() {
    return [...this.businessThemes, ...this.modernThemes, ...this.dataVizThemes].slice(0, 13);
  }

  predefinedColors = [
    { name: 'Gold', bg: BRAND.primary, text: '#ffffff' },
    { name: 'Flare', bg: BRAND.secondary, text: '#ffffff' },
    { name: 'Lunar', bg: BRAND.tertiary, text: '#ffffff' },
    { name: 'Emerald', bg: STATUS.success, text: '#ffffff' },
    { name: 'Rose', bg: '#F472B6', text: '#ffffff' },
    { name: 'Sky', bg: '#60A5FA', text: '#ffffff' }
  ];

  constructor(private apiService: ApiService, private authService: AuthService, private translate: TranslateService, private cdr: ChangeDetectorRef, private ngZone: NgZone) {
    // FontStyles'ı her zaman initialize et
    this.customizationOptions.excelOptions.fontStyles = {
      headerSize: '14',
      dataSize: '11',
      fontFamily: 'Calibri'
    };
    
    // Chart options'ı initialize et
    this.customizationOptions.excelOptions.chartOptions = {
      include_charts: false,
      charts: []
    };
  }

  ngOnInit() {
    // Set user ID
    const user = this.authService.getCurrentUser();
    this.userId = user?.id || '';

    // Chart options synchronization
    this.syncChartOptions();
    
    if (this.isVisible && this.reportId) {
      // Load template first, then start analysis
      this.loadUserTemplate();
      this.startAnalysis();
    }
  }

  // Chart senkronizasyonu
  syncChartOptions() {
    // Excel options'ı initialize et
    if (!this.customizationOptions.excelOptions) {
      this.customizationOptions.excelOptions = {
        includeCharts: false,
        autoFilter: true,
        freezePanes: true,
        colors: {
          headerBg: BRAND.primary,
          headerText: '#1A1714',
          alternateRow: '#FBFAF6',
          borderColor: '#E7E2D7',
          accentColor: BRAND.secondary
        },
        fontStyles: {
          headerSize: '14',
          dataSize: '11',
          fontFamily: 'Calibri'
        }
      };
    }
    
    if (!this.customizationOptions.excelOptions.chartOptions) {
      this.customizationOptions.excelOptions.chartOptions = {
        include_charts: false,
        charts: []
      };
    }
    
    // includeCharts değeri değiştiğinde chartOptions.include_charts'ı güncelle
    this.customizationOptions.excelOptions.chartOptions.include_charts = 
      this.customizationOptions.excelOptions.includeCharts || false;
      
  }

  ngOnChanges() {
    // isVisible true olduğunda ve reportId varsa analiz başlat
    if (this.isVisible && this.reportId && !this.analyzing && !this.reportAnalysis) {
      this.startAnalysis();
    }
  }

  async startAnalysis() {
    this.analyzing = true;
    this.currentStep = 1;

    try {
      ////console.log('🔍 Rapor analizi başlatılıyor:', this.reportId);
      
      const response = await this.apiService.analyzeReport(this.reportId).toPromise();
      
      this.ngZone.run(() => {
        if (response.status === 'success') {
          this.reportAnalysis = response.data;
          this.applyDefaults();
          ////console.log('✅ Rapor analizi tamamlandı');
          
          if (this.shouldAutoPreview) {
            this.shouldAutoPreview = false;
            this.showPreview();
          }
        } else {
          console.error('❌ Rapor analizi başarısız:', response.message);
          alert(this.translate.instant('REPORTS.ANALYSIS_FAILED', { message: response.message }));
          this.closeCustomizer();
        }
        this.analyzing = false;
        this.cdr.detectChanges();
      });
    } catch (error) {
      this.ngZone.run(() => {
        console.error('❌ Rapor analizi hatası:', error);
        alert(this.translate.instant('REPORTS.ANALYZE_ERROR'));
        this.closeCustomizer();
        this.analyzing = false;
        this.cdr.detectChanges();
      });
    }
  }

  applyDefaults() {
    if (!this.reportAnalysis) return;

    const defaults = this.reportAnalysis.customization_defaults;

    // Preserve existing template if loaded from DB
    const existingTemplate = this.excelTemplate || (this.customizationOptions.excelOptions as any)?.excelTemplate;
    const existingFileTemplate = this.fileTemplateConfig || (this.customizationOptions.excelOptions as any)?.fileTemplate;

    // Smart default column selection: prefer key SCADA columns
    const preferredDefaults = this.getPreferredColumns(this.reportAnalysis.available_columns);
    const selectedCols = preferredDefaults.length > 0 ? preferredDefaults : [...defaults.selected_columns];
    
    this.customizationOptions = {
      selectedColumns: selectedCols,
      columnOrder: [...selectedCols],
      primaryColumn: defaults.primary_column,
      sortBy: defaults.sort_by,
      sortAscending: defaults.sort_ascending,
      fileFormat: defaults.file_format,
      reportTitle: this.loadedTemplateName || defaults.report_title,
      reportDescription: defaults.report_description,
      excelOptions: {
        includeCharts: defaults.excel_options.include_charts,
        autoFilter: defaults.excel_options.auto_filter,
        freezePanes: defaults.excel_options.freeze_panes,
        colors: {
          headerBg: defaults.excel_options.colors.header_bg,
          headerText: defaults.excel_options.colors.header_text,
          alternateRow: defaults.excel_options.colors.alternate_row,
          borderColor: defaults.excel_options.colors.border_color || '#d1d5db',
          accentColor: defaults.excel_options.colors.accent_color || '#3b82f6'
        }
      }
    };

    // Re-attach preserved templates
    if (existingTemplate) {
      (this.customizationOptions.excelOptions as any).excelTemplate = existingTemplate;
    }
    if (existingFileTemplate) {
      (this.customizationOptions.excelOptions as any).fileTemplate = existingFileTemplate;
    }

    // FontStyles'ı her zaman initialize et
    this.customizationOptions.excelOptions.fontStyles = {
      headerSize: defaults.excel_options.font_styles?.header_size || '14',
      dataSize: defaults.excel_options.font_styles?.data_size || '11',
      fontFamily: defaults.excel_options.font_styles?.font_family || 'Calibri'
    };

    ////console.log('🎨 Varsayılan ayarlar uygulandı:', this.customizationOptions);
    
    // Set active source tab to first available source
    if (this.reportAnalysis?.source_groups) {
      const sources = Object.keys(this.reportAnalysis.source_groups);
      if (sources.length > 0) {
        this.activeSourceTab = sources[0];
      }
    }
  }

  /**
   * Select preferred default columns with fuzzy matching.
   * Looks for POINT_NAME, TIME_STAMP_LOC, VALUE_CUR, QUALITY_TEXT_CUR
   * and falls back to similar column names (different DB languages, etc.)
   */
  private getPreferredColumns(available: string[]): string[] {
    const patterns: { keywords: string[]; fallbacks: string[] }[] = [
      { keywords: ['POINT_NAME'], fallbacks: ['POINT', 'NAME', 'TAG', 'ELEMENT'] },
      { keywords: ['TIME_STAMP_LOC'], fallbacks: ['TIME_STAMP', 'TIMESTAMP', 'TIME', 'DATUM', 'DATE'] },
      { keywords: ['VALUE_CUR'], fallbacks: ['VALUE', 'WERT', 'VAL', 'MESSWERT'] },
      { keywords: ['QUALITY_TEXT_CUR'], fallbacks: ['QUALITY', 'QUALIT', 'STATUS', 'ZUSTAND'] },
    ];

    const selected: string[] = [];

    for (const pat of patterns) {
      // Exact match first
      let found = available.find(c => pat.keywords.includes(c.toUpperCase()));
      if (!found) {
        // Partial / fuzzy match with fallback keywords
        for (const fb of pat.fallbacks) {
          found = available.find(c => c.toUpperCase().includes(fb) && !selected.includes(c));
          if (found) break;
        }
      }
      if (found && !selected.includes(found)) {
        selected.push(found);
      }
    }

    return selected;
  }

  // ── Multi-source helper methods ───────────────────────────────
  getSourceKeys(): string[] {
    if (!this.reportAnalysis?.source_groups) return [];
    return Object.keys(this.reportAnalysis.source_groups);
  }

  getColumnsForSource(source: string): string[] {
    if (!this.reportAnalysis?.source_groups?.[source]) return this.reportAnalysis?.available_columns || [];
    return this.reportAnalysis.source_groups[source].columns || [];
  }

  getSourceIcon(source: string): string {
    const icons: Record<string, string> = { sys: '📊', app: '⚡', live: '📡' };
    return icons[source] || '📋';
  }

  getSourceTabClass(source: string, active: boolean): string {
    if (!active) return '';
    const classes: Record<string, string> = {
      sys: 'text-blue-300 border-blue-400',
      app: 'text-amber-300 border-amber-400',
      live: 'text-green-300 border-green-400'
    };
    return classes[source] || 'text-blue-300 border-blue-400';
  }

  // Column management
  isColumnSelected(column: string): boolean {
    return this.customizationOptions.selectedColumns.includes(column);
  }

  toggleColumn(column: string) {
    const index = this.customizationOptions.selectedColumns.indexOf(column);
    
    if (index > -1) {
      // Remove column
      this.customizationOptions.selectedColumns.splice(index, 1);
      const orderIndex = this.customizationOptions.columnOrder.indexOf(column);
      if (orderIndex > -1) {
        this.customizationOptions.columnOrder.splice(orderIndex, 1);
      }
    } else {
      // Add column
      this.customizationOptions.selectedColumns.push(column);
      this.customizationOptions.columnOrder.push(column);
    }

    ////console.log('🔄 Kolon seçimi güncellendi:', this.customizationOptions.selectedColumns);
  }

  toggleAllColumns() {
    if (!this.reportAnalysis) return;

    if (this.customizationOptions.selectedColumns.length === this.reportAnalysis.available_columns.length) {
      // Unselect all
      this.customizationOptions.selectedColumns = [];
      this.customizationOptions.columnOrder = [];
    } else {
      // Select all
      this.customizationOptions.selectedColumns = [...this.reportAnalysis.available_columns];
      this.customizationOptions.columnOrder = [...this.reportAnalysis.available_columns];
    }

    ////console.log('🔄 Tüm kolonlar güncellendi:', this.customizationOptions.selectedColumns);
  }

  moveColumn(column: string, direction: 'up' | 'down') {
    const index = this.customizationOptions.columnOrder.indexOf(column);
    if (index === -1) return;

    const newIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (newIndex >= 0 && newIndex < this.customizationOptions.columnOrder.length) {
      // Swap columns
      const temp = this.customizationOptions.columnOrder[index];
      this.customizationOptions.columnOrder[index] = this.customizationOptions.columnOrder[newIndex];
      this.customizationOptions.columnOrder[newIndex] = temp;
      
      ////console.log('🔄 Kolon sıralaması güncellendi:', this.customizationOptions.columnOrder);
    }
  }

  // Color theme management
  applyColorTheme(theme: any) {
    // Tema renklerini doğru şekilde aktar
    this.customizationOptions.excelOptions.colors.headerBg = theme.colors.headerBg;
    this.customizationOptions.excelOptions.colors.headerText = theme.colors.headerText;
    this.customizationOptions.excelOptions.colors.alternateRow = theme.colors.alternateRow;
    this.customizationOptions.excelOptions.colors.borderColor = theme.colors.borderColor;
    this.customizationOptions.excelOptions.colors.accentColor = theme.colors.accentColor;
  }

  // Formula management
  isFormulaEnabled(key: string): boolean {
    return (this.customizationOptions.excelOptions.enabledFormulas || []).includes(key);
  }

  toggleFormula(key: string) {
    if (!this.customizationOptions.excelOptions.enabledFormulas) {
      this.customizationOptions.excelOptions.enabledFormulas = [];
    }
    const idx = this.customizationOptions.excelOptions.enabledFormulas.indexOf(key);
    if (idx > -1) {
      this.customizationOptions.excelOptions.enabledFormulas.splice(idx, 1);
    } else {
      this.customizationOptions.excelOptions.enabledFormulas.push(key);
    }
  }

  // Chart Manager
  openChartManager() {
    if (this.customizationOptions.selectedColumns.length === 0) {
      alert(this.translate.instant('REPORTS.SELECT_ONE_COLUMN'));
      return;
    }
    
    ////console.log('🎨 Grafik Yöneticisi açılıyor...');
    
    // Chart Manager'a gerekli verileri hazırla
    this.chartManagerData = {
      reportId: this.reportId,
      reportAnalysis: this.reportAnalysis,
      selectedColumns: this.customizationOptions.selectedColumns
    };
    
    this.showChartManager = true;
  }

  closeChartManager() {
    this.showChartManager = false;
    this.chartManagerData = null;
  }

  onChartConfigUpdated(charts: any[]) {
    if (!this.customizationOptions.excelOptions.chartOptions) {
      this.customizationOptions.excelOptions.chartOptions = { 
        include_charts: true,
        charts: [] 
      };
    }
    this.customizationOptions.excelOptions.chartOptions.charts = charts;
  }

  // Formula Manager
  openFormulaManager() {
    // Build paths list from report analysis
    if (this.reportAnalysis) {
      const sourceGroups = (this.reportAnalysis as any).source_groups;
      if (sourceGroups) {
        this.formulaManagerPaths = [];
        for (const key of Object.keys(sourceGroups)) {
          const group = sourceGroups[key];
          if (group.paths) {
            for (const p of group.paths) {
              this.formulaManagerPaths.push(p.path || p);
            }
          }
        }
      }
    }
    this.showFormulaManager = true;
  }

  closeFormulaManager() {
    this.showFormulaManager = false;
  }

  onFormulasUpdated(formulas: any[]) {
    this.reportFormulas = formulas;
    // Store formulas in customizationOptions so they reach the backend
    (this.customizationOptions.excelOptions as any).formulas = formulas;
  }

  // Excel Template Builder
  openTemplateBuilder() {
    this.showTemplateBuilder = true;
  }

  closeTemplateBuilder() {
    this.showTemplateBuilder = false;
  }

  onTemplateSaved(template: any) {
    this.excelTemplate = template;
    // Store template in customization options for backend
    (this.customizationOptions.excelOptions as any).excelTemplate = template;

    // Sync chart configs from template builder to customization options
    if (template.chartConfigs?.length) {
      if (!this.customizationOptions.excelOptions.chartOptions) {
        this.customizationOptions.excelOptions.chartOptions = { include_charts: true, charts: [] };
      }
      this.customizationOptions.excelOptions.chartOptions.charts = template.chartConfigs;
      this.customizationOptions.excelOptions.chartOptions.include_charts = true;
    }

    // Sync formula configs from template builder
    if (template.formulaConfigs?.length) {
      this.reportFormulas = template.formulaConfigs;
      (this.customizationOptions.excelOptions as any).formulas = template.formulaConfigs;
    }

    // Ensure columns are selected so preview/generate buttons are enabled
    if (this.customizationOptions.selectedColumns.length === 0 && this.reportAnalysis) {
      this.customizationOptions.selectedColumns = [...this.reportAnalysis.available_columns];
      this.customizationOptions.columnOrder = [...this.reportAnalysis.available_columns];
    }

    // Sync fileFormat to match the template's outputFormat (Excel, ODS, PDF, CSV)!
    if (template.outputFormat) {
      this.customizationOptions.fileFormat = template.outputFormat;
    }

    // Direct transition to preview step!
    this.currentStep = 3;
    this.showPreview();

    // Persist template to DB
    this.saveTemplateToDb(template);
    this.showTemplateBuilder = false; // Hide builder overlay
    this.cdr.detectChanges();
  }

  private saveTemplateToDb(template: any): void {
    if (!this.userId) return;
    const payload: any = {
      user_id: this.userId,
      name: template.name || 'Custom Template',
      description: `Report: ${this.reportId}`,
      template_data: template,
      template_type: 'visual',
      is_shared: this.templateIsShared,
      shared_with: this.templateSharedWith
    };
    if (this.savedTemplateId) {
      payload.id = this.savedTemplateId;
    }
    this.apiService.saveUserTemplate(payload).subscribe({
      next: (res: any) => {
        if (res?.data?.id) {
          this.savedTemplateId = res.data.id;
        }
        console.log('✅ Template saved to DB:', this.savedTemplateId);
      },
      error: (err: any) => {
        console.error('❌ Template save error:', err);
      }
    });
  }

  private loadUserTemplate(): void {
    if (!this.userId) return;

    if (this.presetTemplateId) {
      this.apiService.getUserTemplate(this.presetTemplateId, this.userId).subscribe({
        next: (res: any) => {
          const t = res?.data || res;
          if (t) {
            this.savedTemplateId = t.id;
            this.loadedTemplateName = t.name;
            this.customizationOptions.reportTitle = t.name;
            
            // Preserve sharing metadata
            this.templateIsShared = t.is_shared === 1 || t.is_shared === true;
            this.templateSharedWith = typeof t.shared_with === 'string' ? JSON.parse(t.shared_with || '[]') : (t.shared_with || []);

            try {
              const tplData = typeof t.template_data === 'string'
                ? JSON.parse(t.template_data)
                : t.template_data;
              this.excelTemplate = tplData;
              (this.customizationOptions.excelOptions as any).excelTemplate = tplData;
              
              // Sync chart/formula configs
              if (tplData.chartConfigs?.length) {
                if (!this.customizationOptions.excelOptions.chartOptions) {
                  this.customizationOptions.excelOptions.chartOptions = { include_charts: true, charts: [] };
                }
                this.customizationOptions.excelOptions.chartOptions.charts = tplData.chartConfigs;
                this.customizationOptions.excelOptions.chartOptions.include_charts = true;
                this.customizationOptions.excelOptions.includeCharts = true;
              }
              if (tplData.formulaConfigs?.length) {
                this.reportFormulas = tplData.formulaConfigs;
                (this.customizationOptions.excelOptions as any).formulas = tplData.formulaConfigs;
              }
              
              console.log('✅ Preset template loaded from DB:', t.name, 'sheets:', tplData?.sheets?.length);
              this.shouldAutoPreview = true;
            } catch (e) {
              console.warn('Template parse error:', e);
            }
          }
          this.cdr.detectChanges();
        },
        error: (err: any) => {
          console.warn('Failed to load preset template:', err);
        }
      });
      return;
    }

    this.apiService.listUserTemplates(this.userId).subscribe({
      next: (res: any) => {
        const templates = res?.data || res || [];
        if (Array.isArray(templates) && templates.length > 0) {
          // Find template matching THIS report (description contains report ID)
          const matchingTemplate = templates.find((t: any) =>
            t.description && t.description.includes(this.reportId)
          );
          const latest = matchingTemplate || null;
          if (!latest) {
            console.log('ℹ️ No template found for report:', this.reportId);
            this.cdr.detectChanges();
            return;
          }
          this.savedTemplateId = latest.id;
          this.loadedTemplateName = latest.name;
          this.customizationOptions.reportTitle = latest.name;
          
          // Preserve sharing metadata
          this.templateIsShared = latest.is_shared === 1 || latest.is_shared === true;
          this.templateSharedWith = typeof latest.shared_with === 'string' ? JSON.parse(latest.shared_with || '[]') : (latest.shared_with || []);

          try {
            const tplData = typeof latest.template_data === 'string'
              ? JSON.parse(latest.template_data)
              : latest.template_data;
            this.excelTemplate = tplData;
            (this.customizationOptions.excelOptions as any).excelTemplate = tplData;
            console.log('✅ Template loaded from DB:', latest.name, 'sheets:', tplData?.sheets?.length);
          } catch (e) {
            console.warn('Template parse error:', e);
          }
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.warn('Template load skipped:', err);
      }
    });
  }

  onFileConfigSaved(config: any) {
    this.fileTemplateConfig = config;
    (this.customizationOptions.excelOptions as any).fileTemplate = config;
  }

  // Preview management
  async showPreview() {
    if (this.customizationOptions.selectedColumns.length === 0) {
      alert(this.translate.instant('REPORTS.SELECT_ONE_COLUMN'));
      return;
    }

    this.previewLoading = true;
    this.currentStep = 3;

    try {
      ////console.log('👁️ Önizleme hazırlanıyor:', this.customizationOptions);
      
      const previewOptions = {
        selectedColumns: this.customizationOptions.selectedColumns,
        columnOrder: this.customizationOptions.columnOrder,
        primaryColumn: this.customizationOptions.primaryColumn,
        sortBy: this.customizationOptions.sortBy,
        sortAscending: this.customizationOptions.sortAscending,
        fileFormat: this.customizationOptions.fileFormat,
        reportTitle: this.customizationOptions.reportTitle,
        reportDescription: this.customizationOptions.reportDescription,
        excelOptions: this.customizationOptions.excelOptions,
        maxRows: 10
      };

      this.activePreviewSheetIdx = 0;
      const response = await this.apiService.previewReport(this.reportId, previewOptions).toPromise();
      
      if (response.status === 'success') {
        this.previewData = response.data;
        ////console.log('✅ Önizleme hazırlandı');
      } else {
        console.error('❌ Önizleme başarısız:', response.message);
        alert(this.translate.instant('REPORTS.PREVIEW_FAILED', { message: response.message }));
        this.currentStep = 2;
      }
    } catch (error) {
      console.error('❌ Önizleme hatası:', error);
      alert(this.translate.instant('REPORTS.PREVIEW_ERROR'));
      this.currentStep = 2;
    } finally {
      this.previewLoading = false;
      this.cdr.detectChanges();
    }
  }

  // Report generation
  async generateCustomizedReport() {
    this.generating = true;
    this.progressPercentage = 5;
    this.currentProgressStep = this.translate.instant('REPORTS.PROGRESS_PREPARING');

    // Slowly advance progress until the server responds.
    // We cap at 88 so the bar never "completes" before the real response.
    let progressInterval: any = null;
    const startProgress = (from: number, to: number, stepMs: number, label: string) => {
      if (progressInterval) clearInterval(progressInterval);
      this.progressPercentage = from;
      this.currentProgressStep = label;
      progressInterval = setInterval(() => {
        if (this.progressPercentage < to) {
          this.progressPercentage += 1;
        } else {
          clearInterval(progressInterval);
        }
      }, stepMs);
    };

    startProgress(5, 30, 50, this.translate.instant('REPORTS.PROGRESS_PREPARING'));

    const advanceTimer1 = setTimeout(() => {
      startProgress(30, 60, 80, this.translate.instant('REPORTS.PROGRESS_FETCHING'));
    }, 1500);

    const advanceTimer2 = setTimeout(() => {
      startProgress(60, 88, 200, this.translate.instant('REPORTS.PROGRESS_CREATING_EXCEL'));
    }, 4000);

    try {
      this.syncChartOptions();
      
      // Debug: verify template is in the payload
      const exOpts = (this.customizationOptions.excelOptions as any);
      console.log('🔍 [GENERATE] excelTemplate present:', !!exOpts?.excelTemplate);
      console.log('🔍 [GENERATE] excelTemplate sheets:', exOpts?.excelTemplate?.sheets?.length);
      console.log('🔍 [GENERATE] customizationOptions keys:', Object.keys(this.customizationOptions));
      console.log('🔍 [GENERATE] excelOptions keys:', Object.keys(this.customizationOptions.excelOptions || {}));
      
      // Call backend — may take 10–60s; the progress bar will slowly tick to 88
      const response = await this.apiService.generateFinalReport(this.reportId, this.customizationOptions).toPromise();
      
      clearTimeout(advanceTimer1);
      clearTimeout(advanceTimer2);
      if (progressInterval) clearInterval(progressInterval);

      if (response.status === 'success') {
        this.progressPercentage = 100;
        this.currentProgressStep = this.translate.instant('REPORTS.PROGRESS_COMPLETE');
        
        this.reportGenerated.emit({
          reportId: this.reportId,
          result: response.data,
          customization: this.customizationOptions,
          isFinalReport: true,
          selectedColumnsCount: response.data.selected_columns_count,
          dataCount: response.data.data_count
        });
        
        setTimeout(() => {
          this.closeCustomizer();
        }, 1500);
      } else {
        console.error('❌ Final rapor oluşturma başarısız:', response.message);
        alert(this.translate.instant('REPORTS.FINAL_REPORT_FAILED', { message: response.message }));
      }
    } catch (error) {
      clearTimeout(advanceTimer1);
      clearTimeout(advanceTimer2);
      if (progressInterval) clearInterval(progressInterval);
      console.error('❌ Final rapor oluşturma hatası:', error);
      alert(this.translate.instant('REPORTS.FINAL_REPORT_ERROR'));
    } finally {
      setTimeout(() => {
        this.generating = false;
        this.progressPercentage = 0;
        this.currentProgressStep = '';
        this.cdr.detectChanges();
      }, 1000);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Progress helper methods
  private updateProgress(percentage: number, step: string) {
    this.progressPercentage = percentage;
    this.currentProgressStep = step;
    this.estimatedTimeRemaining = Math.max(0, Math.ceil((100 - percentage) / 10));
  }

  // Navigation
  goToPreviousStep() {
    if (this.currentStep > 1) {
      if (this.currentStep === 3 && this.excelTemplate) {
        this.currentStep = 2;
        this.showTemplateBuilder = true; // Auto re-open template builder!
      } else {
        this.currentStep--;
        
        if (this.currentStep === 1) {
          this.previewData = null;
        }
      }
    }
  }

  // Color theme management functions
  isThemeSelected(theme: any): boolean {
    return theme.colors.headerBg === this.customizationOptions.excelOptions.colors.headerBg &&
           theme.colors.headerText === this.customizationOptions.excelOptions.colors.headerText &&
           theme.colors.alternateRow === this.customizationOptions.excelOptions.colors.alternateRow;
  }

  resetToDefaultColors() {
    this.customizationOptions.excelOptions.colors = {
      headerBg: BRAND.primary,
      headerText: '#1A1714',
      alternateRow: '#FBFAF6',
      borderColor: '#E7E2D7',
      accentColor: BRAND.secondary
    };
    ////console.log('🔄 Varsayılan renkler geri yüklendi');
  }

  toggleAdvancedColors() {
    this.showAdvancedColors = !this.showAdvancedColors;
    ////console.log('🔧 Gelişmiş renk ayarları:', this.showAdvancedColors ? 'açık' : 'kapalı');
  }

  applyStylePreset(presetName: string) {
    const presets: { [key: string]: any } = {
      'minimal': {
        colors: {
          headerBg: '#f8fafc',
          headerText: '#1e293b',
          alternateRow: '#ffffff',
          borderColor: '#e2e8f0',
          accentColor: '#64748b'
        },
        fontStyles: {
          headerSize: '12',
          dataSize: '10',
          fontFamily: 'Arial'
        }
      },
      'corporate': {
        colors: {
          headerBg: '#1e40af',
          headerText: '#ffffff',
          alternateRow: '#eff6ff',
          borderColor: '#bfdbfe',
          accentColor: '#3b82f6'
        },
        fontStyles: {
          headerSize: '14',
          dataSize: '11',
          fontFamily: 'Calibri'
        }
      },
      'vibrant': {
        colors: {
          headerBg: '#7c3aed',
          headerText: '#ffffff',
          alternateRow: '#faf5ff',
          borderColor: '#e9d5ff',
          accentColor: '#a855f7'
        },
        fontStyles: {
          headerSize: '16',
          dataSize: '12',
          fontFamily: 'Segoe UI'
        }
      },
      'elegant': {
        colors: {
          headerBg: '#374151',
          headerText: '#f9fafb',
          alternateRow: '#ffffff',
          borderColor: '#d1d5db',
          accentColor: '#6b7280'
        },
        fontStyles: {
          headerSize: '14',
          dataSize: '11',
          fontFamily: 'Times New Roman'
        }
      }
    };

    const preset = presets[presetName];
    if (preset) {
      this.customizationOptions.excelOptions.colors = {
        ...this.customizationOptions.excelOptions.colors,
        ...preset.colors
      };
      if (preset.fontStyles) {
        this.customizationOptions.excelOptions.fontStyles = {
          ...this.customizationOptions.excelOptions.fontStyles,
          ...preset.fontStyles
        };
      }
      ////console.log('🎯 Stil ön ayarı uygulandı:', presetName);
    }
  }

  // Professional notification system
  showSuccessNotification(message: string, details: string, result: any) {
    this.successMessage = message;
    this.successDetails = details;
    this.reportResult = result;
    this.showSuccessToast = true;
    
    // Auto hide after 10 seconds
    setTimeout(() => {
      this.hideSuccessNotification();
    }, 10000);
    
    ////console.log('🎉 Başarı bildirimi gösterildi:', message);
  }

  hideSuccessNotification() {
    this.showSuccessToast = false;
    this.successMessage = '';
    this.successDetails = '';
    this.reportResult = null;
  }

  downloadReport() {
    if (this.reportResult && this.reportResult.output_path) {
      // Download link oluştur
      const link = document.createElement('a');
      link.href = `/api/download/${this.reportResult.output_file}`;
      link.download = this.reportResult.output_file;
      link.click();
      ////console.log('📥 Rapor indirme başlatıldı:', this.reportResult.output_file);
    }
  }

  // Navigation methods for welcome screen
  goToCustomization() {
    this.currentStep = 2;
    console.log('🎨 Özelleştirme adımına geçiliyor');
  }

  skipCustomization() {
    // Varsayılan ayarlarla devam et, direkt önizleme adımına geç
    this.showPreview();
    console.log('⏭️ Özelleştirme atlanıyor, önizleme gösteriliyor');
  }

  // Save customization without generating report
  async saveCustomization() {
    if (this.customizationOptions.selectedColumns.length === 0) {
      alert(this.translate.instant('REPORTS.SELECT_ONE_COLUMN'));
      return;
    }

    this.saving = true;

    try {
      console.log('💾 Özelleştirmeler kaydediliyor:', this.customizationOptions);
      
      // Raw report dosyasını güncelle
      // Backend'e PUT isteği gönder
      const response = await this.apiService.updateRawReport(this.reportId, this.customizationOptions).toPromise();
      
      if (response && response.status === 'success') {
        console.log('✅ Özelleştirmeler başarıyla kaydedildi');
        
        // Başarı mesajı göster
        this.showSuccessNotification(
          '✅ ' + this.translate.instant('HARDCODED.CUSTOMIZATION_SAVED'),
          this.translate.instant('HARDCODED.CUSTOMIZATION_SAVED'),
          null
        );
        
        // 2 saniye sonra toast'u gizle
        setTimeout(() => {
          this.hideSuccessNotification();
        }, 2000);
      } else {
        console.error('❌ Özelleştirme kaydetme başarısız:', response?.message);
        alert(this.translate.instant('REPORTS.SAVE_CUSTOMIZATION_FAILED', { message: response?.message || '' }));
      }
    } catch (error) {
      console.error('❌ Özelleştirme kaydetme hatası:', error);
      alert(this.translate.instant('REPORTS.SAVE_ERROR'));
    } finally {
      this.saving = false;
    }
  }

  closeCustomizer() {
    this.isVisible = false;
    this.currentStep = 1;
    this.analyzing = false;
    this.previewLoading = false;
    this.generating = false;
    this.reportAnalysis = null;
    this.previewData = null;
    this.showAdvancedColors = false;
    
    // Toast notification state reset
    this.showSuccessToast = false;
    this.successMessage = '';
    this.successDetails = '';
    this.reportResult = null;
    this.showChartOptions = false;
    this.currentChartIndex = -1;
    
    // Reset to defaults
    this.loadedTemplateName = '';
    this.customizationOptions = {
      selectedColumns: [],
      columnOrder: [],
      primaryColumn: '',
      sortBy: '',
      sortAscending: true,
      fileFormat: 'excel',
      reportTitle: '',
      reportDescription: '',
      excelOptions: {
        includeCharts: false,
        includeFormulas: true,
        enabledFormulas: ['sum', 'average', 'min', 'max'],
        autoFilter: true,
        freezePanes: true,
        colors: {
          headerBg: BRAND.primary,
          headerText: '#1A1714',
          alternateRow: '#FBFAF6',
          borderColor: '#E7E2D7',
          accentColor: BRAND.secondary
        }
      }
    };
    
    // FontStyles'ı her zaman initialize et
    this.customizationOptions.excelOptions.fontStyles = {
      headerSize: '14',
      dataSize: '11',
      fontFamily: 'Calibri'
    };
    
    // Chart options'ı initialize et
    this.customizationOptions.excelOptions.chartOptions = {
      include_charts: false,
      charts: []
    };
    
    this.close.emit();
    ////console.log('🚪 Özelleştirme penceresi kapatıldı');
  }

  // Chart Management Methods
  toggleChartOptions() {
    this.showChartOptions = !this.showChartOptions;
    ////console.log('📊 Grafik seçenekleri:', this.showChartOptions ? 'açık' : 'kapalı');
  }

  addNewChart() {
    if (!this.customizationOptions.excelOptions.chartOptions) {
      this.customizationOptions.excelOptions.chartOptions = {
        include_charts: true,
        charts: []
      };
    }

    // Kullanılabilir sütunlardan varsayılan değerler belirle
    const availableColumns = this.reportAnalysis?.available_columns || [];
    const timeColumns = availableColumns.filter(col => 
      col.includes('TIME') || col.includes('DATE') || col.includes('TIMESTAMP')
    );
    const valueColumns = availableColumns.filter(col => 
      col.includes('VALUE') || col.includes('AMOUNT') || col.includes('COUNT')
    );

    const defaultXAxis = timeColumns.length > 0 ? timeColumns[0] : (availableColumns[0] || 'X_AXIS');
    const defaultYAxis = valueColumns.length > 0 ? valueColumns[0] : (availableColumns[1] || 'Y_AXIS');
    
    const chartNumber = this.customizationOptions.excelOptions.chartOptions.charts.length + 1;
    const defaultTitle = `${defaultYAxis} - ${defaultXAxis} ${this.translate.instant('WIDGET.CHART_TITLE_SUFFIX')} ${chartNumber}`;

    const newChart: ChartConfiguration = {
      id: `chart_${Date.now()}`,
      enabled: true,
      title: defaultTitle,
      type: 'line',
      x_axis: defaultXAxis,
      y_axis: defaultYAxis,
      point_name_filter: '',
      color: this.getRandomChartColor()
    };

    this.customizationOptions.excelOptions.chartOptions.charts.push(newChart);
    this.customizationOptions.excelOptions.chartOptions.include_charts = true;
    this.customizationOptions.excelOptions.includeCharts = true; // UI checkbox'ı da güncelle
    
    ////console.log('📈 Yeni grafik eklendi:', newChart);
  }

  removeChart(index: number) {
    if (this.customizationOptions.excelOptions.chartOptions?.charts) {
      this.customizationOptions.excelOptions.chartOptions.charts.splice(index, 1);
      
      // Hiç grafik kalmadıysa include_charts'ı false yap
      if (this.customizationOptions.excelOptions.chartOptions.charts.length === 0) {
        this.customizationOptions.excelOptions.chartOptions.include_charts = false;
      }
      
      ////console.log('🗑️ Grafik silindi, kalan:', this.customizationOptions.excelOptions.chartOptions.charts.length);
    }
  }

  toggleChart(index: number) {
    if (this.customizationOptions.excelOptions.chartOptions?.charts[index]) {
      const chart = this.customizationOptions.excelOptions.chartOptions.charts[index];
      chart.enabled = !chart.enabled;
      ////console.log(`📊 Grafik ${chart.title}:`, chart.enabled ? 'etkin' : 'pasif');
    }
  }

  duplicateChart(index: number) {
    if (this.customizationOptions.excelOptions.chartOptions?.charts[index]) {
      const originalChart = this.customizationOptions.excelOptions.chartOptions.charts[index];
      const duplicatedChart: ChartConfiguration = {
        ...originalChart,
        id: `chart_${Date.now()}`,
        title: `${originalChart.title} ${this.translate.instant('WIDGET.COPY_SUFFIX')}`
      };
      
      this.customizationOptions.excelOptions.chartOptions.charts.splice(index + 1, 0, duplicatedChart);
      ////console.log('📋 Grafik kopyalandı:', duplicatedChart.title);
    }
  }

  // Chart configuration helpers
  getAvailableXAxisOptions(): string[] {
    if (!this.reportAnalysis?.available_columns) return [];
    
    // Önce time/date sütunları, sonra tüm sütunlar
    const timeColumns = this.reportAnalysis.available_columns.filter(col => 
      col.includes('TIME') || 
      col.includes('DATE') ||
      col.includes('TIMESTAMP') ||
      col.includes('HANDLE')
    );

    const otherColumns = this.reportAnalysis.available_columns.filter(col => 
      !timeColumns.includes(col)
    );

    return [...timeColumns, ...otherColumns];
  }

  getAvailableYAxisOptions(): string[] {
    if (!this.reportAnalysis?.available_columns) return [];
    
    // Önce value sütunları, sonra tüm sütunlar  
    const valueColumns = this.reportAnalysis.available_columns.filter(col => 
      col.includes('VALUE') || 
      col.includes('COUNT') ||
      col.includes('AVG') ||
      col.includes('MIN') ||
      col.includes('MAX') ||
      col.includes('SUM') ||
      col.includes('AMOUNT')
    );

    const otherColumns = this.reportAnalysis.available_columns.filter(col => 
      !valueColumns.includes(col)
    );

    return [...valueColumns, ...otherColumns];
  }

  getUniquePointNames(): string[] {
    if (!this.previewData?.paths) return [];
    
    const pointNames = new Set<string>();
    this.previewData.paths.forEach(pathData => {
      pathData.preview_data.forEach((row: any) => {
        const pointName = row['POINT_NAME'];
        if (pointName) {
          pointNames.add(pointName.trim());
        }
      });
    });
    
    return Array.from(pointNames).slice(0, 10); // İlk 10 farklı point name
  }

  // Chart type options
  getChartTypeOptions() {
    return [
      { value: 'line', label: this.translate.instant('WIDGET.CHART_TYPE_LINE'), icon: '📈' },
      { value: 'bar', label: this.translate.instant('WIDGET.CHART_TYPE_BAR'), icon: '📊' },
      { value: 'scatter', label: this.translate.instant('WIDGET.CHART_TYPE_SCATTER'), icon: '⚫' }
    ];
  }

  getChartTypeLabel(type: string): string {
    const typeOption = this.getChartTypeOptions().find(t => t.value === type);
    return typeOption ? typeOption.label : type;
  }

  getRandomChartColor(): string {
    const colors = CHART_PALETTE;
    return colors[Math.floor(Math.random() * colors.length)];
  }
}
