import { ChangeDetectorRef, Component, OnInit, OnChanges, OnDestroy, SimpleChanges, Input } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { PathService } from '../../services/path.service';
import { QueryService } from '../../services/query.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { SavedQuery, SavedPythonScript } from '../../models/query.model';
import { DataSource } from '../../models/data-source.model';
import { AiContextService } from '../../services/ai-context.service';
import {
  PathDef, PathStructure, PathConfig, PreviewResult, SearchResult,
  StructureOption, PathNode,
} from '../../models/path-def.model';
import { AVAILABLE_ICONS, THEME_PRESETS, SpaceMapTheme } from '../../pages/network-map/network-map.component';

/** Önizlemede girintili ağaç için iç içe model. */
interface TreeNode {
  node: PathNode;
  children: TreeNode[];
}

export interface DbFunctionItem {
  name: string;
  type: string;
  signature: string;
  description: string;
  packageName?: string | null;
  queryId?: string;
  defaultStructure?: PathStructure;
  defaultConfig?: PathConfig;
}

@Component({
  standalone: false,
  selector: 'app-path-definer',
  templateUrl: './path-definer.component.html',
  styleUrls: ['./path-definer.component.scss'],
})
export class PathDefinerComponent implements OnInit, OnChanges, OnDestroy {
  private releaseAi: Array<() => void> = [];
  /** Dış bileşenden gelen DB scope (null/undefined → tüm liste). */
  @Input() dataSourceId: string | null | undefined;

  /** Table Explorer'dan gelen seçili tablo adı */
  @Input() tableName: string | null = null;

  view: 'library' | 'build' | 'search' = 'library';

  paths: PathDef[] = [];
  searchLib = '';
  showAllDbPaths = true;

  /** Path tanımlama yetkisi: engineer/admin/superuser. */
  canDefine = false;

  /** Build kaynağını seçme sekmesi: Kayıtlı Sorgu/Query Viewer | Python Script | DB Tablo | DB Package/Procedure */
  sourceMode: 'query' | 'python' | 'table' | 'package' = 'query';
  showQueryViewerModal = false;

  /** DB kaynakları, tablolar, paket/prosedürler ve Python scriptleri */
  dataSources: DataSource[] = [];
  activeDbId = '';
  dbTables: string[] = [];
  dbFunctions: DbFunctionItem[] = [];
  selectedTableName = '';
  selectedFunctionName = '';

  pythonScripts: SavedPythonScript[] = [];
  selectedPyScriptId = '';
  selectedPyDataset = '';
  pyDatasets: string[] = [];

  /** Build formu. */
  form = {
    id: '' as string,
    name: '',
    description: '',
    queryId: '' as string,
    structure: 'tree' as PathStructure,
    config: {} as PathConfig,
  };
  queries: SavedQuery[] = [];
  queryColumns: string[] = [];
  preview: PreviewResult | null = null;
  previewLoading = false;
  previewError = '';
  saving = false;

  /** Space Map Görsel & İkon Ayarları (Path Definer içinden doğrudan yapılandırılabilir) */
  readonly availableIcons = AVAILABLE_ICONS;
  readonly mapThemes: Array<{ id: SpaceMapTheme; label: string; icon: string }> = [
    { id: 'factory', label: 'Fabrika / Endüstriyel', icon: 'fa-industry' },
    { id: 'cyber', label: 'Siber Ağ / IoT', icon: 'fa-network-wired' },
    { id: 'blueprint', label: 'Mühendislik Blueprint', icon: 'fa-drafting-compass' },
    { id: 'crystal', label: 'Kristal / Prizma', icon: 'fa-gem' },
    { id: 'cosmic', label: 'Kozmik Yörünge', icon: 'fa-satellite' },
  ];
  readonly mapLayouts: Array<{ id: 'radial' | 'hierarchy-tb' | 'flow-lr' | 'grid' | 'spiral'; label: string; icon: string }> = [
    { id: 'radial', label: 'Radial (Yörünge)', icon: 'fa-circle-dot' },
    { id: 'hierarchy-tb', label: 'Ağaç (Yukarıdan Aşağı)', icon: 'fa-sitemap' },
    { id: 'flow-lr', label: 'Proses Akışı (Soldan Sağa)', icon: 'fa-arrow-right-long' },
    { id: 'grid', label: 'Kümelenmiş Matris (Grid)', icon: 'fa-table-cells-large' },
    { id: 'spiral', label: 'Galaksi / Spiral', icon: 'fa-hurricane' },
  ];

  /** Arama. */
  searchPath: PathDef | null = null;
  term = '';
  searchResult: SearchResult | null = null;
  searchLoading = false;

  toast = '';

  readonly structures: StructureOption[] = [
    { value: 'tree', label: 'Tree (Ağaç)', icon: 'fa-sitemap', hint: 'ID → Parent ID hiyerarşisi' },
    { value: 'multi_level', label: 'Multi-Level (Katmanlı)', icon: 'fa-layer-group', hint: 'Düz tablodan L1 › L2 › L3 › Yaprak' },
    { value: 'dag', label: 'DAG (Yönlü Ağ)', icon: 'fa-project-diagram', hint: 'Çoklu ebeveyn / üretim rotası' },
    { value: 'sequence', label: 'Sequence (Zincir)', icon: 'fa-list-ol', hint: 'Sıralı adım / proses zinciri' },
    { value: 'grouped', label: 'Grouped (Küme)', icon: 'fa-object-group', hint: 'Tek kolona göre hızlı kümeleme' },
    { value: 'binary_tree', label: 'Binary Tree', icon: 'fa-tree', hint: 'Her düğüm ≤ 2 alt dal' },
  ];

  constructor(
    private http: HttpClient,
    private pathService: PathService,
    private queryService: QueryService,
    private auth: AuthService,
    private confirmService: ConfirmService,
    private router: Router,
    private aiContext: AiContextService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    const bridge = {
      context: () => ({
        active_queries: this.queries.filter(q => q.id === this.form.queryId).map(q => ({ id: q.id, name: q.name, columns: q.columns })),
        path_config: this.form.config, structure: this.form.structure, data_source_id: this.dataSourceId || undefined,
      }),
      accepts: (language: string) => language === 'json' && this.canDefine,
      apply: (_language: string, _content: string, artifact: any) => {
        if (!artifact) throw new Error('Path JSON doğrulanamadı.');
        this.view = 'build'; this.form.structure = artifact.structure;
        this.form.queryId = artifact.queryId; this.form.config = artifact.config;
        this.ensureSpaceMapConfig();
        this.preview = null; this.previewError = ''; this.loadQueryColumns(artifact.queryId);
        this.notify('Copilot yapılandırması aktarıldı.');
        this.cdr.markForCheck();
      },
    };
    this.releaseAi = ['table-explorer'].map(page => this.aiContext.register(page, bridge));
    this.canDefine = this.auth.hasRole('engineer');
    this.activeDbId = this.dataSourceId || '';
    this.loadPaths();
    this.loadQueries();
    this.loadPythonScripts();
    this.loadDataSources();
  }

  ngOnDestroy(): void { this.releaseAi.forEach(release => release()); }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataSourceId']) {
      this.activeDbId = this.dataSourceId || this.activeDbId;
      this.loadQueries();
      this.loadPaths();
      if (this.activeDbId) {
        this.loadDbObjects(this.activeDbId);
      }
    }
    if (changes['tableName'] && this.tableName) {
      this.handleTableNameChange(this.tableName);
    }
  }

  handleTableNameChange(tableName: string, dsOverride?: string): void {
    const targetDs = dsOverride || this.activeDbId || this.dataSourceId;
    if (!targetDs) return;
    this.view = 'build';
    this.sourceMode = 'table';
    this.selectedTableName = tableName;
    if (!this.form.name) {
      this.form.name = `${tableName} — Hiyerarşi Haritası`;
      this.form.description = `${tableName} tablosundan üretilen dinamik uzay haritası.`;
    }

    const autoName = `[Auto] ${tableName}`;
    const q = this.queries.find(x => (x.name === autoName || x.sql?.trim() === `SELECT * FROM ${tableName}`) && x.dataSourceId === targetDs);

    if (q) {
      this.form.queryId = q.id;
      this.loadQueryColumns(q.id, true);
    } else {
      this.queryService.create({
        name: autoName,
        dataSourceId: targetDs,
        sql: `SELECT * FROM ${tableName}`,
        description: `${tableName} tablosu için otomatik Path Definer sorgusu.`,
        isActive: true
      }).subscribe({
        next: (res) => {
          if (res.success && res.data) {
            this.queries.push(res.data);
            this.form.queryId = res.data.id;
            this.loadQueryColumns(res.data.id, true);
            this.notify(`Tablo bağlandı: ${tableName}`);
          }
        },
        error: () => this.notify('Tablo sorgusu oluşturulamadı.')
      });
    }
  }

  // ---- Yükleyiciler ----

  loadPaths(): void {
    this.pathService.list().subscribe({
      next: (res) => {
        this.paths = res.data || [];
        this.cdr.markForCheck();
      },
      error: () => (this.paths = []),
    });
  }

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: (res) => {
        this.queries = res.data || [];
        this.cdr.markForCheck();
      },
      error: () => (this.queries = []),
    });
  }

  loadPythonScripts(): void {
    this.queryService.listPythonScripts().subscribe({
      next: (res) => {
        this.pythonScripts = res.data || [];
        this.cdr.markForCheck();
      },
      error: () => (this.pythonScripts = []),
    });
  }

  loadDataSources(): void {
    this.queryService.listDatasources().subscribe({
      next: (res) => {
        this.dataSources = res.data || [];
        if (!this.activeDbId && this.dataSources.length) {
          this.activeDbId = this.dataSourceId || this.dataSources[0].id;
        }
        if (this.activeDbId) {
          this.loadDbObjects(this.activeDbId);
        }
        this.cdr.markForCheck();
      },
      error: () => (this.dataSources = []),
    });
  }

  loadDbObjects(dsId: string): void {
    if (!dsId) return;
    this.http.get<any>(`${environment.apiUrl}/datasources/${dsId}/tables`).subscribe({
      next: (res) => {
        this.dbTables = (res?.data || []) as string[];
        this.cdr.markForCheck();
      },
      error: () => (this.dbTables = []),
    });
    this.http.get<any>(`${environment.apiUrl}/datasources/${dsId}/functions`).subscribe({
      next: (res) => {
        this.dbFunctions = (res?.data || []) as DbFunctionItem[];
        this.cdr.markForCheck();
      },
      error: () => (this.dbFunctions = []),
    });
  }

  onActiveDbChange(): void {
    this.loadDbObjects(this.activeDbId);
  }

  /** DB scope'lu query id seti (filteredPaths için). */
  private get scopedQueryIds(): Set<string> {
    if (!this.dataSourceId || this.showAllDbPaths) {
      return new Set(this.queries.map(q => q.id));
    }
    return new Set(
      this.queries.filter(q => q.dataSourceId === this.dataSourceId).map(q => q.id)
    );
  }

  get scopedQueries(): SavedQuery[] {
    if (!this.activeDbId || this.showAllDbPaths) return this.queries;
    const filtered = this.queries.filter(q => q.dataSourceId === this.activeDbId);
    return filtered.length ? filtered : this.queries;
  }

  get selectedQueryObj(): SavedQuery | undefined {
    return this.queries.find(q => q.id === this.form.queryId);
  }

  get selectedPythonObj(): SavedPythonScript | undefined {
    return this.pythonScripts.find(s => s.id === this.selectedPyScriptId);
  }

  get filteredPaths(): PathDef[] {
    const ids = this.scopedQueryIds;
    let list = this.paths.filter(p => this.showAllDbPaths || !this.dataSourceId || p.queryId?.startsWith('py:') || ids.has(p.queryId));
    const t = this.searchLib.trim().toLowerCase();
    if (t) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(t) ||
        (p.description || '').toLowerCase().includes(t) ||
        (p.structure || '').toLowerCase().includes(t)
      );
    }
    return list;
  }

  get groupedPackages(): Array<{ pkg: string; items: DbFunctionItem[] }> {
    const map = new Map<string, DbFunctionItem[]>();
    for (const fn of this.dbFunctions) {
      const pkg = fn.packageName || 'STANDALONE FUNCTIONS';
      if (!map.has(pkg)) map.set(pkg, []);
      map.get(pkg)!.push(fn);
    }
    return Array.from(map.entries()).map(([pkg, items]) => ({ pkg, items }));
  }

  structureMeta(s: PathStructure): StructureOption {
    return this.structures.find((x) => x.value === s) || this.structures[0];
  }

  sourceLabelForPath(p: PathDef): string {
    if (!p.queryId) return '—';
    if (p.queryId.startsWith('py:')) {
      const parts = p.queryId.split(':');
      const py = this.pythonScripts.find(s => s.id === parts[1]);
      return py ? `Python: ${py.name} (${parts[2] || 'out'})` : p.queryId;
    }
    return this.queries.find(q => q.id === p.queryId)?.name || p.queryId;
  }

  // ---- Library ----

  newBuild(): void {
    this.form = {
      id: '',
      name: '',
      description: '',
      queryId: '',
      structure: 'tree',
      config: {
        spaceMapConfig: {
          theme: 'factory',
          nodeShape: 'hexagon',
          layout: 'radial',
          color1: '#F59E0B',
          color2: '#10B981',
          color3: '#06B6D4',
          level1Icon: 'fa-industry',
          level2Icon: 'fa-cogs',
          level3Icon: 'fa-robot',
          level4Icon: 'fa-gauge-high',
          autoTypeIcons: true,
          showOrbits: true,
          showGrid: true,
        }
      },
    };
    this.sourceMode = 'query';
    this.queryColumns = [];
    this.preview = null;
    this.previewError = '';
    this.view = 'build';
  }

  editBuild(def: PathDef): void {
    this.form = {
      id: def.id,
      name: def.name,
      description: def.description || '',
      queryId: def.queryId,
      structure: def.structure,
      config: JSON.parse(JSON.stringify(def.config || {})),
    };
    this.ensureSpaceMapConfig();
    if (def.queryId?.startsWith('py:')) {
      this.sourceMode = 'python';
      const parts = def.queryId.split(':');
      this.selectedPyScriptId = parts[1] || '';
      this.selectedPyDataset = parts[2] || '';
      this.loadPythonColumns(this.selectedPyScriptId, this.selectedPyDataset, false);
    } else {
      this.sourceMode = 'query';
      this.loadQueryColumns(def.queryId, false);
    }
    this.preview = null;
    this.previewError = '';
    this.view = 'build';
    setTimeout(() => this.doPreview(), 100);
  }

  async deletePath(def: PathDef, ev: Event): Promise<void> {
    ev.stopPropagation();
    if (!this.canDefine) return;
    if (!await this.confirmService.confirm(`"${def.name}" harita tanımını silmek istediğinize emin misiniz?`)) return;
    this.pathService.remove(def.id).subscribe({
      next: () => { this.notify('Harita tanımı silindi.'); this.loadPaths(); },
      error: () => this.notify('Silme sırasında hata oluştu.'),
    });
  }

  openSearch(def: PathDef): void {
    this.searchPath = def;
    this.term = '';
    this.searchResult = null;
    this.view = 'search';
  }

  openInMap(def: PathDef): void {
    const q = this.queries.find(x => x.id === def.queryId);
    const dsId = (q as any)?.dataSourceId || (q as any)?.data_source_id || this.dataSourceId;
    this.router.navigate(['/network-map'], {
      queryParams: {
        pathId: def.id,
        ...(dsId ? { dataSourceId: dsId } : {})
      }
    });
  }

  /** Space Map / Path tanımından tek tıkla Template Builder'da dinamik rapor oluştur! */
  createReportFromPath(def: PathDef, ev?: Event): void {
    if (ev) ev.stopPropagation();
    sessionStorage.setItem('templateBuilderInitialQuery', JSON.stringify({
      queryId: def.queryId,
      name: `${def.name} — Raporu`,
      description: def.description || `${def.name} hiyerarşi haritası dinamik veri raporu.`,
      pathId: def.id,
      pathName: def.name,
      autoBuildBlueprint: true,
    }));
    this.router.navigate(['/template-builder']);
  }

  // ---- Query Viewer Modal, Python, Tablo ve Package Seçiciler ----

  onQueryViewerSelected(item: any): void {
    this.showQueryViewerModal = false;
    if (!item) return;
    if (item.source === 'python') {
      this.sourceMode = 'python';
      const rawId = String(item.id || '').replace(/^py:/, '');
      this.selectedPyScriptId = rawId;
      const ds = item.datasetName || item.datasetNames?.[0] || 'default';
      this.selectedPyDataset = ds;
      this.form.queryId = `py:${rawId}:${ds}`;
      if (!this.form.name) {
        this.form.name = `${item.name} (${ds}) — Uzay Haritası`;
        this.form.description = item.description || '';
      }
      this.loadPythonColumns(rawId, ds, true);
    } else {
      this.sourceMode = 'query';
      this.form.queryId = item.id;
      if (!this.form.name) {
        this.form.name = `${item.name} — Uzay Haritası`;
        this.form.description = item.description || '';
      }
      this.onQueryChange();
    }
  }

  onSelectPythonScript(): void {
    const s = this.pythonScripts.find(x => x.id === this.selectedPyScriptId);
    if (!s) return;
    this.pyDatasets = s.datasetNames?.length ? s.datasetNames : [];
    this.selectedPyDataset = this.pyDatasets[0] || '';
    this.loadPythonColumns(s.id, this.selectedPyDataset, true);
  }

  onSelectPythonDataset(): void {
    if (!this.selectedPyScriptId || !this.selectedPyDataset) return;
    this.loadPythonColumns(this.selectedPyScriptId, this.selectedPyDataset, true);
  }

  private loadPythonColumns(scriptId: string, datasetName: string, autoSuggest = true): void {
    if (!scriptId) return;
    this.queryService.getPythonScriptColumns(scriptId, datasetName).subscribe({
      next: (res) => {
        const dsNames = (res.datasets || []).map((d: any) => d.name).filter(Boolean);
        if (dsNames.length) this.pyDatasets = dsNames;
        const targetDs = datasetName || dsNames[0] || 'default';
        this.selectedPyDataset = targetDs;
        this.form.queryId = `py:${scriptId}:${targetDs}`;
        this.queryColumns = res.data || [];
        if (autoSuggest && this.queryColumns.length) {
          this.applySuggestedMapping();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.queryColumns = [];
        this.cdr.markForCheck();
      }
    });
  }

  onSelectDbFunction(fn: DbFunctionItem): void {
    this.selectedFunctionName = fn.name;
    this.form.name = `${fn.name} — Topoloji Haritası`;
    this.form.description = fn.description || `${fn.signature} prosedür çıktısı hiyerarşisi.`;
    if (fn.defaultStructure) {
      this.form.structure = fn.defaultStructure;
    }
    if (fn.queryId) {
      this.form.queryId = fn.queryId;
      this.ensureSpaceMapConfig();
      if (fn.defaultConfig) {
        const smc = this.form.config.spaceMapConfig;
        this.form.config = { ...fn.defaultConfig, spaceMapConfig: smc };
      }
      this.loadQueryColumns(fn.queryId, !fn.defaultConfig);
      setTimeout(() => this.doPreview(), 80);
    } else {
      this.notify(`${fn.name} seçildi. Lütfen bağlı sorguyu seçin.`);
    }
  }

  // ---- Build: sorgu & yapı ----

  onQueryChange(): void {
    const q = this.queries.find(x => x.id === this.form.queryId);
    if (q && !this.form.name) {
      this.form.name = `${q.name} — Haritası`;
      this.form.description = q.description || '';
    }
    this.loadQueryColumns(this.form.queryId, true);
    this.preview = null;
  }

  onStructureChange(): void {
    if (this.queryColumns.length) {
      this.applySuggestedMapping();
    }
    this.preview = null;
  }

  private ensureSpaceMapConfig(): void {
    if (!this.form.config) this.form.config = {};
    if (!this.form.config.spaceMapConfig) {
      this.form.config.spaceMapConfig = {
        theme: 'factory',
        nodeShape: 'hexagon',
        layout: 'radial',
        color1: '#F59E0B',
        color2: '#10B981',
        color3: '#06B6D4',
        level1Icon: 'fa-industry',
        level2Icon: 'fa-cogs',
        level3Icon: 'fa-robot',
        level4Icon: 'fa-gauge-high',
        autoTypeIcons: true,
        showOrbits: true,
        showGrid: true,
      };
    }
  }

  applyMapThemePreset(theme: SpaceMapTheme): void {
    this.ensureSpaceMapConfig();
    const preset = THEME_PRESETS[theme];
    if (!preset) return;
    this.form.config.spaceMapConfig = {
      ...this.form.config.spaceMapConfig,
      theme,
      nodeShape: preset.nodeShape,
      color1: preset.color1,
      color2: preset.color2,
      color3: preset.color3,
      level1Icon: preset.level1Icon,
      level2Icon: preset.level2Icon,
      level3Icon: preset.level3Icon,
      level4Icon: (preset as any).level4Icon || 'fa-gauge-high',
    };
  }

  private applySuggestedMapping(): void {
    const savedSmc = this.form.config?.spaceMapConfig;
    const suggested = this.suggestConfig(this.form.structure, this.queryColumns);
    this.form.config = {
      ...suggested,
      spaceMapConfig: savedSmc || {
        theme: 'factory',
        nodeShape: 'hexagon',
        layout: this.form.structure === 'sequence' || this.form.structure === 'dag' ? 'flow-lr' : 'radial',
        color1: '#F59E0B',
        color2: '#10B981',
        color3: '#06B6D4',
        level1Icon: 'fa-industry',
        level2Icon: 'fa-cogs',
        level3Icon: 'fa-robot',
        level4Icon: 'fa-gauge-high',
        autoTypeIcons: true,
        showOrbits: true,
        showGrid: true,
      },
    };
  }

  private loadQueryColumns(queryId: string, autoSuggest = true): void {
    this.ensureSpaceMapConfig();
    if (!queryId) {
      this.queryColumns = [];
      return;
    }
    if (queryId.startsWith('py:')) {
      const parts = queryId.split(':');
      this.loadPythonColumns(parts[1], parts[2] || '', autoSuggest);
      return;
    }
    const q = this.queries.find((x) => x.id === queryId);
    const cols = (q?.columns?.map((c) => c.name) || []);
    if (cols.length) {
      this.queryColumns = cols;
      if (autoSuggest) {
        // Eğer tabloda parent_id benzeri kolon yoksa ve tree seçiliyse otomatik multi_level öner
        const hasParent = cols.some(c => /parent|pid|prereq|upstream/i.test(c));
        if (!hasParent && this.form.structure === 'tree' && !this.form.id && cols.length >= 2) {
          this.form.structure = 'multi_level';
        }
        this.applySuggestedMapping();
      }
      return;
    }
    this.queryColumns = [];
    this.queryService.preview(queryId, {}, 1).subscribe({
      next: (res) => {
        if (this.form.queryId === queryId) {
          this.queryColumns = (res.data?.columns || []).map((c) => c.name);
          if (this.queryColumns.length && autoSuggest) {
            const hasParent = this.queryColumns.some(c => /parent|pid|prereq|upstream/i.test(c));
            if (!hasParent && this.form.structure === 'tree' && !this.form.id && this.queryColumns.length >= 2) {
              this.form.structure = 'multi_level';
            }
            this.applySuggestedMapping();
          }
          this.cdr.markForCheck();
        }
      },
      error: () => {},
    });
  }

  /** Kolon adlarına göre config öner (akıllı varsayılan). */
  private suggestConfig(structure: PathStructure, cols: string[]): PathConfig {
    if (!cols.length) return {};
    const find = (re: RegExp) => cols.find((c) => re.test(c));
    const idCol = find(/^id$|_id$|code$|^kod$|step_id|node_id|path_id/i) || cols[0];
    const labelCol = find(/name|label|title|desc|ad|machine|line|meter/i) || idCol;
    const healthCol = find(/health|oee|score|quality|perform|yield|factor/i);
    const statusCol = find(/status|state|condition|durum|severity/i);

    if (structure === 'multi_level') {
      const catCols = cols.filter(c => c !== healthCol && !/count|total|sum|avg|min|max|kwh|cost|pct|percent|score|time|date/i.test(c));
      const l1 = find(/plant|site|facility|department|area|group|zone|role|category/i) || catCols[0] || cols[0];
      const l2 = catCols.find(c => c !== l1 && /line|bay|type|shift|unit|sub/i.test(c)) || catCols.find(c => c !== l1 && c !== labelCol) || '';
      const lbl = catCols.find(c => c !== l1 && c !== l2) || labelCol;
      return {
        level1_col: l1,
        level2_col: l2,
        label_col: lbl,
        id_col: idCol,
        health_col: healthCol,
        status_col: statusCol,
      };
    }
    if (structure === 'grouped') {
      return {
        group_col: find(/group|area|zone|region|bölge|tip|type|category|line|hat|department|status|role/i) || cols[0],
        label_col: labelCol,
        order_col: find(/order|seq|sort|index|pos|rank|sıra/i),
        id_col: idCol,
        health_col: healthCol,
        status_col: statusCol,
      };
    }
    if (structure === 'sequence') {
      return {
        id_col: idCol,
        label_col: labelCol,
        next_col: find(/next|downstream|successor|sonra|child/i),
        order_col: find(/order|seq|sort|index|pos|rank|sıra|downtime/i) || cols[1] || cols[0],
        health_col: healthCol,
        status_col: statusCol,
      };
    }
    if (structure === 'dag') {
      return {
        id_col: idCol,
        parent_col: find(/prereq|parent|dependency|dep|upstream|predecessor/i) || cols[1] || cols[0],
        label_col: labelCol,
        type_col: find(/type|class|level|operation_type|line/i),
        health_col: healthCol,
        status_col: statusCol,
      };
    }
    return {
      id_col: idCol,
      parent_col: find(/parent|pid|upstream|mother|üst|baba/i) || cols[1] || cols[0],
      label_col: labelCol,
      type_col: find(/type|class|level|katman|seviye/i),
      health_col: healthCol,
      status_col: statusCol,
    };
  }

  private normalizeConfigForSubmit(): PathConfig {
    this.ensureSpaceMapConfig();
    const cfg = { ...this.form.config };
    if (this.form.structure === 'multi_level') {
      const levels: string[] = [];
      for (const c of [cfg.level1_col, cfg.level2_col, cfg.level3_col, cfg.label_col]) {
        if (c && !levels.includes(c)) levels.push(c);
      }
      cfg.level_cols = levels;
    }
    return cfg;
  }

  doPreview(): void {
    if (!this.form.queryId) { this.notify('Lütfen önce bir veri kaynağı (Sorgu / Python / Tablo / Prosedür) seçin.'); return; }
    this.previewLoading = true;
    this.previewError = '';
    const cfg = this.normalizeConfigForSubmit();
    this.pathService.preview(this.form.queryId, this.form.structure, cfg).subscribe({
      next: (res) => {
        this.previewLoading = false;
        this.preview = res.data;
        if (this.preview && !this.queryColumns.length) {
          this.queryColumns = this.preview.columns || [];
        }
        this.cdr.markForCheck();
      },
      error: (e) => {
        this.previewLoading = false;
        this.previewError = e.error?.error || e.message || 'Önizleme hatası';
        this.cdr.markForCheck();
      },
    });
  }

  save(openMapAfter = false): void {
    const name = this.form.name.trim();
    if (!name) { this.notify('Lütfen harita / path adını girin.'); return; }
    if (!this.form.queryId) { this.notify('Lütfen bir veri kaynağı seçin.'); return; }
    this.saving = true;
    const cfg = this.normalizeConfigForSubmit();
    const payload: Partial<PathDef> = {
      name,
      description: this.form.description,
      queryId: this.form.queryId,
      structure: this.form.structure,
      config: cfg,
    };

    const afterSave = (savedDef: PathDef) => {
      this.pathService.build(savedDef.id).subscribe({
        next: (buildRes) => {
          this.saving = false;
          const nodeCount = buildRes.data?.stats?.node_count || buildRes.data?.nodes?.length || 0;
          this.notify(`Harita kaydedildi ve ${nodeCount} düğümlü hiyerarşi derlendi.`);
          this.loadPaths();
          if (openMapAfter) {
            this.openInMap(savedDef);
          } else {
            this.view = 'library';
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.saving = false;
          const warn = err?.error?.error || err?.message || 'Derleme uyarısı';
          this.notify(`Harita kaydedildi (${warn})`);
          this.loadPaths();
          if (openMapAfter) {
            this.openInMap(savedDef);
          } else {
            this.view = 'library';
          }
          this.cdr.markForCheck();
        }
      });
    };

    if (this.form.id) {
      this.pathService.update(this.form.id, payload).subscribe({
        next: (res) => afterSave(res.data || { ...payload, id: this.form.id } as PathDef),
        error: (e) => { this.saving = false; this.notify('Güncelleme hatası: ' + (e.error?.error || e.message)); },
      });
    } else {
      this.pathService.create(payload).subscribe({
        next: (res) => afterSave(res.data),
        error: (e) => { this.saving = false; this.notify('Kaydetme hatası: ' + (e.error?.error || e.message)); },
      });
    }
  }

  // ---- Search ----

  doSearch(): void {
    if (!this.searchPath) return;
    this.searchLoading = true;
    this.pathService.search(this.searchPath.id, this.term).subscribe({
      next: (res) => { this.searchLoading = false; this.searchResult = res.data; this.cdr.markForCheck(); },
      error: (e) => { this.searchLoading = false; this.notify('Arama hatası: ' + (e.error?.error || e.message)); },
    });
  }

  // ---- Önizleme yardımcıları ----

  get previewTree(): TreeNode[] {
    if (!this.preview) return [];
    const nodes = this.preview.structure.nodes;
    const map = new Map<string, TreeNode>();
    nodes.forEach((n) => map.set(n.id, { node: n, children: [] }));
    const roots: TreeNode[] = [];
    const rootSet = new Set(this.preview.structure.roots);
    map.forEach((tn) => {
      const pid = tn.node.parent;
      if (pid && map.has(pid) && pid !== tn.node.id) map.get(pid)!.children.push(tn);
      else if (!pid || rootSet.has(tn.node.id)) roots.push(tn);
    });
    return roots;
  }

  get labelById(): Map<string, string> {
    return new Map((this.preview?.structure.nodes || []).map((n) => [n.id, n.label]));
  }

  breadcrumbFromIds(ids: string[]): string {
    return ids.map((id) => this.labelById.get(id) || id).join(' › ');
  }

  private notify(msg: string): void {
    this.toast = msg;
    window.clearTimeout((this as any)._t);
    (this as any)._t = window.setTimeout(() => { this.toast = ''; this.cdr.markForCheck(); }, 2800);
    this.cdr.markForCheck();
  }
}
