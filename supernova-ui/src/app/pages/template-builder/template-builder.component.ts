import { ChangeDetectorRef, Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { DomSanitizer, SafeStyle } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { QueryService } from '../../services/query.service';
import {
  TemplateBuilderService,
  TemplateSummary,
  EvaluatedTemplateResult,
  EvaluatedQueryStat,
} from '../../services/template-builder.service';
import { SavedQuery, QueryResult, QueryColumn, SavedPythonScript } from '../../models/query.model';
import { DataSource } from '../../models/data-source.model';
import { ConfirmService } from '../../services/confirm.service';
import { AiContextService } from '../../services/ai-context.service';
import { AiCoworkerService } from '../../services/ai-coworker.service';
import {
  TemplateDocument, TemplateSheet, TemplateCell, DetailBand,
  CellBinding, SummaryOperation, cellKey, createEmptyDocument, createEmptySheet,
} from '../../models/template-document.model';

/** Birleştirilmiş veri kaynağı (SQL sorgusu veya Python dataset). */
interface ActiveSource {
  id: string;
  columns: QueryColumn[];
  label: string;
  description?: string;
  kind?: 'sql' | 'python';
  dataSourceId?: string;
  /** Python ise dataset adı (hücre gösterimi için); SQL ise boş. */
  prefix?: string;
  rows?: Array<Record<string, unknown>>;
  totalRows?: number;
  executionMs?: number;
}

@Component({
  standalone: false,
  selector: 'app-template-builder',
  templateUrl: './template-builder.component.html',
  styleUrls: ['./template-builder.component.scss'],
})
export class TemplateBuilderComponent implements OnInit, OnDestroy {
  private releaseAi?: () => void;
  private releaseCoworker?: () => void;
  /** 'gallery' → şablon kütüphanesi; 'editor' → grid editör. */
  mode: 'gallery' | 'editor' = 'gallery';

  /** Düzenlenen doküman. */
  doc: TemplateDocument = createEmptyDocument();
  sheetIndex = 0;

  /** Seçim. */
  selected = { row: 1, col: 1 };
  rangeEnd: { row: number; col: number } | null = null;

  /** Sol panel: sekmeli (Sorgular / Python). */
  sideTab: 'queries' | 'python' = 'queries';
  queries: SavedQuery[] = [];
  dataSources: DataSource[] = [];
  pythonScripts: SavedPythonScript[] = [];
  sourceSearchTerm = '';

  /** Birleştirilmiş aktif kaynak — SQL veya Python dataset. */
  activeSource: ActiveSource | null = null;
  sourceLoading = false;
  showSourcePreviewModal = false;
  summaryField = '';

  /** Python preview: seçilen script'in sandbox çıktı dataset'leri. */
  activePythonId: string | null = null;
  pyPreview: Record<string, QueryResult> | null = null;
  pyError = '';
  pyLoading = false;

  /** Canlı Rapor Çalıştırma / Önizleme Modu (Dynamic Live Execution). */
  livePreviewMode = false;
  livePreviewLoading = false;
  evaluatedResult: EvaluatedTemplateResult | null = null;

  /** Şablon kütüphanesi (galeri). */
  templates: TemplateSummary[] = [];
  searchTemplates = '';

  /** Yeni sorgu formu. */
  showQueryForm = false;
  newQuery: Partial<SavedQuery> & { dataSourceId?: string } = { name: '', description: '', sql: '', dataSourceId: '' };

  /** Açılır menüler. */
  chartMenuOpen = false;

  /** Satır içi düzenleme. */
  editing: { row: number; col: number } | null = null;
  editValue = '';

  /** Sütun/satır yeniden boyutlandırma. */
  resizing: { kind: 'col' | 'row'; index: number; startX: number; startY: number; start: number } | null = null;

  busy = false;
  feedback = '';

  readonly summaryOps: SummaryOperation[] = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'STDEV', 'MEDIAN'];
  readonly chartTypes: Array<'bar' | 'line' | 'pie'> = ['bar', 'line', 'pie'];

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private queryService: QueryService,
    private templateService: TemplateBuilderService,
    private sanitizer: DomSanitizer,
    private confirmService: ConfirmService,
    private aiContext: AiContextService,
    private aiCoworker: AiCoworkerService,
    private cdr: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.releaseAi = this.aiContext.register('template-builder', {
      context: () => ({
        active_queries: this.queries.filter(q => q.id === this.activeSource?.id).map(q => ({ id: q.id, name: q.name, columns: q.columns })),
        selected_cell: this.selected, template_name: this.doc.name,
        active_sheet: { name: this.sheet.name, rowCount: this.sheet.rowCount, columnCount: this.sheet.columnCount },
      }),
      accepts: language => language === 'json' && this.mode === 'editor',
      apply: (_language, _content, artifact) => {
        if (!artifact) throw new Error('Şablon JSON doğrulanamadı.');
        // Validated fragments extend the current sheet; regenerated IDs avoid collisions.
        const incomingCharts = Array.isArray(artifact.charts) ? artifact.charts : [];
        const incomingCells = Array.isArray(artifact.cells) ? artifact.cells : [];
        const incomingBands = Array.isArray(artifact.bands) ? artifact.bands : [];
        this.sheet.charts = [...(this.sheet.charts || []), ...incomingCharts.map((chart: any) => ({ ...chart, id: `ch_${crypto.randomUUID()}` }))];
        for (const cell of incomingCells) this.sheet.cells[cellKey(cell.row, cell.col)] = cell;
        if (incomingBands.length) {
          for (const band of incomingBands) {
            const startRow = Number(band.range?.startRow || 1);
            const fmap = band.fieldMap || {};
            for (const [colStr, fieldName] of Object.entries(fmap)) {
              const colNum = Number(colStr);
              if (!colNum || !fieldName) continue;
              if (startRow > 1 && !this.sheet.cells[cellKey(startRow - 1, colNum)]) {
                this.sheet.cells[cellKey(startRow - 1, colNum)] = {
                  row: startRow - 1,
                  col: colNum,
                  value: String(fieldName),
                  style: { bold: true, bg: '#1E293B', color: '#FFFFFF', align: 'center' },
                };
              }
              if (!this.sheet.cells[cellKey(startRow, colNum)]) {
                this.sheet.cells[cellKey(startRow, colNum)] = {
                  row: startRow,
                  col: colNum,
                  value: `{{${fieldName}}}`,
                  binding: { kind: 'query_field', queryId: band.queryId, field: String(fieldName) },
                };
              }
            }
          }
          this.sheet.bands = [...(this.sheet.bands || []), ...incomingBands.map((band: any) => ({
            ...band,
            id: `bnd_${crypto.randomUUID().slice(0, 8)}`,
          }))];
        }
        const rowEnds = [
          4,
          ...incomingCells.map((cell: any) => cell.row),
          ...incomingCharts.map((chart: any) => chart.anchor.row + chart.anchor.heightRows),
          ...incomingBands.map((band: any) => (band.range?.endRow || 1) + 4),
        ];
        const colEnds = [
          4,
          ...incomingCells.map((cell: any) => cell.col),
          ...incomingCharts.map((chart: any) => chart.anchor.col + chart.anchor.widthCols),
          ...incomingBands.map((band: any) => band.range?.endCol || 1),
        ];
        this.sheet.rowCount = Math.max(this.sheet.rowCount, ...rowEnds);
        this.sheet.columnCount = Math.max(this.sheet.columnCount, ...colEnds);
        this.touch(); this.notify('Copilot içeriği şablona eklendi.'); this.cdr.markForCheck();
      },
    });
    this.releaseCoworker = this.aiCoworker.registerTemplateBuilder({
      initLiveSheet: async (reportName, queryId, totalCols, totalRows) => {
        this.livePreviewMode = false;
        this.evaluatedResult = null;
        this.doc = createEmptyDocument(reportName || 'Copilot Raporu');
        this.doc.description = 'SuperNova Copilot canlı otomasyonu ile oluşturuldu.';
        this.sheetIndex = 0;
        this.sheet.name = 'Rapor';
        this.sheet.columnCount = Math.max(16, totalCols);
        this.sheet.rowCount = Math.max(40, totalRows);
        this.sheet.columnWidths = {};
        for (let i = 1; i <= 10; i++) this.sheet.columnWidths[i] = 20;
        this.sheet.rowHeights = { 1: 30, 2: 20, 4: 20, 5: 26 };
        this.selected = { row: 1, col: 1 };
        this.rangeEnd = null;
        this.mode = 'editor';
        // Reload query list if newly created Copilot query isn't loaded yet
        try {
          const qRes = await firstValueFrom(this.queryService.list());
          this.queries = qRes?.data || [];
          const found = this.queries.find(q => q.id === queryId);
          if (found) {
            this.sideTab = 'queries';
            this.selectQuery(found);
          }
        } catch { /* ignore */ }
        this.cdr.markForCheck();
      },
      writeBannerStep: (reportName, subtitle, tableWidth) => {
        this.selected = { row: 1, col: 1 };
        this.sheet.cells['1,1'] = {
          row: 1, col: 1,
          value: reportName,
          mergeAnchor: `1,1,1,${tableWidth}`,
          style: { bold: true, fontSize: 14, color: '#FFFFFF', bg: '#0F172A', align: 'left', valign: 'middle' },
        };
        this.sheet.cells['2,1'] = {
          row: 2, col: 1,
          value: subtitle,
          mergeAnchor: `2,1,2,${tableWidth}`,
          style: { italic: true, fontSize: 9, color: '#CBD5E1', bg: '#1E293B', align: 'left', valign: 'middle' },
        };
        this.touch();
        this.cdr.markForCheck();
      },
      writeSummaryStep: (colIdx, rowStart, queryId, item) => {
        const op = (item.operation || 'SUM').toUpperCase() as SummaryOperation;
        this.selected = { row: rowStart + 1, col: colIdx };
        this.sheet.cells[`${rowStart},${colIdx}`] = {
          row: rowStart, col: colIdx,
          value: `${op} (${item.field})`,
          style: { bold: true, fontSize: 9, color: '#334155', bg: '#E2E8F0', align: 'center', valign: 'middle' },
        };
        this.sheet.cells[`${rowStart + 1},${colIdx}`] = {
          row: rowStart + 1, col: colIdx,
          value: `={{${op}(${item.field})}}`,
          numberFormat: op === 'COUNT' ? '#,##0' : '#,##0.00',
          binding: { kind: 'summary', queryId, field: item.field, operation: op },
          style: { bold: true, fontSize: 11, color: '#0369A1', bg: '#F0F9FF', align: 'center', valign: 'middle' },
        };
        this.touch();
        this.cdr.markForCheck();
      },
      writeDetailTableStep: (headerRow, selectedCols, numericCols, queryId) => {
        const bandRow = headerRow + 1;
        const fieldMap: Record<number, string> = {};
        selectedCols.forEach((colName, i) => {
          const cIdx = i + 1;
          const isNum = numericCols.includes(colName);
          this.sheet.cells[`${headerRow},${cIdx}`] = {
            row: headerRow, col: cIdx,
            value: colName,
            style: { bold: true, fontSize: 10, color: '#FFFFFF', bg: '#1E293B', align: 'center', valign: 'middle' },
          };
          const bandCell: TemplateCell = {
            row: bandRow, col: cIdx,
            value: `{{${colName}}}`,
            binding: { kind: 'query_field', queryId, field: colName },
            style: { fontSize: 10, color: '#0F172A', align: isNum ? 'right' : 'left', valign: 'middle' },
          };
          if (isNum) bandCell.numberFormat = '#,##0.00';
          this.sheet.cells[`${bandRow},${cIdx}`] = bandCell;
          fieldMap[cIdx] = colName;
        });
        this.sheet.bands = [{
          id: 'bnd_main',
          queryId,
          range: { startRow: bandRow, startCol: 1, endRow: bandRow, endCol: selectedCols.length },
          fieldMap,
        }];
        this.selected = { row: bandRow, col: 1 };
        this.touch();
        this.cdr.markForCheck();
      },
      placeChartStep: (type, title, queryId, xAxis, yAxis, anchorRow, anchorCol) => {
        this.selected = { row: anchorRow, col: anchorCol };
        this.sheet.charts = [{
          id: `ch_${Date.now().toString(36)}`,
          type,
          title,
          queryId,
          xAxis,
          yAxis,
          anchor: { row: anchorRow, col: anchorCol, widthCols: 7, heightRows: 14 },
        }];
        this.touch();
        this.cdr.markForCheck();
      },
      finalizeAndRunLivePreview: async (templateId) => {
        if (templateId) this.doc.id = templateId;
        this.loadTemplates();
        this.livePreviewLoading = true;
        this.cdr.markForCheck();
        try {
          const res = await firstValueFrom(this.templateService.evaluate(this.doc));
          this.evaluatedResult = res.data;
          this.livePreviewMode = true;
          this.notify(`Canlı Rapor hazır (${res.data?.queryStats?.length || 1} sorgu güncel verilerle çalıştırıldı).`);
        } finally {
          this.livePreviewLoading = false;
          this.cdr.markForCheck();
        }
      },
    });
    this.loadQueries();
    this.loadTemplates();
    this.loadPythonScripts();
    this.ensureCell(this.selected.row, this.selected.col);

    // Reports hub'undan veya Copilot'tan "/template-builder/:id" ile doğrudan açılış
    this.route.paramMap.subscribe(params => {
      const routeId = params.get('id');
      if (routeId) {
        this.loadQueries();
        this.loadTemplates();
        this.openById(routeId);
      } else {
        // Space Map, Path Definer veya Query Viewer'dan gelen "Create Report" isteği
        const rawInitial = sessionStorage.getItem('templateBuilderInitialQuery');
        if (rawInitial) {
          sessionStorage.removeItem('templateBuilderInitialQuery');
          try {
            const initData = JSON.parse(rawInitial);
            this.initializeFromSpaceMapBlueprint(initData);
          } catch { /* yok say */ }
        }
      }
    });
  }

  ngOnDestroy(): void {
    this.releaseAi?.();
    this.releaseCoworker?.();
  }

  // ---- Yükleyiciler ----

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: (res) => {
        this.queries = res.data || [];
        // Editör modda, modeldeki ilk bağlı sorgu henüz aktif edilmediyse şimdi dene
        // (route :id ile açılışta query listesi sonra yüklenmiş olabilir).
        if (this.mode === 'editor' && !this.activeSource) this.activateFirstBoundQuery();
      },
      error: () => (this.queries = []),
    });
    this.queryService.listDatasources().subscribe({
      next: (res) => {
        this.dataSources = res.data || [];
        if (!this.newQuery.dataSourceId && this.dataSources.length) {
          this.newQuery.dataSourceId = this.dataSources[0].id;
        }
      },
      error: () => (this.dataSources = []),
    });
  }

  loadPythonScripts(): void {
    this.queryService.listPythonScripts().subscribe({
      next: (res) => {
        this.pythonScripts = res.data || [];
        if (this.mode === 'editor' && !this.activeSource) this.activateFirstBoundQuery();
      },
      error: () => (this.pythonScripts = []),
    });
  }

  loadTemplates(): void {
    this.templateService.list().subscribe({
      next: (res) => (this.templates = res.data || []),
      error: () => (this.templates = []),
    });
  }

  // ---- Galeri ----

  get filteredTemplates(): TemplateSummary[] {
    const t = this.searchTemplates.trim().toLowerCase();
    if (!t) return this.templates;
    return this.templates.filter((x) => (x.name || '').toLowerCase().includes(t));
  }

  openGallery(): void {
    this.mode = 'gallery';
    this.loadTemplates();
  }

  newTemplate(): void {
    this.newDoc();
    this.mode = 'editor';
  }

  open(t: TemplateSummary): void {
    this.templateService.get(t.id).subscribe({
      next: (res) => {
        this.applyLoadedDoc(res.data.model, res.data.name || t.name);
      },
      error: () => this.notify('Could not load template.'),
    });
  }

  /**
   * Reports hub'undan "Edit" (/template-builder/:id) ile doğrudan açılış.
   * Mevcut open() ile aynı efekti üretir; açılışta "queries hazır" için
   * modeldeki ilk bağlı SQL sorgusunu da aktif eder.
   */
  openById(id: string): void {
    this.templateService.get(id).subscribe({
      next: (res) => {
        this.applyLoadedDoc(res.data.model, res.data.name || 'Template');
        if (this.queries.length) this.activateFirstBoundQuery();
      },
      error: () => this.notify('Could not load template.'),
    });
  }

  /** Yüklenen modeli editöre uygular (open/openById ortak yolu). */
  private applyLoadedDoc(model: TemplateDocument, name: string): void {
    this.doc = model;
    if (!this.doc.sheets?.length) this.doc.sheets = [createEmptySheet('Sheet1')];
    this.sheetIndex = 0;
    this.activeSource = null;
    this.livePreviewMode = false;
    this.evaluatedResult = null;
    this.ensureCell(1, 1);
    this.mode = 'editor';
    this.activateFirstBoundQuery();
    this.notify(`"${name}" yüklendi.`);
  }

  /**
   * Modelde başvurulan ilk bağlı SQL sorgusunu veya Python scriptini aktif kaynağa
   * bağlar → sol detay paneli ve alanlar hemen dolar.
   */
  activateFirstBoundQuery(): void {
    if (this.activeSource) return;
    const ref = this.firstBoundSourceId();
    if (!ref) return;
    if (ref.startsWith('py:')) {
      const parts = ref.split(':');
      const sid = parts[1];
      const dsName = parts[2] || '';
      const s = this.pythonScripts.find((x) => x.id === sid);
      if (s) {
        this.sideTab = 'python';
        this.selectPythonScript(s, dsName);
      }
      return;
    }
    const q = this.queries.find((x) => x.id === ref);
    if (q) {
      this.sideTab = 'queries';
      this.selectQuery(q);
    }
  }

  /** Model genelinde başvurulan ilk kaynak id'si (SQL veya py:...). */
  private firstBoundSourceId(): string | null {
    for (const sheet of this.doc.sheets || []) {
      for (const band of sheet.bands || []) {
        if (band.queryId) return band.queryId;
      }
      for (const cell of Object.values(sheet.cells || {})) {
        const b = cell.binding;
        if (b && (b.kind === 'query_field' || b.kind === 'summary') && b.queryId) {
          return b.queryId;
        }
      }
      for (const chart of sheet.charts || []) {
        if (chart.queryId) return chart.queryId;
      }
    }
    return null;
  }

  duplicateTemplate(t: TemplateSummary, ev: Event): void {
    ev.stopPropagation();
    this.templateService.get(t.id).subscribe({
      next: (res) => {
        const model = res.data.model;
        model.id = '';
        this.templateService
          .create(`${t.name} (copy)`, model, model.description || '')
          .subscribe({
            next: () => { this.notify('Template duplicated.'); this.loadTemplates(); },
            error: () => this.notify('Error duplicating template.'),
          });
      },
      error: () => this.notify('Error loading templates.'),
    });
  }

  async deleteTemplate(t: TemplateSummary, ev: Event): Promise<void> {
    ev.stopPropagation();
    if (!await this.confirmService.confirm(`Are you sure you want to delete "${t.name}"?`)) return;
    this.templateService.remove(t.id).subscribe({
      next: () => { this.notify('Deleted successfully.'); this.loadTemplates(); },
      error: () => this.notify('Error deleting template.'),
    });
  }

  backToApp(): void {
    this.router.navigate(['/dashboard']);
  }

  // ---- Sheet / hücre erişimi ----

  get sheet(): TemplateSheet {
    return this.doc.sheets[this.sheetIndex];
  }

  get activeEvaluatedSheet(): any {
    if (!this.livePreviewMode || !this.evaluatedResult?.sheets?.length) return null;
    return this.evaluatedResult.sheets[this.sheetIndex] || this.evaluatedResult.sheets[0];
  }

  get rowCount(): number {
    if (this.activeEvaluatedSheet) {
      return Math.max(this.activeEvaluatedSheet.rowCount || 20, 20);
    }
    return this.sheet.rowCount;
  }

  get colCount(): number {
    if (this.activeEvaluatedSheet) {
      return Math.max(this.activeEvaluatedSheet.columnCount || 12, this.sheet.columnCount);
    }
    return this.sheet.columnCount;
  }

  rowsArray(): number[] {
    return Array.from({ length: this.rowCount }, (_, i) => i + 1);
  }

  colsArray(): number[] {
    return Array.from({ length: this.colCount }, (_, i) => i + 1);
  }

  colLetter(c: number): string {
    if (c <= 26) return String.fromCharCode(64 + c);
    const first = Math.floor((c - 1) / 26);
    const second = ((c - 1) % 26) + 1;
    return String.fromCharCode(64 + first) + String.fromCharCode(64 + second);
  }

  cellAt(r: number, c: number): TemplateCell | undefined {
    if (this.activeEvaluatedSheet) {
      return this.activeEvaluatedSheet.cells?.[cellKey(r, c)];
    }
    return this.sheet.cells[cellKey(r, c)];
  }

  ensureCell(r: number, c: number): TemplateCell {
    const key = cellKey(r, c);
    if (!this.sheet.cells[key]) {
      this.sheet.cells[key] = { row: r, col: c, value: '' };
    }
    return this.sheet.cells[key];
  }

  /** Hücrenin editörde gösterilen değeri. */
  displayValue(cell?: TemplateCell): string {
    if (!cell) return '';
    if (this.livePreviewMode) {
      return cell.value !== undefined && cell.value !== null ? String(cell.value) : '';
    }
    const b = cell.binding;
    if (!b || b.kind === 'text') return cell.value || '';
    if (b.kind === 'builtin') return cell.value || `{{${b.builtin}}}`;
    if (b.kind === 'query_field') return cell.value || `{{${b.field}}}`;
    if (b.kind === 'summary') return cell.value || `{{${b.operation}(${b.field})}}`;
    if (b.kind === 'formula') return cell.value || b.formula || '';
    return cell.value || '';
  }

  /** Hücre stili → güvenli CSS (ngStyle). */
  styleOf(cell?: TemplateCell): SafeStyle | null {
    if (!cell?.style) return null;
    const s = cell.style;
    const parts: string[] = [];
    if (s.bold) parts.push('font-weight:700');
    if (s.italic) parts.push('font-style:italic');
    if (s.underline) parts.push('text-decoration:underline');
    if (s.align) parts.push(`text-align:${s.align}`);
    if (s.bg) parts.push(`background-color:${s.bg}`);
    if (s.color) parts.push(`color:${s.color}`);
    if (s.fontSize) parts.push(`font-size:${s.fontSize}px`);
    return this.sanitizer.bypassSecurityTrustStyle(parts.join(';'));
  }

  // ---- Seçim ----

  select(r: number, c: number, shift = false): void {
    if (shift) {
      this.rangeEnd = { row: r, col: c };
    } else {
      this.selected = { row: r, col: c };
      this.rangeEnd = null;
    }
    this.ensureCell(r, c);
  }

  /** Klavye ile güvenli taşma (sınırların dışına taşıp grid'i otomatik büyüt). */
  moveTo(r: number, c: number): void {
    if (r < 1) r = 1;
    if (c < 1) c = 1;
    if (r > this.rowCount) this.addRows();
    if (c > this.colCount) this.addCols();
    this.selected = { row: r, col: c };
    this.rangeEnd = null;
    this.ensureCell(r, c);
  }

  isSelected(r: number, c: number): boolean {
    return this.selected.row === r && this.selected.col === c;
  }

  inRange(r: number, c: number): boolean {
    if (!this.rangeEnd) return false;
    const r1 = Math.min(this.selected.row, this.rangeEnd.row);
    const r2 = Math.max(this.selected.row, this.rangeEnd.row);
    const c1 = Math.min(this.selected.col, this.rangeEnd.col);
    const c2 = Math.max(this.selected.col, this.rangeEnd.col);
    return r >= r1 && r <= r2 && c >= c1 && c <= c2;
  }

  get hasRange(): boolean {
    return !!this.rangeEnd;
  }

  get selectedAddress(): string {
    return `${this.colLetter(this.selected.col)}${this.selected.row}`;
  }

  get formulaValue(): string {
    const cell = this.cellAt(this.selected.row, this.selected.col);
    return cell ? (cell.value || '') : '';
  }

  set formulaValue(v: string) {
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.value = v;
    // Düz metin yazılırsa bağlama temizlenir (formül hariç).
    if (cell.binding && cell.binding.kind !== 'formula') {
      cell.binding = undefined;
    }
    this.touch();
  }

  // ---- Satır içi düzenleme + klavye ----

  startEdit(initial = ''): void {
    this.editing = { row: this.selected.row, col: this.selected.col };
    const cell = this.cellAt(this.selected.row, this.selected.col);
    this.editValue = initial !== '' ? initial : (cell?.value || '');
    // Input DOM'a yerleşince odakla.
    setTimeout(() => {
      const el = document.getElementById('tb-edit-input') as HTMLInputElement | null;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, 0);
  }

  commitEdit(): void {
    if (!this.editing) return;
    const cell = this.ensureCell(this.editing.row, this.editing.col);
    cell.value = this.editValue;
    if (cell.binding && cell.binding.kind !== 'formula') {
      cell.binding = undefined;
    }
    this.editing = null;
    this.touch();
  }

  cancelEdit(): void {
    this.editing = null;
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (this.mode !== 'editor') return;
    const tag = (e.target as HTMLElement)?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // Düzenleme inputu kendi tuş olaylarını (enter/escape/blur) HTML'de yönetir.
    if (inField) return;

    const r = this.selected.row;
    const c = this.selected.col;
    switch (e.key) {
      case 'ArrowUp': this.moveTo(r - 1, c); e.preventDefault(); break;
      case 'ArrowDown': this.moveTo(r + 1, c); e.preventDefault(); break;
      case 'ArrowLeft': this.moveTo(r, c - 1); e.preventDefault(); break;
      case 'ArrowRight': this.moveTo(r, c + 1); e.preventDefault(); break;
      case 'Enter': this.moveTo(r + 1, c); e.preventDefault(); break;
      case 'Tab': this.moveTo(r, e.shiftKey ? c - 1 : c + 1); e.preventDefault(); break;
      case 'Delete':
      case 'Backspace': this.clearCell(); e.preventDefault(); break;
      case 'F2': this.startEdit(); e.preventDefault(); break;
      default:
        // Yazılabilir tek karakter → hücrede düzenleme başlat.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          this.startEdit(e.key);
          e.preventDefault();
        }
    }
  }

  // ---- Sütun/satır yeniden boyutlandırma ----

  colWidthPx(c: number): number | undefined {
    return this.sheet.columnWidths?.[c];
  }

  rowHeightPx(r: number): number | undefined {
    return this.sheet.rowHeights?.[r];
  }

  startColResize(c: number, e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.resizing = {
      kind: 'col', index: c, startX: e.clientX, startY: 0,
      start: this.sheet.columnWidths?.[c] ?? 92,
    };
  }

  startRowResize(r: number, e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.resizing = {
      kind: 'row', index: r, startX: 0, startY: e.clientY,
      start: this.sheet.rowHeights?.[r] ?? 26,
    };
  }

  @HostListener('document:mousemove', ['$event'])
  onResizeMove(e: MouseEvent): void {
    if (!this.resizing) return;
    if (this.resizing.kind === 'col') {
      const w = Math.max(40, this.resizing.start + (e.clientX - this.resizing.startX));
      this.sheet.columnWidths![this.resizing.index] = w;
    } else {
      const h = Math.max(20, this.resizing.start + (e.clientY - this.resizing.startY));
      this.sheet.rowHeights![this.resizing.index] = h;
    }
  }

  @HostListener('document:mouseup')
  onResizeUp(): void {
    if (this.resizing) {
      this.resizing = null;
      this.touch();
    }
  }

  // ---- Birleştirme (merge) ----

  private mergeRangeFor(r: number, c: number): { r1: number; c1: number; r2: number; c2: number } | null {
    const cellsMap = this.activeEvaluatedSheet?.cells || this.sheet.cells;
    for (const cell of Object.values(cellsMap) as TemplateCell[]) {
      const a = cell.mergeAnchor;
      if (!a) continue;
      const [r1, c1, r2, c2] = a.split(',').map(Number);
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) return { r1, c1, r2, c2 };
    }
    return null;
  }

  isMergeCovered(r: number, c: number): boolean {
    const m = this.mergeRangeFor(r, c);
    return !!m && !(m.r1 === r && m.c1 === c);
  }

  mergeRowspan(r: number, c: number): number {
    const m = this.mergeRangeFor(r, c);
    return m && m.r1 === r && m.c1 === c ? m.r2 - m.r1 + 1 : 1;
  }

  mergeColspan(r: number, c: number): number {
    const m = this.mergeRangeFor(r, c);
    return m && m.r1 === r && m.c1 === c ? m.c2 - m.c1 + 1 : 1;
  }

  mergeRange(): void {
    if (!this.rangeEnd) return;
    const r1 = Math.min(this.selected.row, this.rangeEnd.row);
    const r2 = Math.max(this.selected.row, this.rangeEnd.row);
    const c1 = Math.min(this.selected.col, this.rangeEnd.col);
    const c2 = Math.max(this.selected.col, this.rangeEnd.col);
    const anchor = this.ensureCell(r1, c1);
    anchor.mergeAnchor = `${r1},${c1},${r2},${c2}`;
    this.rangeEnd = null;
    this.notify('Cells merged.');
    this.touch();
  }

  unmergeAt(): void {
    const cell = this.cellAt(this.selected.row, this.selected.col);
    if (cell?.mergeAnchor) {
      delete cell.mergeAnchor;
      this.notify('Unmerged successfully.');
      this.touch();
    }
  }

  get selectedMerge(): boolean {
    return !!this.cellAt(this.selected.row, this.selected.col)?.mergeAnchor;
  }

  get selectedStyle() {
    return this.cellAt(this.selected.row, this.selected.col)?.style || {};
  }

  get selectedBindingBadge(): string {
    const b = this.cellAt(this.selected.row, this.selected.col)?.binding;
    if (!b || b.kind === 'text') return '';
    if (b.kind === 'query_field') return 'FIELD';
    if (b.kind === 'summary') return `Σ ${b.operation || 'SUM'}`;
    if (b.kind === 'builtin') return 'AUTO';
    if (b.kind === 'formula') return 'FX';
    return '';
  }

  /** Hücre bir detail band içinde mi? */
  isInBand(r: number, c: number): boolean {
    for (const b of this.sheet.bands || []) {
      if (
        r >= b.range.startRow && r <= b.range.endRow &&
        c >= b.range.startCol && c <= b.range.endCol
      ) {
        return true;
      }
    }
    return false;
  }

  /** Bu hücrede başlayan bir grafik var mı? */
  chartAnchorAt(r: number, c: number) {
    return (this.sheet.charts || []).find(
      (ch) => ch.anchor.row === r && ch.anchor.col === c
    );
  }

  removeChart(chartId: string, ev: Event): void {
    ev.stopPropagation();
    this.sheet.charts = (this.sheet.charts || []).filter((ch) => ch.id !== chartId);
    this.notify('Chart removed.');
    this.touch();
  }

  // ---- Biçimlendirme (toolbar) ----

  private applyStyleToSelection(mutator: (style: NonNullable<TemplateCell['style']>) => void): void {
    if (this.rangeEnd) {
      const r1 = Math.min(this.selected.row, this.rangeEnd.row);
      const r2 = Math.max(this.selected.row, this.rangeEnd.row);
      const c1 = Math.min(this.selected.col, this.rangeEnd.col);
      const c2 = Math.max(this.selected.col, this.rangeEnd.col);
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const cell = this.ensureCell(r, c);
          cell.style = { ...(cell.style || {}) };
          mutator(cell.style);
        }
      }
    } else {
      const cell = this.ensureCell(this.selected.row, this.selected.col);
      cell.style = { ...(cell.style || {}) };
      mutator(cell.style);
    }
    this.touch();
  }

  toggleBold(): void {
    const next = !this.selectedStyle.bold;
    this.applyStyleToSelection((s) => (s.bold = next));
  }

  toggleItalic(): void {
    const next = !this.selectedStyle.italic;
    this.applyStyleToSelection((s) => (s.italic = next));
  }

  toggleUnderline(): void {
    const next = !this.selectedStyle.underline;
    this.applyStyleToSelection((s) => (s.underline = next));
  }

  setAlign(align: 'left' | 'center' | 'right'): void {
    this.applyStyleToSelection((s) => (s.align = align));
  }

  setFill(hex: string): void {
    this.applyStyleToSelection((s) => (s.bg = hex));
  }

  setTextColor(hex: string): void {
    this.applyStyleToSelection((s) => (s.color = hex));
  }

  applyThemePreset(preset: 'gold-header' | 'onyx-header' | 'lunar-sub' | 'clear'): void {
    if (preset === 'clear') {
      this.applyStyleToSelection((s) => {
        delete s.bg;
        delete s.color;
        delete s.bold;
        delete s.italic;
        delete s.underline;
      });
      return;
    }
    if (preset === 'gold-header') {
      this.applyStyleToSelection((s) => {
        s.bg = '#F5B301';
        s.color = '#1A1714';
        s.bold = true;
      });
    } else if (preset === 'onyx-header') {
      this.applyStyleToSelection((s) => {
        s.bg = '#1F1B26';
        s.color = '#F5B301';
        s.bold = true;
      });
    } else if (preset === 'lunar-sub') {
      this.applyStyleToSelection((s) => {
        s.bg = '#2F2934';
        s.color = '#F4F1EA';
        s.bold = true;
      });
    }
  }

  // ---- Hazır Kurumsal Şablon Taslakları (Starter Blueprints) ----

  readonly starterPresets = [
    {
      id: 'executive-kpi',
      name: 'Executive KPI & User Audit',
      badge: 'Nov4 Gold',
      icon: 'fa-crown',
      accent: 'gold',
      desc: 'Executive summary banner, KPI metric blocks, and auto-expanding data table.',
    },
    {
      id: 'scada-telemetry',
      name: 'SCADA Telemetry & Shift Log',
      badge: 'Industrial',
      icon: 'fa-microchip',
      accent: 'flare',
      desc: 'Shift header with timestamp, statistical summary strip (AVG/MAX/COUNT), and chart.',
    },
    {
      id: 'quality-matrix',
      name: 'Operations & Role Matrix',
      badge: 'Analytics',
      icon: 'fa-layer-group',
      accent: 'lunar',
      desc: 'Multi-section audit matrix with clean lunar steel headers and structured bands.',
    },
  ];

  openStarterPreset(presetId: string): void {
    const now = new Date().toISOString();
    const defaultQuery = this.queries.find((q) => q.id === 'q_users') || this.queries[0];
    const qId = defaultQuery?.id || 'q_users';
    const sheet = createEmptySheet('Report', 36, 10);
    sheet.columnWidths = { 1: 140, 2: 180, 3: 220, 4: 140, 5: 130, 6: 130 };

    if (presetId === 'executive-kpi') {
      sheet.cells = {
        '1,1': {
          row: 1, col: 1,
          value: 'NOV4 EXECUTIVE OPERATIONS & ACCESS REPORT',
          mergeAnchor: '1,1,1,4',
          style: { bold: true, fontSize: 15, bg: '#1F1B26', color: '#F5B301', align: 'left' },
        },
        '2,1': {
          row: 2, col: 1,
          value: 'Generated At:',
          style: { bold: true, color: '#A39A89' },
        },
        '2,2': {
          row: 2, col: 2,
          value: '{{report_datetime}}',
          binding: { kind: 'builtin', builtin: 'report_datetime' },
          style: { bold: true, color: '#F4F1EA' },
        },
        '2,3': {
          row: 2, col: 3,
          value: 'Total Active Records:',
          style: { bold: true, color: '#A39A89', align: 'right' },
        },
        '2,4': {
          row: 2, col: 4,
          value: '{{COUNT(username)}}',
          binding: { kind: 'summary', queryId: qId, field: 'username', operation: 'COUNT' },
          style: { bold: true, bg: '#2F2934', color: '#F5B301', align: 'center' },
        },
        '4,1': { row: 4, col: 1, value: 'USERNAME', style: { bold: true, bg: '#F5B301', color: '#1A1714' } },
        '4,2': { row: 4, col: 2, value: 'DISPLAY NAME', style: { bold: true, bg: '#F5B301', color: '#1A1714' } },
        '4,3': { row: 4, col: 3, value: 'EMAIL ADDRESS', style: { bold: true, bg: '#F5B301', color: '#1A1714' } },
        '4,4': { row: 4, col: 4, value: 'ASSIGNED ROLE', style: { bold: true, bg: '#F5B301', color: '#1A1714', align: 'center' } },
        '5,1': { row: 5, col: 1, value: '{{username}}', binding: { kind: 'query_field', queryId: qId, field: 'username' } },
        '5,2': { row: 5, col: 2, value: '{{Display Name}}', binding: { kind: 'query_field', queryId: qId, field: 'Display Name' } },
        '5,3': { row: 5, col: 3, value: '{{Email}}', binding: { kind: 'query_field', queryId: qId, field: 'Email' } },
        '5,4': { row: 5, col: 4, value: '{{Role}}', binding: { kind: 'query_field', queryId: qId, field: 'Role' }, style: { align: 'center', bold: true } },
      };
      sheet.bands = [{
        id: 'b_exec',
        queryId: qId,
        range: { startRow: 5, startCol: 1, endRow: 5, endCol: 4 },
        fieldMap: { 1: 'username', 2: 'Display Name', 3: 'Email', 4: 'Role' },
      }];
    } else if (presetId === 'scada-telemetry') {
      sheet.cells = {
        '1,1': {
          row: 1, col: 1,
          value: 'SCADA TELEMETRY & SHIFT AUDIT LOG',
          mergeAnchor: '1,1,1,4',
          style: { bold: true, fontSize: 15, bg: '#FF7A1A', color: '#1A1714', align: 'left' },
        },
        '2,1': { row: 2, col: 1, value: 'Report Date', style: { bold: true, bg: '#2F2934', color: '#C9C4BA' } },
        '2,2': { row: 2, col: 2, value: '{{report_date}}', binding: { kind: 'builtin', builtin: 'report_date' } },
        '2,3': { row: 2, col: 3, value: 'Sample Count', style: { bold: true, bg: '#2F2934', color: '#C9C4BA' } },
        '2,4': { row: 2, col: 4, value: '{{COUNT(username)}}', binding: { kind: 'summary', queryId: qId, field: 'username', operation: 'COUNT' }, style: { bold: true, color: '#F5B301', align: 'center' } },
        '4,1': { row: 4, col: 1, value: 'OPERATOR ID', style: { bold: true, bg: '#1F1B26', color: '#F5B301' } },
        '4,2': { row: 4, col: 2, value: 'FULL NAME', style: { bold: true, bg: '#1F1B26', color: '#F5B301' } },
        '4,3': { row: 4, col: 3, value: 'CONTACT CHANNEL', style: { bold: true, bg: '#1F1B26', color: '#F5B301' } },
        '4,4': { row: 4, col: 4, value: 'CLEARANCE', style: { bold: true, bg: '#1F1B26', color: '#F5B301', align: 'center' } },
        '5,1': { row: 5, col: 1, value: '{{username}}', binding: { kind: 'query_field', queryId: qId, field: 'username' } },
        '5,2': { row: 5, col: 2, value: '{{Display Name}}', binding: { kind: 'query_field', queryId: qId, field: 'Display Name' } },
        '5,3': { row: 5, col: 3, value: '{{Email}}', binding: { kind: 'query_field', queryId: qId, field: 'Email' } },
        '5,4': { row: 5, col: 4, value: '{{Role}}', binding: { kind: 'query_field', queryId: qId, field: 'Role' }, style: { align: 'center' } },
      };
      sheet.bands = [{
        id: 'b_scada',
        queryId: qId,
        range: { startRow: 5, startCol: 1, endRow: 5, endCol: 4 },
        fieldMap: { 1: 'username', 2: 'Display Name', 3: 'Email', 4: 'Role' },
      }];
      sheet.charts = [{
        id: 'ch_scada',
        type: 'bar',
        anchor: { row: 8, col: 1, widthCols: 4, heightRows: 10 },
        queryId: qId,
        title: 'TELEMETRY DISTRIBUTION',
      }];
    } else {
      sheet.cells = {
        '1,1': {
          row: 1, col: 1,
          value: 'OPERATIONS & ROLE COMPLIANCE MATRIX',
          mergeAnchor: '1,1,1,4',
          style: { bold: true, fontSize: 15, bg: '#7C8DB5', color: '#14111B', align: 'left' },
        },
        '2,1': { row: 2, col: 1, value: '{{report_name}}', binding: { kind: 'builtin', builtin: 'report_name' }, style: { italic: true, color: '#C9C4BA' } },
        '2,4': { row: 2, col: 4, value: '{{report_date}}', binding: { kind: 'builtin', builtin: 'report_date' }, style: { align: 'right', color: '#F5B301' } },
        '4,1': { row: 4, col: 1, value: 'ACCOUNT', style: { bold: true, bg: '#2F2934', color: '#F4F1EA' } },
        '4,2': { row: 4, col: 2, value: 'RESPONSIBLE', style: { bold: true, bg: '#2F2934', color: '#F4F1EA' } },
        '4,3': { row: 4, col: 3, value: 'NOTIFICATION EMAIL', style: { bold: true, bg: '#2F2934', color: '#F4F1EA' } },
        '4,4': { row: 4, col: 4, value: 'ACCESS TIER', style: { bold: true, bg: '#2F2934', color: '#F5B301', align: 'center' } },
        '5,1': { row: 5, col: 1, value: '{{username}}', binding: { kind: 'query_field', queryId: qId, field: 'username' } },
        '5,2': { row: 5, col: 2, value: '{{Display Name}}', binding: { kind: 'query_field', queryId: qId, field: 'Display Name' } },
        '5,3': { row: 5, col: 3, value: '{{Email}}', binding: { kind: 'query_field', queryId: qId, field: 'Email' } },
        '5,4': { row: 5, col: 4, value: '{{Role}}', binding: { kind: 'query_field', queryId: qId, field: 'Role' }, style: { align: 'center' } },
      };
      sheet.bands = [{
        id: 'b_matrix',
        queryId: qId,
        range: { startRow: 5, startCol: 1, endRow: 5, endCol: 4 },
        fieldMap: { 1: 'username', 2: 'Display Name', 3: 'Email', 4: 'Role' },
      }];
    }

    const presetMeta = this.starterPresets.find((p) => p.id === presetId);
    this.doc = {
      id: '',
      name: presetMeta?.name || 'Nov4 Report Template',
      description: presetMeta?.desc || '',
      sheets: [sheet],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.sheetIndex = 0;
    this.activeSource = null;
    this.ensureCell(1, 1);
    this.mode = 'editor';
    if (defaultQuery) {
      this.selectQuery(defaultQuery);
    }
    this.notify(`"${this.doc.name}" blueprint loaded.`);
  }

  // ---- Sol panel: Sorgular & Python Arama/Filtreleme ----

  get filteredQueries(): SavedQuery[] {
    const q = this.sourceSearchTerm.trim().toLowerCase();
    if (!q) return this.queries;
    return this.queries.filter(item =>
      item.name.toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q) ||
      (item.dataSourceId || '').toLowerCase().includes(q)
    );
  }

  get filteredPythonScripts(): SavedPythonScript[] {
    const q = this.sourceSearchTerm.trim().toLowerCase();
    if (!q) return this.pythonScripts;
    return this.pythonScripts.filter(item =>
      item.name.toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q)
    );
  }

  selectQuery(q: SavedQuery): void {
    this.activeSource = {
      id: q.id,
      columns: q.columns || [],
      label: q.name,
      prefix: '',
      description: q.description || '',
      kind: 'sql',
      dataSourceId: q.dataSourceId,
      rows: [],
      totalRows: 0,
      executionMs: 0,
    };
    if (this.activeSource.columns.length) {
      this.summaryField = this.activeSource.columns[0].name;
    }
    this.sourceLoading = true;
    this.queryService.preview(q.id, {}, 50).subscribe({
      next: (res) => {
        const cols = res.data?.columns || q.columns || [];
        const rows = res.data?.rows || [];
        if (this.activeSource?.id === q.id) {
          this.activeSource.columns = cols;
          this.activeSource.rows = rows;
          this.activeSource.totalRows = res.data?.totalRows ?? rows.length;
          this.activeSource.executionMs = res.data?.executionMs ?? 0;
          if (!this.summaryField || !cols.some((c: QueryColumn) => c.name === this.summaryField)) {
            this.summaryField = cols[0]?.name || '';
          }
        }
        this.sourceLoading = false;
      },
      error: () => { this.sourceLoading = false; },
    });
  }

  toggleQueryForm(): void {
    this.showQueryForm = !this.showQueryForm;
    if (this.showQueryForm && !this.newQuery.dataSourceId && this.dataSources.length) {
      this.newQuery.dataSourceId = this.dataSources[0].id;
    }
  }

  saveQuery(): void {
    if (!this.newQuery.name?.trim() || !this.newQuery.sql?.trim() || !this.newQuery.dataSourceId) {
      this.notify('Name, SQL, and data source are required.');
      return;
    }
    this.queryService.create(this.newQuery as Partial<SavedQuery>).subscribe({
      next: (res) => {
        this.loadQueries();
        this.showQueryForm = false;
        this.newQuery = { name: '', sql: '', dataSourceId: this.newQuery.dataSourceId };
        this.notify('Query saved.');
      },
      error: (e) => this.notify('Could not save query: ' + (e.error?.error || e.message)),
    });
  }

  // ---- Sol panel: Python ----

  selectPythonScript(s: SavedPythonScript, preferredDataset?: string): void {
    this.activePythonId = s.id;
    this.pyLoading = true;
    this.pyError = '';
    this.pyPreview = null;
    this.queryService.runSavedPythonScript(s.id).subscribe({
      next: (res) => {
        this.pyLoading = false;
        const datasets = res.data?.datasets || {};
        this.pyPreview = datasets;
        const names = Object.keys(datasets);
        if (!names.length) {
          this.pyError = "No output dataset found. Use out('name', rows) in your script.";
          return;
        }
        const targetDs = preferredDataset && datasets[preferredDataset] ? preferredDataset : names[0];
        this.selectPythonDataset(targetDs, res.data?.executionMs);
      },
      error: (e) => {
        this.pyLoading = false;
        this.pyError = e.error?.error || e.message || 'Execution error';
      },
    });
  }

  get activePython(): SavedPythonScript | undefined {
    return this.pythonScripts.find((s) => s.id === this.activePythonId);
  }

  get pyDatasetNames(): string[] {
    return this.pyPreview ? Object.keys(this.pyPreview) : [];
  }

  selectPythonDataset(dsName: string, executionMs?: number): void {
    const s = this.activePython;
    const ds = this.pyPreview?.[dsName];
    if (!s || !ds) return;
    const cols = ds.columns || [];
    const rows = ds.rows || [];
    this.activeSource = {
      id: `py:${s.id}:${dsName}`,
      columns: cols,
      label: `${s.name} › ${dsName}`,
      prefix: dsName,
      description: s.description || `Python Script (${s.name}) — '${dsName}' veri seti çıktısı.`,
      kind: 'python',
      rows: rows.slice(0, 50),
      totalRows: ds.totalRows ?? rows.length,
      executionMs: executionMs ?? this.activeSource?.executionMs ?? 0,
    };
    if (cols.length) {
      this.summaryField = cols[0].name;
    }
  }

  // ---- Bağlama (binding) ----

  /** Aktif kaynağın bir alanını seçili hücreye bağla. */
  bindField(field: string): void {
    if (!this.activeSource) return;
    if (this.livePreviewMode) this.exitLivePreview();
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    const isPy = this.activeSource.id.startsWith('py:');
    const display = isPy && this.activeSource.prefix
      ? `{{${this.activeSource.prefix}.${field}}}`
      : `{{${field}}}`;
    const binding: CellBinding = { kind: 'query_field', queryId: this.activeSource.id, field };
    cell.binding = binding;
    cell.value = display;
    this.notify(`Bound ${display} to ${this.selectedAddress}`);
    this.touch();
  }

  /** Seçili hücreye özet (summary) bağla. */
  bindSummary(op: SummaryOperation, explicitField?: string): void {
    if (!this.activeSource || !op) return;
    if (this.livePreviewMode) this.exitLivePreview();
    const field = explicitField || this.summaryField || this.activeSource.columns?.[0]?.name || '';
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.binding = { kind: 'summary', queryId: this.activeSource.id, field, operation: op };
    cell.value = `{{${op}(${field})}}`;
    this.notify(`Bound Σ ${op}(${field}) to ${this.selectedAddress}`);
    this.touch();
  }

  /**
   * Aktif kaynağı tek tıkla seçili hücreden başlayarak:
   * - Seçili satıra kolon başlıkları (styled header)
   * - Bir alt satıra dinamik Detail Band ({{field}} binding'leri)
   * olarak yerleştirir. Statik veri yazmaz; rapor her çalıştığında canlı sorgulanır!
   */
  autoInsertTableFromActiveSource(): void {
    if (!this.activeSource || !this.activeSource.columns?.length) {
      this.notify('Lütfen önce kolonları olan bir SQL sorgusu veya Python veri seti seçin.');
      return;
    }
    if (this.livePreviewMode) this.exitLivePreview();

    const cols = this.activeSource.columns;
    const startR = this.selected.row;
    const startC = this.selected.col;
    const endC = startC + cols.length - 1;
    const bandR = startR + 1;

    while (this.sheet.columnCount < endC + 1) {
      this.addCols(4);
    }
    while (this.sheet.rowCount < bandR + 10) {
      this.addRows(10);
    }

    const isPy = this.activeSource.id.startsWith('py:');
    const prefix = isPy ? this.activeSource.prefix : '';
    const fieldMap: Record<number, string> = {};

    this.sheet.rowHeights = this.sheet.rowHeights || {};
    this.sheet.columnWidths = this.sheet.columnWidths || {};
    this.sheet.rowHeights[startR] = 28;
    this.sheet.rowHeights[bandR] = 24;

    cols.forEach((col, idx) => {
      const c = startC + idx;
      fieldMap[c] = col.name;
      if (!this.sheet.columnWidths![c] || this.sheet.columnWidths![c] < 120) {
        this.sheet.columnWidths![c] = 140;
      }

      // 1) Başlık hücresi
      const hCell = this.ensureCell(startR, c);
      hCell.value = col.name.toUpperCase();
      hCell.binding = undefined;
      hCell.style = {
        bold: true,
        bg: '#161A23',
        color: '#F5B301',
        align: idx === 0 ? 'left' : 'right',
        fontSize: 10,
      };

      // 2) Dinamik veri bandı hücresi ({{field}})
      const dCell = this.ensureCell(bandR, c);
      dCell.binding = {
        kind: 'query_field',
        queryId: this.activeSource!.id,
        field: col.name,
      };
      dCell.value = isPy && prefix ? `{{${prefix}.${col.name}}}` : `{{${col.name}}}`;
      dCell.style = {
        bg: '#0F1218',
        color: '#E5E7EB',
        align: idx === 0 ? 'left' : 'right',
        fontSize: 10,
      };
    });

    // Aynı satırdaki eski bandı temizle ve yeni dinamik bandı ekle
    const existingBands = (this.sheet.bands || []).filter(
      b => !(b.range.startRow === bandR && b.range.startCol === startC)
    );
    const band: DetailBand = {
      id: `b_${Date.now().toString(36)}`,
      queryId: this.activeSource.id,
      range: { startRow: bandR, startCol: startC, endRow: bandR, endCol: endC },
      fieldMap,
    };
    this.sheet.bands = [...existingBands, band];
    this.notify(`"${this.activeSource.label}" dinamik tablosu (${cols.length} kolon) ${this.colLetter(startC)}${startR} konumuna eklendi.`);
    this.touch();
  }

  /**
   * Space Map veya Path Definer'dan "Hızlı Rapor Oluştur" ile gelindiğinde
   * hem SQL hem Python veri kaynağını bağlar ve dinamik rapor şablonunu otomatik kurar.
   */
  private initializeFromSpaceMapBlueprint(initData: any): void {
    this.newDoc();
    this.mode = 'editor';
    if (initData.name) {
      this.doc.name = initData.name;
    }
    if (initData.nodePath) {
      this.doc.description = `Space Map Odak Yolu: ${initData.nodePath}`;
    } else {
      this.doc.description = 'Space Map / Path Definer üzerinden oluşturulan canlı rapor şablonu';
    }

    const qId: string = initData.queryId || '';
    if (!qId) return;

    if (qId.startsWith('py:')) {
      const parts = qId.split(':');
      const scriptId = parts[1];
      const dsName = parts[2] || '';
      this.sideTab = 'python';
      this.activePythonId = scriptId;
      this.pyLoading = true;
      this.queryService.runSavedPythonScript(scriptId).subscribe({
        next: (res) => {
          this.pyLoading = false;
          const datasets = res.data?.datasets || {};
          this.pyPreview = datasets;
          const names = Object.keys(datasets);
          if (!names.length) return;
          const targetDs = dsName && datasets[dsName] ? dsName : names[0];
          const ds = datasets[targetDs];
          const scriptName = this.pythonScripts.find(s => s.id === scriptId)?.name || scriptId;
          this.activeSource = {
            id: `py:${scriptId}:${targetDs}`,
            columns: ds.columns || [],
            label: `${scriptName} › ${targetDs}`,
            prefix: targetDs,
            description: `Python Script (${scriptName}) — '${targetDs}' veri seti çıktısı.`,
            kind: 'python',
            rows: (ds.rows || []).slice(0, 50),
            totalRows: ds.totalRows ?? (ds.rows || []).length,
            executionMs: res.data?.executionMs ?? 0,
          };
          if (this.activeSource.columns.length) {
            this.summaryField = this.activeSource.columns[0].name;
          }
          if (initData.autoBuildBlueprint) {
            this.buildSpaceMapReportSheet(initData);
          }
        },
        error: () => { this.pyLoading = false; }
      });
    } else {
      this.sideTab = 'queries';
      this.queryService.get(qId).subscribe({
        next: (qRes) => {
          const q = qRes.data;
          if (!q) return;
          this.activeSource = {
            id: q.id,
            columns: q.columns || [],
            label: q.name,
            prefix: '',
            description: q.description || '',
            kind: 'sql',
            dataSourceId: q.dataSourceId,
            rows: [],
            totalRows: 0,
            executionMs: 0,
          };
          this.sourceLoading = true;
          this.queryService.preview(q.id, {}, 50).subscribe({
            next: (pRes) => {
              this.sourceLoading = false;
              const cols = pRes.data?.columns || q.columns || [];
              const rows = pRes.data?.rows || [];
              if (this.activeSource && this.activeSource.id === q.id) {
                this.activeSource.columns = cols;
                this.activeSource.rows = rows;
                this.activeSource.totalRows = pRes.data?.totalRows ?? rows.length;
                this.activeSource.executionMs = pRes.data?.executionMs ?? 0;
                if (cols.length) this.summaryField = cols[0].name;
              }
              if (initData.autoBuildBlueprint) {
                this.buildSpaceMapReportSheet(initData);
              }
            },
            error: () => {
              this.sourceLoading = false;
              if (initData.autoBuildBlueprint && this.activeSource?.columns?.length) {
                this.buildSpaceMapReportSheet(initData);
              }
            }
          });
        }
      });
    }
  }

  private buildSpaceMapReportSheet(initData: any): void {
    if (!this.activeSource || !this.activeSource.columns?.length) return;
    const cols = this.activeSource.columns;
    const spanCols = Math.max(4, Math.min(cols.length, 8));
    const firstField = cols[0].name;

    this.sheet.rowHeights = this.sheet.rowHeights || {};
    this.sheet.rowHeights[1] = 36;
    this.sheet.rowHeights[2] = 26;

    // Satır 1: Başlık Banner
    this.sheet.cells['1,1'] = {
      row: 1,
      col: 1,
      value: (initData.name || 'SPACE MAP OPERASYONEL RAPORU').toUpperCase(),
      mergeAnchor: `1,1,1,${spanCols}`,
      style: { bold: true, fontSize: 14, bg: '#1F1B26', color: '#F5B301', align: 'left' }
    };

    // Satır 2: Meta & Canlı Özet Bilgisi
    this.sheet.cells['2,1'] = {
      row: 2, col: 1,
      value: initData.nodePath ? `Odak: ${initData.nodePath}` : `Kaynak: ${this.activeSource.label}`,
      style: { bold: true, bg: '#2F2934', color: '#38BDF8' }
    };
    this.sheet.cells['2,2'] = {
      row: 2, col: 2,
      value: '{{report_datetime}}',
      binding: { kind: 'builtin', builtin: 'report_datetime' },
      style: { bg: '#2F2934', color: '#E2E8F0' }
    };
    this.sheet.cells['2,3'] = {
      row: 2, col: 3,
      value: 'Toplam Kayıt:',
      style: { bold: true, bg: '#2F2934', color: '#94A3B8', align: 'right' }
    };
    this.sheet.cells['2,4'] = {
      row: 2, col: 4,
      value: `{{COUNT(${firstField})}}`,
      binding: { kind: 'summary', queryId: this.activeSource.id, field: firstField, operation: 'COUNT' },
      style: { bold: true, bg: '#2F2934', color: '#10B981', align: 'center' }
    };

    // Satır 4 & 5: Dinamik Kolon Başlıkları + DetailBand
    this.selected = { row: 4, col: 1 };
    this.autoInsertTableFromActiveSource();

    // Grafik ekle (en az 2 kolon varsa)
    if (cols.length >= 2) {
      this.sheet.charts = [{
        id: `ch_${Date.now().toString(36)}`,
        type: 'bar',
        anchor: { row: 8, col: 1, widthCols: Math.min(6, Math.max(4, cols.length)), heightRows: 11 },
        queryId: this.activeSource.id,
        title: `${initData.nodeLabel || this.activeSource.label} — Dağılım Analizi`
      }];
    }

    this.selected = { row: 1, col: 1 };
    this.touch();
    this.cdr.markForCheck();
  }

  /** Seçili aralığı aktif kaynağa detail band yap. */
  makeBand(): void {
    if (!this.rangeEnd || !this.activeSource) {
      this.notify('Please select a range (shift+click) and a data source first.');
      return;
    }
    if (this.livePreviewMode) this.exitLivePreview();
    const r1 = Math.min(this.selected.row, this.rangeEnd.row);
    const r2 = Math.max(this.selected.row, this.rangeEnd.row);
    const c1 = Math.min(this.selected.col, this.rangeEnd.col);
    const c2 = Math.max(this.selected.col, this.rangeEnd.col);
    const cols = this.activeSource.columns || [];
    const fieldMap: Record<number, string> = {};
    for (let c = c1; c <= c2; c++) {
      const col = cols[c - c1];
      if (col) fieldMap[c] = col.name;
    }
    const band: DetailBand = {
      id: `b_${Date.now().toString(36)}`,
      queryId: this.activeSource.id,
      range: { startRow: r1, startCol: c1, endRow: r2, endCol: c2 },
      fieldMap,
    };
    const isPy = this.activeSource.id.startsWith('py:');
    const prefix = isPy ? this.activeSource.prefix : '';
    for (let c = c1; c <= c2; c++) {
      if (!fieldMap[c]) continue;
      const cell = this.ensureCell(r1, c);
      cell.binding = { kind: 'query_field', queryId: this.activeSource.id, field: fieldMap[c] };
      cell.value = isPy && prefix ? `{{${prefix}.${fieldMap[c]}}}` : `{{${fieldMap[c]}}}`;
    }
    this.sheet.bands = [...(this.sheet.bands || []), band];
    this.rangeEnd = null;
    this.notify('Detail band added.');
    this.touch();
  }

  /** Seçili hücreye grafik yerleştir (aktif kaynak). */
  insertChart(type: 'bar' | 'line' | 'pie'): void {
    if (!this.activeSource) {
      this.notify('Please select a data source first.');
      return;
    }
    if (this.livePreviewMode) this.exitLivePreview();
    const chart = {
      id: `ch_${Date.now().toString(36)}`,
      type,
      anchor: { row: this.selected.row, col: this.selected.col, widthCols: 5, heightRows: 12 },
      queryId: this.activeSource.id,
      title: `${this.activeSource.label} (${type.toUpperCase()})`,
    };
    this.sheet.charts = [...(this.sheet.charts || []), chart];
    this.notify('Chart added.');
    this.touch();
  }

  insertBuiltin(name: string): void {
    if (!name) return;
    if (this.livePreviewMode) this.exitLivePreview();
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.binding = { kind: 'builtin', builtin: name };
    cell.value = `{{${name}}}`;
    this.touch();
  }

  clearCell(): void {
    if (this.livePreviewMode) return;
    const key = cellKey(this.selected.row, this.selected.col);
    delete this.sheet.cells[key];
    this.touch();
  }

  // ---- Canlı Çalıştırma / Dinamik Rapor Önizleme (Live Execution) ----

  toggleLivePreview(): void {
    if (this.livePreviewMode) {
      this.exitLivePreview();
    } else {
      this.executeLivePreview();
    }
  }

  executeLivePreview(): void {
    this.livePreviewLoading = true;
    this.templateService.evaluate(this.doc).subscribe({
      next: (res) => {
        this.livePreviewLoading = false;
        this.evaluatedResult = res.data;
        this.livePreviewMode = true;
        const statsCount = res.data?.queryStats?.length || 0;
        this.notify(`Rapor canlı çalıştırıldı (${statsCount} sorgu/script güncel verilerle hesaplandı).`);
      },
      error: (e) => {
        this.livePreviewLoading = false;
        this.notify('Canlı çalıştırma hatası: ' + (e.error?.error || e.message));
      },
    });
  }

  exitLivePreview(): void {
    this.livePreviewMode = false;
    this.evaluatedResult = null;
  }

  // ---- Sheet işlemleri ----

  addRows(n = 10): void { this.sheet.rowCount += n; }
  addCols(n = 4): void { this.sheet.columnCount += n; }

  selectSheet(i: number): void { this.sheetIndex = i; }

  addSheet(): void {
    this.doc.sheets.push(createEmptySheet(`Sheet${this.doc.sheets.length + 1}`));
    this.sheetIndex = this.doc.sheets.length - 1;
    this.touch();
  }

  // ---- Doküman: yeni / kaydet / render (.xlsx & .pdf) ----

  newDoc(): void {
    this.livePreviewMode = false;
    this.evaluatedResult = null;
    this.doc = createEmptyDocument('Untitled Template');
    this.sheetIndex = 0;
    this.activeSource = null;
    this.ensureCell(1, 1);
  }

  save(): void {
    const name = this.doc.name?.trim() || 'Untitled Template';
    this.doc.name = name;
    this.busy = true;
    const done = (msg: string) => { this.busy = false; this.notify(msg); this.loadTemplates(); };
    if (this.doc.id) {
      this.templateService.update(this.doc.id, this.doc, name, this.doc.description).subscribe({
        next: () => done('Saved successfully.'),
        error: (e) => { this.busy = false; this.notify('Save error: ' + (e.error?.error || e.message)); },
      });
    } else {
      this.templateService.create(name, this.doc, this.doc.description || '').subscribe({
        next: (res) => { this.doc.id = res.data.id; done('Created successfully.'); },
        error: (e) => { this.busy = false; this.notify('Create error: ' + (e.error?.error || e.message)); },
      });
    }
  }

  render(format: 'xlsx' | 'pdf' = 'xlsx'): void {
    const runRender = (id: string) => {
      this.busy = true;
      this.templateService.render(id, {}, format).subscribe({
        next: (blob) => {
          this.busy = false;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${(this.doc.name || 'template').replace(/\s+/g, '_')}.${format}`;
          a.click();
          URL.revokeObjectURL(url);
          this.notify(`${format.toUpperCase()} raporu güncel verilerle üretildi.`);
        },
        error: (e) => { this.busy = false; this.notify('Render error: ' + (e.error?.error || e.message)); },
      });
    };

    // Her zaman en güncel şablon tasarımını kaydedip canlı sorgularla çıktı üret
    const name = this.doc.name?.trim() || 'Untitled Template';
    this.doc.name = name;
    this.busy = true;
    if (this.doc.id) {
      this.templateService.update(this.doc.id, this.doc, name, this.doc.description).subscribe({
        next: () => runRender(this.doc.id!),
        error: () => runRender(this.doc.id!),
      });
    } else {
      this.templateService.create(name, this.doc, this.doc.description || '').subscribe({
        next: (res) => {
          this.doc.id = res.data.id;
          this.loadTemplates();
          runRender(res.data.id);
        },
        error: (e) => { this.busy = false; this.notify('Save before export failed: ' + (e.error?.error || e.message)); },
      });
    }
  }

  // ---- Dahili ----

  private touch(): void {
    this.doc.updatedAt = new Date().toISOString();
  }

  private notify(msg: string): void {
    this.feedback = msg;
    window.clearTimeout((this as any)._t);
    (this as any)._t = window.setTimeout(() => (this.feedback = ''), 2500);
  }

  /** Galeride göreceli tarih ("2 saat önce"). */
  relTime(iso?: string): string {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'az önce';
    if (m < 60) return `${m} dk önce`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} sa önce`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} gün önce`;
    return new Date(iso).toLocaleDateString();
  }
}
