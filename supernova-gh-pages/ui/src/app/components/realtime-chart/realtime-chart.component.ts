import { Component, OnInit, OnDestroy, ViewChild, ElementRef, Input } from '@angular/core';
import { ChartConfiguration, Chart } from 'chart.js';
import { DataService, VoltageData, FrequencyData } from '../../services/data.service';
import { Subscription } from 'rxjs';
import { BaseChartDirective } from 'ng2-charts';
import { TranslateService } from '@ngx-translate/core';
import annotationPlugin from 'chartjs-plugin-annotation';
import { CHART_PALETTE, BRAND, STATUS } from '../../shared/theme/palette';
import { ThemeColors } from '../../shared/theme/theme-colors';

interface PathItem {
  id: number;
  path: string;
  isSelected: boolean;
}

interface Threshold {
  warning?: number;
  danger?: number;
  unit?: string;
}

interface PathSelectorDialogResult {
  paths: string[];
  updateInterval: number;
  animationsEnabled: boolean;
  thresholds?: { 
    warning?: number; 
    danger?: number; 
    unit?: string;
    thresholdsEnabled: boolean; 
  };
}

@Component({
  standalone: false,
  selector: 'app-realtime-chart',
  templateUrl: './realtime-chart.component.html',
})
export class RealtimeChartComponent implements OnInit, OnDestroy {
  // Chart references
  @ViewChild('voltageChart') voltageChartRef?: BaseChartDirective;
  @ViewChild('frequencyChart') frequencyChartRef?: BaseChartDirective;
  
  // Eşik değerleri için Input özellikleri
  @Input() voltageThresholds: Threshold = { warning: 235, danger: 245, unit: 'V' };
  @Input() frequencyThresholds: Threshold = { warning: 50.5, danger: 51, unit: 'Hz' };
  
  // Path Selector özellikleri
  isPathSelectorDialogOpen = false;
  availablePaths: PathItem[] = [];
  selectedPaths: string[] = [];
  pathSelectionSuccess = false;
  
  // Visibility state for phases
  phaseAVisible: boolean = true;
  phaseBVisible: boolean = true;
  phaseCVisible: boolean = true;
  frequencyVisible: boolean = true;
  
  // Ayarlar Diyaloğu ve Tam Ekran özellikleri
  isSettingsDialogOpen = false;
  isFullscreenActive = false;
  currentDialogType: 'voltage' | 'frequency' = 'voltage';
  currentFullscreenType: 'voltage' | 'frequency' = 'voltage';
  tempVoltageThresholds: Threshold = { warning: 235, danger: 245, unit: 'V' };
  tempFrequencyThresholds: Threshold = { warning: 50.5, danger: 51, unit: 'Hz' };
  
  // Görsel ayarlar
  animationDuration = 300;
  showDataPoints = false;
  historyMinutes = 10; // SYS'ten çekilecek geçmiş veri süresi (dakika)
  
  // Track latest data for smoother updates
  private latestVoltageData: VoltageData[] = [];
  private latestFrequencyData: FrequencyData[] = [];
  private voltageSeeded = false;
  private frequencySeeded = false;
  private lastVoltageCount = 0;
  private lastFrequencyCount = 0;  // Tam ekran modu için chart options
  fullscreenChartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: this.animationDuration, easing: 'easeInOutSine' },
    transitions: {
      active: {
        animation: {
          duration: 500
        }
      }
    },
    scales: {
      x: { 
        display: true,
        ticks: {
          maxTicksLimit: 15,
          color: this.themeColors.axis(),
          font: { size: 12, family: "'Poppins', 'Helvetica', 'Arial', sans-serif" }
        },        grid: { 
          color: this.themeColors.grid()  
        },
        border: {
          display: false,
          color: this.themeColors.grid()
        }
      },
      y: {
        display: true,
        ticks: {
          color: this.themeColors.axis(),
          font: { size: 12, family: "'Poppins', 'Helvetica', 'Arial', sans-serif" },
          padding: 10
        },        grid: { 
          color: this.themeColors.grid()
        },
        border: {
          display: false
        }
      }
    },
    plugins: {
      legend: { 
        display: true, 
        position: 'top',
        labels: {
          color: this.themeColors.axis(),
          font: { size: 12, family: "'Poppins', 'Helvetica', 'Arial', sans-serif" },
          padding: 20,
          usePointStyle: true,
          boxWidth: 8
        }
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        backgroundColor: this.themeColors.tooltipBg(),
        titleColor: this.themeColors.tooltipText(),
        bodyColor: this.themeColors.tooltipMuted(),
        borderColor: this.themeColors.tooltipBorder(),
        borderWidth: 1,
        cornerRadius: 6,
        padding: 12,
        titleFont: {
          size: 14,
          family: "'Poppins', 'Helvetica', 'Arial', sans-serif",
          weight: 'bold'
        },
        bodyFont: {
          size: 13,
          family: "'Poppins', 'Helvetica', 'Arial', sans-serif"
        },
        boxPadding: 6,
        usePointStyle: true,
        callbacks: {
          // Tooltip'te değeri göster
          label: function(context) {
            const label = context.dataset.label || '';
            const val = context.parsed.y;
            if (val === null || val === undefined) return label;
            return ' ' + label + ': ' + val.toFixed(2);
          }
        }
      },
      annotation: {
        annotations: {}
      }
    },
    interaction: {
      mode: 'nearest',
      axis: 'x',
      intersect: false
    },
    elements: {
      point: {
        radius: 2,
        hoverRadius: 6,
        hitRadius: 10,
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        borderWidth: 2
      },
      line: {
        borderWidth: 3,
        tension: 0.4,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        fill: true
      }
    }
  };
    // Voltage Chart Configuration
  voltageChartData: ChartConfiguration<'line'>['data'] = {
    labels: [],
    datasets: [
      {
        data: [],
        label: 'Gerilim/L1',
        borderColor: CHART_PALETTE[0],
        backgroundColor: (ctx: any) => {
          const chart = ctx.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'rgba(245, 179, 1, 0.15)';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(245, 179, 1, 0.25)');
          gradient.addColorStop(0.5, 'rgba(245, 179, 1, 0.08)');
          gradient.addColorStop(1, 'rgba(245, 179, 1, 0)');
          return gradient;
        },
        fill: true,
        tension: 0.35,
        hidden: false,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: CHART_PALETTE[0],
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2
      },
      {
        data: [],
        label: 'Gerilim/L2',
        borderColor: CHART_PALETTE[1],
        backgroundColor: (ctx: any) => {
          const chart = ctx.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'rgba(255, 122, 26, 0.15)';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(255, 122, 26, 0.25)');
          gradient.addColorStop(0.5, 'rgba(255, 122, 26, 0.08)');
          gradient.addColorStop(1, 'rgba(255, 122, 26, 0)');
          return gradient;
        },
        fill: true,
        tension: 0.35,
        hidden: false,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: CHART_PALETTE[1],
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2
      },
      {
        data: [],
        label: 'Gerilim/L3',
        borderColor: CHART_PALETTE[2],
        backgroundColor: (ctx: any) => {
          const chart = ctx.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'rgba(124, 141, 181, 0.15)';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(124, 141, 181, 0.20)');
          gradient.addColorStop(0.5, 'rgba(124, 141, 181, 0.06)');
          gradient.addColorStop(1, 'rgba(124, 141, 181, 0)');
          return gradient;
        },
        fill: true,
        tension: 0.35,
        hidden: false,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: CHART_PALETTE[2],
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2
      },
    ],
  };

  // Frequency Chart Configuration
  frequencyChartData: ChartConfiguration<'line'>['data'] = {
    labels: [],
    datasets: [
      {
        data: [],
        label: 'Frekans',
        borderColor: CHART_PALETTE[3],
        backgroundColor: (ctx: any) => {
          const chart = ctx.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'rgba(52, 211, 153, 0.15)';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(52, 211, 153, 0.30)');
          gradient.addColorStop(0.4, 'rgba(52, 211, 153, 0.10)');
          gradient.addColorStop(1, 'rgba(52, 211, 153, 0)');
          return gradient;
        },
        fill: true,
        tension: 0.35,
        hidden: false,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: CHART_PALETTE[3],
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2
      }
    ],
  };  // Chart common options
  chartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { 
      duration: 600,
      easing: 'easeOutQuart'
    },
    transitions: {
      active: {
        animation: {
          duration: 400
        }
      },
      resize: {
        animation: {
          duration: 0
        }
      }
    },
    layout: {
      padding: {
        top: 4,
        right: 8,
        bottom: 0,
        left: 0
      }
    },
    scales: {
      x: { 
        display: true,
        ticks: {
          maxTicksLimit: 8,
          color: this.themeColors.axis(),
          font: {
            size: 10,
            family: "'Inter', system-ui, sans-serif"
          },
          padding: 6
        },
        grid: {
          color: this.themeColors.grid(),
          drawTicks: false
        },
        border: {
          display: false
        }
      },
      y: {
        display: true,
        ticks: {
          color: this.themeColors.axis(),
          font: {
            size: 10,
            family: "'Inter', system-ui, sans-serif"
          },
          padding: 12,
          maxTicksLimit: 6,
          callback: function(value: any) {
            return typeof value === 'number' ? value.toFixed(2) : value;
          }
        },
        grid: {
          color: this.themeColors.grid(),
          drawTicks: false
        },
        border: {
          display: false
        }
      }
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        backgroundColor: this.themeColors.tooltipBg(),
        titleColor: this.themeColors.tooltipText(),
        bodyColor: this.themeColors.tooltipMuted(),
        borderColor: this.themeColors.tooltipBorder(),
        borderWidth: 1,
        cornerRadius: 12,
        padding: 14,
        titleFont: {
          size: 11,
          family: "'Inter', system-ui, sans-serif",
          weight: '600' as any
        },
        bodyFont: {
          size: 11,
          family: "'Inter', system-ui, sans-serif",
          weight: '400' as any
        },
        boxPadding: 6,
        usePointStyle: true,
        titleMarginBottom: 8,
        displayColors: true,
        caretSize: 6,
        caretPadding: 8,
        callbacks: {
          label: function(context) {
            const label = context.dataset.label || '';
            const val = context.parsed.y;
            if (val === null || val === undefined) return label;
            return ' ' + label + ': ' + val.toFixed(3);
          }
        }
      },
      annotation: {
        annotations: {}
      }
    },
    interaction: {
      mode: 'nearest',
      axis: 'x',
      intersect: false
    },
    elements: {
      point: {
        radius: 0,
        hoverRadius: 5,
        hitRadius: 20,
        borderWidth: 2,
        backgroundColor: 'rgba(255, 255, 255, 0.95)'
      },
      line: {
        borderWidth: 2.5,
        tension: 0.35,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        fill: true
      }
    }
  };
    // Frequency chart specific options
  frequencyChartOptions: ChartConfiguration<'line'>['options'] = {
    ...this.chartOptions,
    scales: {
      ...this.chartOptions?.scales,
      ['y']: {
        ...this.chartOptions?.scales?.['y'],
        ticks: {
          maxTicksLimit: 8,
          color: this.themeColors.axis(),
          font: {
            size: 10,
            family: "'Inter', system-ui, sans-serif"
          },
          padding: 12,
          callback: function(value: any) {
            return typeof value === 'number' ? value.toFixed(2) : value;
          }
        },
        grid: {
          color: this.themeColors.grid(),
          drawTicks: false
        }
      }
    },
    plugins: {
      ...this.chartOptions?.plugins,
      legend: {
        display: false
      },
      annotation: {
        annotations: {
          // Frekans için eşik çizgileri burada dinamik olarak eklenecek
        }
      }
    }
  };
  
  // Abonelikleri takip etmek için
  private subscriptions: Subscription[] = [];
  
  // Inject DataService to get test data
  constructor(private dataService: DataService, private translate: TranslateService, private themeColors: ThemeColors) {
    Chart.register(annotationPlugin);
  }
  ngOnInit() {
    // Eşik çizgilerini ekle
    this.setupThresholdAnnotations();

    // SYS'ten geçmiş veriyi yükle
    this.dataService.loadInitialDataFromApi(this.historyMinutes);

    // Subscribe to voltage data
    this.subscriptions.push(
      this.dataService.getLatestVoltageData(60).subscribe((data: VoltageData[]) => {
        this.latestVoltageData = data;
        this.updateVoltageChart(data);
      })
    );

    // Subscribe to frequency data
    this.subscriptions.push(
      this.dataService.getLatestFrequencyData(120).subscribe((data: FrequencyData[]) => {
        this.latestFrequencyData = data;
        this.updateFrequencyChart(data);
      })
    );
  }
  
  // Eşik çizgilerini ayarla
  setupThresholdAnnotations(): void {
    if (!this.chartOptions || !this.chartOptions.plugins) return;
    
    // Voltage chart için eşik çizgileri
    if (this.chartOptions.plugins.annotation && this.voltageThresholds) {
      const annotations: any = {};
      
      // Uyarı eşiği
      if (this.voltageThresholds.warning) {
        annotations['voltageWarning'] = {
          type: 'line',
          yMin: this.voltageThresholds.warning,
          yMax: this.voltageThresholds.warning,
          borderColor: STATUS.warning + 'B3',
          borderWidth: 2,
          borderDash: [5, 5],
          label: {
            display: true,
            content: `Uyarı: ${this.voltageThresholds.warning}${this.voltageThresholds.unit || ''}`,
            position: 'end',
            backgroundColor: STATUS.warning + 'CC',
            color: 'black',
            font: {
              size: 10,
              style: 'bold'
            },
            padding: 4
          }
        };
      }
      
      // Tehlike eşiği
      if (this.voltageThresholds.danger) {
        annotations['voltageDanger'] = {
          type: 'line',
          yMin: this.voltageThresholds.danger,
          yMax: this.voltageThresholds.danger,
          borderColor: STATUS.danger + 'B3',
          borderWidth: 2,
          label: {
            display: true,
            content: `Kritik: ${this.voltageThresholds.danger}${this.voltageThresholds.unit || ''}`,
            position: 'end',
            backgroundColor: STATUS.danger + 'CC',
            color: 'white',
            font: {
              size: 10,
              style: 'bold'
            },
            padding: 4
          }
        };
      }
      
      // Annotationları ekle
      (this.chartOptions.plugins.annotation as any).annotations = annotations;
    }
    
    // Frequency chart için eşik çizgileri
    if (this.frequencyChartOptions?.plugins?.annotation && this.frequencyThresholds) {
      const annotations: any = {};
      
      // Frekans alt uyarı eşiği (49.5Hz)
      if (this.frequencyThresholds.warning) {
        annotations['freqWarningLower'] = {
          type: 'line',
          yMin: 49.5,
          yMax: 49.5,
          borderColor: STATUS.warning + 'B3',
          borderWidth: 2,
          borderDash: [5, 5],
          label: {
            display: true,
            content: 'Min: 49.5Hz',
            position: 'start',
            backgroundColor: STATUS.warning + 'CC',
            color: 'black',
            font: {
              size: 10,
              style: 'bold'
            },
            padding: 4
          }
        };
        
        // Frekans üst uyarı eşiği
        annotations['freqWarningUpper'] = {
          type: 'line',
          yMin: this.frequencyThresholds.warning,
          yMax: this.frequencyThresholds.warning,
          borderColor: STATUS.warning + 'B3',
          borderWidth: 2,
          borderDash: [5, 5],
          label: {
            display: true,
            content: `Maks: ${this.frequencyThresholds.warning}Hz`,
            position: 'end',
            backgroundColor: STATUS.warning + 'CC',
            color: 'black',
            font: {
              size: 10,
              style: 'bold'
            },
            padding: 4
          }
        };
      }
      
      // Frekans normal aralık bölgesi
      annotations['freqNormalZone'] = {
        type: 'box',
        yMin: 49.5,
        yMax: 50.5,
        backgroundColor: 'rgba(75, 192, 192, 0.05)',
        borderColor: 'rgba(75, 192, 192, 0.1)',
        borderWidth: 1,
        drawTime: 'beforeDatasetsDraw'
      };
      
      // Frekans tehlike eşiği
      if (this.frequencyThresholds.danger) {
        annotations['freqDanger'] = {
          type: 'line',
          yMin: this.frequencyThresholds.danger,
          yMax: this.frequencyThresholds.danger,
          borderColor: STATUS.danger + 'B3',
          borderWidth: 2,
          label: {
            display: true,
            content: `Kritik: ${this.frequencyThresholds.danger}Hz`,
            position: 'end',
            backgroundColor: STATUS.danger + 'CC',
            color: 'white',
            font: {
              size: 10,
              style: 'bold'
            },
            padding: 4
          }
        };
      }
      
      // Annotationları ekle
      (this.frequencyChartOptions.plugins.annotation as any).annotations = annotations;
    }
  }  ngOnDestroy() {
    // Clean up subscriptions to prevent memory leaks
    this.subscriptions.forEach((sub: Subscription) => sub.unsubscribe());
  }
  // Toggle phase visibility
  togglePhaseVisibility(phaseIndex: number): void {
    switch (phaseIndex) {
      case 0:
        this.phaseAVisible = !this.phaseAVisible;
        if (this.voltageChartRef && this.voltageChartRef.chart) {
          this.voltageChartRef.chart.data.datasets[0].hidden = !this.phaseAVisible;
        } else {
          this.voltageChartData.datasets[0].hidden = !this.phaseAVisible;
        }
        break;
      case 1:
        this.phaseBVisible = !this.phaseBVisible;
        if (this.voltageChartRef && this.voltageChartRef.chart) {
          this.voltageChartRef.chart.data.datasets[1].hidden = !this.phaseBVisible;
        } else {
          this.voltageChartData.datasets[1].hidden = !this.phaseBVisible;
        }
        break;
      case 2:
        this.phaseCVisible = !this.phaseCVisible;
        if (this.voltageChartRef && this.voltageChartRef.chart) {
          this.voltageChartRef.chart.data.datasets[2].hidden = !this.phaseCVisible;
        } else {
          this.voltageChartData.datasets[2].hidden = !this.phaseCVisible;
        }
        break;
    }

    // Update chart to reflect visibility changes without redrawing completely
    if (this.voltageChartRef && this.voltageChartRef.chart) {
      this.voltageChartRef.chart.update();
    }
  }
  // Toggle frequency visibility
  toggleFrequencyVisibility(): void {
    this.frequencyVisible = !this.frequencyVisible;
    
    // Doğrudan çizilen grafikteki veriyi güncelle (eğer varsa)
    if (this.frequencyChartRef && this.frequencyChartRef.chart) {
      this.frequencyChartRef.chart.data.datasets[0].hidden = !this.frequencyVisible;
      // Görünürlük değişikliğini yansıtmak için grafiği güncelle (tümüyle yeniden çizmeden)
      this.frequencyChartRef.chart.update();
    } else {
      // Grafik henüz çizilmemişse, veri modelini güncelle
      this.frequencyChartData.datasets[0].hidden = !this.frequencyVisible;
    }
  }
  // Update chart with voltage data
  private updateVoltageChart(data: VoltageData[]) {
    if (!data || data.length === 0) return;

    const MAX_POINTS = 120;

    const formatTime = (ts: any) => {
      const d = new Date(ts);
      return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    };

    // Bulk data geldi mi? (ilk seed veya yeni veri sayısı > 2)
    const isBulkLoad = !this.voltageSeeded || (data.length - this.lastVoltageCount) > 2;
    this.lastVoltageCount = data.length;

    if (isBulkLoad) {
      // İlk yükleme veya bulk: tüm veriyi çiz
      this.voltageSeeded = true;
      const labels = data.map(item => formatTime(item.timestamp));
      const phaseA = data.map(item => item.phase_a);
      const phaseB = data.map(item => item.phase_b);
      const phaseC = data.map(item => item.phase_c);

      const hiddenA = this.voltageChartData.datasets[0].hidden;
      const hiddenB = this.voltageChartData.datasets[1].hidden;
      const hiddenC = this.voltageChartData.datasets[2].hidden;

      if (this.voltageChartRef?.chart) {
        const chart = this.voltageChartRef.chart;
        chart.data.labels = labels;
        chart.data.datasets[0].data = phaseA;
        chart.data.datasets[1].data = phaseB;
        chart.data.datasets[2].data = phaseC;
        chart.data.datasets[0].hidden = hiddenA;
        chart.data.datasets[1].hidden = hiddenB;
        chart.data.datasets[2].hidden = hiddenC;
        chart.update('none');
      } else {
        this.voltageChartData = {
          labels,
          datasets: [
            { ...this.voltageChartData.datasets[0], data: phaseA, hidden: hiddenA },
            { ...this.voltageChartData.datasets[1], data: phaseB, hidden: hiddenB },
            { ...this.voltageChartData.datasets[2], data: phaseC, hidden: hiddenC }
          ]
        };
      }
      return;
    }

    // Tek nokta realtime ekleme
    if (!this.voltageChartRef?.chart) return;
    const chart = this.voltageChartRef.chart;
    const lastData = data[data.length - 1];

    if (chart.data?.labels && chart.data?.datasets) {
      chart.data.labels.push(formatTime(lastData.timestamp));
      chart.data.datasets[0].data.push(lastData.phase_a);
      chart.data.datasets[1].data.push(lastData.phase_b);
      chart.data.datasets[2].data.push(lastData.phase_c);

      if (chart.data.labels.length > MAX_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(ds => ds.data.shift());
      }

      chart.update('active');
    }
  }
  // Update chart with frequency data
  private updateFrequencyChart(data: FrequencyData[]) {
    if (!data || data.length === 0) return;

    const MAX_POINTS = 120;

    const formatTime = (ts: any) => {
      const d = new Date(ts);
      return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    };

    const isBulkLoad = !this.frequencySeeded || (data.length - this.lastFrequencyCount) > 2;
    this.lastFrequencyCount = data.length;

    if (isBulkLoad) {
      this.frequencySeeded = true;
      const labels = data.map(item => formatTime(item.timestamp));
      const values = data.map(item => item.value);
      const hiddenState = this.frequencyChartData.datasets[0].hidden;

      if (this.frequencyChartRef?.chart) {
        const chart = this.frequencyChartRef.chart;
        chart.data.labels = labels;
        chart.data.datasets[0].data = values;
        chart.data.datasets[0].hidden = hiddenState;
        chart.update('none');
      } else {
        this.frequencyChartData = {
          labels,
          datasets: [
            { ...this.frequencyChartData.datasets[0], data: values, hidden: hiddenState }
          ]
        };
      }
      return;
    }

    // Tek nokta realtime ekleme
    if (!this.frequencyChartRef?.chart) return;
    const chart = this.frequencyChartRef.chart;
    const lastData = data[data.length - 1];

    if (chart.data?.labels && chart.data?.datasets?.[0]) {
      chart.data.labels.push(formatTime(lastData.timestamp));
      chart.data.datasets[0].data.push(lastData.value);

      if (chart.data.labels.length > MAX_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
      }

      chart.update('active');
    }
  }
  
  // Ayarlar diyaloğunu açma
  openSettingsDialog(type: 'voltage' | 'frequency'): void {
    this.currentDialogType = type;
    
    // Geçici olarak mevcut ayarları kopyala
    if (type === 'voltage') {
      this.tempVoltageThresholds = { ...this.voltageThresholds };
    } else {
      this.tempFrequencyThresholds = { ...this.frequencyThresholds };
    }
    
    // Diyaloğu aç
    this.isSettingsDialogOpen = true;
  }
  
  // Ayarlar diyaloğunu kapatma
  closeSettingsDialog(): void {
    this.isSettingsDialogOpen = false;
    
    // Yapılan değişiklikleri iptal et
    this.tempVoltageThresholds = { ...this.voltageThresholds };
    this.tempFrequencyThresholds = { ...this.frequencyThresholds };
  }
  
  // Tam ekran modunu açma
  toggleFullscreen(type: 'voltage' | 'frequency'): void {
    this.currentFullscreenType = type;
    this.isFullscreenActive = !this.isFullscreenActive;
    
    // Tam ekran olunca animasyonu güncelle
    if (this.isFullscreenActive) {
      this.setupFullscreenAnnotations();
    }
  }
  
  // Tam ekran modunu kapatma
  closeFullscreen(): void {
    this.isFullscreenActive = false;
  }
  
  // Tam ekran modunda eşik çizgilerini ayarla
  setupFullscreenAnnotations(): void {
    if (!this.fullscreenChartOptions || !this.fullscreenChartOptions.plugins) return;
    
    if (this.fullscreenChartOptions.plugins.annotation) {
      if (this.currentFullscreenType === 'voltage') {
        const annotations: any = {};
        
        // Uyarı eşiği
        if (this.voltageThresholds.warning) {
          annotations['voltageWarning'] = {
            type: 'line',
            yMin: this.voltageThresholds.warning,
            yMax: this.voltageThresholds.warning,
            borderColor: STATUS.warning + 'B3',
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
              display: true,
              content: `Uyarı: ${this.voltageThresholds.warning}${this.voltageThresholds.unit || ''}`,
              position: 'end',
              backgroundColor: STATUS.warning + 'CC',
              color: 'black',
              font: { size: 12, style: 'bold' },
              padding: 6
            }
          };
        }
        
        // Tehlike eşiği
        if (this.voltageThresholds.danger) {
          annotations['voltageDanger'] = {
            type: 'line',
            yMin: this.voltageThresholds.danger,
            yMax: this.voltageThresholds.danger,
            borderColor: STATUS.danger + 'B3',
            borderWidth: 2,
            label: {
              display: true,
              content: `Kritik: ${this.voltageThresholds.danger}${this.voltageThresholds.unit || ''}`,
              position: 'end',
              backgroundColor: STATUS.danger + 'CC',
              color: 'white',
              font: { size: 12, style: 'bold' },
              padding: 6
            }
          };
        }
        
        // Annotationları ekle
        (this.fullscreenChartOptions.plugins.annotation as any).annotations = annotations;
      } else {
        // Frekans için tam ekran modu annotationları
        const annotations: any = {};
        
        // Frekans alt uyarı eşiği (49.5Hz)
        annotations['freqWarningLower'] = {
          type: 'line',
          yMin: 49.5,
          yMax: 49.5,
          borderColor: STATUS.warning + 'B3',
          borderWidth: 2,
          borderDash: [5, 5],
          label: {
            display: true,
            content: 'Min: 49.5Hz',
            position: 'start',
            backgroundColor: STATUS.warning + 'CC',
            color: 'black',
            font: { size: 12, style: 'bold' },
            padding: 6
          }
        };
        
        // Frekans üst uyarı eşiği
        if (this.frequencyThresholds.warning) {
          annotations['freqWarningUpper'] = {
            type: 'line',
            yMin: this.frequencyThresholds.warning,
            yMax: this.frequencyThresholds.warning,
            borderColor: STATUS.warning + 'B3',
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
              display: true,
              content: `Maks: ${this.frequencyThresholds.warning}Hz`,
              position: 'end',
              backgroundColor: STATUS.warning + 'CC',
              color: 'black',
              font: { size: 12, style: 'bold' },
              padding: 6
            }
          };
        }
        
        // Frekans normal aralık bölgesi
        annotations['freqNormalZone'] = {
          type: 'box',
          yMin: 49.5,
          yMax: 50.5,
          backgroundColor: 'rgba(75, 192, 192, 0.05)',
          borderColor: 'rgba(75, 192, 192, 0.1)',
          borderWidth: 1,
          drawTime: 'beforeDatasetsDraw'
        };
        
        // Frekans tehlike eşiği
        if (this.frequencyThresholds.danger) {
          annotations['freqDanger'] = {
            type: 'line',
            yMin: this.frequencyThresholds.danger,
            yMax: this.frequencyThresholds.danger,
            borderColor: STATUS.danger + 'B3',
            borderWidth: 2,
            label: {
              display: true,
              content: `Kritik: ${this.frequencyThresholds.danger}Hz`,
              position: 'end',
              backgroundColor: STATUS.danger + 'CC',
              color: 'white',
              font: { size: 12, style: 'bold' },
              padding: 6
            }
          };
        }
        
        // Annotationları ekle
        (this.fullscreenChartOptions.plugins.annotation as any).annotations = annotations;
      }
    }
  }
  
  // Ayarları kaydetme
  saveSettings(): void {
    // Güncel ekran türüne göre ayarları uygula
    if (this.currentDialogType === 'voltage') {
      this.voltageThresholds = { ...this.tempVoltageThresholds };
    } else {
      this.frequencyThresholds = { ...this.tempFrequencyThresholds };
    }
    
    // Animasyon süresini güncelle
    if (this.chartOptions && this.chartOptions.animation) {
      this.chartOptions.animation.duration = this.animationDuration;
    }
    
    if (this.frequencyChartOptions && this.frequencyChartOptions.animation) {
      this.frequencyChartOptions.animation.duration = this.animationDuration;
    }
    
    if (this.fullscreenChartOptions && this.fullscreenChartOptions.animation) {
      this.fullscreenChartOptions.animation.duration = this.animationDuration;
    }
    
    // Noktaları görünürlüğünü ayarla
    if (this.chartOptions && this.chartOptions.elements && this.chartOptions.elements.point) {
      this.chartOptions.elements.point.radius = this.showDataPoints ? 3 : 0;
    }
    
    if (this.frequencyChartOptions && this.frequencyChartOptions.elements && this.frequencyChartOptions.elements.point) {
      this.frequencyChartOptions.elements.point.radius = this.showDataPoints ? 3 : 0;
    }
    
    // Eşik çizgilerini güncelle
    this.setupThresholdAnnotations();
    
    // historyMinutes değiştiyse SYS'ten yeniden veri çek
    this.dataService.loadInitialDataFromApi(this.historyMinutes);
    
    // Grafikleri güncelle
    if (this.voltageChartRef) {
      this.voltageChartRef.chart?.update();
    }
    
    if (this.frequencyChartRef) {
      this.frequencyChartRef.chart?.update();
    }
    
    // Diyaloğu kapat
    this.isSettingsDialogOpen = false;
  }
  
  // Eşik değerlerini güncelleme
  updateThresholdValue(event: Event, type: 'warning' | 'danger'): void {
    const inputElement = event.target as HTMLInputElement;
    const value = parseFloat(inputElement.value);
    
    if (!isNaN(value)) {
      if (this.currentDialogType === 'voltage') {
        this.tempVoltageThresholds[type] = value;
      } else {
        this.tempFrequencyThresholds[type] = value;
      }
    }
  }
    // Path seçici diyaloğunu açma
  openPathSelector(): void {
    // İsPathSelectorDialogOpen değişkenini true yaparak modal'ı açıyoruz
    this.isPathSelectorDialogOpen = true;
    
    // Örnek veri yollarını başlangıç olarak ayarlayalım
    this.availablePaths = [
      { id: 1, path: 'Enerji/Trafo/Gerilim/L1', isSelected: false },
      { id: 2, path: 'Enerji/Trafo/Gerilim/L2', isSelected: false },
      { id: 3, path: 'Enerji/Trafo/Gerilim/L3', isSelected: false },
      { id: 4, path: 'Enerji/Trafo/Akım/L1', isSelected: false },
      { id: 5, path: 'Enerji/Trafo/Akım/L2', isSelected: false },
      { id: 6, path: 'Enerji/Trafo/Akım/L3', isSelected: false },
      { id: 7, path: 'Enerji/Trafo/Frekans', isSelected: false },
      { id: 8, path: 'Enerji/Trafo/Güç/Aktif', isSelected: false },
      { id: 9, path: 'Enerji/Trafo/Güç/Reaktif', isSelected: false },
      { id: 10, path: 'Enerji/Trafo/Güç/Görünür', isSelected: false }
    ];
    
    // Mevcut seçilmiş yolları işaretleyelim (örnek olarak)
    if (this.selectedPaths.length > 0) {
      this.selectedPaths.forEach(selectedPath => {
        const matchedPath = this.availablePaths.find(p => p.path === selectedPath);
        if (matchedPath) {
          matchedPath.isSelected = true;
        }
      });
    }
    
    ////console.log('Path selector açıldı, toplam yol sayısı:', this.availablePaths.length);
  }
  
  // Path seçici diyaloğunu kapatma
  closePathSelector(): void {
    this.isPathSelectorDialogOpen = false;
  }
  
  // Path seçimini güncelleme
  togglePathSelection(path: PathItem): void {
    path.isSelected = !path.isSelected;
  }
  
  // Seçilen path'leri kaydetme
  savePathSelection(): void {
    // Seçilen yolları filtreleme ve kaydetme
    this.selectedPaths = this.availablePaths
      .filter(path => path.isSelected)
      .map(path => path.path);
    
    // Seçim sonucunu konsola yazdıralım
    ////console.log('Seçilen veri yolları:', this.selectedPaths);
    
    // Eşik değerlerini güncelle
    if (this.currentDialogType === 'voltage') {
      this.tempVoltageThresholds = {
        warning: 235,
        danger: 245,
        unit: 'V'
      };
    } else {
      this.tempFrequencyThresholds = {
        warning: 50.5,
        danger: 51.0,
        unit: 'Hz'
      };
    }
    
    // Kullanıcıya seçimin başarılı olduğunu bildir
    this.pathSelectionSuccess = true;
    setTimeout(() => {
      this.pathSelectionSuccess = false;
    }, 3000);
    
    // Modal'ı kapat
    this.closePathSelector();
  }

  // Seçilen veri yollarının sayısını döndüren getter
  get selectedPathsCount(): number {
    return this.availablePaths.filter(p => p.isSelected).length;
  }
  
  // Seçilen veri yollarını döndüren getter
  get selectedPathItems(): PathItem[] {
    return this.availablePaths.filter(p => p.isSelected);
  }
  
  // Path seçili mi kontrolü
  isPathSelected(path: PathItem): boolean {
    return path.isSelected;
  }
}
