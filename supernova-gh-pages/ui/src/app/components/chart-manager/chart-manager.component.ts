import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { TranslateService } from '@ngx-translate/core';
import { CHART_PALETTE_EXT, BRAND } from '../../shared/theme/palette';
import { ThemeColors } from '../../shared/theme/theme-colors';

export interface ChartSeries {
  id: string;
  pathIndex: number;
  pathLabel: string;
  yColumn: string;
  color: string;
  lineStyle: 'solid' | 'dashed' | 'dotted';
}

export interface ChartConfiguration {
  id: string;
  enabled: boolean;
  title: string;
  type: 'line' | 'bar' | 'scatter' | 'area' | 'pie';
  x_axis: string;
  y_axis: string;
  point_name_filter: string;
  color: string;
  series?: ChartSeries[];
  showLegend?: boolean;
  showGrid?: boolean;
  position?: {
    sheet?: string;
    row?: number;
    col?: number;
    width?: number;
    height?: number;
  };
}

export interface PathInfo {
  index: number;
  path: string;
  label: string;
  source: string;
  columns: string[];
  numericColumns: string[];
}

export interface ReportAnalysis {
  available_columns: string[];
  column_types: { [key: string]: string };
  sample_data: any[];
  total_records: number;
}

@Component({
  standalone: false,
  selector: 'app-chart-manager',
  templateUrl: './chart-manager.component.html',
  styleUrls: ['./chart-manager.component.scss']
})
export class ChartManagerComponent implements OnInit, OnChanges, AfterViewChecked {
  @Input() reportId: string = '';
  @Input() isVisible: boolean = false;
  @Input() reportAnalysis: ReportAnalysis | null = null;
  @Input() selectedColumns: string[] = [];
  @Input() availablePaths: PathInfo[] = [];
  @Input() existingCharts: ChartConfiguration[] = [];
  @Output() chartConfigUpdated = new EventEmitter<ChartConfiguration[]>();
  @Output() closeManager = new EventEmitter<void>();

  @ViewChild('previewCanvas') previewCanvas!: ElementRef<HTMLCanvasElement>;

  charts: ChartConfiguration[] = [];
  activeChartIndex: number = 0;
  loading: boolean = false;
  needsRedraw: boolean = false;

  // Column data
  numericColumns: string[] = [];
  timeColumns: string[] = [];

  // Chart types
  chartTypes = [
    { value: 'line', icon: '📈', labelKey: 'REPORTS.CHART_TYPE_LINE' },
    { value: 'bar', icon: '📊', labelKey: 'REPORTS.CHART_TYPE_BAR' },
    { value: 'scatter', icon: '⚫', labelKey: 'REPORTS.CHART_TYPE_SCATTER' },
    { value: 'area', icon: '🌄', labelKey: 'REPORTS.CHART_TYPE_AREA' }
  ];

  // Color palette for series
  seriesColors = [...CHART_PALETTE_EXT];

  constructor(private apiService: ApiService, private translate: TranslateService, private themeColors: ThemeColors) {}

  ngOnInit() {
    this.classifyColumns();
    if (this.existingCharts?.length) {
      this.charts = JSON.parse(JSON.stringify(this.existingCharts));
      this.activeChartIndex = 0;
    } else if (this.charts.length === 0) {
      this.addNewChart();
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['reportAnalysis'] || changes['selectedColumns']) {
      this.classifyColumns();
    }
    if (changes['availablePaths'] && this.availablePaths?.length > 0 && this.charts.length === 0) {
      this.addNewChart();
    }
  }

  ngAfterViewChecked() {
    if (this.needsRedraw) {
      this.needsRedraw = false;
      this.drawPreview();
    }
  }

  classifyColumns() {
    const cols = this.selectedColumns || this.reportAnalysis?.available_columns || [];
    this.timeColumns = cols.filter(c => {
      const u = c.toUpperCase();
      return u.includes('TIME') || u.includes('DATE') || u.includes('TIMESTAMP');
    });
    this.numericColumns = cols.filter(c => {
      const u = c.toUpperCase();
      return u.includes('VALUE') || u.includes('AVG') || u.includes('MAX') ||
             u.includes('MIN') || u.includes('INT') || u.includes('COUNT') ||
             u.includes('SUM') || u.includes('POWER') || u.includes('ENERGY') ||
             u.includes('VOLTAGE') || u.includes('CURRENT') || u.includes('FREQ') ||
             u.includes('TEMP') || u.includes('PRESSURE') || u.includes('FLOW') ||
             u.includes('LEVEL') || u.includes('QUALITY');
    });
  }

  get activeChart(): ChartConfiguration | null {
    return this.charts[this.activeChartIndex] || null;
  }

  getColumnsForPath(pathIndex: number): string[] {
    const p = this.availablePaths.find(pp => pp.index === pathIndex);
    return p?.columns?.length ? p.columns : this.selectedColumns;
  }

  getNumericColumnsForPath(pathIndex: number): string[] {
    const cols = this.getColumnsForPath(pathIndex);
    return cols.filter(c => {
      const u = c.toUpperCase();
      return u.includes('VALUE') || u.includes('AVG') || u.includes('MAX') ||
             u.includes('MIN') || u.includes('INT') || u.includes('COUNT') ||
             u.includes('SUM') || u.includes('POWER') || u.includes('ENERGY') ||
             u.includes('VOLTAGE') || u.includes('CURRENT') || u.includes('FREQ') ||
             u.includes('TEMP') || u.includes('PRESSURE') || u.includes('FLOW') ||
             u.includes('LEVEL');
    });
  }

  getTimeColumnsForPath(pathIndex: number): string[] {
    const cols = this.getColumnsForPath(pathIndex);
    return cols.filter(c => {
      const u = c.toUpperCase();
      return u.includes('TIME') || u.includes('DATE') || u.includes('TIMESTAMP');
    });
  }

  addNewChart() {
    const xAxis = this.timeColumns[0] || this.selectedColumns[0] || '';
    const yAxis = this.numericColumns[0] || this.selectedColumns[1] || '';
    const firstPath = this.availablePaths[0];

    const newChart: ChartConfiguration = {
      id: this.generateId(),
      enabled: true,
      title: `${this.translate.instant('REPORTS.CHART_LABEL')} ${this.charts.length + 1}`,
      type: 'line',
      x_axis: xAxis,
      y_axis: yAxis,
      point_name_filter: '',
      color: this.seriesColors[0],
      showLegend: true,
      showGrid: true,
      series: firstPath ? [{
        id: this.generateId(),
        pathIndex: firstPath.index,
        pathLabel: firstPath.label,
        yColumn: yAxis,
        color: this.seriesColors[0],
        lineStyle: 'solid'
      }] : [],
      position: {
        row: 2 + (this.charts.length * 22),
        col: 1,
        width: 12,
        height: 20
      }
    };

    this.charts.push(newChart);
    this.activeChartIndex = this.charts.length - 1;
    this.scheduleRedraw();
    this.emitUpdate();
  }

  removeChart(index: number) {
    this.charts.splice(index, 1);
    if (this.activeChartIndex >= this.charts.length) {
      this.activeChartIndex = Math.max(0, this.charts.length - 1);
    }
    this.scheduleRedraw();
    this.emitUpdate();
  }

  duplicateChart(index: number) {
    const orig = this.charts[index];
    const dup: ChartConfiguration = {
      ...JSON.parse(JSON.stringify(orig)),
      id: this.generateId(),
      title: `${orig.title} (${this.translate.instant('REPORTS.COPY')})`,
      position: { ...orig.position, row: (orig.position?.row || 0) + 22 }
    };
    if (dup.series) {
      dup.series.forEach((s: ChartSeries) => s.id = this.generateId());
    }
    this.charts.splice(index + 1, 0, dup);
    this.activeChartIndex = index + 1;
    this.scheduleRedraw();
    this.emitUpdate();
  }

  selectChart(index: number) {
    this.activeChartIndex = index;
    this.scheduleRedraw();
  }

  // Series management
  addSeries() {
    const chart = this.activeChart;
    if (!chart) return;
    if (!chart.series) chart.series = [];

    // pick next unused path, fallback to first
    const usedPaths = new Set(chart.series.map(s => s.pathIndex));
    const nextPath = this.availablePaths.find(p => !usedPaths.has(p.index)) || this.availablePaths[0];
    if (!nextPath) return;

    const cols = this.getNumericColumnsForPath(nextPath.index);
    chart.series.push({
      id: this.generateId(),
      pathIndex: nextPath.index,
      pathLabel: nextPath.label,
      yColumn: cols[0] || this.numericColumns[0] || '',
      color: this.seriesColors[chart.series.length % this.seriesColors.length],
      lineStyle: 'solid'
    });
    this.scheduleRedraw();
    this.emitUpdate();
  }

  removeSeries(seriesIndex: number) {
    const chart = this.activeChart;
    if (!chart?.series) return;
    chart.series.splice(seriesIndex, 1);
    this.scheduleRedraw();
    this.emitUpdate();
  }

  onSeriesPathChange(series: ChartSeries) {
    const p = this.availablePaths.find(pp => pp.index === series.pathIndex);
    series.pathLabel = p?.label || '';
    // auto-select first numeric column for that path
    const numCols = this.getNumericColumnsForPath(series.pathIndex);
    if (numCols.length > 0 && !numCols.includes(series.yColumn)) {
      series.yColumn = numCols[0];
    }
    this.scheduleRedraw();
    this.emitUpdate();
  }

  onConfigChange() {
    // sync first series color with chart.color for backward compat
    const chart = this.activeChart;
    if (chart?.series?.length) {
      chart.color = chart.series[0].color;
      chart.y_axis = chart.series[0].yColumn;
    }
    this.scheduleRedraw();
    this.emitUpdate();
  }

  emitUpdate() {
    this.chartConfigUpdated.emit(this.charts);
  }

  saveAndClose() {
    this.emitUpdate();
    setTimeout(() => this.closeManager.emit(), 200);
  }

  closeChartManager() {
    this.closeManager.emit();
  }

  // ── Preview Drawing ──
  scheduleRedraw() {
    this.needsRedraw = true;
  }

  drawPreview() {
    const canvas = this.previewCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const chart = this.activeChart;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    // Background
    ctx.fillStyle = this.themeColors.read('--bg-elevated');
    ctx.fillRect(0, 0, w, h);

    if (!chart) return;

    const pad = { top: 30, right: 20, bottom: 40, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Grid
    if (chart.showGrid !== false) {
      ctx.strokeStyle = this.themeColors.read('--border-color');
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const y = pad.top + (plotH / 5) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
      }
      for (let i = 0; i <= 6; i++) {
        const x = pad.left + (plotW / 6) * i;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
      }
    }

    // Axes
    ctx.strokeStyle = this.themeColors.grid();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = this.themeColors.read('--text-muted');
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(chart.x_axis || 'X', pad.left + plotW / 2, h - 8);
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(chart.y_axis || 'Y', 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = this.themeColors.read('--text-primary');
    ctx.font = 'bold 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(chart.title || '', w / 2, 18);

    // Draw series
    const series = chart.series?.length ? chart.series : [{ color: chart.color || BRAND.primary, lineStyle: 'solid' as const }];
    const numPoints = 20;

    series.forEach((s, sIdx) => {
      // generate mock data
      const points: { x: number; y: number }[] = [];
      const seed = sIdx * 137 + 42;
      for (let i = 0; i < numPoints; i++) {
        const x = pad.left + (plotW / (numPoints - 1)) * i;
        const noise = Math.sin(i * 0.8 + seed) * 0.3 + Math.cos(i * 0.4 + seed * 0.7) * 0.2;
        const base = 0.3 + sIdx * 0.15;
        const yVal = pad.top + plotH * (1 - (base + noise * 0.4));
        points.push({ x, y: Math.max(pad.top, Math.min(pad.top + plotH, yVal)) });
      }

      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = 2;

      if (s.lineStyle === 'dashed') ctx.setLineDash([6, 4]);
      else if (s.lineStyle === 'dotted') ctx.setLineDash([2, 3]);
      else ctx.setLineDash([]);

      if (chart.type === 'line' || chart.type === 'scatter') {
        if (chart.type === 'line') {
          ctx.beginPath();
          points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.stroke();
        }
        if (chart.type === 'scatter' || chart.type === 'line') {
          points.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, chart.type === 'scatter' ? 4 : 2.5, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      } else if (chart.type === 'area') {
        ctx.beginPath();
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        // fill
        const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        gradient.addColorStop(0, s.color + '40');
        gradient.addColorStop(1, s.color + '05');
        ctx.lineTo(points[points.length - 1].x, pad.top + plotH);
        ctx.lineTo(points[0].x, pad.top + plotH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.fillStyle = s.color;
      } else if (chart.type === 'bar') {
        const barW = (plotW / numPoints) * 0.6 / series.length;
        const offset = sIdx * barW;
        points.forEach(p => {
          const barH = pad.top + plotH - p.y;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(p.x - barW * series.length / 2 + offset, p.y, barW, barH);
          ctx.globalAlpha = 1;
        });
      }

      ctx.setLineDash([]);
    });

    // Legend
    if (chart.showLegend !== false && chart.series && chart.series.length > 0) {
      const legendX = pad.left + 8;
      let legendY = pad.top + 8;
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      chart.series.forEach(s => {
        ctx.fillStyle = s.color;
        ctx.fillRect(legendX, legendY, 12, 3);
        ctx.fillStyle = this.themeColors.read('--text-muted');
        const label = s.pathLabel ? (s.pathLabel.length > 30 ? s.pathLabel.substring(0, 30) + '…' : s.pathLabel) : s.yColumn;
        ctx.fillText(label, legendX + 16, legendY + 4);
        legendY += 14;
      });
    }
  }

  // ── Helpers ──
  generateId(): string {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  }

  getChartTypeIcon(type: string): string {
    return this.chartTypes.find(t => t.value === type)?.icon || '📊';
  }

  getActiveChartsCount(): number {
    return this.charts.filter(c => c.enabled).length;
  }

  trackByChartId(_: number, chart: ChartConfiguration): string {
    return chart.id;
  }

  trackBySeriesId(_: number, series: ChartSeries): string {
    return series.id;
  }

  isRealtimePathActive(chart: any): boolean {
    if (!chart || !chart.series || !chart.series.length) return false;
    return chart.series.some((s: any) => {
      const p = this.availablePaths.find(pp => pp.index === s.pathIndex);
      return p && p.source === 'realtime';
    });
  }
}
