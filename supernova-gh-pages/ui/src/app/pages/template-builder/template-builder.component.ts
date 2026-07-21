import { Component, OnInit, HostListener } from '@angular/core';
import { Router } from '@angular/router';
import { DomSanitizer, SafeStyle } from '@angular/platform-browser';
import { QueryService } from '../../services/query.service';
import { TemplateBuilderService, TemplateSummary } from '../../services/template-builder.service';
import { SavedQuery, QueryResult, QueryColumn, SavedPythonScript } from '../../models/query.model';
import { DataSource } from '../../models/data-source.model';
import { ConfirmService } from '../../services/confirm.service';
import {
  TemplateDocument, TemplateSheet, TemplateCell, DetailBand,
  CellBinding, SummaryOperation, cellKey, createEmptyDocument, createEmptySheet,
} from '../../models/template-document.model';

/** Birleştirilmiş veri kaynağı (SQL sorgusu veya Python dataset). */
interface ActiveSource {
  id: string;
  columns: QueryColumn[];
  label: string;
  /** Python ise dataset adı (hücre gösterimi için); SQL ise boş. */
  prefix?: string;
}

@Component({
  standalone: false,
  selector: 'app-template-builder',
  templateUrl: './template-builder.component.html',
  styleUrls: ['./template-builder.component.scss'],
})
export class TemplateBuilderComponent implements OnInit {
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

  /** Birleştirilmiş aktif kaynak — SQL veya Python dataset. */
  activeSource: ActiveSource | null = null;
  sourceLoading = false;

  /** Python preview: seçilen script'in sandbox çıktı dataset'leri. */
  activePythonId: string | null = null;
  pyPreview: Record<string, QueryResult> | null = null;
  pyError = '';
  pyLoading = false;

  /** Şablon kütüphanesi (galeri). */
  templates: TemplateSummary[] = [];
  searchTemplates = '';

  /** Yeni sorgu formu. */
  showQueryForm = false;
  newQuery: Partial<SavedQuery> & { dataSourceId?: string } = { name: '', sql: '', dataSourceId: '' };

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
    private queryService: QueryService,
    private templateService: TemplateBuilderService,
    private sanitizer: DomSanitizer,
    private confirmService: ConfirmService,
  ) { }

  ngOnInit(): void {
    this.loadQueries();
    this.loadTemplates();
    this.loadPythonScripts();
    this.ensureCell(this.selected.row, this.selected.col);
  }

  // ---- Yükleyiciler ----

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: (res) => (this.queries = res.data || []),
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
      next: (res) => (this.pythonScripts = res.data || []),
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
        this.doc = res.data.model;
        if (!this.doc.sheets?.length) this.doc.sheets = [createEmptySheet('Sheet1')];
        this.sheetIndex = 0;
        this.activeSource = null;
        this.ensureCell(1, 1);
        this.mode = 'editor';
        this.notify(`"${t.name}" loaded.`);
      },
      error: () => this.notify('Could not load template.'),
    });
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

  get rowCount(): number {
    return this.sheet.rowCount;
  }

  get colCount(): number {
    return this.sheet.columnCount;
  }

  rowsArray(): number[] {
    return Array.from({ length: this.rowCount }, (_, i) => i + 1);
  }

  colsArray(): number[] {
    return Array.from({ length: this.colCount }, (_, i) => i + 1);
  }

  colLetter(c: number): string {
    return String.fromCharCode(64 + c); // 1..26 → A..Z
  }

  cellAt(r: number, c: number): TemplateCell | undefined {
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
    for (const cell of Object.values(this.sheet.cells)) {
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

  // ---- Biçimlendirme (toolbar) ----

  toggleBold(): void {
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.style = { ...(cell.style || {}) };
    cell.style.bold = !cell.style.bold;
    this.touch();
  }

  setFill(hex: string): void {
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.style = { ...(cell.style || {}) };
    cell.style.bg = hex;
    this.touch();
  }

  // ---- Sol panel: Sorgular ----

  selectQuery(q: SavedQuery): void {
    this.activeSource = { id: q.id, columns: q.columns || [], label: q.name, prefix: '' };
    this.sourceLoading = true;
    this.queryService.preview(q.id, {}, 50).subscribe({
      next: (res) => {
        const cols = res.data?.columns || q.columns || [];
        if (this.activeSource?.id === q.id) this.activeSource.columns = cols;
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

  selectPythonScript(s: SavedPythonScript): void {
    this.activePythonId = s.id;
    this.pyLoading = true;
    this.pyError = '';
    this.pyPreview = null;
    this.queryService.runPython(s.code, s.sqlQueryIds || [], {}).subscribe({
      next: (res) => {
        this.pyLoading = false;
        this.pyPreview = res.data || {};
        if (!Object.keys(this.pyPreview).length) {
          this.pyError = "No output. Use out('name').append({...}) in your script.";
        }
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

  selectPythonDataset(dsName: string): void {
    const s = this.activePython;
    const ds = this.pyPreview?.[dsName];
    if (!s || !ds) return;
    this.activeSource = {
      id: `py:${s.id}:${dsName}`,
      columns: ds.columns || [],
      label: `${s.name} › ${dsName}`,
      prefix: dsName,
    };
  }

  // ---- Bağlama (binding) ----

  /** Aktif kaynağın bir alanını seçili hücreye bağla. */
  bindField(field: string): void {
    if (!this.activeSource) return;
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    const isPy = this.activeSource.id.startsWith('py:');
    const display = isPy && this.activeSource.prefix
      ? `{{${this.activeSource.prefix}.${field}}}`
      : `{{${field}}}`;
    const binding: CellBinding = { kind: 'query_field', queryId: this.activeSource.id, field };
    cell.binding = binding;
    cell.value = display;
    this.touch();
  }

  /** Seçili hücreye özet (summary) bağla. */
  bindSummary(op: SummaryOperation): void {
    if (!this.activeSource) return;
    const field = this.activeSource.columns?.[0]?.name ?? '';
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.binding = { kind: 'summary', queryId: this.activeSource.id, field, operation: op };
    cell.value = `{{${op}(${field})}}`;
    this.touch();
  }

  /** Seçili aralığı aktif kaynağa detail band yap. */
  makeBand(): void {
    if (!this.rangeEnd || !this.activeSource) {
      this.notify('Please select a range (shift+click) and a data source first.');
      return;
    }
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
    const chart = {
      id: `ch_${Date.now().toString(36)}`,
      type,
      anchor: { row: this.selected.row, col: this.selected.col, widthCols: 5, heightRows: 12 },
      queryId: this.activeSource.id,
      title: type.toUpperCase(),
    };
    this.sheet.charts = [...(this.sheet.charts || []), chart];
    this.notify('Chart added.');
    this.touch();
  }

  insertBuiltin(name: string): void {
    const cell = this.ensureCell(this.selected.row, this.selected.col);
    cell.binding = { kind: 'builtin', builtin: name };
    cell.value = `{{${name}}}`;
    this.touch();
  }

  clearCell(): void {
    const key = cellKey(this.selected.row, this.selected.col);
    delete this.sheet.cells[key];
    this.touch();
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

  // ---- Doküman: yeni / kaydet / render ----

  newDoc(): void {
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

  render(): void {
    if (!this.doc.id) {
      this.notify('Please save first.');
      return;
    }
    this.busy = true;
    this.templateService.render(this.doc.id).subscribe({
      next: (blob) => {
        this.busy = false;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(this.doc.name || 'template').replace(/\s+/g, '_')}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
        this.notify('Excel generated successfully.');
      },
      error: (e) => { this.busy = false; this.notify('Render error: ' + (e.error?.error || e.message)); },
    });
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
