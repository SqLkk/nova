import { Component, OnInit, OnChanges, SimpleChanges, Input } from '@angular/core';
import { PathService } from '../../services/path.service';
import { QueryService } from '../../services/query.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { SavedQuery } from '../../models/query.model';
import {
  PathDef, PathStructure, PathConfig, PreviewResult, SearchResult,
  StructureOption, PathNode,
} from '../../models/path-def.model';

/** Önizlemede girintili ağaç için iç içe model. */
interface TreeNode {
  node: PathNode;
  children: TreeNode[];
}

@Component({
  standalone: false,
  selector: 'app-path-definer',
  templateUrl: './path-definer.component.html',
  styleUrls: ['./path-definer.component.scss'],
})
export class PathDefinerComponent implements OnInit, OnChanges {
  /** Dış bileşenden gelen DB scope (null/undefined → tüm liste). */
  @Input() dataSourceId: string | null | undefined;
  
  /** Table Explorer'dan gelen seçili tablo adı */
  @Input() tableName: string | null = null;

  view: 'library' | 'build' | 'search' = 'library';

  paths: PathDef[] = [];
  searchLib = '';

  /** Path tanımlama yetkisi: engineer/admin/superuser. */
  canDefine = false;

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

  /** Arama. */
  searchPath: PathDef | null = null;
  term = '';
  searchResult: SearchResult | null = null;
  searchLoading = false;

  toast = '';

  readonly structures: StructureOption[] = [
    { value: 'tree', label: 'Tree', icon: 'fa-sitemap', hint: 'parent_id hierarchy (n-ary)' },
    { value: 'binary_tree', label: 'Binary Tree', icon: 'fa-tree', hint: 'each node ≤ 2 children' },
    { value: 'sequence', label: 'Sequence', icon: 'fa-list-ol', hint: 'next_id or order chain' },
    { value: 'grouped', label: 'Grouped', icon: 'fa-layer-group', hint: 'group by column' },
  ];

  constructor(
    private pathService: PathService,
    private queryService: QueryService,
    private auth: AuthService,
    private confirmService: ConfirmService
  ) {}

  ngOnInit(): void {
    const role = this.auth.getCurrentUser()?.role;
    this.canDefine = role === 'admin' || role === 'superuser' || role === 'engineer';
    this.loadPaths();
    this.loadQueries();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataSourceId']) {
      this.loadQueries();
      this.loadPaths();
      // Eğer DB değiştiyse build formunu sıfırla (yanlış sorgu ID kalmasın)
      if (this.view === 'build' && this.form.queryId) {
        this.newBuild();
      }
    }
    if (changes['tableName'] && this.tableName) {
      this.handleTableNameChange(this.tableName);
    }
  }

  handleTableNameChange(tableName: string): void {
    if (!this.dataSourceId) return;
    this.view = 'build';
    
    // Check if auto query exists
    const autoName = `[Auto] ${tableName}`;
    let q = this.queries.find(x => x.name === autoName && x.dataSourceId === this.dataSourceId);
    
    if (q) {
      this.form.queryId = q.id;
      this.loadQueryColumns(q.id);
    } else {
      // Create auto query
      this.queryService.create({
        name: autoName,
        dataSourceId: this.dataSourceId,
        sql: `SELECT * FROM ${tableName}`,
        description: 'Auto-generated for Path Definer',
        isActive: true
      }).subscribe({
        next: (res) => {
          if (res.success && res.data) {
            this.queries.push(res.data);
            this.form.queryId = res.data.id;
            this.loadQueryColumns(res.data.id);
            this.notify(`Table selected: ${tableName}`);
          }
        },
        error: () => this.notify('Query could not be auto-generated.')
      });
    }
  }

  // ---- Yükleyiciler ----

  loadPaths(): void {
    this.pathService.list().subscribe({
      next: (res) => (this.paths = res.data || []),
      error: () => (this.paths = []),
    });
  }

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: (res) => (this.queries = res.data || []),
      error: () => (this.queries = []),
    });
  }

  /** DB scope'lu query id seti (filteredPaths için). */
  private get scopedQueryIds(): Set<string> {
    if (!this.dataSourceId) return new Set(this.queries.map(q => q.id));
    return new Set(
      this.queries.filter(q => q.dataSourceId === this.dataSourceId).map(q => q.id)
    );
  }

  /** DB scope'lu sorgular (build-form query <select>). */
  get scopedQueries(): SavedQuery[] {
    if (!this.dataSourceId) return this.queries;
    return this.queries.filter(q => q.dataSourceId === this.dataSourceId);
  }

  get filteredPaths(): PathDef[] {
    const ids = this.scopedQueryIds;
    let list = this.paths.filter(p => ids.has(p.queryId));
    const t = this.searchLib.trim().toLowerCase();
    if (t) list = list.filter(p => (p.name || '').toLowerCase().includes(t));
    return list;
  }

  structureMeta(s: PathStructure): StructureOption {
    return this.structures.find((x) => x.value === s) || this.structures[0];
  }

  // ---- Library ----

  newBuild(): void {
    this.form = {
      id: '', name: '', description: '', queryId: '',
      structure: 'tree', config: {},
    };
    this.queryColumns = [];
    this.preview = null;
    this.previewError = '';
    this.view = 'build';
  }

  editBuild(def: PathDef): void {
    this.form = {
      id: def.id, name: def.name, description: def.description || '',
      queryId: def.queryId, structure: def.structure,
      config: { ...(def.config || {}) },
    };
    this.loadQueryColumns(def.queryId);
    this.preview = null;
    this.previewError = '';
    this.view = 'build';
  }

  async deletePath(def: PathDef, ev: Event): Promise<void> {
    ev.stopPropagation();
    if (!this.canDefine) return;
    if (!await this.confirmService.confirm(`Are you sure you want to delete "${def.name}"?`)) return;
    this.pathService.remove(def.id).subscribe({
      next: () => { this.notify('Deleted successfully.'); this.loadPaths(); },
      error: () => this.notify('Error deleting path.'),
    });
  }

  openSearch(def: PathDef): void {
    this.searchPath = def;
    this.term = '';
    this.searchResult = null;
    this.view = 'search';
  }

  // ---- Build: sorgu & yapı ----

  onQueryChange(): void {
    this.loadQueryColumns(this.form.queryId);
    this.form.config = this.suggestConfig(this.form.structure, this.queryColumns);
    this.preview = null;
  }

  onStructureChange(): void {
    if (this.queryColumns.length) {
      this.form.config = this.suggestConfig(this.form.structure, this.queryColumns);
    }
    this.preview = null;
  }

  private loadQueryColumns(queryId: string): void {
    const q = this.queries.find((x) => x.id === queryId);
    const cols = (q?.columns?.map((c) => c.name) || []);
    if (cols.length) {
      this.queryColumns = cols;
      return;
    }
    // columns_meta boşsa → 1 satırlık preview ile kolonları öğren.
    this.queryColumns = [];
    if (!queryId) return;
    this.queryService.preview(queryId, {}, 1).subscribe({
      next: (res) => {
        // Yalnızca hâlâ aynı sorgu seçiliyse uygula (yarış önlemi).
        if (this.form.queryId === queryId) {
          this.queryColumns = (res.data?.columns || []).map((c) => c.name);
          if (this.queryColumns.length && !Object.keys(this.form.config).length) {
            this.form.config = this.suggestConfig(this.form.structure, this.queryColumns);
          }
        }
      },
      error: () => {},
    });
  }

  /** Kolon adlarına göre config öner (akıllı varsayılan). */
  private suggestConfig(structure: PathStructure, cols: string[]): PathConfig {
    if (!cols.length) return {};
    const find = (re: RegExp) => cols.find((c) => re.test(c));
    const idCol = find(/^id$|_id$|code$|^kod$/i) || cols[0];
    const labelCol = find(/name|label|title|desc|ad/i) || idCol;
    if (structure === 'grouped') {
      return {
        group_col: find(/group|area|zone|region|bölge|tip|type|category|line|hat/i) || cols[0],
        label_col: labelCol,
        order_col: find(/order|seq|sort|index|pos|rank|sıra/i),
        id_col: idCol,
      };
    }
    if (structure === 'sequence') {
      return {
        id_col: idCol,
        label_col: labelCol,
        next_col: find(/next|downstream|successor|sonra|child/i),
        order_col: find(/order|seq|sort|index|pos|rank|sıra/i),
      };
    }
    return {
      id_col: idCol,
      parent_col: find(/parent|pid|upstream|mother|üst|baba/i) || cols[0],
      label_col: labelCol,
      type_col: find(/type|class|level|katman|seviye/i),
    };
  }

  doPreview(): void {
    if (!this.form.queryId) { this.notify('Please select a query first.'); return; }
    this.previewLoading = true;
    this.previewError = '';
    this.pathService.preview(this.form.queryId, this.form.structure, this.form.config).subscribe({
      next: (res) => {
        this.previewLoading = false;
        this.preview = res.data;
        if (this.preview && !this.queryColumns.length) {
          this.queryColumns = this.preview.columns || [];
        }
      },
      error: (e) => {
        this.previewLoading = false;
        this.previewError = e.error?.error || e.message || 'Preview error';
      },
    });
  }

  save(): void {
    const name = this.form.name.trim();
    if (!name) { this.notify('Path name is required.'); return; }
    if (!this.form.queryId) { this.notify('Select a query.'); return; }
    this.saving = true;
    const payload: Partial<PathDef> = {
      name,
      description: this.form.description,
      queryId: this.form.queryId,
      structure: this.form.structure,
      config: this.form.config,
    };
    const done = (msg: string) => { this.saving = false; this.notify(msg); this.loadPaths(); this.view = 'library'; };
    if (this.form.id) {
      this.pathService.update(this.form.id, payload).subscribe({
        next: () => done('Updated successfully.'),
        error: (e) => { this.saving = false; this.notify('Update error: ' + (e.error?.error || e.message)); },
      });
    } else {
      this.pathService.create(payload).subscribe({
        next: () => done('Path saved successfully.'),
        error: (e) => { this.saving = false; this.notify('Save error: ' + (e.error?.error || e.message)); },
      });
    }
  }

  // ---- Search ----

  doSearch(): void {
    if (!this.searchPath) return;
    this.searchLoading = true;
    this.pathService.search(this.searchPath.id, this.term).subscribe({
      next: (res) => { this.searchLoading = false; this.searchResult = res.data; },
      error: (e) => { this.searchLoading = false; this.notify('Search error: ' + (e.error?.error || e.message)); },
    });
  }

  // ---- Önizleme yardımcıları ----

  /** Önizleme yapısını iç içe ağaca çevir (girintili render için). */
  get previewTree(): TreeNode[] {
    if (!this.preview) return [];
    const nodes = this.preview.structure.nodes;
    const map = new Map<string, TreeNode>();
    nodes.forEach((n) => map.set(n.id, { node: n, children: [] }));
    const roots: TreeNode[] = [];
    const rootSet = new Set(this.preview.structure.roots);
    map.forEach((tn) => {
      const pid = tn.node.parent;
      if (pid && map.has(pid)) map.get(pid)!.children.push(tn);
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

  // ---- Dahili ----

  private notify(msg: string): void {
    this.toast = msg;
    window.clearTimeout((this as any)._t);
    (this as any)._t = window.setTimeout(() => (this.toast = ''), 2500);
  }
}
