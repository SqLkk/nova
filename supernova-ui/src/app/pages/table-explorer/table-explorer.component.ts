import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { DataSourceSelectionService, SourceStatus } from '../../services/data-source-selection.service';
import { ConfirmService } from '../../services/confirm.service';

export interface TableInfo {
  id: string;
  name: string;
}

export interface ColumnDef {
  field: string;
  header: string;
  type: string;        // normalize edilmiş: string|number|datetime|boolean
  nullable: boolean;
  isPrimaryKey: boolean;
}

@Component({
  selector: 'app-table-explorer',
  templateUrl: './table-explorer.component.html',
  styleUrls: ['./table-explorer.component.scss'],
  standalone: false
})
export class TableExplorerComponent implements OnInit, OnDestroy {
  /** Seçili DB id'si (paylaşılan servisten). */
  selectedId: string | null = null;
  /** Status map (paylaşılan servisten). */
  statusMap: Record<string, SourceStatus> = {};

  tables: TableInfo[] = [];
  selectedTable: string | null = null;
  activeTab: 'data' | 'schema' = 'data';
  showPathDefiner = false;

  togglePathDefiner(): void {
    this.showPathDefiner = !this.showPathDefiner;
  }

  columns: ColumnDef[] = [];
  data: any[] = [];
  loading = false;

  // Arama: sol ağaç + veri filtresi.
  searchTermTable = '';
  searchQuery = '';

  // Sayfalama.
  pageSize = 100;
  offset = 0;
  rowCount: number | null = null;

  private selSub?: Subscription;
  private statusSub?: Subscription;

  constructor(
    private http: HttpClient,
    public dss: DataSourceSelectionService,
    private confirmService: ConfirmService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.dss.load();
    this.dss.ensureValidSelection();

    this.selSub = this.dss.selectedId$.subscribe(id => {
      if (id !== this.selectedId) {
        this.selectedId = id;
        this.onSourceChange(id);
        this.cdr.markForCheck();
      }
    });

    this.statusSub = this.dss.statuses$.subscribe(st => {
      this.statusMap = st;
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.selSub?.unsubscribe();
    this.statusSub?.unsubscribe();
  }

  /** Seçili DB değişince tablo listesini yükle. dss.select() çağırmaz (loop). */
  onSourceChange(sourceId: string | null): void {
    this.selectedTable = null;
    this.tables = [];
    this.columns = [];
    this.data = [];
    this.offset = 0;
    this.rowCount = null;

    if (!sourceId) return;

    this.http.get<any>(`${environment.apiUrl}/datasources/${sourceId}/tables`).subscribe(res => {
      if (res && res.success) {
        this.tables = res.data.map((tableName: string) => ({ id: tableName, name: tableName }));
      }
      this.cdr.markForCheck();
    });
  }

  refreshTablesList(): void {
    if (!this.selectedId) return;
    this.http.get<any>(`${environment.apiUrl}/datasources/${this.selectedId}/tables?refresh=1`).subscribe({
      next: (res) => {
        if (res && res.success) {
          this.tables = res.data.map((tableName: string) => ({ id: tableName, name: tableName }));
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        alert(err?.error?.message || 'Failed to refresh table list.');
        this.cdr.markForCheck();
      }
    });
  }

  getSelectedSourceName(): string {
    const ds = this.dss.getById(this.selectedId);
    return ds ? ds.name : 'Unknown Database';
  }

  /** Sol ağacı search'e göre filtrele. */
  get filteredTables(): TableInfo[] {
    const term = this.searchTermTable.trim().toLowerCase();
    if (!term) return this.tables;
    return this.tables.filter(t => t.name.toLowerCase().includes(term));
  }

  /** Mevcut sayfadaki satırları client-side filtrele. */
  get filteredData(): any[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.data;
    return this.data.filter(row =>
      this.columns.some(col => {
        const v = row[col.field];
        return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
      })
    );
  }

  selectTable(tableName: string, resetOffset = true): void {
    if (!this.selectedId || !tableName) return;

    this.selectedTable = tableName;
    if (resetOffset) {
      this.offset = 0;
    }
    this.loading = true;

    const base = `${environment.apiUrl}/datasources/${this.selectedId}/tables/${tableName}`;
    // Şema (cache'li metadata) + sayfalı veriyi paralel çek.
    const schema$ = this.http.get<any>(`${base}/schema`);
    const data$ = this.http.get<any>(`${base}?limit=${this.pageSize}&offset=${this.offset}`);

    let pending = 2;
    const done = () => { if (--pending === 0) this.loading = false; };

    schema$.subscribe({
      next: (res) => {
        if (res && res.success && res.data) {
          this.columns = (res.data.columns || []).map((c: any) => ({
            field: c.name,
            header: c.name,
            type: this.normalizeType(c.dataType),
            nullable: c.nullable !== false,
            isPrimaryKey: !!c.isPrimaryKey
          }));
          if (res.data.rowCount !== null && res.data.rowCount !== undefined) {
            this.rowCount = res.data.rowCount;
          }
          this.activeTab = 'data';
        }
        done();
        this.cdr.markForCheck();
      },
      error: () => {
        done();
        this.cdr.markForCheck();
      }
    });

    data$.subscribe({
      next: (res) => {
        if (res && res.success && res.data) {
          this.data = res.data.rows || [];
          // Şema boş gelirse (ör. izin yoksa) kolonları satırdan türet.
          if (!this.columns.length && this.data.length > 0) {
            this.columns = Object.keys(this.data[0]).map(k => ({
              field: k, header: k, type: this.normalizeType(typeof this.data[0][k]), nullable: true, isPrimaryKey: false
            }));
          }
          if (res.data.rowCount !== null && res.data.rowCount !== undefined) {
            this.rowCount = res.data.rowCount;
          }
        }
        done();
        this.cdr.markForCheck();
      },
      error: () => {
        done();
        this.cdr.markForCheck();
        this.loading = false;
        this.confirmService.alert('Failed to load table data.');
      }
    });
  }

  nextPage(): void {
    if (this.rowCount === null || this.offset + this.pageSize >= this.rowCount) return;
    this.offset += this.pageSize;
    this.selectTable(this.selectedTable!, false);
  }

  prevPage(): void {
    if (this.offset <= 0) return;
    this.offset = Math.max(0, this.offset - this.pageSize);
    this.selectTable(this.selectedTable!, false);
  }

  get page(): number {
    return Math.floor(this.offset / this.pageSize) + 1;
  }

  get totalPages(): number | null {
    if (this.rowCount === null) return null;
    return Math.max(1, Math.ceil(this.rowCount / this.pageSize));
  }

  refresh(): void {
    if (this.selectedTable) {
      this.offset = 0;
      this.selectTable(this.selectedTable, false);
    }
  }

  /** DB veri tipini UI ikik/rengi için normalize et. */
  private normalizeType(t?: string): string {
    const s = (t || '').toLowerCase();
    if (/int|float|double|num|dec|real|long|short/.test(s)) return 'number';
    if (/date|time|stamp/.test(s)) return 'datetime';
    if (/bool/.test(s)) return 'boolean';
    return 'string';
  }
}
