import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, OnChanges, SimpleChanges, ViewChild } from '@angular/core';
import { ChartConfiguration, ChartOptions, ChartType, Chart } from 'chart.js';
import { ChangeDetectorRef } from '@angular/core';
import { BaseChartDirective } from 'ng2-charts';
import { PathSelectorDialogResult } from '../../dialogs/path-selector-dialog/path-selector-dialog.component';
import { Subscription, interval, Observable, of } from 'rxjs';
import { map, catchError, switchMap } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { TranslateService } from '@ngx-translate/core';
import { evaluateFormulaOnArrays } from '../../utils/formula-engine';
import { BRAND, STATUS, CHART_PALETTE } from '../../shared/theme/palette';
import { ThemeColors } from '../../shared/theme/theme-colors';

@Component({
  standalone: false,
  selector: 'app-widget',
  templateUrl: './widget.component.html',
  styleUrls: ['./widget.component.scss']
})
export class WidgetComponent implements OnInit, OnDestroy, OnChanges {
  @Input() title = '';
  @Input() instanceId = '';
  @Input() icon = '';
  @Input() type: 'success' | 'info' | 'danger' = 'info';
  @Input() widgetType: string = 'line-chart'; // Ekstra grafik tipi için
  @Input() dataSource: string = ''; // Veri kaynağı
  @Input() dataSourceType: 'realtime' | 'historical' | 'app' | 'sql' | 'python' = 'realtime'; // Veri kaynağı tipi 
  @Input() startDate?: string; // Geçmiş veri başlangıç tarihi
  @Input() endDate?: string; // Geçmiş veri bitiş tarihi
  @Input() initialPaths: string[] = []; // İlk yüklemede hazır path listesi
  @Input() thresholds: { min?: number; max?: number; warning?: number; danger?: number; unit?: string; } = {}; // Eşik değerleri
  @Input() refreshRate?: number; // Cache'den gelen refresh rate
  @Input() historyMinutes: number = 10; // SYS tarihsel veri süresi (dk)
  @Input() formula: string = ''; // Formula expression (e.g. "P1 + P2")
  @Input() activePaths: { [path: string]: boolean } = {}; // Hangi path'lerin aktif olduğunu takip et
  @Input() showHeader: boolean = true; // Dashboard'da false — dış kart zaten header gösteriyor
  @Input() decimalPlaces: number = 2; // Ondalık basamak sayısı (per-widget)
  @Input() decimalPlacesEnabled: boolean = false; // Ondalık basamak aktif mi
  @Input() sqlValueColumn?: string; // SQL value column mapping
  @Input() sqlLabelColumn?: string; // SQL label column mapping

  // Output Events
  @Output() pathsChanged = new EventEmitter<string[]>(); // Path'ler değiştiğinde parent'a bildir
  @Output() configChanged = new EventEmitter<any>(); // Config değiştiğinde parent'a bildir

  // Canlı veri değerleri
  currentValue: number | null = null;
  valueStatus: 'normal' | 'warning' | 'danger' = 'normal';
  valueUnit: string = '';

  description: string = '';
  currentDataPaths: string[] = []; // Birden fazla path desteği için array kullan
  isNoData: boolean = false; // Veritabanında hiç kayıt yoksa No Data overlay göstermek için
  updateInterval: number = 10000; // Default 10 saniye
  animationsEnabled: boolean = true;
  pathSelectorVisible = false;
  @Input() isFullscreen = false; // Tam ekran modunu kontrol etmek için
  @Output() fullscreenToggled = new EventEmitter<boolean>();
  private lastToggleTime: number = 0; // API throttling için
  private standardChartOptions: any = null;
  
  private dataUpdateSubscription?: Subscription;
  sqlTableRows: any[] = [];
  sqlTableColumns: string[] = [];
  columnFilters: { [key: string]: string } = {};
  activeFilterColumn: string | null = null;
  isLoadingData: boolean = false;

  getFilteredSqlRows(): any[] {
    if (Object.keys(this.columnFilters).length === 0) {
      return this.sqlTableRows;
    }
    
    return this.sqlTableRows.filter(row => {
      return Object.keys(this.columnFilters).every(col => {
        const rawFilter = this.columnFilters[col].trim();
        const cellValue = String(row[col] || '').trim();
        
        let op = '';
        let cleanFilter = rawFilter;
        
        // Extract 2-character operators
        const ops2 = ['<=', '>=', '!=', '==', '<>'];
        for (const possibleOp of ops2) {
          if (rawFilter.startsWith(possibleOp)) {
            op = possibleOp;
            cleanFilter = rawFilter.substring(2).trim();
            break;
          }
        }
        
        // Extract 1-character operators
        if (!op) {
          const ops1 = ['<', '>', '='];
          for (const possibleOp of ops1) {
            if (rawFilter.startsWith(possibleOp)) {
              op = possibleOp;
              cleanFilter = rawFilter.substring(1).trim();
              break;
            }
          }
        }
        
        const cellLower = cellValue.toLowerCase();
        const filterLower = cleanFilter.toLowerCase();
        
        if (op) {
          // Attempt numeric comparison first
          const cellNum = Number(cellLower);
          const filterNum = Number(filterLower);
          
          if (!isNaN(cellNum) && !isNaN(filterNum) && cellValue !== '' && cleanFilter !== '') {
            if (op === '<') return cellNum < filterNum;
            if (op === '<=') return cellNum <= filterNum;
            if (op === '>') return cellNum > filterNum;
            if (op === '>=') return cellNum >= filterNum;
            if (op === '!=' || op === '<>') return cellNum !== filterNum;
            if (op === '=' || op === '==') return cellNum === filterNum;
          }
          
          // Lexicographical string comparison (perfect for YYYY-MM-DD HH:MM:SS date strings)
          if (op === '<') return cellLower < filterLower;
          if (op === '<=') return cellLower <= filterLower;
          if (op === '>') return cellLower > filterLower;
          if (op === '>=') return cellLower >= filterLower;
          if (op === '!=' || op === '<>') return cellLower !== filterLower;
          if (op === '=' || op === '==') return cellLower === filterLower;
        }
        
        // Default: contains (case-insensitive)
        return cellLower.includes(filterLower);
      });
    });
  }

  toggleFilterPopover(column: string): void {
    this.activeFilterColumn = this.activeFilterColumn === column ? null : column;
  }

  private getStorageKey(): string {
    return `widget_filters_${this.instanceId || this.title}`;
  }

  setFilter(column: string, value: string): void {
    if (value) {
      this.columnFilters[column] = value;
    } else {
      delete this.columnFilters[column];
    }
    localStorage.setItem(this.getStorageKey(), JSON.stringify(this.columnFilters));
  }

  clearFilter(column: string): void {
    delete this.columnFilters[column];
    localStorage.setItem(this.getStorageKey(), JSON.stringify(this.columnFilters));
    this.activeFilterColumn = null;
  }

  private loadFilters(): void {
    const saved = localStorage.getItem(this.getStorageKey());
    if (saved) {
      try { this.columnFilters = JSON.parse(saved); } catch(e) { this.columnFilters = {}; }
    }
  }

  // Self-healing / Auto-retry properties
  hasError: boolean = false;
  errorMessage: string = '';
  retryCountdown: number = 0;
  private retryTimerSubscription?: Subscription;

  // Chart reference for incremental updates
  @ViewChild(BaseChartDirective) chartComponent?: BaseChartDirective;

  // Path to Satz mapping - gerçek API değerleri için
  private pathToSatzMapping: { [key: string]: number } = {
    '9/1/2/26/1': 7262,  // vienna 220 paris P mvmoment
    // Buraya diğer path-satz eşleştirmeleri eklenebilir
    // Örnek: '9/1/2/27/1': 7263, 
    // '9/1/2/28/1': 7264,
  };

  /**
   * Path'in LIVE mi SYS mi olduğunu belirler.
   * LIVE path'leri [satz] içerir (ör: MvMoment[7262]). SYS path'leri içermez.
   */
  private isRealtimePath(path: string): boolean {
    if (!path || typeof path !== 'string') {
      return false;
    }
    return /\[\d+\]/.test(path);
  }

  /**
   * Tek bir path için uygun API'den veri çeker (LIVE veya SYS veya SQL).
   * Observable<{status, data, message}> döndürür.
   */
  private fetchSinglePathData(path: string): Observable<{status: string; data: any; message?: string}> {
    if (path.startsWith('sql://')) {
      const expId = path.substring(6);
      return this.apiService.getSavedExplorationData(expId).pipe(
        map((res: any) => {
          if (res && res.status === 'success' && res.data) {
            const rows = res.data.rows || [];
            if (rows.length === 0) {
              return { status: 'success', data: [], message: 'Empty SQL results' };
            }
            const columns = Object.keys(rows[0] || {});
            let numericCol = '';
            for (const col of columns) {
              const val = rows[0][col];
              if (typeof val === 'number') {
                numericCol = col;
                break;
              }
            }
            if (!numericCol) {
              for (const col of columns) {
                const val = parseFloat(rows[0][col]);
                if (!isNaN(val)) {
                  numericCol = col;
                  break;
                }
              }
            }
            const dataValues = rows.map((row: any) => {
              const val = parseFloat(row[numericCol]);
              return isNaN(val) ? 0 : val;
            });
            return {
              status: 'success',
              data: dataValues,
              message: `SQL: ${res.data.name || 'Saved SQL'} (${dataValues.length} rows)`
            };
          }
          return { status: 'error', data: [], message: 'Failed to load SQL data' };
        }),
        catchError(err => of({ status: 'error' as string, data: null, message: err.message }))
      );
    } else if (this.isRealtimePath(path)) {
      const satz = this.getSatzFromPath(path);
      // To prevent flat-line starting values on page load/refresh, fetch actual historical backup values from SYS,
      // and let the LIVE socket/timer update new live values on top of this real curves!
      const cleanPath = path.replace(/\[\d+\]/g, ''); // Remove satz e.g. 'Vienna/220/Paris/P/MvMoment[12]' -> 'Vienna/220/Paris/P/MvMoment'
      return this.apiService.readRawDataHIS(cleanPath, this.historyMinutes).pipe(
        map((res: any) => {
          const data = res?.data?.data || res?.data || [];
          if (Array.isArray(data) && data.length > 0 && res?.status !== 'error') {
            return {
              status: 'success',
              data: data,
              message: `LIVE Historical ${data.length} kayıt (${this.historyMinutes} dk)`
            };
          }
          // Throwing an error guarantees that catchError will trigger and execute the fallback to standard LIVE single-point
          throw new Error('No SYS backup for LIVE');
        }),
        catchError(() => {
          // Fallback to standard single LIVE point on error
          return this.apiService.readRawDataWithSatz(path, satz);
        })
      );
    } else {
      // SYS path — readRawDataHIS ile son N dakikalık raw veri çek
      return this.apiService.readRawDataHIS(path, this.historyMinutes).pipe(
        map((res: any) => {
          const data = res?.data?.data || res?.data || [];
          return {
            status: Array.isArray(data) && data.length > 0 ? 'success' : 'error',
            data: Array.isArray(data) ? data : [],
            message: Array.isArray(data) && data.length > 0 ? `SYS ${data.length} kayıt (${this.historyMinutes} dk)` : 'No SYS data'
          };
        }),
        catchError(err => of({ status: 'error' as string, data: null, message: err.message }))
      );
    }
  }

  // Grafik verisi
  chartData: ChartConfiguration<'line'>['data'] = {
    labels: [''],
    datasets: [
      {
        data: [] as number[], // Tip güvenli başlangıç - boş number array
        label: 'Live Data',
        fill: true,
        tension: 0.4,
        borderColor: '#4FD1C5',
        backgroundColor: 'rgba(79, 209, 197, 0.2)',
        pointRadius: 0
      }
    ]
  };
  chartType: ChartType = 'line';
  chartOptions: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 8,
        right: 12,
        bottom: 8,
        left: 16
      }
    },
    interaction: {
      mode: 'index',
      intersect: false
    },
    scales: {
      x: { 
        display: true,
        offset: false, // Line'ların chart kenarlarına kadar uzanması için
        type: 'category', // Category scale - tam genişlik için
        bounds: 'data', // Data sınırlarını sıkı takip et
        grid: {
          color: 'rgba(200, 200, 200, 0.03)', // Çok çok açık grid
          lineWidth: 0.5, // İnce grid çizgileri
          drawTicks: false,
          tickLength: 0
        },
        border: {
          display: false
        },
        ticks: {
          color: 'rgba(180, 180, 180, 0.9)',
          font: {
            size: 11, // X ekseni için daha büyük font
            family: "'Poppins', 'Helvetica', 'Arial', sans-serif",
            weight: 'bold'
          },
          autoSkip: true,
          maxTicksLimit: 8,
          padding: 4
        }
      },
      y: {
        display: true,
        position: 'left',
        offset: false, // Y ekseni için de line'ların chart kenarlarına kadar uzanması
        beginAtZero: false, // Dinamik scaling için false
        grace: '10%', // Ekstra padding — line'lar taşmasın
        grid: {
          color: 'rgba(200, 200, 200, 0.03)', // Çok çok açık grid
          lineWidth: 0.5, // İnce grid çizgileri  
          drawTicks: false,
          tickLength: 0
        },
        border: {
          display: false
        },
        ticks: {
          color: 'rgba(180, 180, 180, 0.9)',
          font: {
            size: 12, // Daha büyük font
            family: "'Poppins', 'Helvetica', 'Arial', sans-serif",
            weight: 'bold'
          },
          padding: 8,
          autoSkip: true,
          maxTicksLimit: 8,
          callback: (value: any) => this.formatTickValue(value)
        }
      }
    },
    animation: {
      duration: 800, // Smooth animasyon
      easing: 'easeInOutQuart' // Modern easing
    },
    transitions: {
      active: {
        animation: {
          duration: 300,
          easing: 'easeOutQuart'
        }
      }
    },
    elements: {
      line: { 
        borderWidth: 2.5, // Biraz daha ince ama görünür
        tension: 0.4, // Daha smooth eğriler
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        fill: false // Clean lines
      },
      point: { 
        radius: 0, // NOKTALARI TAMAMEN GIZLE
        hoverRadius: 4, // Hover'da küçük nokta göster
        hitRadius: 12, // Geniş tıklama alanı
        borderWidth: 0,
        hoverBorderWidth: 2,
        backgroundColor: 'transparent',
        hoverBackgroundColor: 'rgba(79, 209, 197, 0.9)', // Hover'da güzel renk
        borderColor: 'transparent',
        hoverBorderColor: '#FFFFFF'
      }
    },
    plugins: {
      legend: { 
        display: false // Path labels line ucunda gösterilecek
      },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(15, 17, 21, 0.96)',
        titleColor: '#FFFFFF',
        bodyColor: 'rgba(255, 255, 255, 0.92)',
        borderColor: 'rgba(79, 209, 197, 0.8)',
        borderWidth: 2,
        cornerRadius: 12,
        padding: 16,
        mode: 'index',
        intersect: false,
        position: 'nearest',
        titleFont: {
          size: 12,
          family: "'Poppins', sans-serif",
          weight: 'bold'
        },
        bodyFont: {
          size: 11,
          family: "'Poppins', sans-serif", 
          weight: 'normal'
        },
        displayColors: true, // Path renklerini göster
        usePointStyle: true, // Line style ile göster
        caretSize: 8,
        caretPadding: 10,
        callbacks: {
          title: (context: any[]) => {
            return `⏰ ${context[0].label}`;
          },
          label: (context: any) => {
            const pathName = context.dataset.label || `Path ${context.datasetIndex + 1}`;
            const value = context.parsed.y;
            const unit = context.dataset.unit || '';
            
            // Path ismini kısalt ve güzel göster
            const displayName = pathName.length > 25 
              ? pathName.substring(0, 25) + '...' 
              : pathName;
            
            return `📊 ${displayName}: ${this.formatValue(value)}${unit}`;
          },
          beforeBody: (context: any[]) => {
            if (context.length > 1) {
              const tooltipLabel = this.translateService?.instant('HARDCODED.ACTIVE_PATHS_TOOLTIP') || 'active sources';
              return [`📈 ${context.length} ${tooltipLabel}`];
            }
            return [];
          }
        }
      }
    }
  };
  
  // Tam ekran modunda kullanılacak grafik seçenekleri
  fullscreenChartOptions: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        grid: {
          color: 'rgba(200, 200, 200, 0.15)'
        },
        ticks: {
          color: 'rgba(200, 200, 200, 0.9)',
          font: {
            size: 12
          }
        }
      },
      y: {
        grid: {
          color: 'rgba(200, 200, 200, 0.15)'
        },
        ticks: {
          color: 'rgba(200, 200, 200, 0.9)',
          font: {
            size: 12
          }
        }
      }
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: {
          color: 'white',
          font: {
            size: 14
          }
        }
      },
      tooltip: {
        backgroundColor: 'rgba(20, 20, 20, 0.95)', // Daha koyu background
        titleFont: {
          size: 16, // Daha büyük title
          weight: 'bold'
        },
        bodyFont: {
          size: 14 // Daha büyük body
        },
        padding: 12, // Daha fazla padding
        cornerRadius: 8,
        borderColor: 'rgba(255, 255, 255, 0.1)',
        borderWidth: 1
      }
    }
  };

  constructor(private cdr: ChangeDetectorRef, private apiService: ApiService, private translateService: TranslateService, private themeColors: ThemeColors) {}

  ngOnChanges(changes: SimpleChanges): void {
    ////console.log('[WIDGET] ngOnChanges tetiklendi, değişiklikler:', changes);
    
    // Initial paths değiştiğinde yeni veriyi yükle
    if (changes['initialPaths']) {
      if (this.initialPaths && this.initialPaths.length > 0) {
        ////console.log('[WIDGET] Yeni path\'ler ayarlanıyor:', this.initialPaths);
        this.currentDataPaths = [...this.initialPaths];
        
        // Her zaman activePaths'i yeni initialPaths ile senkronize et (eski path'leri temizle)
        this.activePaths = {};
        this.currentDataPaths.forEach(path => {
          this.activePaths[path] = true;
        });
        
        // Description güncelle
        this.updateDescription();
        ////console.log('[WIDGET] Chart güncelleniyor...');
        this.updateChartWithActivePaths(); // Yeni veriyi yükle
        
        // Timer'ı yeniden başlat (sadece interval değişmişse)
        if (changes['initialPaths'] && !changes['initialPaths'].isFirstChange()) {
          this.startDataUpdates();
        }
      }
    }

    if (changes['activePaths']) {
      if (!changes['activePaths'].isFirstChange()) {
        this.updateChartWithActivePaths();
      }
    }
    
    // Data source type değiştiğinde veriyi yeniden yükle (ama timer başlatma)
    if (changes['dataSourceType'] && !changes['dataSourceType'].isFirstChange()) {
      ////console.log('[WIDGET] Veri kaynağı değişikliği algılandı:', changes['dataSourceType'].currentValue);
      this.updateChartWithActivePaths(); // Sadece veri çek, timer başlatma
    }
    
    // Formula değiştiğinde veriyi yeniden yükle
    if (changes['formula'] && !changes['formula'].isFirstChange()) {
      console.log(`📐 [WIDGET] Formula changed via @Input: "${this.formula}"`);
      this.updateChartWithActivePaths();
    }

    // Threshold değerlerini güncelle
    if (changes['thresholds'] && !changes['thresholds'].isFirstChange()) {
      ////console.log('[WIDGET] Eşik değerleri güncellendi:', changes['thresholds'].currentValue);
      if (this.thresholds && this.thresholds.unit) {
        this.valueUnit = this.thresholds.unit;
      }
    }

    // Decimal places değiştiğinde chart'ı yeniden çiz
    if ((changes['decimalPlaces'] || changes['decimalPlacesEnabled']) && this.chartComponent?.chart) {
      const chart = this.chartComponent.chart;
      // Scale tick callback'ini güncel değerlerle zorla yeniden oluştur
      const yScale = (chart.options as any).scales?.y;
      if (yScale?.ticks) {
        yScale.ticks.callback = (value: any) => {
          if (typeof value === 'number') {
            if (!this.decimalPlacesEnabled) {
              if (Number.isInteger(value)) return String(value);
              return parseFloat(value.toPrecision(6)).toString();
            }
            if (value >= 1000000) {
              return (value / 1000000).toFixed(this.decimalPlaces) + 'M';
            } else if (value >= 1000) {
              return (value / 1000).toFixed(this.decimalPlaces) + 'k';
            } else {
              return value.toFixed(this.decimalPlaces);
            }
          }
          return value;
        };
      }
      chart.update();
    }
  }

  ngOnInit(): void {
    // Widget tipine göre chart tipini ayarla
    this.setChartTypeFromWidgetType();
    
    // Cache'den gelen refreshRate'i kullan
    if (this.refreshRate && this.refreshRate > 0) {
      this.updateInterval = this.refreshRate;
      ////console.log('🔄 [WIDGET] Cache\'den refresh rate yüklendi:', this.refreshRate);
    }
    
    // İlk path'leri ayarla (varsa)
    if (this.initialPaths && this.initialPaths.length > 0) {
      this.currentDataPaths = [...this.initialPaths];
      // Tüm path'leri aktif olarak işaretle (eğer activePaths verilmemişse)
      if (!this.activePaths || Object.keys(this.activePaths).length === 0) {
        this.activePaths = {};
        this.currentDataPaths.forEach(path => {
          this.activePaths[path] = true;
        });
      }
    }
    
    // Eşik değerlerinden birim bilgisini al
    if (this.thresholds && this.thresholds.unit) {
      this.valueUnit = this.thresholds.unit;
    }
    
    this.updateDescription();
    this.updateChartWithActivePaths(); // İlk veriyi yükle
    
    // Timer'ı başlat (sadece realtime modda)
    if (this.dataSourceType === 'realtime') {
      this.startDataUpdates();
    }
    
    ////console.log('✅ [WIDGET] Widget başlatıldı - Tip:', this.widgetType, 'Chart Tip:', this.chartType, 'Mod:', this.dataSourceType, 'Interval:', this.updateInterval + 'ms');
  }

  /**
   * Widget tipine göre chart tipini ayarlar
   */
  private setChartTypeFromWidgetType(): void {
    ////console.log('🎨 [WIDGET] Widget tipi belirleniyor:', this.widgetType);
    
    // Chart tiplerini eşleştir
    switch (this.widgetType) {
      case 'chart':
      case 'line-chart':
      case 'multi-line-chart':
        this.chartType = 'line';
        break;
      case 'bar-chart':
        this.chartType = 'bar';
        break;
      case 'stacked-bar-chart':
        this.chartType = 'bar';
        // Stacked bar için özel yapılandırma
        this.chartOptions.scales = {
          ...this.chartOptions.scales,
          x: { ...(this.chartOptions.scales as any)?.['x'], stacked: true },
          y: { ...(this.chartOptions.scales as any)?.['y'], stacked: true }
        };
        break;
      case 'pie-chart':
        this.chartType = 'pie';
        break;
      case 'doughnut-chart':
        this.chartType = 'doughnut';
        break;
      case 'area-chart':
        this.chartType = 'line'; // Area chart, line chart'ın fill:true hali
        // Area chart için dataset fill özelliğini ayarla
        this.chartData.datasets.forEach(dataset => {
          dataset.fill = true;
          dataset.backgroundColor = dataset.backgroundColor || 'rgba(79, 209, 197, 0.3)';
        });
        break;
      case 'polar-chart':
        this.chartType = 'polarArea';
        break;
      case 'radar-chart':
        this.chartType = 'radar';
        break;
      case 'scatter-chart':
        this.chartType = 'scatter';
        break;
      case 'bubble-chart':
        this.chartType = 'bubble';
        break;
      case 'waterfall-chart':
        this.chartType = 'bar'; // Waterfall chart, özel bar chart konfigürasyonu
        break;
      case 'heatmap-chart':
        this.chartType = 'scatter'; // Heatmap için scatter chart kullan
        break;
      // Value-based widgets
      case 'value-card':
      case 'stat-card':
      case 'gauge':
      case 'kpi-widget':
      case 'trend-indicator':
      case 'status-indicator':
      case 'progress-indicator':
      case 'alert-widget':
        // These types are not charts, custom rendering
        console.log('💎 [WIDGET] Value-based widget type:', this.widgetType);
        break;
      // Table widgets
      case 'data-table':
        console.log('📊 [WIDGET] Table widget type:', this.widgetType);
        break;
      // Specialized widgets
      case 'phasor-chart':
      case 'power-quality':
      case 'forecasting-chart':
      case 'network-diagram':
      case 'multi-value':
      case 'event-log':
      case 'comparison-widget':
      case 'alarm-list':
      case 'alarm-summary':
      case 'switching-status':
      case 'power-flow':
      case 'load-profile':
      case 'query-viewer':
        ////console.log('🔬 [WIDGET] Specialized widget type:', this.widgetType);
        this.chartType = 'line'; // Default to line chart
        break;
      default:
        console.warn('⚠️ [WIDGET] Unknown widget type:', this.widgetType, '- Line chart will be used');
        this.chartType = 'line';
        break;
    }
    
    ////console.log('✅ [WIDGET] Chart tipi ayarlandı:', this.chartType, 'Widget tipi:', this.widgetType);
  }

  ngOnDestroy(): void {
    this.stopDataUpdates();
    this.stopRetryTimer();
  }

  // Start automatic self-healing countdown
  startRetryCountdown(): void {
    // Avoid double timers
    this.stopRetryTimer();
    
    this.retryCountdown = 10; // Try again in 10 seconds
    this.retryTimerSubscription = interval(1000).subscribe(() => {
      this.retryCountdown--;
      if (this.retryCountdown <= 0) {
        console.log(`🔄 [WIDGET] Auto-retry countdown reached 0. Automatically retrying data fetch...`);
        this.stopRetryTimer();
        this.manualRetry();
      }
      this.cdr.detectChanges();
    });
  }

  // Stop self-healing timer
  stopRetryTimer(): void {
    if (this.retryTimerSubscription) {
      this.retryTimerSubscription.unsubscribe();
      this.retryTimerSubscription = undefined;
    }
    this.retryCountdown = 0;
  }

  // Manually or automatically retry data load
  manualRetry(): void {
    console.log('🔄 [WIDGET] Retrying data load...');
    this.hasError = false;
    this.errorMessage = '';
    this.stopRetryTimer();
    
    // Trigger update Chart
    this.updateChartWithActivePaths();
  }

  // Path Selector Dialog'u açma
  openPathSelector(): void {
    ////console.log('🔓 [WIDGET] Path selector açılıyor, mevcut path\'ler:', this.currentDataPaths);
    this.pathSelectorVisible = true;
  }

  // Diyalog görünürlüğünü ayarlar (hem path ekleme hem ayarlar için)
  setDialogVisibility(visible: boolean): void {
    this.pathSelectorVisible = visible;
  }

  // Bound callback for direct function call from dialog (bypasses Angular EventEmitter)
  boundOnPathSelected = (result: PathSelectorDialogResult) => this.onPathSelected(result);

  // Path Selector'dan seçilen değerleri işleme
  onPathSelected(result: PathSelectorDialogResult): void {
    console.log('🎯 [WIDGET] onPathSelected:', { paths: result?.paths?.length, formula: result?.formula, dataSourceType: result?.dataSourceType });
    
    // Close the dialog from widget side
    this.pathSelectorVisible = false;
    
    if (!result || !result.paths) {
      console.warn('❌ [WIDGET] Selected path result is invalid, operation cancelled.');
      return;
    }

    ////console.log('🎯 [WIDGET] Path seçildi - Result:', result);
    ////console.log('🎯 [WIDGET] Seçilen path\'ler:', result.paths);
    ////console.log('🎯 [WIDGET] Mevcut path\'ler:', this.currentDataPaths);

    // Path selector'dan gelen result.paths zaten birleştirilmiş path'leri içeriyor
    // Path selector component kendi içinde mevcut + yeni path'leri yönetiyor
    this.currentDataPaths = [...result.paths]; // Path selector'dan gelen güncel path listesi
    
    ////console.log('✅ [WIDGET] Güncellenmiş path\'ler:', this.currentDataPaths);
    
    // Tüm path'leri aktif olarak işaretle
    if (result.activePaths) {
      this.activePaths = { ...result.activePaths };
    } else {
      this.activePaths = {};
      this.currentDataPaths.forEach(path => {
        this.activePaths[path] = true;
      });
    }
    
    // Veri kaynağı tipini güncelle
    if (result.dataSourceType) {
      this.dataSourceType = result.dataSourceType;
      ////console.log('🔄 [WIDGET] Veri kaynağı tipi güncellendi:', this.dataSourceType);
      
      // Historical data için tarih aralığını ayarla
      if (result.dataSourceType === 'historical') {
        this.startDate = result.startDate;
        this.endDate = result.endDate;
        ////console.log('📅 [WIDGET] Geçmiş veri aralığı:', this.startDate, 'ile', this.endDate);
      }
    }
    
    // Animasyon ayarlarını güncelle
    this.animationsEnabled = result.animationsEnabled;
    
    // Formula güncelle
    this.formula = result.formula || '';
    console.log(`📐 [WIDGET] Formula set to: "${this.formula}" | paths: ${this.currentDataPaths.length} | dataSourceType: ${this.dataSourceType}`);
    
    this.chartOptions = {
      ...this.chartOptions, 
      animation: {
        duration: this.animationsEnabled ? 200 : 0
      }
    };
    
    // Eşik değerlerini güncelle (eğer mevcutsa)
    if (result.thresholds && result.thresholds.thresholdsEnabled) {
      this.thresholds = {
        warning: result.thresholds.warning,
        danger: result.thresholds.danger,
        unit: result.thresholds.unit || this.thresholds.unit
      };
      
      // Birim bilgisini güncelle
      if (result.thresholds.unit) {
        this.valueUnit = result.thresholds.unit;
      }
      
      ////console.log('Eşik değerleri güncellendi:', this.thresholds);
    }
    
    // Güncelleme sıklığını değiştir
    if (this.updateInterval !== result.updateInterval) {
      this.updateInterval = result.updateInterval;
      this.startDataUpdates(); // Yeni aralıklarla güncellemeleri yeniden başlat
    }
      // Veri kaynağı tipine göre uygun veri çekme stratejisini uygula
    if (this.dataSourceType === 'historical') {
      if (this.startDate && this.endDate) {
        ////console.log('Geçmiş veri modu etkinleştirildi. Veri çekiliyor...');
        this.fetchHistoricalData();
      } else {
        console.warn('⚠️ [WIDGET] Historical data mode is active but date range is not specified!');
        // Show visible error message to user
        this.description = this.translateService.instant('HARDCODED.ERROR_NO_DATE_RANGE');
        this.chartData.datasets = [{
          data: [],
          label: this.translateService.instant('HARDCODED.DATE_RANGE_MISSING'),
          fill: false,
          borderColor: STATUS.danger,
          backgroundColor: 'rgba(239, 68, 68, 0.2)',
          pointRadius: 0
        }];
        this.chartData = { ...this.chartData };
        this.cdr.detectChanges();
      }
    } else {
      // Realtime data için normal akış
      ////console.log('Gerçek zamanlı veri modu etkinleştirildi. Veri akışı başlatılıyor...');
      this.updateChartWithActivePaths();
    }
    
    // Parent component'e (Dashboard) path değişikliğini bildir
    ////console.log('📤 [WIDGET] Parent\'a path değişikliği bildiriliyor:', this.currentDataPaths);
    this.pathsChanged.emit(this.currentDataPaths);
    
    // Parent component'e (Dashboard) config değişikliğini bildir
    this.sqlValueColumn = result.sqlValueColumn;
    this.sqlLabelColumn = result.sqlLabelColumn;
    
    const configUpdate = {
      refreshRate: this.updateInterval,
      paths: this.currentDataPaths,
      dataSourceType: this.dataSourceType,
      thresholds: this.thresholds,
      formula: this.formula || '',
      activePaths: this.activePaths,
      sqlValueColumn: result.sqlValueColumn,
      sqlLabelColumn: result.sqlLabelColumn
    };
    ////console.log('📤 [WIDGET] Parent\'a config değişikliği bildiriliyor:', configUpdate);
    this.configChanged.emit(configUpdate);
  }

  // Veri güncellemelerini başlatma
  startDataUpdates(): void {
    // Önce mevcut timer'ı durdur
    this.stopDataUpdates();
    
    // Sadece LIVE path varsa timer başlat (SYS verisi değişmez)
    const hasRtPaths = this.currentDataPaths.some(p => this.isRealtimePath(p));
    if (hasRtPaths) {
      this.dataUpdateSubscription = interval(this.updateInterval).subscribe(() => {
        this.updateDescription();
        this.updateChartData();
      });
    } else {
      console.warn('📅 [WIDGET] Historical path only - Automatic updates disabled');
    }
  }

  // Veri güncellemelerini durdurma
  stopDataUpdates(): void {
    if (this.dataUpdateSubscription) {
      ////console.log('⏹️ [WIDGET] Veri güncellemeleri durduruldu');
      this.dataUpdateSubscription.unsubscribe();
      this.dataUpdateSubscription = undefined;
    }
  }

  // Yeni path'ten veri çekme ve grafiği modernize etme
  fetchDataFromNewPath(path: string): void {
    // Path'i parçalara ayır
    const pathParts = path.split('/');
    const dataSourceName = pathParts[pathParts.length - 1] || 'Veri';
    const locationName = pathParts.length > 1 ? pathParts[0] : '';
    
    
    // Yedek veri üretimi metodunu çağır
    this.generateFallbackData(dataSourceName, locationName, path);
  }

  /**
   * Hex renk kodunu belirtilen opacity ile rgba'ya çevirir.
   */
  /**
   * Linearly interpolate a short data array to fill targetLen points.
   * Used to stretch LIVE data (~10 pts) across the full X-axis when mixed with SYS (~50 pts).
   */
  private stretchData(data: number[], targetLen: number): number[] {
    if (data.length === 0) return new Array(targetLen).fill(NaN);
    if (data.length === 1) return new Array(targetLen).fill(data[0]);
    if (data.length >= targetLen) return data;
    const result: number[] = [];
    for (let i = 0; i < targetLen; i++) {
      const srcPos = (i / (targetLen - 1)) * (data.length - 1);
      const lo = Math.floor(srcPos);
      const hi = Math.ceil(srcPos);
      if (lo === hi || hi >= data.length) {
        result.push(data[lo]);
      } else {
        const frac = srcPos - lo;
        result.push(data[lo] + frac * (data[hi] - data[lo]));
      }
    }
    return result;
  }

  private fadeColor(hex: string, opacity: number): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  // Veri tipine göre renk şeması döndüren yardımcı fonksiyon (Multi-path desteği ile)
  public getColorsForDataType(path: string, index?: number): { border: string, background: string } {
    // Multi-path durumunda index'e göre profesyonel renk paleti kullan
    if (typeof index === 'number' && index >= 0) {
      const professionalPalette = CHART_PALETTE.map(hex => ({
        border: hex,
        background: this.fadeColor(hex, 0.14)
      }));
      
      const colorIndex = index % professionalPalette.length;
      const selectedColor = professionalPalette[colorIndex];
      ////console.log(`🎨 [WIDGET] Path ${index + 1} (${path}) için profesyonel renk: ${selectedColor.border}`);
      
      return {
        border: selectedColor.border,
        background: selectedColor.background
      };
    }
    
    // Fallback: Path içeriğine göre profesyonel renk belirleme
    const safePath = typeof path === 'string' ? path : '';
    const lowerPath = safePath.toLowerCase();
    
    // Profesyonel veri tipi renk şemaları - gradient uyumlu
    const professionalColorSchemes = {
      'temperature': { border: '#FF7A1A', background: this.fadeColor('#FF7A1A', 0.12) }, // Flare
      'temp': { border: '#FF7A1A', background: this.fadeColor('#FF7A1A', 0.12) },
      'sicaklik': { border: '#FF7A1A', background: this.fadeColor('#FF7A1A', 0.12) },
      'humidity': { border: '#60A5FA', background: this.fadeColor('#60A5FA', 0.12) }, // Sky
      'nem': { border: '#60A5FA', background: this.fadeColor('#60A5FA', 0.12) },
      'pressure': { border: '#A78BFA', background: this.fadeColor('#A78BFA', 0.12) }, // Violet
      'basinc': { border: '#A78BFA', background: this.fadeColor('#A78BFA', 0.12) },
      'consumption': { border: '#34D399', background: this.fadeColor('#34D399', 0.12) }, // Emerald
      'tuketim': { border: '#34D399', background: this.fadeColor('#34D399', 0.12) },
      'active': { border: '#F5B301', background: this.fadeColor('#F5B301', 0.12) }, // Gold
      'aktif': { border: '#F5B301', background: this.fadeColor('#F5B301', 0.12) },
      'status': { border: STATUS.danger, background: this.fadeColor(STATUS.danger, 0.12) }, // Danger
      'durum': { border: STATUS.danger, background: this.fadeColor(STATUS.danger, 0.12) },
      'mvmoment': { border: '#2DD4BF', background: this.fadeColor('#2DD4BF', 0.12) }, // Teal
      'voltage': { border: '#7C8DB5', background: this.fadeColor('#7C8DB5', 0.12) }, // Lunar
      'volt': { border: '#7C8DB5', background: this.fadeColor('#7C8DB5', 0.12) },
      'gerilim': { border: '#7C8DB5', background: this.fadeColor('#7C8DB5', 0.12) },
      'current': { border: '#2DD4BF', background: this.fadeColor('#2DD4BF', 0.12) }, // Teal
      'akim': { border: '#2DD4BF', background: this.fadeColor('#2DD4BF', 0.12) },
      'frequency': { border: '#F472B6', background: this.fadeColor('#F472B6', 0.12) }, // Rose
      'frekans': { border: '#F472B6', background: this.fadeColor('#F472B6', 0.12) },
      'power': { border: '#F5B301', background: this.fadeColor('#F5B301', 0.12) }, // Gold
      'guc': { border: '#F5B301', background: this.fadeColor('#F5B301', 0.12) }
    };
    
    // Path tabanlı profesyonel renk eşleştirmesi
    for (const [key, value] of Object.entries(professionalColorSchemes)) {
      if (lowerPath.includes(key)) {
        return value;
      }
    }
    
    // Varsayılan profesyonel renk şeması - Gradient uyumlu Gold
    return { border: BRAND.primary, background: this.fadeColor(BRAND.primary, 0.12) };
  }
  
  // İstatistiklere göre açıklama metnini güncelle (yeni fonksiyon)
  private updateStatisticsDescription(statistics: any): void {
    // İstatistiklere göre açıklama metni oluştur
    const unit = statistics.unit || '';
    const timeRange = statistics.timeRange || this.translateService.instant('HARDCODED.LAST_10_MIN');
    
    const maxValue = this.formatValue(parseFloat(statistics.max));
    const minValue = this.formatValue(parseFloat(statistics.min));
    const avgValue = this.formatValue(parseFloat(statistics.avg));
    
    this.description = `${timeRange}: Avg: ${avgValue}${unit} (Min: ${minValue}${unit}, Max: ${maxValue}${unit})`;
  }

  getDataSourceLabel(path: string = ''): string {
    const pathMap: { [key: string]: string } = {
      '/api/sensors/temperature': this.translateService.instant('HARDCODED.TEMPERATURE_DATA'),
      '/api/sensors/humidity': this.translateService.instant('HARDCODED.HUMIDITY_DATA'),
      '/api/sensors/pressure': this.translateService.instant('HARDCODED.PRESSURE_DATA'),
      '/api/energy/consumption': this.translateService.instant('HARDCODED.ENERGY_CONSUMPTION'),
      '/api/alarms/active': this.translateService.instant('HARDCODED.ACTIVE_ALARM_COUNT')
    };
    
    return pathMap[path] || this.translateService.instant('HARDCODED.LIVE_DATA');
  }

  updateDescription(): void {
    if (this.currentDataPaths.length > 0) {
      const activePaths = Object.keys(this.activePaths).filter(path => this.activePaths[path]);
      
      if (activePaths.length > 0) {
        // Gerçek current value kullan, yoksa API'den veri çek
        if (this.currentValue !== null) {
          const unit = this.valueUnit || '';
          const primaryPathName = this.getPathDisplayName(activePaths[0]);
          this.description = `${primaryPathName}: ${this.formatValue(this.currentValue)}${unit} (${activePaths.length} ${this.translateService.instant('HARDCODED.ACTIVE_SOURCE')})`;
        } else {
          const primaryPathName = this.getPathDisplayName(activePaths[0]);
          this.description = `${primaryPathName}: ${this.translateService.instant('HARDCODED.DATA_LOADING')} (${activePaths.length} ${this.translateService.instant('HARDCODED.ACTIVE_SOURCE')})`;
          // İlk kez gerçek veriyi çek
          this.fetchCurrentValueFromActivePaths();
        }
      } else {
        this.description = this.translateService.instant('HARDCODED.NO_ACTIVE_SOURCE');
      }
    } else {
      this.description = this.translateService.instant('HARDCODED.NO_DATA_SOURCE_SET');
    }
  }

  // Path'i aktif/pasif yapma
  togglePathActive(path: string): void {
    this.activePaths[path] = !this.activePaths[path];
    
    // Throttle: Çok sık API çağrısı yapma
    if (this.lastToggleTime && (Date.now() - this.lastToggleTime) < 1000) {
      ////console.log('⚠️ [WIDGET] Path toggle çok sık, API çağrısı atlandı');
      return;
    }
    this.lastToggleTime = Date.now();
    
    this.updateChartWithActivePaths();
    ////console.log(`${path} ${this.activePaths[path] ? 'aktif' : 'pasif'} hale getirildi`);
  }

  // Aktif path'lerden gerçek current value çekme
  fetchCurrentValueFromActivePaths(): void {
    const activePaths = Object.keys(this.activePaths).filter(path => this.activePaths[path]);
    
    if (activePaths.length === 0) {
      return;
    }

    // İlk aktif path'i kullan (birden fazla varsa ilkini)
    const primaryPath = activePaths[0];
    
    ////console.log('🔍 [WIDGET] Current value çekiliyor - Path:', primaryPath);
    
    // Path formatını kontrol et ve API çağrısı yap
    if (this.isValidApiPath(primaryPath)) {
      this.apiService.readRawData(primaryPath).subscribe({
        next: (response) => {
          if (response.status === 'success' && response.data !== null && response.data !== undefined) {
            // API'den gelen veriyi current value olarak ayarla
            let currentValue: number;
            
            if (Array.isArray(response.data) && response.data.length > 0) {
              const lastItem = response.data[response.data.length - 1];
              currentValue = typeof lastItem === 'number' ? lastItem : parseFloat(lastItem.value || lastItem.data || lastItem.gzahl || lastItem);
            } else if (typeof response.data === 'object') {
              // Object formatında - farklı alan isimlerini kontrol et
              if (response.data.gzahl !== undefined) {
                // Moment API format: { gzahl: 4501, qb0: 9, qb1: 0, zeit: 801880125 }
                currentValue = parseFloat(response.data.gzahl);
              } else if (response.data.value !== undefined) {
                // Standart value alanı
                currentValue = parseFloat(response.data.value);
              } else if (response.data.data !== undefined) {
                // Data alanı
                currentValue = parseFloat(response.data.data);
              } else {
                // Object'in ilk sayısal değerini bul
                const numericValues = Object.values(response.data).filter(val => !isNaN(parseFloat(val as string)));
                if (numericValues.length > 0) {
                  currentValue = parseFloat(numericValues[0] as string);
                } else {
                  currentValue = NaN;
                }
              }
            } else if (typeof response.data === 'number') {
              currentValue = response.data;
            } else {
              currentValue = parseFloat(response.data.toString());
            }
            
            if (!isNaN(currentValue)) {
              this.currentValue = currentValue;
              this.valueUnit = this.determineUnitFromPath(primaryPath);
              this.checkThresholds(currentValue);
              
              // Description'ı güncelle
              this.updateDescription();
              this.cdr.detectChanges();
            }
          }
        },
        error: (error) => {
          console.error('❌ [WIDGET] Current value API error:', error);
          // Update description on error
          this.updateDescription();
        }
      });
    }
  }

  // Multi-path için profesyonel güçlü renk paleti
  private colorPalette = [
    { bgColor: 'rgba(245, 179, 1, 0.25)', borderColor: '#F5B301', textColor: '#F5B301' }, // Gold - Güçlü
    { bgColor: 'rgba(255, 122, 26, 0.25)', borderColor: '#FF7A1A', textColor: '#FF7A1A' }, // Flare - Güçlü
    { bgColor: 'rgba(124, 141, 181, 0.25)', borderColor: '#7C8DB5', textColor: '#7C8DB5' }, // Lunar - Güçlü
    { bgColor: 'rgba(52, 211, 153, 0.25)', borderColor: '#34D399', textColor: '#34D399' }, // Emerald - Güçlü
    { bgColor: 'rgba(244, 114, 182, 0.25)', borderColor: '#F472B6', textColor: '#F472B6' }, // Rose - Güçlü
    { bgColor: 'rgba(167, 139, 250, 0.25)', borderColor: '#A78BFA', textColor: '#A78BFA' }, // Violet - Güçlü
    { bgColor: 'rgba(45, 212, 191, 0.25)', borderColor: '#2DD4BF', textColor: '#2DD4BF' }, // Teal - Güçlü
    { bgColor: 'rgba(252, 211, 77, 0.25)', borderColor: '#FCD34D', textColor: '#FCD34D' }, // Açık Altın - Güçlü
    { bgColor: 'rgba(96, 165, 250, 0.25)', borderColor: '#60A5FA', textColor: '#60A5FA' }, // Sky - Güçlü
    { bgColor: 'rgba(251, 113, 133, 0.25)', borderColor: '#FB7185', textColor: '#FB7185' }, // Coral - Güçlü
    { bgColor: 'rgba(245, 158, 11, 0.25)', borderColor: '#F59E0B', textColor: '#F59E0B' }, // Amber - Güçlü
    { bgColor: 'rgba(139, 92, 246, 0.25)', borderColor: '#8B5CF6', textColor: '#8B5CF6' }, // Purple - Güçlü
  ];

  // Path'e göre renk kodu döndür (Multi-path desteği ile)
  getColorForPath(path: string, pathIndex?: number): { bgColor: string, borderColor: string, textColor: string } {
    // Multi-path durumunda index'e göre farklı renk ata
    if (typeof pathIndex === 'number' && pathIndex >= 0) {
      const colorIndex = pathIndex % this.colorPalette.length;
      const selectedColor = this.colorPalette[colorIndex];
      ////console.log(`🎨 [WIDGET] Path ${pathIndex + 1} için renk: ${selectedColor.borderColor}`);
      return selectedColor;
    }
    
    // Fallback: Path içeriğine göre renk belirleme (legacy support)
    const safePath = typeof path === 'string' ? path : '';
    const lowerPath = safePath.toLowerCase();
    
    if (lowerPath.includes('mvmoment')) {
      // Default mvmoment color (ilk renk)
      return this.colorPalette[0];
    } else if (lowerPath.includes('status') || lowerPath.includes('durum')) {
      return this.colorPalette[7]; // Red
    } else if (lowerPath.includes('voltage') || lowerPath.includes('volt')) {
      return this.colorPalette[6]; // Sky blue
    } else if (lowerPath.includes('current') || lowerPath.includes('akim')) {
      return this.colorPalette[3]; // Orange
    } else if (lowerPath.includes('temp') || lowerPath.includes('sicaklik')) {
      return this.colorPalette[7]; // Red
    } else {
      return this.colorPalette[0]; // Default teal
    }
  }

  formatValue(value: number): string {
    if (!this.decimalPlacesEnabled) return String(value);
    return value.toFixed(this.decimalPlaces);
  }

  formatTickValue(value: any): string {
    if (typeof value === 'number') {
      const unit = this.valueUnit || '';
      let formatted: string;
      const absVal = Math.abs(value);
      if (!this.decimalPlacesEnabled) {
        if (Number.isInteger(value)) {
          formatted = String(value);
        } else {
          formatted = parseFloat(value.toPrecision(6)).toString();
        }
      } else if (absVal >= 1000000) {
        formatted = (value / 1000000).toFixed(this.decimalPlaces) + 'M';
      } else if (absVal >= 1000) {
        formatted = (value / 1000).toFixed(this.decimalPlaces) + 'k';
      } else {
        formatted = value.toFixed(this.decimalPlaces);
      }
      return `${formatted}${unit}`;
    }
    return value;
  }

  getPathDisplayName(path: string): string {
    if (!path) return this.translateService.instant('HARDCODED.UNKNOWN_PATH');
    
    // Gerçek path formatı: "Vienna > 220 > Paris > P > MvMoment[7262]"
    if (path.includes(' > ')) {
      const parts = path.split(' > ');
      if (parts.length >= 4) {
        const station = parts[0]; // Vienna
        const voltage = parts[1]; // 220
        const substation = parts[2]; // Paris
        const type = parts[3]; // P
        return `${station} ${voltage} ${substation} ${type}`;
      }
    }
    
    // "/" ile ayrılmış path: "Vienna/220/Paris/P/MvMoment[7262]"
    const parts = path.split('/');
    if (parts.length >= 4) {
      const b1 = parts[0];
      const b2 = parts[1];
      const b3 = parts[2];
      const elem = parts[3];
      return `${b1} ${b2} ${b3} ${elem}`;
    }
    
    if (parts.length >= 2) {
      return parts.slice(0, -1).join(' ');
    }
    
    // Tek parça — [satz] varsa temizle
    return path.replace(/\[\d+\]/, '').trim() || path;
  }

  // Aktif path'lere göre grafik verilerini güncelle - Incremental Update Version
  private lastUpdateTime: number = 0; // API debouncing için
  private isInitialLoad: boolean = true; // İlk yükleme kontrolü
  
  isDarkMode(): boolean {
    return document.documentElement.classList.contains('dark');
  }

  applyThemeColorsToOptions(): void {
    const isDark = this.isDarkMode();
    
    // Determine colors based on active theme (centralized via ThemeColors)
    const gridColor = this.themeColors.grid();
    const textColor = isDark ? this.themeColors.axis() : this.themeColors.read('--text-primary');
    const tooltipBg = this.themeColors.tooltipBg();
    const tooltipText = this.themeColors.tooltipMuted();
    const tooltipTitle = this.themeColors.tooltipText();
    const tooltipBorder = this.themeColors.tooltipBorder();
    
    // Update chartOptions scales
    if (this.chartOptions.scales) {
      if (this.chartOptions.scales['x']) {
        const x = this.chartOptions.scales['x'] as any;
        if (x.grid) x.grid.color = gridColor;
        if (x.ticks) x.ticks.color = textColor;
      }
      if (this.chartOptions.scales['y']) {
        const y = this.chartOptions.scales['y'] as any;
        if (y.grid) y.grid.color = gridColor;
        if (y.ticks) y.ticks.color = textColor;
      }
    }
    
    // Update chartOptions tooltip plugins
    if (this.chartOptions.plugins && this.chartOptions.plugins.tooltip) {
      const tt = this.chartOptions.plugins.tooltip as any;
      tt.backgroundColor = tooltipBg;
      tt.titleColor = tooltipTitle;
      tt.bodyColor = tooltipText;
      tt.borderColor = tooltipBorder;
    }
    
    // Update fullscreenChartOptions scales and tooltip plugins
    if (this.fullscreenChartOptions.scales) {
      if (this.fullscreenChartOptions.scales['x']) {
        const x = this.fullscreenChartOptions.scales['x'] as any;
        if (x.grid) x.grid.color = this.themeColors.grid();
        if (x.ticks) x.ticks.color = isDark ? this.themeColors.axis() : this.themeColors.read('--text-primary');
      }
      if (this.fullscreenChartOptions.scales['y']) {
        const y = this.fullscreenChartOptions.scales['y'] as any;
        if (y.grid) y.grid.color = this.themeColors.grid();
        if (y.ticks) y.ticks.color = isDark ? this.themeColors.axis() : this.themeColors.read('--text-primary');
      }
    }

    if (this.fullscreenChartOptions.plugins) {
      if (this.fullscreenChartOptions.plugins.legend) {
        const leg = this.fullscreenChartOptions.plugins.legend as any;
        if (leg.labels) leg.labels.color = isDark ? this.themeColors.axis() : this.themeColors.read('--text-primary');
      }
      if (this.fullscreenChartOptions.plugins.tooltip) {
        const tt = this.fullscreenChartOptions.plugins.tooltip as any;
        tt.backgroundColor = tooltipBg;
        tt.titleColor = tooltipTitle;
        tt.bodyColor = tooltipText;
        tt.borderColor = tooltipBorder;
      }
    }
  }
  
  updateChartWithActivePaths(): void {
    // Apply dynamic theme colors right before redrawing
    this.applyThemeColorsToOptions();

    // Debouncing: Çok sık API çağrısı yapma (300ms içinde tekrar çağrı varsa atla)
    const now = Date.now();
    if (this.lastUpdateTime && (now - this.lastUpdateTime) < 300) {
      return;
    }
    this.lastUpdateTime = now;

    // Check if SQL mode is active
    if (this.dataSourceType === 'sql' || (this.currentDataPaths.length > 0 && this.currentDataPaths[0]?.startsWith('sql://'))) {
      const expId = this.currentDataPaths[0]?.startsWith('sql://') 
        ? this.currentDataPaths[0].substring(6) 
        : this.currentDataPaths[0];
      if (expId) {
        this.fetchSqlExplorationData(expId);
        return;
      }
    }
    
    // If formula is set, we must fetch ALL paths in currentDataPaths to evaluate the formula.
    // Otherwise, we only fetch active paths.
    const hasFormula = !!(this.formula && this.formula.trim());
    const pathsToFetch = hasFormula 
      ? [...this.currentDataPaths] 
      : this.currentDataPaths.filter(path => this.activePaths[path]);
    
    if (pathsToFetch.length === 0) {
      // Path'ler yoksa veya temizlendiyse her zaman grafiği sıfırla ve placeholder göster
      if (this.currentDataPaths.length > 0) {
        console.warn('⚠️ [WIDGET] No data paths are active, skipping chart update.');
      }
      
      this.chartData.datasets = [{
        data: [] as number[],
        label: this.translateService.instant('DASHBOARD.NO_DATA') || 'Veri yok',
        fill: true,
        tension: 0.6,
        borderColor: '#6B7280',
        backgroundColor: 'rgba(107, 114, 128, 0.1)',
        pointRadius: 0
      }];
      this.chartData = { ...this.chartData };
      this.cdr.detectChanges();
      return;
    }

    // Check if Historical mode is active
    if (this.dataSourceType === 'historical') {
      if (this.startDate && this.endDate) {
        this.fetchHistoricalData();
        return;
      } else {
        console.warn('⚠️ [WIDGET] Historical data mode is active but date range is not specified!');
      }
    }
    
    // İlk yükleme mi, yoksa güncelleme mi?
    if (this.isInitialLoad || !this.chartComponent?.chart) {
      ////console.log('🎯 [WIDGET] İlk veri yüklemesi başlatılıyor...');
      this.fetchInitialMultipleDataSets(pathsToFetch);
      this.isInitialLoad = false;
    } else {
      ////console.log(' [WIDGET] Incremental veri güncelleme başlatılıyor...');
      this.updateExistingMultipleDataSets(pathsToFetch);
    }
  }

  fetchSqlExplorationData(expId: string): void {
    this.apiService.getSavedExplorationData(expId).subscribe({
      next: res => {
        if (res && res.status === 'success' && res.data) {
          const rows = res.data.rows || [];
          const source = res.data.source || 'sql';
          const queryName = res.data.name || 'Saved SQL Query';
          this.description = `SQL: "${queryName}" from ${source.toUpperCase()} (${rows.length} rows)`;

          if (rows.length === 0) {
            this.currentValue = 0;
            this.chartData.labels = ['No Data'];
            this.chartData.datasets = [{
              data: [0],
              label: 'No Data returned from SQL',
              fill: false,
              borderColor: '#9CA3AF',
              backgroundColor: 'rgba(156, 163, 175, 0.1)',
              pointRadius: 0
            }];
            this.chartData = { ...this.chartData };
            this.cdr.detectChanges();
            return;
          }

          // Identify columns dynamically
          const columns = Object.keys(rows[0] || {});
          this.sqlTableRows = rows;
          this.sqlTableColumns = columns;
          
          let numericCol = '';
          let labelCol = '';

          // Use user-defined mappings if provided and valid
          if (this.sqlValueColumn && columns.includes(this.sqlValueColumn)) {
            numericCol = this.sqlValueColumn;
          }
          if (this.sqlLabelColumn && columns.includes(this.sqlLabelColumn)) {
            labelCol = this.sqlLabelColumn;
          }
          
          // Strict numeric helper
          const isStrictNumeric = (val: any): boolean => {
            if (val === null || val === undefined) return false;
            if (typeof val === 'number') return !isNaN(val);
            if (typeof val === 'string') {
              const trimmed = val.trim();
              return /^-?\d+(\.\d+)?$/.test(trimmed);
            }
            return false;
          };

          // Find first numeric column and first category/timestamp column if not mapped
          if (!numericCol) {
            const scanRows = rows.slice(0, 5);
            for (const col of columns) {
              let colIsNumeric = false;
              for (const row of scanRows) {
                if (isStrictNumeric(row[col])) {
                  colIsNumeric = true;
                  break;
                }
              }
              if (colIsNumeric) {
                numericCol = col;
                break;
              }
            }
          }

          if (!labelCol) {
            for (const col of columns) {
              if (col !== numericCol && (col.toLowerCase().includes('time') || col.toLowerCase().includes('date') || col.toLowerCase().includes('name') || col.toLowerCase().includes('label') || col.toLowerCase().includes('path'))) {
                labelCol = col;
                break;
              }
            }
          }
          
          if (!numericCol) numericCol = columns[0];
          if (!labelCol) labelCol = columns[0];

          // Extract values strictly
          const dataValues = rows.map((row: any) => {
            const val = row[numericCol];
            if (typeof val === 'number') return isNaN(val) ? null : val;
            if (typeof val === 'string') {
              const num = parseFloat(val);
              return isNaN(num) ? null : num;
            }
            return null;
          });

          const validCount = dataValues.filter((v: any) => v !== null).length;
          
          // If this is a numeric widget (not data-table) and has no valid numeric columns or values, reject strictly!
          if (this.widgetType !== 'data-table' && (!numericCol || validCount === 0)) {
            this.currentValue = null;
            this.description = `⚠️ Incompatible Output: Selected Saved SQL has no numeric columns for plotting on charts/gauges.`;
            this.chartData.labels = ['Incompatible Query'];
            this.chartData.datasets = [{
              data: [0],
              label: `Error: Non-numeric data columns returned`,
              borderColor: STATUS.danger,
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              pointRadius: 0
            }];
            this.chartData = { ...this.chartData };
            this.cdr.detectChanges();
            return;
          }

          const cleanDataValues = dataValues.map((v: any) => v === null ? 0 : v);

          const labels = rows.map((row: any) => {
            const val = row[labelCol];
            return val !== null && val !== undefined ? String(val) : '';
          });

          // Set currentValue as the last row's value
          this.currentValue = cleanDataValues[cleanDataValues.length - 1];
          this.valueUnit = '';
          if (this.currentValue !== null) {
            this.checkThresholds(this.currentValue);
          }

          // Update chart
          const colors = this.getColorsForDataType('sql', 0);
          this.chartData.labels = labels;
          this.chartData.datasets = [{
            data: cleanDataValues,
            label: `${numericCol} (${queryName})`,
            fill: this.widgetType === 'area-chart',
            tension: 0.4,
            borderColor: colors.border,
            backgroundColor: colors.background,
            pointRadius: labels.length > 20 ? 0 : 3,
            pointHoverRadius: 6,
            borderWidth: 3,
            cubicInterpolationMode: 'monotone' as const
          }];

          this.chartData = { ...this.chartData };
          this.cdr.detectChanges();
        } else {
          this.generateFallbackData(expId, 'SQL', 'sql://' + expId);
        }
      },
      error: err => {
        console.error('Failed to load SQL widget data:', err);
        this.generateFallbackData(expId, 'SQL', 'sql://' + expId);
      }
    });
  }
  
  // Tekli veri yolu için veri çekme
  fetchDataForPath(path: string): void {
    ////console.log('🟢 [WIDGET] Veri çekiliyor - Path:', path, 'Veri kaynağı:', this.dataSourceType);
    ////console.log('🔍 [WIDGET] currentDataPaths:', this.currentDataPaths);
    ////console.log('🔍 [WIDGET] activePaths:', this.activePaths);
    
    // Path'i parçalara ayır
    const pathParts = path.split('/');
    const dataSourceName = pathParts[pathParts.length - 1] || 'Veri';
    const locationName = pathParts.length > 1 ? pathParts[0] : '';
    
    // Path format kontrolü - farklı API formatlarını destekle
    const isValidApiPath = this.isValidApiPath(path);
    
    if (isValidApiPath) {
      ////console.log('✅ [WIDGET] Geçerli API path\'i tespit edildi, veri çekiliyor...');
      
      // API'den raw data çekmeyi dene - LIVE veya SYS otomatik seçim
      this.fetchSinglePathData(path).subscribe({
        next: (response) => {
          ////console.log('✅ [WIDGET] API\'den veri alındı:', response);
          
          if (response.status === 'success' && response.data !== null && response.data !== undefined) {
            // Gerçek veriyi işle
            this.processRealApiData(response.data, dataSourceName, locationName, path);
          } else {
            console.warn('⚠️ [WIDGET] API response failed, using fallback data');
            this.generateFallbackData(dataSourceName, locationName, path);
          }
        },
        error: (error) => {
          console.error('❌ [WIDGET] API error, using fallback data:', error);
          this.generateFallbackData(dataSourceName, locationName, path);
        }
      });
    } else {
      ////console.log('⚠️ [WIDGET] Geçersiz path format\'ı, fallback veri kullanılıyor');
      // Yedek veri üretimi metodunu çağır
      this.generateFallbackData(dataSourceName, locationName, path);
    }
  }

  /**
   * Path'in geçerli bir API path'i olup olmadığını kontrol eder
   */
  private isValidApiPath(path: string): boolean {
    if (!path || typeof path !== 'string') {
      return false;
    }

    if (path.startsWith('sql://')) {
      return true;
    }

    // API endpoint formatı (/api/... veya rakamla biten NimSatz formatı)
    const isApiEndpoint = path.startsWith('/api/') && path.includes('/');
    
    // NimSatz formatı (sonunda rakam olan)
    const isNimSatzFormat = /\d+$/.test(path) && path.includes('/');
    
    // SYS path formatı — en az 2 seviyeli path (ör: Enerji/Trafo/Gerilim/L1)
    const isHisPath = path.split('/').length >= 2 && !path.startsWith('http');
    
    // Realtime formatı (" > " ile ayrılmış, genellikle 5 seviyeli: B1 > B2 > B3 > Element > Info)
    const isRealtimeFormat = path.includes(' > ') && path.split(' > ').length >= 3;
    
    // LIVE path formatı — [satz] içeren path'ler
    const isRtPath = /\[\d+\]/.test(path);
    
    return isApiEndpoint || isNimSatzFormat || isHisPath || isRealtimeFormat || isRtPath;
  }

  /**
   * Gerçek API verilerini işler
   */
  private processRealApiData(data: any, dataSourceName: string, locationName: string, path: string): void {
    ////console.log('🔄 [WIDGET] Gerçek API verisi işleniyor:', data);
    
    try {
      // API verisinin formatına göre işleme
      let processedValue: number;
      
      if (Array.isArray(data) && data.length > 0) {
        // Diziden son değeri al
        const lastItem = data[data.length - 1];
        processedValue = typeof lastItem === 'number' ? lastItem : parseFloat(lastItem.value || lastItem.data || lastItem.gzahl || lastItem);
      } else if (typeof data === 'object') {
        // Object formatında - farklı alan isimlerini kontrol et
        if (data.gzahl !== undefined) {
          // Moment API format: { gzahl: 4501, qb0: 9, qb1: 0, zeit: 801880125 }
          processedValue = parseFloat(data.gzahl);
        } else if (data.value !== undefined) {
          // Standart value alanı
          processedValue = parseFloat(data.value);
        } else if (data.data !== undefined) {
          // Data alanı
          processedValue = parseFloat(data.data);
        } else {
          // Object'in ilk sayısal değerini bul
          const numericValues = Object.values(data).filter(val => !isNaN(parseFloat(val as string)));
          if (numericValues.length > 0) {
            processedValue = parseFloat(numericValues[0] as string);
          } else {
            processedValue = NaN;
          }
        }
      } else if (typeof data === 'number') {
        // Direkt sayı değeri
        processedValue = data;
      } else {
        // Parse etmeye çalış
        processedValue = parseFloat(data.toString());
      }
      
      // Geçersiz sayıysa fallback kullan
      if (isNaN(processedValue)) {
        console.warn('⚠️ [WIDGET] API data is not numeric, using fallback:', data);
        this.generateFallbackData(dataSourceName, locationName, path);
        return;
      }
      
      // Gerçek veriyi widget'a uygula
      this.currentValue = processedValue;
      
      // Path display name'ini al ve modern format oluştur
      const displayName = this.getPathDisplayName(path);
      const unit = this.determineUnitFromPath(path);
      const formattedValue = this.formatValue(processedValue);
      
      // Modern açıklama formatı - tema uygun styling ile
      this.description = this.createModernDescription(displayName, formattedValue, unit);
      this.valueUnit = unit;
      
      // Eşik kontrolü
      this.checkThresholds(processedValue);
      
      // Grafik verisini güncelle
      this.updateChartWithRealData(processedValue, dataSourceName);
      
    } catch (error) {
      console.error('❌ [WIDGET] Real data processing error:', error);
      this.generateFallbackData(dataSourceName, locationName, path);
    }
  }

  /**
   * Modern ve tema uygun açıklama formatı oluşturur
   */
  private createModernDescription(displayName: string, value: string, unit: string): string {
    // Tema uygun modern format
    const location = this.extractLocationFromDisplayName(displayName);
    const measurement = this.extractMeasurementFromDisplayName(displayName);
    
    if (location && measurement) {
      return `${location} • ${measurement} • ${value} ${unit}`;
    }
    
    // Fallback format
    return `${displayName} • ${value} ${unit}`;
  }

  /**
   * Display name'den lokasyon bilgisini çıkarır
   */
  private extractLocationFromDisplayName(displayName: string): string {
    const locationMatch = displayName.match(/^([^:]+)(?:\s+\d+)?/);
    if (locationMatch) {
      return locationMatch[1].trim();
    }
    return displayName;
  }

  /**
   * Display name'den ölçüm tipini çıkarır
   */
  private extractMeasurementFromDisplayName(displayName: string): string {
    // Display name'in son kısmını ölçüm tipi olarak kullan
    const parts = displayName.split(/[/\s]+/);
    return parts[parts.length - 1] || displayName;
  }

  /**
   * Widget'ın value-card modunda olup olmadığını kontrol eder
   */
  private isValueCardMode(): boolean {
    return this.widgetType === 'value-card';
  }

  /**
   * Path'ten uygun birimi tahmin eder
   */
  private determineUnitFromPath(path: string): string {
    // Birim hardcode edilmez - widget thresholds veya config'den gelir
    return this.thresholds?.unit || '';
  }

  /**
   * Widget tipine göre dataset konfigürasyonu döndürür
   */
  private getDatasetConfigForWidgetType(): any {
    // Profesyonel güçlü gradient color palette (CHART_PALETTE kaynaklı)
    const professionalColors = CHART_PALETTE.map(hex => ({
      border: hex,
      background: `linear-gradient(135deg, ${this.fadeColor(hex, 0.4)} 0%, ${this.fadeColor(hex, 0.1)} 100%)`,
      solidBackground: this.fadeColor(hex, 0.25)
    }));
    
    const baseColor = professionalColors[0]; // Default professional color
    
    switch (this.widgetType) {
        case 'line-chart':
        return {
          fill: true, // Gradient fill için true
          tension: 0.6, // Daha smooth curves
          borderColor: baseColor.border,
          backgroundColor: baseColor.solidBackground, // Solid background for canvas
          pointRadius: 4, // Daha büyük noktalar
          pointHoverRadius: 12, // Daha büyük hover
          borderWidth: 4, // Daha kalın çizgiler
          pointBackgroundColor: baseColor.border,
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          pointHoverBackgroundColor: '#ffffff',
          pointHoverBorderColor: baseColor.border,
          pointHoverBorderWidth: 3,
          cubicInterpolationMode: 'monotone', // Professional smooth interpolation
          borderCapStyle: 'round',
          borderJoinStyle: 'round'
        };      case 'area-chart':
        return {
          fill: true,
          tension: 0.6,
          borderColor: baseColor.border,
          backgroundColor: baseColor.solidBackground,
          pointRadius: 1,
          pointHoverRadius: 6,
          borderWidth: 3,
          pointBackgroundColor: baseColor.border,
          pointBorderColor: '#ffffff',
          pointBorderWidth: 1,
          cubicInterpolationMode: 'monotone'
        };
        
      case 'bar-chart':
        return {
          backgroundColor: baseColor.border,
          borderColor: baseColor.border,
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false
        };
        
      case 'pie-chart':
      case 'doughnut-chart':
        return {
          backgroundColor: [
            ...CHART_PALETTE
          ],
          borderColor: '#1F2937',
          borderWidth: 2
        };

      case 'polar-chart':
        return {
          backgroundColor: [
            ...CHART_PALETTE.slice(0, 5).map(hex => this.fadeColor(hex, 0.6))
          ],
          borderColor: [
            ...CHART_PALETTE.slice(0, 5)
          ],
          borderWidth: 2
        };
        
      default:
        return {
          fill: false,
          tension: 0.4,
          borderColor: baseColor.border,
          backgroundColor: baseColor.background,
          pointRadius: 3,
          pointHoverRadius: 6,
          borderWidth: 2
        };
    }
  }

  /**
   * Eşik değerlerini kontrol eder
   */
  private checkThresholds(value: number): void {
    if (this.thresholds.danger && value >= this.thresholds.danger) {
      this.valueStatus = 'danger';
    } else if (this.thresholds.warning && value >= this.thresholds.warning) {
      this.valueStatus = 'warning';
    } else {
      this.valueStatus = 'normal';
    }
  }

  /**
   * Gerçek veri ile grafik günceller - Smooth incremental update için optimize edildi
   */
  private updateChartWithRealData(value: number, label: string): void {
    // Value-card modunda sadece anlık değeri güncelle
    if (this.isValueCardMode()) {
      this.currentValue = value;
      ////console.log('💎 [VALUE-CARD] Değer güncellendi:', value);
      this.cdr.detectChanges();
      return;
    }

    // Chart referansına eriş
    const chartComponent = this.chartComponent;
    if (!chartComponent || !chartComponent.chart) {
      // Chart henüz hazır değilse, data'ya ekle ve sonra chart oluşturulacak
      this.initializeChartDataForFirstTime(value, label);
      return;
    }

    const chart = chartComponent.chart;
    const now = new Date();
    const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    // Incremental update - sadece yeni veriyi ekle
    if (chart.data.labels && chart.data.datasets && chart.data.datasets[0]) {
      // Yeni data point'i ekle
      chart.data.labels.push(timeLabel);
      chart.data.datasets[0].data.push(value);
      
      // Sliding window: maksimum 50 data point tut
      const MAX_POINTS = 50;
      if (chart.data.labels.length > MAX_POINTS) {
        chart.data.labels.shift(); // İlk label'ı kaldır
        chart.data.datasets[0].data.shift(); // İlk data point'i kaldır
      }
      
      // Dataset label'ını güncelle
      chart.data.datasets[0].label = this.getPathDisplayName(label);
      
      // Smooth animation ile chart'ı güncelle
      chart.update('active'); // 'active' mode sadece yeni data için animation yapar
      
    }
  }

  /**
   * İlk veri için chart data'sını hazırla
   */
  private initializeChartDataForFirstTime(value: number, label: string): void {
    const now = new Date();
    const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    // İlk 5 data point ile başla (smooth başlangıç için)
    const initialData: number[] = [];
    const initialLabels: string[] = [];
    
    for (let i = 4; i >= 0; i--) {
      const pastTime = new Date(now.getTime() - (i * 15000)); // 15 saniye intervals
      const pastLabel = `${pastTime.getHours().toString().padStart(2, '0')}:${pastTime.getMinutes().toString().padStart(2, '0')}:${pastTime.getSeconds().toString().padStart(2, '0')}`;
      initialLabels.push(pastLabel);
      initialData.push(value); // Aynı değerle başla
    }
    
    // Current data point'i ekle
    initialLabels.push(timeLabel);
    initialData.push(value);
    
    this.chartData.labels = initialLabels;
    
    // Dataset'i güncelle veya oluştur
    if (this.chartData.datasets.length === 0) {
      const datasetConfig = this.getDatasetConfigForWidgetType();
      this.chartData.datasets.push({
        data: initialData,
        label: this.getPathDisplayName(label),
        ...datasetConfig
      });
    } else {
      this.chartData.datasets[0].data = initialData;
      this.chartData.datasets[0].label = this.getPathDisplayName(label);
    }
    
    // Chart data referansını güncelle
    this.chartData = { ...this.chartData };
    
    this.cdr.detectChanges();
  }

  // Çoklu veri yolları için veri setleri oluşturma
  fetchMultipleDataSets(paths: string[]): void {
    this.isLoadingData = true;
    this.chartData.datasets = [];
    this.chartData.labels = ['Loading...'];
    this.cdr.detectChanges();
    
    // Geriye uyumluluk için mevcut implementasyonu koru
    this.fetchInitialMultipleDataSets(paths);
  }

  // İlk veri yüklemesi - Chart'ı sıfırlayarak yeni veri seti oluşturur
  fetchInitialMultipleDataSets(paths: string[]): void {
    this.isLoadingData = true;
    this.chartData.datasets = [];
    this.chartData.labels = ['Preparing...'];
    this.cdr.detectChanges();
    
    // Her path için ayrı API çağrısı yap
    const dataSetPromises = paths.map((path, index) => {
      return new Promise<any>((resolve, reject) => {
        const pathParts = path.split('/');
        const dataSourceName = this.getPathDisplayName(path);
        
        ////console.log(`📡 [WIDGET] API çağrısı ${index + 1}/${paths.length}: ${dataSourceName}`);
        
        if (this.isValidApiPath(path)) {
          this.fetchSinglePathData(path).subscribe({
            next: (response) => {
              if (response.status === 'success' && response.data !== null) {
                ////console.log(`✅ [WIDGET] ${dataSourceName} verisi alındı:`, response.data);
                
                // API verisini işle
                let processedData: number[] = [];
                let currentValue: number = 0;
                let hisTimestamps: string[] | null = null;
                
                if (Array.isArray(response.data)) {
                  const isHisPath = !this.isRealtimePath(path);
                  // SYS: tüm veriyi al (son N dk), LIVE: son 10
                  const dataSlice = isHisPath ? response.data : response.data.slice(-10);
                  processedData = dataSlice.map((item: any) => {
                    // readRawDataHIS VALUE_CUR veya value döner
                    const val = item?.VALUE_CUR ?? item?.value ?? item?.gzahl ?? item?.data;
                    const num = typeof val === 'number' ? val : parseFloat(val);
                    return isNaN(num) ? 0 : num;
                  });
                  // SYS verileri için zaman etiketlerini çıkar (tarih + saat)
                  if (isHisPath) {
                    hisTimestamps = dataSlice.map((item: any) => {
                      const ts = item?.TIMESTAMP || item?.timestamp;
                      if (ts) {
                        const d = new Date(ts);
                        return `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                      }
                      return '';
                    });
                  }
                  currentValue = processedData[processedData.length - 1] || 0;
                } else {
                  // Tek veri noktası
                  currentValue = this.extractNumericValue(response.data);
                  processedData = Array(10).fill(currentValue);
                }
                
                // Veri tipine göre profesyonel renk şeması al
                const colors = this.getColorsForDataType(path, index);
                
                resolve({
                  data: processedData,
                  label: dataSourceName,
                  fill: this.widgetType === 'area-chart',
                  tension: 0.6, // Profesyonel smooth curves
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                  pointRadius: 4, // Daha büyük noktalar
                  pointHoverRadius: 12, // Daha büyük hover
                  borderWidth: 4, // Daha kalın çizgiler
                  borderDash: index > 4 ? [8, 4] : [], // İlk 5 line solid, sonrakiler dashed
                  cubicInterpolationMode: 'monotone', // Profesyonel interpolation
                  borderCapStyle: 'round',
                  borderJoinStyle: 'round',
                  pointBackgroundColor: colors.border,
                  pointBorderColor: '#ffffff',
                  pointBorderWidth: 3, // Daha kalın point border
                  pointHoverBackgroundColor: '#ffffff',
                  pointHoverBorderColor: colors.border,
                  pointHoverBorderWidth: 4, // Daha kalın hover border
                  currentValue: currentValue,
                  path: path,
                  hisTimestamps: hisTimestamps
                });
              } else {
                console.warn(`⚠️ [WIDGET] ${dataSourceName} API response failed`);
                
                // Başarısız API için placeholder dataset
                resolve({
                  data: Array(10).fill(0),
                  label: `❌ ${dataSourceName}`,
                  fill: false,
                  tension: 0,
                  borderColor: STATUS.danger,
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  pointRadius: 3,
                  borderWidth: 1,
                  borderDash: [10, 5],
                  currentValue: 0,
                  path: path,
                  isError: true
                });
              }
            },
            error: (error) => {
              console.error(`❌ [WIDGET] ${dataSourceName} API error:`, error);
              
              // Hata durumu için dataset
              resolve({
                data: Array(10).fill(0),
                label: `❌ ${dataSourceName}`,
                fill: false,
                tension: 0,
                borderColor: STATUS.danger,
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                pointRadius: 3,
                borderWidth: 1,
                borderDash: [10, 5],
                currentValue: 0,
                path: path,
                isError: true
              });
            }
          });
        } else {
          console.warn(`⚠️ [WIDGET] Invalid path format: ${path}`);
          
          // Geçersiz path için fallback dataset
          resolve({
            data: Array(10).fill(0),
            label: `⚠️ ${this.getPathDisplayName(path)}`,
            fill: false,
            tension: 0,
            borderColor: STATUS.warning,
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            pointRadius: 3,
            borderWidth: 1,
            borderDash: [5, 5],
            currentValue: 0,
            path: path,
            isError: true
          });
        }
      });
    });
    
    // Tüm API çağrılarını bekle ve sonuçları işle
    Promise.allSettled(dataSetPromises).then(results => {
      const successfulDataSets: any[] = [];
      const errorDataSets: any[] = [];
      let primaryValue: number | null = null;
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const dataset = result.value;
          if (dataset.isError) {
            errorDataSets.push(dataset);
          } else {
            successfulDataSets.push(dataset);
            // İlk başarılı dataset'ten current value al
            if (primaryValue === null) {
              primaryValue = dataset.currentValue;
            }
          }
        }
      });
      
      ////console.log(`📊 [WIDGET] API sonuçları: ${successfulDataSets.length} başarılı, ${errorDataSets.length} hatalı`);
      
      // Başarılı dataset'ler varsa onları kullan
      if (successfulDataSets.length > 0) {
        this.hasError = false;
        this.errorMessage = '';
        this.stopRetryTimer();
        
        // Tüm dataset'lerin maksimum uzunluğunu bul
        let maxLen = Math.max(...successfulDataSets.map(ds => (ds.data as any[]).length));
        
        // Eğer tüm veri setleri boşsa (veritabanında hiç kayıt yoksa), dürüstçe No Data durumuna geç!
        const isEmptyData = (maxLen === 0);
        if (isEmptyData) {
          this.isNoData = true;
          this.chartData.datasets = [];
          this.currentValue = null;
          this.description = 'No Data';
          
          this.chartData.labels = ['No Data'];
          this.chartData = { ...this.chartData };
          this.isLoadingData = false;
          this.cdr.detectChanges();
          return;
        } else {
          this.isNoData = false;
        }

        // SYS timestamps varsa bunları kullan, yoksa LIVE zaman etiketleri oluştur
        const hisDataset = successfulDataSets.find(ds => ds.hisTimestamps && ds.hisTimestamps.length > 0);
        let labels: string[];
        if (hisDataset) {
          labels = hisDataset.hisTimestamps;
        } else {
          const now = new Date();
          labels = [];
          for (let i = maxLen - 1; i >= 0; i--) {
            const time = new Date(now.getTime() - i * this.updateInterval);
            labels.push(`${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`);
          }
        }

        // Tüm dataset'leri aynı uzunluğa getir (kısa olanları interpolasyon ile yay)
        for (const ds of successfulDataSets) {
          const arr = ds.data as number[];
          if (arr.length < labels.length) {
            ds.data = this.stretchData(arr, labels.length);
          }
        }
        
        this.chartData.labels = labels;
        
        // Başarılı dataset'leri ekle ve profesyonel renk paleti uygula
        this.chartData.datasets = successfulDataSets.map((dataset, index) => {
          const colors = this.getColorsForDataType(dataset.path, index);
          const isHis = !this.isRealtimePath(dataset.path);
          
          return {
            ...dataset,
            hidden: this.activePaths[dataset.path] === false,
            borderColor: isHis ? this.fadeColor(colors.border, 0.45) : colors.border,
            backgroundColor: colors.background,
            pointBackgroundColor: isHis ? this.fadeColor(colors.border, 0.45) : colors.border,
            pointBorderColor: '#ffffff',
            pointBorderWidth: isHis ? 1 : 2,
            pointRadius: isHis ? 1 : 3,
            pointHoverRadius: isHis ? 4 : 6,
            pointHoverBackgroundColor: colors.border,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: isHis ? 2 : 3,
            borderWidth: isHis ? 1.5 : 3.5,
            borderDash: isHis ? [6, 3] : [],
            fill: this.widgetType === 'area-chart',
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            spanGaps: false
          };
        });
        
        // Hatalı dataset'leri de ekle (görsel geri bildirim için)
        if (errorDataSets.length > 0) {
          this.chartData.datasets.push(...errorDataSets.map((dataset, errorIndex) => {
            const totalIndex = successfulDataSets.length + errorIndex;
            return {
              ...dataset,
              hidden: this.activePaths[dataset.path] === false,
              borderColor: STATUS.danger,
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              pointBackgroundColor: STATUS.danger,
              pointBorderColor: '#ffffff',
              pointBorderWidth: 2,
              borderWidth: 2,
              borderDash: [5, 5]
            };
          }));
        }
        
        // ─── Formula evaluation ───
        if (this.formula && this.formula.trim() && successfulDataSets.length >= 1) {
          try {
            const dataArrays = this.currentDataPaths.map(path => {
              const ds = successfulDataSets.find(d => d.path === path);
              if (ds && ds.data) {
                return ds.data as number[];
              }
              return Array(labels.length).fill(0);
            });
            console.log(`📐 [WIDGET] Formula: "${this.formula}" | paths: ${dataArrays.length} | data lengths: ${dataArrays.map(a => a.length).join(',')}`);
            const computedData = evaluateFormulaOnArrays(this.formula, dataArrays);
            console.log(`📐 [WIDGET] Formula result: ${computedData.length} points, sample: ${computedData.slice(0, 3).join(', ')}`);
            
            if (computedData.length > 0) {
              const formulaDataset = {
                data: computedData,
                label: `ƒ ${this.formula}`,
                fill: false,
                tension: 0.4,
                borderColor: STATUS.warning,
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                pointBackgroundColor: STATUS.warning,
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointRadius: 3,
                pointHoverRadius: 7,
                pointHoverBackgroundColor: '#ffffff',
                pointHoverBorderColor: STATUS.warning,
                pointHoverBorderWidth: 3,
                borderWidth: 3.5,
                borderDash: [] as number[],
                cubicInterpolationMode: 'monotone' as const,
                spanGaps: false,
                order: 0
              };
              
              // Formula active → ADD formula as extra dataset, keep source paths visible
              this.chartData.datasets.push(formulaDataset as any);
              
              // Update current value from formula
              const lastVal = computedData[computedData.length - 1];
              if (!isNaN(lastVal)) {
                primaryValue = lastVal;
              }
            }
          } catch (e) {
            console.warn('⚠️ [WIDGET] Formula evaluation error:', e);
          }
        }
        
        // Current value ve unit güncelle
        if (primaryValue !== null) {
          this.currentValue = primaryValue;
          this.valueUnit = this.determineUnitFromPath(paths[0]);
          this.checkThresholds(primaryValue);
        }
        
        // Description güncelle
        const totalPaths = paths.length;
        const successCount = successfulDataSets.length;
        const rtCount = paths.filter(p => this.isRealtimePath(p)).length;
        const hisCount = totalPaths - rtCount;
        
        if (successCount === totalPaths) {
          if (this.formula && this.formula.trim()) {
            this.description = `ƒ ${this.formula} (${totalPaths} paths)`;
          } else if (hisCount > 0 && rtCount > 0) {
            this.description = `LIVE(${rtCount}) + SYS(${hisCount})`;
          } else if (hisCount > 0) {
            this.description = `Historical (${hisCount} path)`;
          } else {
            this.description = `Realtime (${rtCount} path)`;
          }
        } else {
          this.description = `Data (${successCount}/${totalPaths} loaded)`;
        }
        
        ////console.log(`✅ [WIDGET] Multi-path güncellendi: ${successCount}/${totalPaths} başarılı`);
      } else {
        // Hiçbir API çağrısı başarılı olmadı
        console.error('❌ [WIDGET] All API calls failed!');
        
        this.hasError = true;
        this.errorMessage = this.translateService.instant('HARDCODED.ERROR') || 'API Error';
        this.startRetryCountdown();
        
        this.description = `❌ ${this.translateService.instant('HARDCODED.ERROR')} (${paths.length} paths)`;
        this.currentValue = null;
        this.valueStatus = 'danger';
        
        this.chartData.labels = [this.translateService.instant('HARDCODED.ERROR')];
        this.chartData.datasets = [{
          data: [0],
          label: 'API Error',
          borderColor: STATUS.danger,
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          borderDash: [5, 5],
          pointRadius: 5
        }];
      }
      
      // Grafik ayarlarını çoklu veri seti için güncelle
      this.updateChartOptionsForMultiPath(this.chartData.datasets.length);
      
      // Grafiği yenile
      this.chartData = { ...this.chartData };
      this.isLoadingData = false;
      this.cdr.detectChanges();
      
      ////console.log('🎯 [WIDGET] Multi-path veri güncelleme tamamlandı');
    }).catch(error => {
      console.error('❌ [WIDGET] Multi-path Promise error:', error);
      
      this.hasError = true;
      this.errorMessage = error?.message || 'Critical API Error';
      this.startRetryCountdown();

      // Kritik hata durumu
      this.description = '❌ Critical API error';
      this.currentValue = null;
      this.valueStatus = 'danger';
      
      this.chartData.labels = ['Critical Error'];
      this.chartData.datasets = [{
        data: [0],
        label: 'System Error',
        borderColor: STATUS.danger,
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        borderDash: [10, 5],
        pointRadius: 8
      }];
      
      this.chartData = { ...this.chartData };
      this.isLoadingData = false;
      this.cdr.detectChanges();
    });
  }
  
  // API yanıtından sayısal değer çıkarma - Multi-path desteği için
  private extractNumericValue(data: any): number {
    if (typeof data === 'number') {
      return data;
    }
    
    if (typeof data === 'string') {
      const parsed = parseFloat(data);
      return isNaN(parsed) ? 0 : parsed;
    }
    
    if (typeof data === 'object' && data !== null) {
      // readRawDataHIS format: { TIMESTAMP, VALUE_CUR, ... }
      if (data.VALUE_CUR !== undefined) {
        return parseFloat(data.VALUE_CUR) || 0;
      }
      // Moment API format kontrolü
      if (data.gzahl !== undefined) {
        return parseFloat(data.gzahl) || 0;
      }
      if (data.value !== undefined) {
        return parseFloat(data.value) || 0;
      }
      if (data.data !== undefined) {
        return parseFloat(data.data) || 0;
      }
      
      // Object'in ilk sayısal değerini al
      const numericValues = Object.values(data).filter(val => {
        const num = parseFloat(val as string);
        return !isNaN(num);
      });
      
      if (numericValues.length > 0) {
        return parseFloat(numericValues[0] as string) || 0;
      }
    }
    
    return 0;
  }
  
  private updateChartOptionsForMultiPath(datasetCount: number): void {
    ////console.log(`🎨 [WIDGET] Chart seçenekleri güncelleniyor: ${datasetCount} dataset`);
    
    this.chartOptions = {
      ...this.chartOptions,
      layout: {
        ...this.chartOptions.layout,
        padding: {
          ...(this.chartOptions.layout?.padding as any),
          left: 28
        }
      },
      plugins: {
        ...this.chartOptions.plugins,
        legend: {
          display: datasetCount > 1,
          position: 'top' as const,
          labels: {
            boxWidth: 12,
            padding: 8,
            usePointStyle: true,
            font: { 
              size: datasetCount > 5 ? 9 : 10 
            },
            filter: (item: any, chartData: any) => {
              if (item.text.startsWith('❌')) return false;
              // Hide component paths from legend if they are hidden on the chart
              const dataset = chartData?.datasets?.[item.datasetIndex];
              if (dataset && dataset.hidden) {
                return false;
              }
              return true;
            }
          }
        },
        tooltip: {
          mode: 'index' as const,
          intersect: false,
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          titleColor: '#F9FAFB',
          bodyColor: '#F9FAFB',
          borderColor: '#374151',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: true,
          callbacks: {
            title: function(context: any) {
              return `Time: ${context[0].label}`;
            },
            label: (context: any) => {
              const label = context.dataset.label || '';
              const value = context.raw;
              
              if (label.startsWith('❌') || label.startsWith('⚠️')) {
                return `${label} - Veri yok`;
              }
              
              return `${label}: ${this.formatTickValue(value)}`;
            }
          }
        }
      },
      interaction: {
        mode: 'index' as const,
        intersect: false
      },
      scales: {
        ...this.chartOptions.scales,
        y: {
          ...this.chartOptions.scales?.['y'],
          grid: {
            ...this.chartOptions.scales?.['y']?.grid,
            display: true,
            color: 'rgba(156, 163, 175, 0.2)'
          },
          ticks: {
            ...this.chartOptions.scales?.['y']?.ticks,
            callback: (value: any) => this.formatTickValue(value)
          }
        }
      }
    };
    
    ////console.log('✅ [WIDGET] Chart seçenekleri güncellendi');
  }

  // Yedek veri üretimi - sadece API başarısız olduğunda kullanılır
  private generateFallbackData(dataSourceName: string, locationName: string, path: string): void {
    console.warn('⚠️ [WIDGET] Failed to retrieve API data, showing error status');
    
    // API başarısız olduğunda hata mesajı göster
    this.description = `❌ API ${this.translateService.instant('HARDCODED.ERROR')}: ${dataSourceName}`;
    this.currentValue = null;
    this.valueStatus = 'danger';
    
    // Grafik için error state - tip güvenli
    this.chartData.labels = [this.translateService.instant('HARDCODED.ERROR')];
    this.chartData.datasets = [{
      data: [0] as number[], // Tip güvenli error data
      label: `❌ ${dataSourceName} - ${this.translateService.instant('HARDCODED.ERROR')}`,
      fill: false,
      tension: 0,
      borderColor: STATUS.danger,
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      pointRadius: 5,
      pointBackgroundColor: STATUS.danger,
      borderWidth: 2,
      borderDash: [5, 5] // Kesikli çizgi hata için
    }];
    
    // Grafiği güncelle
    this.chartData = { ...this.chartData };
    this.cdr.detectChanges();
    
    ////console.log('❌ [WIDGET] API hatası - Otomatik yeniden deneme devre dışı (performans için)');
  }

  // Historical data çekmek için özel metot
  fetchHistoricalData(): void {
    if (!this.startDate || !this.endDate) {
      console.error('❌ [WIDGET] Start and end dates are required for historical data');
      return;
    }
    
    // Veri yükleniyor göstergesi
    const loadingDataset = {
      data: [],
      label: 'Loading data...',
      borderColor: BRAND.tertiary,
      backgroundColor: 'rgba(124, 141, 181, 0.2)',
      pointRadius: 0
    };
    
    this.chartData.datasets = [loadingDataset];
    this.chartData = { ...this.chartData };
    this.cdr.detectChanges();
    
    try {
      // Tarih aralığına göre zaman etiketlerini oluştur
      const startDate = new Date(this.startDate);
      const endDate = new Date(this.endDate);
      
      // Tarih kontrolü
      if (startDate > endDate) {
        throw new Error('Start date cannot be after end date');
      }
      
      // Tarih aralığına göre farklı formatlama stratejileri
      const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
      let labels: string[] = [];
      let dateFormat: string;
      
      if (diffDays <= 1) {
        // Tek gün - saatlik görünüm
        dateFormat = 'HH:mm';
        const hours = 24;
        for (let i = 0; i < hours; i++) {
          const date = new Date(startDate);
          date.setHours(i, 0, 0, 0);
          labels.push(`${i}:00`);
        }
      } else if (diffDays <= 31) {
        // Bir ay veya daha az - günlük görünüm
        dateFormat = 'DD.MM';
        for (let i = 0; i <= diffDays; i++) {
          const date = new Date(startDate);
          date.setDate(date.getDate() + i);
          labels.push(`${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}`);
        }
      } else {
        // Bir aydan fazla - aylık görünüm
        dateFormat = 'MM.YYYY';
        // Ayların ilk günlerini belirle
        const months = [];
        let currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        while (currentDate <= endDate) {
          months.push(new Date(currentDate));
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        
        labels = months.map(date => `${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`);
      }
      
      this.chartData.labels = labels;
      
      // API'den geçmiş veri çekme - artık gerçek API çağrısı yapıyoruz
      const dataSetPromises = this.currentDataPaths.map((path, index) => {
        const pathParts = path.split('/');
        const dataSourceName = pathParts[pathParts.length - 1] || 'Veri';
        
        return this.fetchHistoricalDataFromAPI(path, this.startDate || '', this.endDate || '')
          .then(historicalData => {
            const colors = this.getColorsForDataType(path, index);
            
            // Eğer historicalData boşsa (veri yoksa), X eksenine uygun şekilde sıfır (0) dizisi oluştur ki düz çizgi çizsin
            const finalData = (historicalData && historicalData.length > 0)
              ? historicalData
              : new Array(labels.length).fill(0);
            
            return {
              data: finalData,
              label: dataSourceName,
              path: path,
              hidden: this.activePaths[path] === false,
              fill: this.widgetType === 'area-chart',
              tension: 0.4,
              borderColor: colors.border,
              backgroundColor: colors.background,
              pointRadius: labels.length > 20 ? 0 : 2,
              pointHoverRadius: 5,
              borderWidth: 2,
              borderDash: index > 2 ? [5, 5] : []
            };
          })
          .catch(error => {
            console.error(`❌ [WIDGET] Failed to load historical data for path ${path}:`, error);
            // Return placeholder dataset on error
            return {
              data: [],
              label: `❌ ${dataSourceName}`,
              path: path,
              hidden: this.activePaths[path] === false,
              fill: false,
              borderColor: STATUS.danger,
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderDash: [5, 5],
              pointRadius: 0
            };
          });
      });
      
      // Tüm API çağrılarını bekle
      Promise.all(dataSetPromises).then(datasets => {
        const successfulDatasets = datasets.filter(ds => ds.data.length > 0 && !ds.label.startsWith('❌'));
        
        // Eğer hiçbir başarılı veri seti yoksa (veritabanı boşsa), dürüstçe No Data durumuna geç!
        if (successfulDatasets.length === 0) {
          this.isNoData = true;
          this.chartData.datasets = [];
          this.currentValue = null;
        } else {
          this.isNoData = false;
          this.chartData.datasets = successfulDatasets;
          
          // Set currentValue to the last value of the primary dataset for value cards/gauge widgets
          const primaryDataset = successfulDatasets.find(d => d.path === this.currentDataPaths[0]) || successfulDatasets[0];
          if (primaryDataset && primaryDataset.data && primaryDataset.data.length > 0) {
            this.currentValue = primaryDataset.data[primaryDataset.data.length - 1];
            if (this.currentValue !== null) {
              this.checkThresholds(this.currentValue);
            }
          }
        }
        
        // ─── Formula evaluation (Historical) ───
        console.log(`📐 [WIDGET-SYS] Formula check: formula="${this.formula}" datasets=${successfulDatasets.length}`);
        if (this.formula && this.formula.trim() && successfulDatasets.length >= 1 && !this.isNoData) {
          try {
            const dataArrays = this.currentDataPaths.map(path => {
              const ds = datasets.find(d => d.path === path);
              if (ds && ds.data && ds.data.length > 0) {
                return ds.data as number[];
              }
              return Array(labels.length).fill(0);
            });
            console.log(`📐 [WIDGET-SYS] Formula eval: "${this.formula}" | arrays: ${dataArrays.length} | lengths: ${dataArrays.map(a => a.length).join(',')}`);
            const computedData = evaluateFormulaOnArrays(this.formula, dataArrays);
            console.log(`📐 [WIDGET-SYS] Formula result: ${computedData.length} points, sample: ${computedData.slice(0, 3).join(', ')}`);
            
            if (computedData.length > 0) {
              const formulaDataset = {
                data: computedData,
                label: `ƒ ${this.formula}`,
                fill: false,
                tension: 0.4,
                borderColor: STATUS.warning,
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                pointBackgroundColor: STATUS.warning,
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointRadius: successfulDatasets[0] ? (successfulDatasets[0].data.length > 20 ? 0 : 2) : 2,
                pointHoverRadius: 5,
                borderWidth: 3,
                borderDash: [] as number[],
                cubicInterpolationMode: 'monotone' as const,
                spanGaps: false,
                order: 0
              };
              // Formula active → ADD formula as extra dataset, keep source paths visible
              this.chartData.datasets.push(formulaDataset as any);
            }
          } catch (e) {
            console.warn('⚠️ [WIDGET] Formula evaluation error (historical):', e);
          }
        }
        
        // Grafiği güncelle
        this.chartData = { ...this.chartData };
        // Tarihleri gösteren alt başlık ekle
        const formattedStartDate = this.formatDate(new Date(this.startDate || ''));
        const formattedEndDate = this.formatDate(new Date(this.endDate || ''));
        const dsLabel = this.isNoData ? 'No Data' : (this.formula ? `ƒ ${this.formula}` : `${this.chartData.datasets.length} veri kaynağı`);
        this.description = this.isNoData ? 'No historical records' : `${formattedStartDate} - ${formattedEndDate} (${dsLabel})`;
        
        this.cdr.detectChanges();
      }).catch(error => {
        console.error('❌ [WIDGET] Historical data processing error:', error);
        
        // Genel hata durumu
        this.chartData.datasets = [{
          data: [],
          label: '❌ Could not fetch data',
          fill: false,
          borderColor: STATUS.danger,
          backgroundColor: 'rgba(239, 68, 68, 0.2)',
          pointRadius: 0
        }];
        
        this.description = '❌ Could not fetch historical data';
        this.chartData = { ...this.chartData };
        this.cdr.detectChanges();
      });
    } catch (error) {
      console.error('❌ [WIDGET] Error loading historical data:', error);
      
      // Hata durumunda kullanıcıya bilgi ver
      this.chartData.datasets = [{
        data: [],
        label: 'Error loading data',
        fill: false,
        borderColor: STATUS.danger,
        backgroundColor: 'rgba(239, 68, 68, 0.2)',
        pointRadius: 0
      }];
      
      this.chartData = { ...this.chartData };
      this.cdr.detectChanges();
    }
  }
  
  // Geçmiş veri için tarih formatlama
  private formatDate(date: Date): string {
    return `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
  }
  
  // Geçmiş veriyi API'den çekme 
  private fetchHistoricalDataFromAPI(path: string, startDateStr: string, endDateStr: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      if (!this.isValidApiPath(path)) {
        console.warn(`⚠️ [WIDGET] Geçersiz path formatı: ${path}`);
        reject(new Error(`Invalid path format: ${path}`));
        return;
      }
      
      // Determine aggregation dynamically based on the date range (diffDays)
      let aggregationValue: 'minute' | 'hour' | 'day' = 'hour';
      try {
        const startDate = new Date(startDateStr);
        const endDate = new Date(endDateStr);
        const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
        
        if (diffDays <= 30) {
          aggregationValue = 'hour';
        } else {
          aggregationValue = 'day';
        }
      } catch (e) {
        console.error('Error determining aggregation:', e);
      }
      
      this.apiService.getHistoricalData({
        dataPath: path,
        startDate: startDateStr,
        endDate: endDateStr,
        aggregation: aggregationValue
      }).subscribe({
        next: (response) => {
          try {
            let historicalData: number[] = [];
            let timestamps: string[] = [];
            
            if (Array.isArray(response)) {
              historicalData = response.map(item => {
                if (typeof item === 'number') return item;
                if (item && typeof item === 'object') {
                  if (item.value !== undefined) return parseFloat(item.value);
                  if (item.gzahl !== undefined) return parseFloat(item.gzahl);
                  if (item.data !== undefined) return parseFloat(item.data);
                  const vals = Object.values(item).map(v => parseFloat(v as string)).filter(v => !isNaN(v));
                  if (vals.length > 0) return vals[0];
                }
                return parseFloat(item.toString());
              }).filter(val => !isNaN(val));

              timestamps = response.map(item => {
                if (item && typeof item === 'object') {
                  const ts = item.timestamp || item.TIMESTAMP || item.created_at;
                  if (ts) {
                    const d = new Date(ts);
                    if (aggregationValue === 'day') {
                      return `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}`;
                    } else {
                      return `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                    }
                  }
                }
                return '';
              }).filter(t => t !== '');
            }

            if (timestamps.length > 0) {
              this.chartData.labels = timestamps;
            }

            if (historicalData.length === 0) {
              console.warn('⚠️ [WIDGET] Historical data from API is empty or invalid');
              reject(new Error('No valid historical data received'));
              return;
            }
            
            resolve(historicalData);
          } catch (e: any) {
            reject(e);
          }
        },
        error: (err) => {
          console.error(`❌ [WIDGET] Historical data API error (${path}):`, err);
          reject(err);
        }
      });
    });
  }

  // Veri yenileme için ana metot - veri kaynağı tipine göre uygun veri çekme metodunu çağırır
  updateChartData(): void {
    if (this.dataSourceType === 'historical') {
      // Historical modda otomatik güncelleme yapma
      ////console.log('📅 [WIDGET] Historical modda - Veri güncellemesi atlandı');
      return;
    } else {
      // Gerçek zamanlı veri için aktif path'lerle grafiği güncelle
      ////console.log('🔄 [WIDGET] Realtime veri güncellemesi başlatılıyor');
      this.updateChartWithActivePaths();
    }
  }

  // Tam ekran modunu kontrol etmek için
  toggleFullscreen(): void {
    this.isFullscreen = !this.isFullscreen;
    if (this.isFullscreen) {
      // Save current options before entering fullscreen
      this.standardChartOptions = { ...this.chartOptions };
      // Enter fullscreen: merge to preserve existing custom plugins/ticks
      this.chartOptions = {
        ...this.chartOptions,
        ...this.fullscreenChartOptions
      };
    } else {
      // Restore standard options
      if (this.standardChartOptions) {
        this.chartOptions = { ...this.standardChartOptions };
      } else {
        this.chartOptions = {
          ...this.chartOptions,
          responsive: true,
          maintainAspectRatio: false
        };
      }
    }
    this.fullscreenToggled.emit(this.isFullscreen);
    this.cdr.detectChanges();
  }
  
  // Widget verilerini dışa aktar
  exportWidgetData(): void {
    try {
      // Dışa aktarılacak veri nesnesini oluştur
      const exportData = {
        title: this.title,
        timestamp: new Date().toISOString(),
        dataSourceType: this.dataSourceType,
        paths: this.currentDataPaths,
        labels: this.chartData.labels,
        datasets: this.chartData.datasets.map(ds => ({
          label: ds.label,
          data: ds.data
        }))
      };
      
      // JSON formatına dönüştür
      const dataStr = JSON.stringify(exportData, null, 2);
      
      // Dosya indirme işlemi için link oluştur
      const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
      const exportFileName = `${this.title.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.json`;
      
      const linkElement = document.createElement('a');
      linkElement.setAttribute('href', dataUri);
      linkElement.setAttribute('download', exportFileName);
      linkElement.click();
      
      ////console.log('Grafik verileri başarıyla dışa aktarıldı:', exportFileName);
    } catch (error) {
      console.error('❌ [WIDGET] Error exporting data:', error);
    }
  }
  
  // Güncel değeri güncelle - value-card ve stat-card widget'ları için
  updateCurrentValue(): void {
    if (this.chartData.datasets.length > 0 && this.chartData.datasets[0].data.length > 0) {
      // Son veri noktasını al
      const latestData = this.chartData.datasets[0].data;
      this.currentValue = latestData[latestData.length - 1] as number;
      
      // Eşik değerlerine göre durum belirle
      if (this.thresholds) {
        if (this.thresholds.danger !== undefined && this.currentValue >= this.thresholds.danger) {
          this.valueStatus = 'danger';
        } else if (this.thresholds.warning !== undefined && this.currentValue >= this.thresholds.warning) {
          this.valueStatus = 'warning';
        } else {
          this.valueStatus = 'normal';
        }
      }
    } else {
      this.currentValue = null;
    }
  }

  /**
   * Path'ten doğru satz değerini alır
   */
  private getSatzFromPath(path: string): number {
    if (!path || typeof path !== 'string') {
      return 1;
    }
    // Önce mapping'den bak
    if (this.pathToSatzMapping[path]) {
      return this.pathToSatzMapping[path];
    }
    
    // Path'te [satz] formatı var mı kontrol et (dataSourceType'a bakmadan!)
    // Örnekler: "MvMoment[39691]", "U/MvMoment[7262]", "Paris > P > MvMoment[7262]"
    const satzMatch = path.match(/\[(\d+)\]/);
    if (satzMatch) {
      return parseInt(satzMatch[1]);
    }
    
    // Fallback — son rakamı al
    const lastNumber = path.split('/').pop();
    const satz = lastNumber ? parseInt(lastNumber) : 1;
    return isNaN(satz) ? 1 : satz;
  }

  // Widget tipi metodları
  getGaugePercentage(): number {
    if (this.currentValue === null || !this.thresholds.max) return 0;
    return Math.min(100, Math.max(0, (this.currentValue / this.thresholds.max) * 100));
  }

  getTrendIcon(): string {
    const direction = this.getTrendDirection();
    switch (direction) {
      case 'up': return 'fas fa-arrow-up';
      case 'down': return 'fas fa-arrow-down';
      case 'stable': return 'fas fa-minus';
      default: return 'fas fa-minus';
    }
  }

  getTrendDirection(): 'up' | 'down' | 'stable' {
    if (!this.chartData.datasets || this.chartData.datasets.length === 0) return 'stable';
    const primaryDs = this.chartData.datasets[0];
    if (!primaryDs || !primaryDs.data || primaryDs.data.length < 2) return 'stable';

    const validData = primaryDs.data.filter((v: any) => typeof v === 'number' && !isNaN(v) && v !== null) as number[];
    if (validData.length < 2) return 'stable';

    const first = validData[0];
    const last = validData[validData.length - 1];

    if (last > first) return 'up';
    if (last < first) return 'down';
    return 'stable';
  }

  getTrendPercentage(): number {
    if (!this.chartData.datasets || this.chartData.datasets.length === 0) return 0;
    const primaryDs = this.chartData.datasets[0];
    if (!primaryDs || !primaryDs.data || primaryDs.data.length < 2) return 0;

    const validData = primaryDs.data.filter((v: any) => typeof v === 'number' && !isNaN(v) && v !== null) as number[];
    if (validData.length < 2) return 0;

    const first = validData[0];
    const last = validData[validData.length - 1];

    if (first === 0) return 0;
    const pct = ((last - first) / first) * 100;
    return Math.abs(Math.round(pct * 10) / 10);
  }

  getStatValue(type: 'min' | 'max' | 'avg'): string {
    if (!this.chartData.datasets || this.chartData.datasets.length === 0) {
      if (this.currentValue !== null) {
        if (type === 'avg') return this.currentValue.toFixed(1);
        return '--';
      }
      return '--';
    }
    
    // Collect all valid numbers across all visible datasets
    const allValues: number[] = [];
    this.chartData.datasets.forEach(ds => {
      if (!ds.hidden && ds.data) {
        ds.data.forEach((val: any) => {
          if (typeof val === 'number' && !isNaN(val) && val !== null) {
            allValues.push(val);
          }
        });
      }
    });

    if (allValues.length === 0) {
      if (this.currentValue !== null) {
        if (type === 'avg') return this.currentValue.toFixed(1);
        return '--';
      }
      return '--';
    }

    if (type === 'min') {
      const min = Math.min(...allValues);
      return min.toFixed(1);
    }
    if (type === 'max') {
      const max = Math.max(...allValues);
      return max.toFixed(1);
    }
    if (type === 'avg') {
      const sum = allValues.reduce((a, b) => a + b, 0);
      const avg = sum / allValues.length;
      return avg.toFixed(1);
    }

    return '--';
  }

  getTableData(): Array<{parameter: string, value: string, status: string}> {
    const unit = this.valueUnit || '';
    const displayValue = this.currentValue != null ? this.formatValue(this.currentValue) : '--';
    return [
      { parameter: this.title || 'Data', value: `${displayValue} ${unit}`, status: this.valueStatus },
    ];
  }

  getKPIValue(type: string): number {
    return 0; // Dynamic database-driven KPIs should be configured via calculations
  }

  getAlerts(): Array<{message: string, severity: string, time: string}> {
    return []; // Disable static mockup alerts
  }

  // Mevcut chart'ı incremental olarak günceller - chart reset yapmaz
  updateExistingMultipleDataSets(paths: string[]): void {
    ////console.log('📈 [WIDGET] Mevcut chart\'ı incremental güncelleniyor:', paths);
    
    if (!this.chartComponent?.chart) {
      console.warn('⚠️ [WIDGET] Chart referansı bulunamadı, fallback\'e geçiliyor');
      this.fetchInitialMultipleDataSets(paths);
      return;
    }

    const chart = this.chartComponent.chart;
    
    // Self-healing: if we are currently in an error state (e.g. red dashed lines)
    // we must perform a full re-initialization to restore beautiful curves!
    const isCurrentlyError = chart.data.datasets && chart.data.datasets.some((ds: any) => ds.isError || (ds.label && ds.label.startsWith('❌')));
    if (isCurrentlyError) {
      console.log('🔄 [WIDGET] Hata durumundan çıkılıyor, grafik sıfırdan re-initialize ediliyor...');
      this.fetchInitialMultipleDataSets(paths);
      return;
    }

    const now = new Date();
    const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    // Sadece LIVE path'leri filtrele
    const rtPaths = paths.filter(p => this.isRealtimePath(p));
    if (rtPaths.length === 0) return;

    // Tüm LIVE path'lerden paralel veri çek, hepsi gelince tek seferde chart'ı güncelle
    const fetches = rtPaths.map(path => {
      if (!this.isValidApiPath(path)) return Promise.resolve({ path, value: null });
      return this.fetchSinglePathData(path).toPromise().then(response => {
        if (response && response.status === 'success' && response.data !== null) {
          let currentValue: number = 0;
          if (Array.isArray(response.data)) {
            const lastItem = response.data[response.data.length - 1];
            currentValue = this.extractNumericValue(lastItem);
          } else {
            currentValue = this.extractNumericValue(response.data);
          }
          if (isNaN(currentValue)) currentValue = 0;
          return { path, value: currentValue };
        }
        return { path, value: null };
      }).catch(() => ({ path, value: null }));
    });

    Promise.all(fetches).then(results => {
      // Check if chart has been destroyed or replaced in the meantime
      if (!this.chartComponent?.chart || this.chartComponent.chart !== chart) {
        return;
      }

      if (!chart.data.labels || !chart.data.datasets) return;

      // Önce trailing spacer'ı kaldır (varsa)
      if (chart.data.labels.length > 0 && chart.data.labels[chart.data.labels.length - 1] === '') {
        chart.data.labels.pop();
        chart.data.datasets.forEach((ds: any) => {
          if (ds.data && ds.data.length > 0) ds.data.pop();
        });
      }

      // İlk yükleme kontrolü
      if (chart.data.labels.length === 0 || chart.data.labels[0] === 'Yükleniyor...' || chart.data.labels[0] === 'Hazırlanıyor...') {
        const initialLabels: string[] = [];
        for (let i = 9; i >= 0; i--) {
          const pastTime = new Date(now.getTime() - (i * 6000));
          initialLabels.push(`${pastTime.getHours().toString().padStart(2, '0')}:${pastTime.getMinutes().toString().padStart(2, '0')}:${pastTime.getSeconds().toString().padStart(2, '0')}`);
        }
        chart.data.labels = initialLabels;
        chart.data.datasets.forEach((ds: any) => {
          if (ds.label && ds.label.startsWith('ƒ ')) return; // Formula is calculated later
          const r = results.find(r => r.path === (ds as any).path || r.path === ds.label);
          const val = r?.value ?? 0;
          ds.data = initialLabels.map(() => val);
        });
      } else {
        // Yeni zaman etiketi ekle (tek seferde, tüm dataset'ler için ortak)
        chart.data.labels.push(timeLabel);

        // Her dataset'e karşılık gelen yeni değeri ekle
        chart.data.datasets.forEach((ds: any) => {
          if (ds.label && ds.label.startsWith('ƒ ')) return; // Formula is calculated later
          
          if (ds.path) {
            ds.hidden = this.activePaths[ds.path] === false;
          }
          
          const r = results.find(r => {
            const dsName = this.getPathDisplayName(r.path);
            return (ds as any).path === r.path || ds.label === dsName;
          });
          if (r && r.value !== null) {
            ds.data.push(r.value);
          } else {
            // Veri gelmedi — null ekle, çizgi son gerçek değerde durur
            ds.data.push(null);
          }
        });

        // Sliding window: maksimum 50 data point
        const MAX_POINTS = 50;
        if (chart.data.labels.length > MAX_POINTS) {
          chart.data.labels.shift();
          chart.data.datasets.forEach((ds: any) => {
            if (ds.data && ds.data.length > MAX_POINTS) {
              ds.data.shift();
            }
          });
        }
      }

      // Formula recalculation in real-time
      if (this.formula && this.formula.trim()) {
        try {
          const dataArrays = this.currentDataPaths.map(path => {
            const dsName = this.getPathDisplayName(path);
            const ds = chart.data.datasets.find((d: any) => d.path === path || d.label === dsName);
            if (ds && ds.data) {
              return ds.data as number[];
            }
            return Array(chart.data.labels?.length || 10).fill(0);
          });

          const computedData = evaluateFormulaOnArrays(this.formula, dataArrays);
          
          // Find or create formula dataset
          let formulaDs = chart.data.datasets.find((d: any) => d.label === `ƒ ${this.formula}`);
          if (formulaDs) {
            formulaDs.data = computedData;
          }
          
          if (computedData.length > 0) {
            const lastVal = computedData[computedData.length - 1];
            if (!isNaN(lastVal) && lastVal !== null) {
              this.currentValue = lastVal;
              this.checkThresholds(lastVal);
            }
          }
        } catch (e) {
          console.warn('⚠️ [WIDGET] Formula update error:', e);
        }
      } else {
        const activePaths = Object.keys(this.activePaths).filter(p => this.activePaths[p]);
        if (activePaths.length > 0) {
          const primaryPath = activePaths[0];
          const primaryResult = results.find(r => r.path === primaryPath);
          if (primaryResult && primaryResult.value !== null) {
            this.currentValue = primaryResult.value;
            this.checkThresholds(primaryResult.value);
          }
        }
      }

      // Sağda 1 barem boşluk bırak (boş label + null → çizgi son gerçek noktada biter)
      chart.data.labels.push('');
      chart.data.datasets.forEach((ds: any) => {
        ds.data.push(null);
      });

      // Y-axis'i dinamik olarak ayarla
      this.adjustYAxisScale(chart);

      // Chart'ı smooth animation ile güncelle
      chart.update('active');
    });
  }

  // Y-axis scale'ini dinamik olarak ayarlar
  private adjustYAxisScale(chart: any): void {
    if (!chart.data.datasets || chart.data.datasets.length === 0) return;
    
    // Tüm aktif ve görünür dataset'lerden min/max değerleri bul
    const allValues: number[] = [];
    chart.data.datasets.forEach((dataset: any) => {
      if (!dataset.hidden && dataset.data && Array.isArray(dataset.data)) {
        allValues.push(...dataset.data.filter((val: any) => typeof val === 'number' && !isNaN(val)));
      }
    });
    
    if (allValues.length > 0) {
      const minValue = Math.min(...allValues);
      const maxValue = Math.max(...allValues);
      const range = maxValue - minValue;
      let padding = range * 0.1; // %10 padding
      if (range === 0) {
        // Flat line: add default padding of 10% of absolute value or at least 1.0
        padding = Math.max(1.0, Math.abs(maxValue) * 0.1);
      }
      
      // Chart options'ı güncelle
      if (chart.options && chart.options.scales && chart.options.scales.y) {
        chart.options.scales.y.min = minValue >= 0 ? Math.max(0, minValue - padding) : minValue - padding;
        chart.options.scales.y.max = maxValue + padding;
        
        ////console.log(`📊 [WIDGET] Y-axis dinamik olarak ayarlandı: ${chart.options.scales.y.min} - ${chart.options.scales.y.max}`);
      }
    }
  }

  public getTabularData(): { headers: string[]; rows: any[][] } {
    if (this.sqlTableRows && this.sqlTableRows.length > 0) {
      const headers = this.sqlTableColumns && this.sqlTableColumns.length > 0 ? this.sqlTableColumns : Object.keys(this.sqlTableRows[0]);
      const rows = this.sqlTableRows.map(row => headers.map(h => row[h]));
      return { headers, rows };
    } else if (this.chartData && this.chartData.datasets && this.chartData.datasets.length > 0) {
      const headers = ['Label / Timestamp', ...this.chartData.datasets.map(ds => ds.label || 'Series')];
      const labels = this.chartData.labels || [];
      const rows = labels.map((label, lIdx) => {
        const row: any[] = [label];
        this.chartData.datasets.forEach(ds => {
          row.push(ds.data && ds.data[lIdx] !== undefined ? ds.data[lIdx] : null);
        });
        return row;
      });
      return { headers, rows };
    } else if (this.currentValue !== null) {
      return {
        headers: ['Metric', 'Value', 'Unit'],
        rows: [[this.title || 'Current Value', this.currentValue, this.valueUnit || '']]
      };
    }
    return { headers: [], rows: [] };
  }
}

// Custom Chart.js Plugin: Line ucuna path isimleri (disabled - overflow sorunları nedeniyle devre dışı)
// Path bilgisi tooltip hover ve üst legend'da gösteriliyor
const pathLabelsPlugin = {
  id: 'pathLabels',
  afterDatasetsDraw(_chart: any) {
    // Disabled: labels were overflowing widget container
  }
};

// Plugin'i Chart.js'e register et
Chart.register(pathLabelsPlugin);
