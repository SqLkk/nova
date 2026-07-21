import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, combineLatest, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { QueryService, ApiEnvelope } from './query.service';
import { DataSource } from '../models/data-source.model';

export type SourceStatus = 'online' | 'offline' | 'checking';

/**
 * App-geneli seçili veri kaynağı (database) durumunu tutan paylaşılan servis.
 *
 * Navbar, Table Explorer, SQL Workspace, Python Workspace ve Path Definer
 * hepsi bu servise abone olur → tek bir seçim tüm uygulamada paylaşılır.
 *
 * Backend `/datasources` ham yanıtı snake_case'dir (`is_active`, `db_type`...);
 * burada camelCase `DataSource` modeline normalize edilir (mevcut query-creator
 * binding'ini de düzeltir). Online/offline probe'u `/datasources/{id}/tables`
 * endpoint'ini yeniden kullanır (table-explorer'daki kanıtlanmış yol).
 */
@Injectable({ providedIn: 'root' })
export class DataSourceSelectionService {
  private readonly base = `${environment.apiUrl}/datasources`;

  private readonly _dataSources$ = new BehaviorSubject<DataSource[]>([]);
  readonly dataSources$: Observable<DataSource[]> = this._dataSources$.asObservable();

  private readonly _statuses$ = new BehaviorSubject<Record<string, SourceStatus>>({});
  readonly statuses$: Observable<Record<string, SourceStatus>> = this._statuses$.asObservable();

  private readonly _selectedId$ = new BehaviorSubject<string | null>(null);
  readonly selectedId$: Observable<string | null> = this._selectedId$.asObservable();

  /** Seçili id + liste → seçili DataSource nesnesi (türetilmiş). */
  readonly selectedDataSource$: Observable<DataSource | null> = combineLatest([
    this._dataSources$,
    this._selectedId$,
  ]).pipe(map(([list, id]) => list.find(d => d.id === id) ?? null));

  /** Çoklu yüklemeyi önle. */
  private loaded = false;

  constructor(
    private queryService: QueryService,
    private http: HttpClient,
    private router: Router,
  ) {}

  // ---- Snapshot getter'lar ----

  get dataSources(): DataSource[] {
    return this._dataSources$.value;
  }

  get statuses(): Record<string, SourceStatus> {
    return this._statuses$.value;
  }

  get selectedId(): string | null {
    return this._selectedId$.value;
  }

  getById(id: string | null | undefined): DataSource | null {
    if (!id) return null;
    return this.dataSources.find(d => d.id === id) ?? null;
  }

  // ---- Yükleme ----

  /** Datasource listesini bir kez cache'ler (re-entrant güvenli). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    this.queryService.listDatasources().subscribe({
      next: (res: ApiEnvelope<DataSource[]>) => {
        const rawList: any[] = (res?.data ?? []) as any[];
        // Backend hem snake hem camel dönebilir; aktif olanları al.
        const active = rawList.filter(ds => ds.is_active === 1 || ds.isActive === true);
        const list = active.map(raw => this.normalize(raw));
        this._dataSources$.next(list);

        if (!this._selectedId$.value && list.length > 0) {
          this._selectedId$.next(list[0].id);
        }

        // Her kaynak için durum probe'u başlat.
        const next: Record<string, SourceStatus> = {};
        list.forEach(d => (next[d.id] = 'checking'));
        this._statuses$.next(next);
        list.forEach(d => this.probeStatus(d.id));
      },
      error: () => {
        this.loaded = false; // hata durumunda tekrar denenebilsin
      },
    });
  }

  /** Zorla yeniden yükle (admin yeni kaynak eklediyse). */
  refresh(): void {
    this.loaded = false;
    this.load();
  }

  // ---- Seçim ----

  /** Bir datasource seç ve (id non-null ise) table-explorer'a git. Bilinmeyen id → no-op. */
  select(id: string | null): void {
    if (id !== null && !this.getById(id)) return;
    this._selectedId$.next(id);
    if (id !== null) {
      this.router.navigate(['/table-explorer']);
    }
  }

  /** Seçimi navigasyonsuz temizle. */
  clearSelection(): void {
    this._selectedId$.next(null);
  }

  /**
   * Seçili id geçerli mi? Değilse ilk online (yoksa ilk) kaynağı seçer.
   * Direkt `/table-explorer` navigasyonunda boş ekran önler. Seçilen id'yi döner.
   */
  ensureValidSelection(): string | null {
    const list = this.dataSources;
    if (!list.length) {
      this._selectedId$.next(null);
      return null;
    }
    const current = this.selectedId;
    if (current && list.some(d => d.id === current)) return current;
    const firstOnline = list.find(d => this.statuses[d.id] === 'online');
    const pick = firstOnline?.id ?? list[0].id;
    this._selectedId$.next(pick);
    return pick;
  }

  // ---- Dahili ----

  /** snake_case raw → camelCase DataSource. */
  private normalize(raw: any): DataSource {
    return {
      id: raw.id,
      name: raw.name,
      dbType: raw.db_type ?? raw.dbType ?? 'unknown',
      host: raw.host,
      port: raw.port,
      databaseName: raw.database_name ?? raw.databaseName,
      isActive: raw.is_active === 1 || raw.isActive === true,
      createdAt: raw.created_at ?? raw.createdAt,
      updatedAt: raw.updated_at ?? raw.updatedAt,
    } as DataSource;
  }

  /** `/datasources/{id}/tables` → success=online, error=offline. Yeni obje emit eder. */
  private probeStatus(id: string): void {
    this.http.get<any>(`${this.base}/${id}/tables`).subscribe({
      next: (res) => this.patchStatus(id, res && res.success ? 'online' : 'offline'),
      error: () => this.patchStatus(id, 'offline'),
    });
  }

  private patchStatus(id: string, status: SourceStatus): void {
    this._statuses$.next({ ...this._statuses$.value, [id]: status });
  }
}
