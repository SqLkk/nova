import {
  Component, OnInit, OnDestroy, AfterViewInit, ChangeDetectionStrategy,
  ChangeDetectorRef, ViewChild, ElementRef, HostListener,
} from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { forkJoin, Subscription, fromEvent } from 'rxjs';
import { throttleTime } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { DataSourceSelectionService } from '../../services/data-source-selection.service';
import { PathService } from '../../services/path.service';
import { QueryService } from '../../services/query.service';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { DashboardEditService, Widget } from '../../services/dashboard-edit.service';
import { BuiltStructure, PathDef } from '../../models/path-def.model';
import { SavedQuery } from '../../models/query.model';

// ============================================================================
// Space Map — Çok temalı, interaktif hiyerarşi görselleştirme motoru.
// 5 farklı endüstriyel ve görsel tema: Kozmik, Fabrika, Siber Ağ, Blueprint, Kristal.
// Canvas 2D + leaf-ağırlıklı radial layout + drill-down + FontAwesome canvas glyphs.
// ============================================================================

export type SpaceMapTheme = 'cosmic' | 'factory' | 'cyber' | 'blueprint' | 'crystal';
export type SpaceMapShape = 'auto' | 'planet' | 'hexagon' | 'cyber' | 'blueprint' | 'diamond' | 'circle';

export interface SpaceMapConfig {
  theme: SpaceMapTheme;
  nodeShape: SpaceMapShape;
  color1: string;
  color2: string;
  color3: string;
  level1Icon: string;
  level2Icon: string;
  level3Icon: string;
  showOrbits: boolean;
  showGrid: boolean;
  layout?: 'radial' | 'spiral';
}

export interface AvailableIcon {
  id: string;
  label: string;
  glyph: string;
}

export const AVAILABLE_ICONS: AvailableIcon[] = [
  // Genel & Uzay
  { id: 'fa-sun', label: 'Güneş / Yıldız', glyph: '\uf185' },
  { id: 'fa-globe', label: 'Gezegen / Dünya', glyph: '\uf0ac' },
  { id: 'fa-satellite', label: 'Uydu', glyph: '\uf7bf' },
  { id: 'fa-rocket', label: 'Roket', glyph: '\uf135' },
  { id: 'fa-meteor', label: 'Meteor / Asteroit', glyph: '\uf753' },
  { id: 'fa-atom', label: 'Atom / Çekirdek', glyph: '\uf5d2' },
  // Endüstriyel
  { id: 'fa-industry', label: 'Fabrika / Tesis', glyph: '\uf275' },
  { id: 'fa-cogs', label: 'Dişliler / Mekanizma', glyph: '\uf085' },
  { id: 'fa-wrench', label: 'Bakım / Alet', glyph: '\uf0ad' },
  { id: 'fa-robot', label: 'Robot / Otomasyon', glyph: '\uf544' },
  { id: 'fa-bolt', label: 'Güç / Elektrik', glyph: '\uf0e7' },
  { id: 'fa-warehouse', label: 'Depo / Ambar', glyph: '\uf494' },
  // Siber & IT
  { id: 'fa-server', label: 'Sunucu / Host', glyph: '\uf233' },
  { id: 'fa-database', label: 'Veritabanı', glyph: '\uf1c0' },
  { id: 'fa-network-wired', label: 'Ağ / Network', glyph: '\uf6ff' },
  { id: 'fa-microchip', label: 'Mikroçip / CPU', glyph: '\uf2db' },
  { id: 'fa-wifi', label: 'Kablosuz / IoT', glyph: '\uf1eb' },
  { id: 'fa-shield-alt', label: 'Güvenlik / Koruma', glyph: '\uf3ed' },
  { id: 'fa-terminal', label: 'Terminal / Kod', glyph: '\uf120' },
  // Mimari & Blueprint
  { id: 'fa-layer-group', label: 'Katman / Modül', glyph: '\uf5fd' },
  { id: 'fa-sitemap', label: 'Hiyerarşi Şeması', glyph: '\uf0e8' },
  { id: 'fa-drafting-compass', label: 'Tasarım / Pergel', glyph: '\uf568' },
  { id: 'fa-cubes', label: 'Bileşenler / Küpler', glyph: '\uf1b3' },
  { id: 'fa-project-diagram', label: 'Proje Şeması', glyph: '\uf542' },
  // Kristal & Değer
  { id: 'fa-gem', label: 'Mücevher / Kristal', glyph: '\uf3a5' },
  { id: 'fa-cube', label: 'Blok / Matris', glyph: '\uf1b2' },
  { id: 'fa-dice-d20', label: 'Prizma (D20)', glyph: '\uf6cf' },
  { id: 'fa-certificate', label: 'Rozet / Sertifika', glyph: '\uf0a3' },
];

export const THEME_PRESETS: Record<SpaceMapTheme, Omit<SpaceMapConfig, 'theme'>> = {
  cosmic: {
    nodeShape: 'planet',
    color1: '#60A5FA',
    color2: '#22D3EE',
    color3: '#A78BFA',
    level1Icon: 'fa-sun',
    level2Icon: 'fa-globe',
    level3Icon: 'fa-satellite',
    showOrbits: true,
    showGrid: true,
  },
  factory: {
    nodeShape: 'hexagon',
    color1: '#F59E0B',
    color2: '#10B981',
    color3: '#06B6D4',
    level1Icon: 'fa-industry',
    level2Icon: 'fa-cogs',
    level3Icon: 'fa-microchip',
    showOrbits: true,
    showGrid: true,
  },
  cyber: {
    nodeShape: 'cyber',
    color1: '#00FF9D',
    color2: '#00F0FF',
    color3: '#FF007F',
    level1Icon: 'fa-server',
    level2Icon: 'fa-network-wired',
    level3Icon: 'fa-microchip',
    showOrbits: true,
    showGrid: true,
  },
  blueprint: {
    nodeShape: 'blueprint',
    color1: '#38BDF8',
    color2: '#818CF8',
    color3: '#F472B6',
    level1Icon: 'fa-layer-group',
    level2Icon: 'fa-sitemap',
    level3Icon: 'fa-drafting-compass',
    showOrbits: true,
    showGrid: true,
  },
  crystal: {
    nodeShape: 'diamond',
    color1: '#EC4899',
    color2: '#8B5CF6',
    color3: '#06B6D4',
    level1Icon: 'fa-gem',
    level2Icon: 'fa-atom',
    level3Icon: 'fa-certificate',
    showOrbits: true,
    showGrid: true,
  },
};

const FA_GLYPHS: Record<string, string> = {};
AVAILABLE_ICONS.forEach(item => {
  FA_GLYPHS[item.id] = item.glyph;
  FA_GLYPHS[item.id.replace('fa-', '')] = item.glyph;
});
FA_GLYPHS['gear'] = '\uf013';
FA_GLYPHS['gears'] = '\uf085';
FA_GLYPHS['cpu'] = '\uf2db';
FA_GLYPHS['shield'] = '\uf3ed';
FA_GLYPHS['circle'] = '\uf111';

/** Render için iç düğüm modeli (PathNode'dan türetilir, layout koordinatları eklenir). */
interface RNode {
  id: string;
  label: string;
  depth: number;          // orijinal ağaç derinliği (data)
  parentId: string | null;
  children: RNode[];
  leafCount: number;      // alt ağacındaki yaprak sayısı (layout ağırlığı)
  x: number;
  y: number;
  ring: number;           // focus'a göre ring offseti (layout sırasında set)
  row?: Record<string, unknown>;
}

@Component({
  standalone: false,
  selector: 'app-network-map-optimized',
  templateUrl: './network-map.component.html',
  styleUrls: ['./network-map.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetworkMapOptimizedComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('networkCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('mapContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  // ---- Veri ----
  dataSources: any[] = [];
  selectedDataSourceId: string | null = null;

  queries: SavedQuery[] = [];
  paths: PathDef[] = [];
  filteredPaths: PathDef[] = [];
  selectedPathId: string | null = null;
  selectedPath: PathDef | null = null;

  isLoading = false;
  error: string | null = null;
  warnings: string[] = [];

  // ---- Tema & Özelleştirme ----
  showThemeModal = false;
  themeConfig: SpaceMapConfig = {
    theme: 'cosmic',
    nodeShape: 'planet',
    layout: 'radial',
    color1: '#60A5FA',
    color2: '#22D3EE',
    color3: '#A78BFA',
    level1Icon: 'fa-sun',
    level2Icon: 'fa-globe',
    level3Icon: 'fa-satellite',
    showOrbits: true,
    showGrid: true,
  };
  readonly availableIcons = AVAILABLE_ICONS;
  readonly availableShapes: { id: SpaceMapShape; labelKey: string }[] = [
    { id: 'auto', labelKey: 'NETWORK_MAP.SHAPE_AUTO' },
    { id: 'planet', labelKey: 'NETWORK_MAP.SHAPE_PLANET' },
    { id: 'hexagon', labelKey: 'NETWORK_MAP.SHAPE_HEXAGON' },
    { id: 'cyber', labelKey: 'NETWORK_MAP.SHAPE_CYBER' },
    { id: 'blueprint', labelKey: 'NETWORK_MAP.SHAPE_BLUEPRINT' },
    { id: 'diamond', labelKey: 'NETWORK_MAP.SHAPE_DIAMOND' },
    { id: 'circle', labelKey: 'NETWORK_MAP.SHAPE_CIRCLE' },
  ];
  readonly presetList: { id: SpaceMapTheme; icon: string; nameKey: string; desc: string }[] = [
    { id: 'cosmic', icon: 'fa-satellite', nameKey: 'NETWORK_MAP.THEME_COSMIC', desc: '🪐 Yıldızlar, gezegenler ve yörünge halkaları' },
    { id: 'factory', icon: 'fa-industry', nameKey: 'NETWORK_MAP.THEME_FACTORY', desc: '🏭 CAD ızgarası, perçinli altıgenler ve boru hatları' },
    { id: 'cyber', icon: 'fa-network-wired', nameKey: 'NETWORK_MAP.THEME_CYBER', desc: '⚡ Neon matris, çip köşebentleri ve lazer hatları' },
    { id: 'blueprint', icon: 'fa-drafting-compass', nameKey: 'NETWORK_MAP.THEME_BLUEPRINT', desc: '📐 Mühendislik mavisi, milimetrik grid ve teknik çizgiler' },
    { id: 'crystal', icon: 'fa-gem', nameKey: 'NETWORK_MAP.THEME_CRYSTAL', desc: '💎 Kuvars fasetleri, prizmatik aurora ve ışık huzmeleri' },
  ];
  private hasFitted = false;

  // ---- Hiyerarşi (render modeli) ----
  private roots: RNode[] = [];
  private nodeMap = new Map<string, RNode>();
  /** null = overview (kökler ring 1); aksi halde focus düğümü merkeze koy. */
  focusId: string | null = null;
  /** Şu anda layout'lanıp ekrana gelen pencere (culling + hit-test için). */
  private renderNodes: RNode[] = [];
  totalNodes = 0;
  maxDepth = 0;

  // ---- Etkileşim / görünüm ----
  selectedNode: RNode | null = null;
  hoveredNode: RNode | null = null;
  private view = { zoom: 1, targetZoom: 1, panX: 0, panY: 0 };
  private readonly minZoom = 0.15;
  private readonly maxZoom = 3;

  // ---- Arama ----
  searchTerm = '';
  searchResults: RNode[] = [];
  searchHint = '';

  // ---- Yetki ----
  canManage = false;

  // ---- Toast ----
  toast = '';
  toastType: 'success' | 'error' = 'success';

  // ---- Canvas / render altyapısı ----
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private needsRender = true;
  private zoomAnimating = false;
  private bgCache: HTMLCanvasElement | null = null;
  private bgCacheSize = { w: 0, h: 0 };
  private labelCache = new Map<string, string>();
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf: number | null = null;
  private dragState = { active: false, moved: false, lastX: 0, lastY: 0, startX: 0, startY: 0 };

  private readonly subs: Subscription[] = [];

  // ---- Layout sabitleri ----
  private readonly RING_RADIUS = 235;          // ring başına dünya birimi
  private readonly MAX_DRILL_RING = 2;         // focus + 2 ring (drill-down pencere)
  private readonly NODE_RADIUS_BY_RING = [30, 20, 14, 10, 8, 7];
  /** Derinliğe göre sade serin palet (steel → sky → cyan → violet → gold). */
  private readonly LEVEL_COLORS = ['#9DB4D1', '#60A5FA', '#22D3EE', '#A78BFA', '#F5B301'];
  private readonly MAX_SEARCH_RESULTS = 12;
  private readonly MAX_LABEL_LEN = 16;

  constructor(
    private dss: DataSourceSelectionService,
    private pathService: PathService,
    private queryService: QueryService,
    private apiService: ApiService,
    private dashEdit: DashboardEditService,
    private auth: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
  ) {}

  private initialPathId: string | null = null;
  private initialDataSourceId: string | null = null;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  ngOnInit(): void {
    this.canManage = this.auth.hasRole('engineer');
    this.dss.load();

    this.subs.push(
      this.route.queryParams.subscribe(params => {
        if (params['pathId']) {
          this.initialPathId = params['pathId'];
        }
        if (params['dataSourceId']) {
          this.initialDataSourceId = params['dataSourceId'];
          this.selectedDataSourceId = params['dataSourceId'];
        }
      })
    );

    this.subs.push(
      this.dss.dataSources$.subscribe(list => {
        this.dataSources = list || [];
        if (!this.selectedDataSourceId && this.dss.selectedId) {
          this.selectedDataSourceId = this.dss.selectedId;
        }
        this.loadQueriesAndPaths();
      }),
    );

    this.subs.push(
      this.dss.selectedId$.subscribe(id => {
        if (id && id !== this.selectedDataSourceId) {
          this.selectedDataSourceId = id;
          this.onDataSourceChange();
        }
      }),
    );
  }

  ngAfterViewInit(): void {
    this.initCanvas();
    this.bindEvents();
    this.startRenderLoop();

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeRaf !== null) cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = null;
        this.resizeCanvas();
      });
    });
    if (this.containerRef) this.resizeObserver.observe(this.containerRef.nativeElement);
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.resizeRaf !== null) cancelAnimationFrame(this.resizeRaf);
  }

  // ===========================================================================
  // Veri yükleme — her DB için ayrı, otomatik
  // ===========================================================================

  private loadQueriesAndPaths(): void {
    forkJoin({
      queries: this.queryService.list(),
      paths: this.pathService.list(),
    }).subscribe({
      next: ({ queries, paths }) => {
        this.queries = (queries.data as SavedQuery[]) || [];
        this.paths = (paths.data as PathDef[]) || [];
        this.filterPathsByDataSource();

        // Eğer URL query params'tan belirli bir pathId geldiyse onu doğrudan seç ve aç
        if (this.initialPathId) {
          const target = this.paths.find(p => p.id === this.initialPathId);
          if (target) {
            const q = this.queries.find(x => x.id === target.queryId);
            const dsId = (q as any)?.dataSourceId || (q as any)?.data_source_id;
            if (dsId && dsId !== this.selectedDataSourceId) {
              this.selectedDataSourceId = dsId;
              this.filterPathsByDataSource();
            }
            this.selectedPathId = target.id;
            this.onSelectPath(target.id);
            this.initialPathId = null;
            this.cdr.markForCheck();
            return;
          }
        }

        // İlk yüklemede bu DB için ilk path'i otomatik seç.
        if (!this.selectedPathId) this.autoSelectFirstPath();
        this.cdr.markForCheck();
      },
      error: () => {
        this.queries = [];
        this.paths = [];
        this.filteredPaths = [];
        this.cdr.markForCheck();
      },
    });
  }

  /** Path'leri seçili datasource'a göre filtrele (query → dataSourceId haritası). */
  filterPathsByDataSource(): void {
    if (!this.selectedDataSourceId) {
      this.filteredPaths = this.paths;
      return;
    }
    const dsByQuery = new Map<string, string>();
    this.queries.forEach(q => dsByQuery.set(q.id, (q as any).dataSourceId || (q as any).data_source_id));
    this.filteredPaths = this.paths.filter(p => {
      const dsId = dsByQuery.get((p as any).queryId);
      return !dsId || dsId === this.selectedDataSourceId;
    });
  }

  onDataSourceChange(): void {
    this.filterPathsByDataSource();
    // DB değişti → seçimi sıfırla ve ilk path'i otomatik üret.
    this.selectedPathId = null;
    this.selectedPath = null;
    this.resetGraph();
    this.autoSelectFirstPath();
    this.cdr.markForCheck();
  }

  /** Bu DB için ilk path'i otomatik seçip render et (yoksa boş durum). */
  private autoSelectFirstPath(): void {
    if (this.filteredPaths.length) {
      this.onSelectPath(this.filteredPaths[0].id);
    } else {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  onSelectPath(pathId: string | null): void {
    if (!pathId || pathId === 'null') {
      this.selectedPathId = null;
      this.selectedPath = null;
      this.resetGraph();
      this.cdr.markForCheck();
      return;
    }
    this.selectedPathId = pathId;
    this.isLoading = true;
    this.error = null;
    this.cdr.markForCheck();

    // Önce path detayını al (ad ve tema gösterimi), sonra build ile yapıyı kur.
    this.pathService.get(pathId).subscribe({
      next: res => {
        this.selectedPath = res.data || null;
        this.syncThemeFromPath();
        const hasMaterialized = !!(this.selectedPath?.materialized?.nodes?.length);
        if (hasMaterialized && this.selectedPath?.materialized) {
          // Önbellekten hemen çiz (anında görüntüleme)
          this.onBuilt(this.selectedPath.materialized);
        }
        this.buildAndRender(pathId, hasMaterialized);
      },
      error: () => {
        this.selectedPath = null;
        this.buildAndRender(pathId, false);
      },
    });
  }

  private buildAndRender(pathId: string, hasCachedFallback = false): void {
    this.isLoading = !hasCachedFallback;
    this.pathService.build(pathId).subscribe({
      next: res => {
        this.isLoading = false;
        this.onBuilt(res.data);
      },
      error: err => {
        this.isLoading = false;
        const msg = err?.error?.error || err?.message || 'Failed to build path.';
        if (hasCachedFallback) {
          this.notify('NETWORK_MAP.CACHED_WARNING', 'error');
        } else {
          this.error = msg;
          this.resetGraph();
        }
        this.cdr.markForCheck();
      },
    });
  }

  private onBuilt(built: BuiltStructure | null): void {
    this.isLoading = false;
    if (!built || !built.nodes?.length) {
      this.error = this.translate.instant('NETWORK_MAP.NO_DATA');
      this.resetGraph();
      this.cdr.markForCheck();
      return;
    }
    this.error = null;
    this.warnings = built.stats?.warnings || [];
    this.totalNodes = built.stats?.node_count || built.nodes.length;
    this.maxDepth = built.stats?.max_depth || 0;

    this.buildForest(built);
    // Tek kök varsa doğrudan ona odaklan; çok köklü ise overview (kökler ring 1).
    this.focusId = this.roots.length === 1 ? this.roots[0].id : null;
    this.selectedNode = null;
    this.hoveredNode = null;
    this.relayout();
    this.fitView();
    this.markDirty();
    this.cdr.markForCheck();
  }

  // ===========================================================================
  // Orman kurulumu (PathNode[] → RNode[] parent/child ağacı + leaf sayımı)
  // ===========================================================================

  private buildForest(built: BuiltStructure): void {
    const map = new Map<string, RNode>();
    built.nodes.forEach(n => {
      map.set(n.id, {
        id: n.id,
        label: n.label || n.id,
        depth: n.depth ?? 0,
        parentId: n.parent || null,
        children: [],
        leafCount: 1,
        x: 0, y: 0, ring: 0,
        row: n.row,
      });
    });
    const roots: RNode[] = [];
    const rootIds = new Set(built.roots || []);
    map.forEach(node => {
      if (node.parentId && node.parentId !== node.id && map.has(node.parentId) && !rootIds.has(node.id)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    });
    // Çocukları kararlı sırala (label) — layout tutarlılığı için.
    const sortVisited = new Set<string>();
    roots.forEach(r => this.sortChildren(r, sortVisited));
    const visited = new Set<string>();
    roots.forEach(r => this.computeLeaves(r, visited));

    this.roots = roots;
    this.nodeMap = map;
  }

  private sortChildren(node: RNode, visited = new Set<string>()): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    node.children.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    node.children.forEach(c => this.sortChildren(c, visited));
  }

  private computeLeaves(node: RNode, visited: Set<string>): number {
    if (visited.has(node.id)) return 1;
    visited.add(node.id);
    if (!node.children.length) {
      node.leafCount = 1;
      return 1;
    }
    let sum = 0;
    node.children.forEach(c => (sum += this.computeLeaves(c, visited)));
    node.leafCount = Math.max(sum, 1);
    return node.leafCount;
  }

  // ===========================================================================
  // Layout — leaf-ağırlıklı radial ağaç (drill pencerelemeli)
  // ===========================================================================

  /** focus veya pencere değişince yeniden layout + render listesini kur. */
  private relayout(): void {
    this.labelCache.clear();
    const window: RNode[] = [];

    if (this.focusId) {
      const focus = this.nodeMap.get(this.focusId);
      if (focus) {
        focus.x = 0; focus.y = 0; focus.ring = 0;
        window.push(focus);
        this.layoutChildren(focus, 0, Math.PI * 2, 1, window);
      }
    } else {
      // Overview: sanal merkez; kökleri ring 1'e, çocuklarını ring 2'ye yerleştir.
      const totalLeaves = this.roots.reduce((s, r) => s + r.leafCount, 0) || 1;
      let cursor = 0;
      this.roots.forEach(root => {
        const span = (Math.PI * 2) * (root.leafCount / totalLeaves);
        this.placeRadial(root, cursor, cursor + span, 1, window);
        cursor += span;
      });
    }
    this.renderNodes = window;
  }

  /** Bir çocuğu [start,end] açısal sektörüne yerleştir, alt çocuklarını recursive böl. */
  private placeRadial(node: RNode, start: number, end: number, ring: number, out: RNode[]): void {
    const mid = (start + end) / 2;
    node.ring = ring;
    node.x = Math.cos(mid) * this.RING_RADIUS * ring;
    node.y = Math.sin(mid) * this.RING_RADIUS * ring;
    out.push(node);
    if (ring >= this.MAX_DRILL_RING) return;

    const total = node.children.reduce((s, c) => s + c.leafCount, 0) || 1;
    let cursor = start;
    node.children.forEach(child => {
      const span = (end - start) * (child.leafCount / total);
      this.placeRadial(child, cursor, cursor + span, ring + 1, out);
      cursor += span;
    });
  }

  /** Focus (center) çocuklarını tam daireye yerleştir. */
  private layoutChildren(node: RNode, start: number, end: number, ring: number, out: RNode[]): void {
    const total = node.children.reduce((s, c) => s + c.leafCount, 0) || 1;
    let cursor = start;
    node.children.forEach(child => {
      const span = (end - start) * (child.leafCount / total);
      this.placeRadial(child, cursor, cursor + span, ring, out);
      cursor += span;
    });
  }

  // ===========================================================================
  // Canvas kurulumu
  // ===========================================================================

  private initCanvas(): void {
    if (!this.canvasRef) return;
    this.canvas = this.canvasRef.nativeElement;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (ctx) {
      this.ctx = ctx;
      this.resizeCanvas();
      this.markDirty();
    }
  }

  private resizeCanvas(): void {
    if (!this.canvas || !this.containerRef) return;
    const rect = this.containerRef.nativeElement.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Arka plan cache boyutu değiştiyse yeniden üret.
    this.bgCache = null;
    if (!this.hasFitted && this.renderNodes.length > 0) {
      this.fitView();
    }
    this.markDirty();
  }

  private get canvasSize(): { w: number; h: number } {
    if (!this.canvas) return { w: 1600, h: 900 };
    const dpr = window.devicePixelRatio || 1;
    return { w: this.canvas.width / dpr, h: this.canvas.height / dpr };
  }

  // ===========================================================================
  // Render döngüsü
  // ===========================================================================

  private startRenderLoop(): void {
    const tick = () => {
      // Zoom interpolasyonu (sadece animasyon sırasında çiz).
      if (Math.abs(this.view.zoom - this.view.targetZoom) > 0.001) {
        this.view.zoom += (this.view.targetZoom - this.view.zoom) * 0.2;
        this.zoomAnimating = true;
        this.markDirty();
      } else if (this.zoomAnimating) {
        this.view.zoom = this.view.targetZoom;
        this.zoomAnimating = false;
        this.markDirty();
      }
      if (this.needsRender) {
        this.render();
        this.needsRender = this.zoomAnimating;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private markDirty(): void {
    this.needsRender = true;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = this.canvasSize;

    // Arka plan (cache'li).
    this.drawBackground(w, h);

    if (!this.renderNodes.length) return;

    ctx.save();
    ctx.translate(this.view.panX, this.view.panY);
    ctx.scale(this.view.zoom, this.view.zoom);

    const bounds = this.visibleBounds();

    // Önce bağlantılar (parent→child Bezier), sonra düğümler.
    this.drawLinks(bounds);
    this.drawNodes(bounds);

    ctx.restore();
  }

  // ---- Arka plan (Kozmik / Fabrika / Siber / Blueprint / Kristal) ----
  private drawBackground(w: number, h: number): void {
    const ctx = this.ctx!;
    const theme = this.themeConfig.theme;
    const showGrid = this.themeConfig.showGrid !== false;

    if (!this.bgCache || this.bgCacheSize.w !== w || this.bgCacheSize.h !== h) {
      const cache = document.createElement('canvas');
      cache.width = w; cache.height = h;
      const c = cache.getContext('2d')!;

      if (theme === 'factory') {
        // Endüstriyel Fabrika Teması: Koyu grafit/çelik zemin + CAD ızgarası
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#090d14');
        g.addColorStop(0.5, '#0f1522');
        g.addColorStop(1, '#070a10');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        if (showGrid) {
          // 40px CAD minor grid
          c.strokeStyle = 'rgba(245, 158, 11, 0.035)';
          c.lineWidth = 1;
          for (let gx = 0; gx < w; gx += 40) {
            c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
          }
          for (let gy = 0; gy < h; gy += 40) {
            c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
          }

          // 120px CAD major grid & crosshairs
          c.strokeStyle = 'rgba(245, 158, 11, 0.08)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 120) {
            c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
          }
          for (let gy = 0; gy < h; gy += 120) {
            c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
          }

          // Intersection coordinate ticks (+)
          c.strokeStyle = 'rgba(245, 158, 11, 0.25)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 120) {
            for (let gy = 0; gy < h; gy += 120) {
              c.beginPath();
              c.moveTo(gx - 4, gy); c.lineTo(gx + 4, gy);
              c.moveTo(gx, gy - 4); c.lineTo(gx, gy + 4);
              c.stroke();
            }
          }
        }

        const glow = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
        glow.addColorStop(0, 'rgba(245, 158, 11, 0.08)');
        glow.addColorStop(0.6, 'rgba(16, 185, 129, 0.04)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = glow; c.fillRect(0, 0, w, h);

      } else if (theme === 'cyber') {
        // Siber Ağ & IoT Teması: Ultra-koyu OLED + neon cyber grid + HUD köşe işaretleri
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#020408');
        g.addColorStop(0.5, '#050c14');
        g.addColorStop(1, '#010204');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        if (showGrid) {
          // Cyber 35px grid
          c.strokeStyle = 'rgba(0, 255, 157, 0.035)';
          c.lineWidth = 1;
          for (let gx = 0; gx < w; gx += 35) {
            c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
          }
          for (let gy = 0; gy < h; gy += 35) {
            c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
          }

          // Cyber 140px data tracks
          c.strokeStyle = 'rgba(0, 240, 255, 0.08)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 140) {
            c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
          }
          for (let gy = 0; gy < h; gy += 140) {
            c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
          }

          // Tech reticles [+]
          c.strokeStyle = 'rgba(0, 255, 157, 0.35)';
          c.lineWidth = 1.4;
          for (let gx = 0; gx < w; gx += 140) {
            for (let gy = 0; gy < h; gy += 140) {
              c.strokeRect(gx - 3, gy - 3, 6, 6);
            }
          }
        }

        const glow = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.55);
        glow.addColorStop(0, 'rgba(0, 255, 157, 0.09)');
        glow.addColorStop(0.5, 'rgba(0, 240, 255, 0.04)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = glow; c.fillRect(0, 0, w, h);

      } else if (theme === 'blueprint') {
        // Teknik Blueprint Teması: Klasik mimari/mühendislik derin mavisi + milimetrik grid
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#061a33');
        g.addColorStop(0.5, '#09274c');
        g.addColorStop(1, '#051426');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        if (showGrid) {
          // 20px fine grid
          c.strokeStyle = 'rgba(56, 189, 248, 0.045)';
          c.lineWidth = 0.8;
          for (let gx = 0; gx < w; gx += 20) {
            c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
          }
          for (let gy = 0; gy < h; gy += 20) {
            c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
          }

          // 100px major drafting grid
          c.strokeStyle = 'rgba(56, 189, 248, 0.12)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 100) {
            c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
          }
          for (let gy = 0; gy < h; gy += 100) {
            c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
          }

          // Drafting crosshair markers
          c.strokeStyle = 'rgba(56, 189, 248, 0.35)';
          c.lineWidth = 1;
          for (let gx = 0; gx < w; gx += 100) {
            for (let gy = 0; gy < h; gy += 100) {
              c.beginPath();
              c.moveTo(gx - 5, gy); c.lineTo(gx + 5, gy);
              c.moveTo(gx, gy - 5); c.lineTo(gx, gy + 5);
              c.stroke();
            }
          }
        }

        const glow = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.65);
        glow.addColorStop(0, 'rgba(56, 189, 248, 0.09)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = glow; c.fillRect(0, 0, w, h);

      } else if (theme === 'crystal') {
        // Kristal & Prizma Teması: Obsidyen zemin + aurora dalgaları + prizma ışıltıları
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#07050f');
        g.addColorStop(0.5, '#0e0a1f');
        g.addColorStop(1, '#05030b');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        // Aurora ışık dalgaları
        const a1 = c.createRadialGradient(w * 0.35, h * 0.4, 30, w * 0.35, h * 0.4, Math.max(w, h) * 0.5);
        a1.addColorStop(0, 'rgba(236, 72, 153, 0.10)');
        a1.addColorStop(0.6, 'rgba(139, 92, 246, 0.04)');
        a1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = a1; c.fillRect(0, 0, w, h);

        const a2 = c.createRadialGradient(w * 0.68, h * 0.6, 20, w * 0.68, h * 0.6, Math.max(w, h) * 0.45);
        a2.addColorStop(0, 'rgba(6, 182, 212, 0.09)');
        a2.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = a2; c.fillRect(0, 0, w, h);

        // Prizmatik kristal ışıltıları
        c.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        c.fillStyle = 'rgba(255, 255, 255, 0.7)';
        const sparkleCount = Math.min(80, Math.floor((w * h) / 20000));
        for (let i = 0; i < sparkleCount; i++) {
          const hx = this.hash(i * 44851 + 3) * w;
          const hy = this.hash(i * 32173 + 7) * h;
          const s = (this.hash(i * 19283 + 9) % 10) / 10 * 2.5 + 1;
          c.beginPath();
          c.moveTo(hx - s * 2, hy); c.lineTo(hx + s * 2, hy);
          c.moveTo(hx, hy - s * 2); c.lineTo(hx, hy + s * 2);
          c.stroke();
          c.beginPath();
          c.arc(hx, hy, s * 0.4, 0, Math.PI * 2);
          c.fill();
        }

      } else {
        // Kozmik Uzay Teması: Çok katmanlı nebula + yıldızlar + güneş parıltısı
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#04060e');
        g.addColorStop(0.5, '#080c1d');
        g.addColorStop(1, '#04050c');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        // Nebula gaz bulutları (mor / camgöbeği)
        const n1 = c.createRadialGradient(w * 0.3, h * 0.35, 20, w * 0.3, h * 0.35, Math.max(w, h) * 0.48);
        n1.addColorStop(0, 'rgba(167, 139, 250, 0.11)');
        n1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = n1; c.fillRect(0, 0, w, h);

        const n2 = c.createRadialGradient(w * 0.7, h * 0.65, 30, w * 0.7, h * 0.65, Math.max(w, h) * 0.42);
        n2.addColorStop(0, 'rgba(34, 211, 238, 0.08)');
        n2.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = n2; c.fillRect(0, 0, w, h);

        const glow = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.58);
        glow.addColorStop(0, 'rgba(96, 165, 250, 0.12)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = glow; c.fillRect(0, 0, w, h);

        // Yıldızlar
        c.fillStyle = 'rgba(225, 235, 255, 0.75)';
        const starCount = Math.min(150, Math.floor((w * h) / 12000));
        for (let i = 0; i < starCount; i++) {
          const hx = this.hash(i * 92821 + 1);
          const hy = this.hash(i * 27487 + 7);
          const r = (this.hash(i * 12553 + 3) % 10) / 10 * 1.3 + 0.25;
          c.globalAlpha = 0.2 + (this.hash(i * 61511 + 5) % 70) / 100;
          c.beginPath();
          c.arc(hx * w, hy * h, r, 0, Math.PI * 2);
          c.fill();
        }
        c.globalAlpha = 1;
      }
      this.bgCache = cache;
      this.bgCacheSize = { w, h };
    }
    ctx.drawImage(this.bgCache, 0, 0, w, h);

    // Yörünge rehber halkaları (isteğe bağlı)
    if (this.themeConfig.showOrbits !== false) {
      ctx.save();
      ctx.translate(this.view.panX, this.view.panY);
      ctx.scale(this.view.zoom, this.view.zoom);

      if (theme === 'factory') {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.09)';
        ctx.setLineDash([8, 8]);
      } else if (theme === 'cyber') {
        ctx.strokeStyle = 'rgba(0, 255, 157, 0.10)';
        ctx.setLineDash([4, 12]);
      } else if (theme === 'blueprint') {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
        ctx.setLineDash([6, 6]);
      } else if (theme === 'crystal') {
        ctx.strokeStyle = 'rgba(236, 72, 153, 0.10)';
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(124, 141, 181, 0.07)';
        ctx.setLineDash([]);
      }

      ctx.lineWidth = 1 / this.view.zoom;
      for (let r = 1; r <= this.MAX_DRILL_RING + 1; r++) {
        ctx.beginPath();
        ctx.arc(0, 0, this.RING_RADIUS * r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawLinks(bounds: VisibleBounds): void {
    const ctx = this.ctx!;
    const showAll = this.renderNodes.length <= 600;
    const nodeSet = new Set(this.renderNodes.map(n => n.id));
    const theme = this.themeConfig.theme;

    for (const node of this.renderNodes) {
      if (!node.parentId) continue;
      if (!nodeSet.has(node.parentId)) continue;
      const parent = this.nodeMap.get(node.parentId);
      if (!parent) continue;
      // Bağlantı yalnızca her iki uç pencerede ve ekranda görünüyorsa çiz.
      if (!showAll && !this.inBounds(node, bounds) && !this.inBounds(parent, bounds)) continue;

      const color = this.levelColor(node.ring);

      ctx.save();
      if (theme === 'blueprint') {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = this.alpha(color, 0.45);
        ctx.lineWidth = 1.2;
      } else if (theme === 'cyber') {
        ctx.setLineDash([]);
        ctx.strokeStyle = this.alpha(color, 0.6);
        ctx.lineWidth = 1.6;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      } else if (theme === 'factory') {
        ctx.setLineDash([]);
        ctx.strokeStyle = this.alpha(color, 0.42);
        ctx.lineWidth = 2.4;
      } else if (theme === 'crystal') {
        ctx.setLineDash([]);
        ctx.strokeStyle = this.alpha(color, 0.45);
        ctx.lineWidth = 1.5;
      } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = this.alpha(color, 0.35);
        ctx.lineWidth = 1.4;
      }

      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      // Kavisli Bezier
      const mx = (parent.x + node.x) / 2;
      const my = (parent.y + node.y) / 2;
      ctx.quadraticCurveTo(mx, my, node.x, node.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawNodes(bounds: VisibleBounds): void {
    const ctx = this.ctx!;
    const focus = this.focusId ? this.nodeMap.get(this.focusId) : null;
    const showLabels = this.view.zoom >= 0.55;
    const shape = this.resolveNodeShape();

    for (const node of this.renderNodes) {
      if (!this.inBounds(node, bounds)) continue;
      const isFocus = focus === node;
      const isHover = this.hoveredNode === node;
      const isSel = this.selectedNode === node;
      const baseR = this.nodeRadius(node.ring);
      const r = isHover || isFocus ? baseR * 1.15 : baseR;
      const color = this.levelColor(node.ring);

      // Halo (focus/hover/seçili)
      if (isFocus || isHover || isSel) {
        ctx.shadowColor = color;
        ctx.shadowBlur = isFocus ? 28 : (isSel ? 22 : 16);
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // Şekle göre gövde çizimi
      if (shape === 'hexagon') {
        this.drawHexagon(ctx, node.x, node.y, r);
        const grad = ctx.createLinearGradient(node.x - r, node.y - r, node.x + r, node.y + r);
        grad.addColorStop(0, '#1c2430');
        grad.addColorStop(0.5, '#121822');
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.strokeStyle = isSel ? '#ffffff' : this.alpha(color, 0.6);
        ctx.stroke();

        if (r >= 14) {
          this.drawHexagonRivets(ctx, node.x, node.y, r, '#ffffff');
        }
      } else if (shape === 'cyber') {
        this.drawCyberOctagon(ctx, node.x, node.y, r);
        const grad = ctx.createLinearGradient(node.x - r, node.y - r, node.x + r, node.y + r);
        grad.addColorStop(0, '#041315');
        grad.addColorStop(0.6, '#082322');
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.strokeStyle = isSel ? '#ffffff' : this.alpha(color, 0.7);
        ctx.stroke();

        if (r >= 12 && (isFocus || isHover || isSel || this.view.zoom >= 0.75)) {
          this.drawCyberBrackets(ctx, node.x, node.y, r, isSel ? '#ffffff' : color);
        }
      } else if (shape === 'diamond') {
        this.drawDiamond(ctx, node.x, node.y, r);
        const grad = ctx.createRadialGradient(node.x, node.y, r * 0.1, node.x, node.y, r);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.3, color);
        grad.addColorStop(1, '#090514');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.strokeStyle = isSel ? '#ffffff' : this.alpha(color, 0.65);
        ctx.stroke();

        if (r >= 14) {
          this.drawCrystalFacets(ctx, node.x, node.y, r, '#ffffff');
        }
      } else if (shape === 'blueprint') {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(node.x, node.y, r * 0.2, node.x, node.y, r);
        grad.addColorStop(0, '#103765');
        grad.addColorStop(0.7, '#071f3b');
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.strokeStyle = isSel ? '#ffffff' : this.alpha(color, 0.75);
        ctx.stroke();

        if (r >= 12) {
          this.drawBlueprintCrosshairs(ctx, node.x, node.y, r, isSel ? '#ffffff' : color);
        }
      } else {
        // 'planet' veya 'circle'
        if (shape === 'planet' && (isFocus || node.ring === 0)) {
          this.drawSunCorona(ctx, node.x, node.y, r, color);
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(node.x - r / 3, node.y - r / 3, r / 6, node.x, node.y, r);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.35, color);
        grad.addColorStop(1, '#0b1020');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.strokeStyle = isSel ? '#ffffff' : this.alpha(color, 0.5);
        ctx.stroke();

        if (shape === 'planet' && node.ring > 0 && r >= 14) {
          this.drawPlanetaryRing(ctx, node.x, node.y, r, color);
        }
      }

      // FontAwesome glyph ikonu
      const icon = this.getNodeIcon(node.ring);
      if (icon && r >= 14 && this.view.zoom >= 0.45) {
        const iconSize = Math.round(r * 0.88);
        this.renderCanvasIcon(ctx, icon, node.x, node.y, iconSize, '#ffffff');
      }

      // Çocuk sayısı çipi (yaprak olmayan) - sağ üst rozet
      if (node.children.length && r >= 12) {
        const chip = String(node.children.length);
        const bx = node.x + r * 0.72;
        const by = node.y - r * 0.72;
        const badgeR = Math.max(7, Math.round(r * 0.38));
        ctx.beginPath();
        ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#05070f';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.font = `700 ${Math.round(badgeR * 1.1)}px "Space Grotesk", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#05070f';
        ctx.fillText(chip, bx, by);
      }

      // Etiket
      if (showLabels || isHover || isFocus) {
        this.drawLabel(node.label, node.x, node.y + r + 12, color, isHover || isFocus);
      }
    }
  }

  // ---- Düğüm Şekil Çözümlemesi ----
  resolveNodeShape(): SpaceMapShape {
    const s = this.themeConfig.nodeShape;
    if (!s || s === 'auto') {
      switch (this.themeConfig.theme) {
        case 'factory': return 'hexagon';
        case 'cyber': return 'cyber';
        case 'blueprint': return 'blueprint';
        case 'crystal': return 'diamond';
        case 'cosmic':
        default:
          return 'planet';
      }
    }
    return s;
  }

  private getNodeIcon(ring: number): string {
    if (ring === 0) return this.themeConfig.level1Icon || 'fa-sun';
    if (ring === 1) return this.themeConfig.level2Icon || 'fa-globe';
    return this.themeConfig.level3Icon || 'fa-satellite';
  }

  private renderCanvasIcon(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, size: number, color = '#ffffff'): void {
    if (!icon) return;
    const clean = icon.trim();
    const glyph = FA_GLYPHS[clean] || FA_GLYPHS[clean.replace('fa-', '')] || (clean.startsWith('fa-') ? null : clean);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (glyph && (glyph.charCodeAt(0) > 255 || glyph.startsWith('\\u'))) {
      ctx.font = `900 ${Math.round(size)}px "Font Awesome 6 Free", sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(glyph, x, y);
    } else if (glyph && glyph.length <= 4) {
      ctx.font = `700 ${Math.round(size * 0.9)}px "Space Grotesk", sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(glyph, x, y);
    } else {
      const fallbackGlyph = FA_GLYPHS['fa-' + clean] || '\uf111';
      ctx.font = `900 ${Math.round(size)}px "Font Awesome 6 Free", sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(fallbackGlyph, x, y);
    }
    ctx.restore();
  }

  // ---- Vektörel Şekil Çizicileri ----
  private drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + r * Math.cos(angle);
      const py = y + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  private drawHexagonRivets(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    const rivetR = Math.max(1, r * 0.08);
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + (r * 0.82) * Math.cos(angle);
      const py = y + (r * 0.82) * Math.sin(angle);
      ctx.beginPath();
      ctx.arc(px, py, rivetR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCyberOctagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    const c = r * 0.35;
    ctx.beginPath();
    ctx.moveTo(x - r + c, y - r);
    ctx.lineTo(x + r - c, y - r);
    ctx.lineTo(x + r, y - r + c);
    ctx.lineTo(x + r, y + r - c);
    ctx.lineTo(x + r - c, y + r);
    ctx.lineTo(x - r + c, y + r);
    ctx.lineTo(x - r, y + r - c);
    ctx.lineTo(x - r, y - r + c);
    ctx.closePath();
  }

  private drawCyberBrackets(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    const bDist = r + 4;
    const bLen = Math.max(3, r * 0.32);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    // Top-Left
    ctx.beginPath();
    ctx.moveTo(x - bDist + bLen, y - bDist);
    ctx.lineTo(x - bDist, y - bDist);
    ctx.lineTo(x - bDist, y - bDist + bLen);
    ctx.stroke();
    // Top-Right
    ctx.beginPath();
    ctx.moveTo(x + bDist - bLen, y - bDist);
    ctx.lineTo(x + bDist, y - bDist);
    ctx.lineTo(x + bDist, y - bDist + bLen);
    ctx.stroke();
    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(x - bDist, y + bDist - bLen);
    ctx.lineTo(x - bDist, y + bDist);
    ctx.lineTo(x - bDist + bLen, y + bDist);
    ctx.stroke();
    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(x + bDist - bLen, y + bDist);
    ctx.lineTo(x + bDist, y + bDist);
    ctx.lineTo(x + bDist, y + bDist - bLen);
    ctx.stroke();
  }

  private drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.1);
    ctx.lineTo(x + r * 0.95, y);
    ctx.lineTo(x, y + r * 1.1);
    ctx.lineTo(x - r * 0.95, y);
    ctx.closePath();
  }

  private drawCrystalFacets(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    ctx.strokeStyle = this.alpha(color, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ir = r * 0.45;
    ctx.moveTo(x, y - ir * 1.1);
    ctx.lineTo(x + ir * 0.95, y);
    ctx.lineTo(x, y + ir * 1.1);
    ctx.lineTo(x - ir * 0.95, y);
    ctx.closePath();
    ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x, y - ir * 1.1);
    ctx.moveTo(x + r * 0.95, y); ctx.lineTo(x + ir * 0.95, y);
    ctx.moveTo(x, y + r * 1.1); ctx.lineTo(x, y + ir * 1.1);
    ctx.moveTo(x - r * 0.95, y); ctx.lineTo(x - ir * 0.95, y);
    ctx.stroke();
  }

  private drawBlueprintCrosshairs(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    const ext = r + 6;
    ctx.strokeStyle = this.alpha(color, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - ext, y); ctx.lineTo(x + ext, y);
    ctx.moveTo(x, y - ext); ctx.lineTo(x, y + ext);
    ctx.stroke();

    const d = r * 0.72;
    const tickLen = 3;
    ctx.beginPath();
    ctx.moveTo(x - d, y - d - tickLen); ctx.lineTo(x - d, y - d + tickLen);
    ctx.moveTo(x + d, y - d - tickLen); ctx.lineTo(x + d, y - d + tickLen);
    ctx.moveTo(x - d, y + d - tickLen); ctx.lineTo(x - d, y + d + tickLen);
    ctx.moveTo(x + d, y + d - tickLen); ctx.lineTo(x + d, y + d + tickLen);
    ctx.stroke();
  }

  private drawPlanetaryRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.35);
    ctx.scale(1.75, 0.42);
    ctx.strokeStyle = this.alpha(color, 0.4);
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = this.alpha(color, 0.18);
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawSunCorona(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    const coronaGlow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.2);
    coronaGlow.addColorStop(0, this.alpha(color, 0.4));
    coronaGlow.addColorStop(0.5, this.alpha(color, 0.12));
    coronaGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = coronaGlow;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = this.alpha(color, 0.25);
    ctx.lineWidth = 1.2;
    const rayCount = 12;
    for (let i = 0; i < rayCount; i++) {
      const angle = (Math.PI * 2 / rayCount) * i;
      const len = r * (1.3 + (i % 3) * 0.25);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * (r * 0.95), y + Math.sin(angle) * (r * 0.95));
      ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
      ctx.stroke();
    }
  }

  private drawLabel(text: string, x: number, y: number, color: string, emphasize: boolean): void {
    const ctx = this.ctx!;
    const label = this.truncate(text);
    ctx.font = `${emphasize ? '600 ' : ''}12px "Space Grotesk", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, x, y);
    ctx.fillStyle = emphasize ? '#ffffff' : this.alpha(color, 0.92);
    ctx.fillText(label, x, y);
  }

  // ===========================================================================
  // Olaylar
  // ===========================================================================

  private bindEvents(): void {
    if (!this.canvas) return;
    const el = this.canvas;
    this.subs.push(fromEvent<MouseEvent>(el, 'mousedown').subscribe(e => this.onDown(e)));
    this.subs.push(fromEvent<MouseEvent>(el, 'mousemove').pipe(throttleTime(16)).subscribe(e => this.onMove(e)));
    this.subs.push(fromEvent<MouseEvent>(el, 'mouseup').subscribe(() => this.onUp()));
    this.subs.push(fromEvent<MouseEvent>(el, 'click').subscribe(e => this.onClick(e)));
    this.subs.push(fromEvent<WheelEvent>(el, 'wheel').subscribe(e => this.onWheel(e)));
    this.subs.push(fromEvent<TouchEvent>(el, 'touchstart').subscribe(e => this.onTouchStart(e)));
    this.subs.push(fromEvent<TouchEvent>(el, 'touchmove').subscribe(e => this.onTouchMove(e)));
    this.subs.push(fromEvent<TouchEvent>(el, 'touchend').subscribe(() => this.onUp()));
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.panX) / this.view.zoom,
      y: (clientY - rect.top - this.view.panY) / this.view.zoom,
    };
  }

  private onDown(e: MouseEvent): void {
    this.dragState = { active: true, moved: false, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY };
    if (this.canvas) this.canvas.style.cursor = 'grabbing';
  }

  private onMove(e: MouseEvent): void {
    if (this.dragState.active) {
      const dx = e.clientX - this.dragState.lastX;
      const dy = e.clientY - this.dragState.lastY;
      if (Math.abs(e.clientX - this.dragState.startX) + Math.abs(e.clientY - this.dragState.startY) > 4) {
        this.dragState.moved = true;
      }
      this.view.panX += dx;
      this.view.panY += dy;
      this.dragState.lastX = e.clientX;
      this.dragState.lastY = e.clientY;
      this.markDirty();
      return;
    }
    const { x, y } = this.toWorld(e.clientX, e.clientY);
    const hit = this.findNodeAt(x, y);
    if (hit !== this.hoveredNode) {
      this.hoveredNode = hit;
      if (this.canvas) this.canvas.style.cursor = hit ? 'pointer' : 'default';
      this.markDirty();
    }
  }

  private onUp(): void {
    this.dragState.active = false;
    if (this.canvas) this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'default';
  }

  private onClick(e: MouseEvent): void {
    if (this.dragState.moved) return;
    const { x, y } = this.toWorld(e.clientX, e.clientY);
    const hit = this.findNodeAt(x, y);
    if (hit) this.selectNode(hit);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.view.targetZoom * factor));
    // İmleç merkezinde zoom: imleç dünyasını sabit tut.
    const rect = this.canvas!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const wx = (cx - this.view.panX) / this.view.zoom;
    const wy = (cy - this.view.panY) / this.view.zoom;
    this.view.targetZoom = newZoom;
    this.view.zoom = newZoom;
    this.view.panX = cx - wx * newZoom;
    this.view.panY = cy - wy * newZoom;
    this.markDirty();
  }

  private onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this.dragState = { active: true, moved: false, lastX: t.clientX, lastY: t.clientY, startX: t.clientX, startY: t.clientY };
    }
  }

  private onTouchMove(e: TouchEvent): void {
    if (e.touches.length === 1 && this.dragState.active) {
      const t = e.touches[0];
      this.view.panX += t.clientX - this.dragState.lastX;
      this.view.panY += t.clientY - this.dragState.lastY;
      this.dragState.lastX = t.clientX;
      this.dragState.lastY = t.clientY;
      this.dragState.moved = true;
      this.markDirty();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape': this.navigateUp(); break;
      case '+': case '=': this.zoomIn(); break;
      case '-': this.zoomOut(); break;
      case '0': this.fitView(); break;
    }
  }

  // ===========================================================================
  // Hit-test & yardımcılar
  // ===========================================================================

  private findNodeAt(x: number, y: number): RNode | null {
    let best: RNode | null = null;
    let bestDist = Infinity;
    for (const node of this.renderNodes) {
      const r = this.nodeRadius(node.ring) + 4;
      const dx = node.x - x;
      const dy = node.y - y;
      const d = dx * dx + dy * dy;
      if (d <= r * r && d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  private nodeRadius(ring: number): number {
    return this.NODE_RADIUS_BY_RING[Math.min(ring, this.NODE_RADIUS_BY_RING.length - 1)];
  }

  private levelColor(ring: number): string {
    const palette = [
      this.themeConfig.color1 || '#60A5FA',
      this.themeConfig.color2 || '#22D3EE',
      this.themeConfig.color3 || '#A78BFA',
      '#F5B301',
      '#10B981',
      '#EC4899',
      '#6366F1',
    ];
    return palette[((ring % palette.length) + palette.length) % palette.length];
  }

  private truncate(text: string): string {
    if (text.length <= this.MAX_LABEL_LEN) return text;
    return text.slice(0, this.MAX_LABEL_LEN - 1) + '…';
  }

  /** Kararlı [0,1) sahte-değer (Math.random yerine — render deterministik kalsın). */
  private hash(n: number): number {
    let x = Math.sin(n) * 43758.5453;
    return x - Math.floor(x);
  }

  private alpha(hex: string, a: number): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  private visibleBounds(): VisibleBounds {
    const { w, h } = this.canvasSize;
    const z = this.view.zoom;
    const pad = 120;
    return {
      minX: (-this.view.panX) / z - pad,
      maxX: (w - this.view.panX) / z + pad,
      minY: (-this.view.panY) / z - pad,
      maxY: (h - this.view.panY) / z + pad,
    };
  }

  private inBounds(node: RNode, b: VisibleBounds): boolean {
    return node.x >= b.minX && node.x <= b.maxX && node.y >= b.minY && node.y <= b.maxY;
  }

  // ===========================================================================
  // Public (template) — seçim, drill, zoom, arama, aksiyonlar
  // ===========================================================================

  /** Düğüme tıklama → detay paneli + (yaprak değilse) alt seviyeye drill. */
  selectNode(node: RNode): void {
    this.selectedNode = node;
    // Yaprak değilse o düğüme odaklanarak alt seviyeleri aç (drill-down).
    if (node.children.length) {
      this.focusId = node.id;
      this.relayout();
      this.fitView();
    }
    this.markDirty();
    this.cdr.markForCheck();
  }

  /** Bir üst seviyeye çık (seçimi temizle, focus'u atasına/overview'a al). */
  navigateUp(): void {
    this.selectedNode = null;
    if (!this.focusId) {
      this.cdr.markForCheck();
      return;
    }
    const focus = this.nodeMap.get(this.focusId);
    this.focusId = focus?.parentId && this.nodeMap.has(focus.parentId) ? focus.parentId : null;
    this.relayout();
    this.fitView();
    this.markDirty();
    this.cdr.markForCheck();
  }

  zoomIn(): void {
    this.zoomBy(1.3);
  }

  zoomOut(): void {
    this.zoomBy(1 / 1.3);
  }

  private zoomBy(factor: number): void {
    const { w, h } = this.canvasSize;
    const cx = w / 2;
    const cy = h / 2;
    const currentZoom = this.view.targetZoom;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, currentZoom * factor));
    if (Math.abs(newZoom - currentZoom) < 0.0001) return;
    const wx = (cx - this.view.panX) / this.view.zoom;
    const wy = (cy - this.view.panY) / this.view.zoom;
    this.view.targetZoom = newZoom;
    this.view.zoom = newZoom;
    this.view.panX = cx - wx * newZoom;
    this.view.panY = cy - wy * newZoom;
    this.markDirty();
  }

  /** Görünür düğümleri canvas'a sığdır. */
  fitView(): void {
    if (!this.renderNodes.length || !this.canvas) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.renderNodes) {
      const r = this.nodeRadius(n.ring) + 28;
      minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
      minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
    }
    const { w, h } = this.canvasSize;
    if (w <= 0 || h <= 0) return;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(w / bw, h / bh) * 0.88));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.view.zoom = zoom;
    this.view.targetZoom = zoom;
    this.view.panX = w / 2 - cx * zoom;
    this.view.panY = h / 2 - cy * zoom;
    this.hasFitted = true;
    this.markDirty();
  }

  refresh(): void {
    if (this.selectedPathId) this.buildAndRender(this.selectedPathId);
  }

  // ---- Arama (yerel, label eşleşmesi) ----
  onSearch(): void {
    const q = this.searchTerm.trim().toLowerCase();
    if (!q) {
      this.searchResults = [];
      this.searchHint = '';
      return;
    }
    const matches: RNode[] = [];
    for (const node of this.nodeMap.values()) {
      if (node.label.toLowerCase().includes(q)) {
        matches.push(node);
        if (matches.length >= this.MAX_SEARCH_RESULTS) break;
      }
    }
    this.searchResults = matches;
    this.searchHint = matches.length
      ? this.translate.instant('NETWORK_MAP.SEARCH_HINT', { n: matches.length })
      : this.translate.instant('NETWORK_MAP.NO_RESULTS');
  }

  focusSearchResult(node: RNode): void {
    // Yaprak düğümse üst düğümü odakla ki kardeşler ve üst hiyerarşi görünür kalsın
    if (!node.children.length && node.parentId && this.nodeMap.has(node.parentId)) {
      this.focusId = node.parentId;
    } else {
      this.focusId = node.id;
    }
    this.relayout();
    this.selectedNode = node;
    this.fitView();
    this.searchResults = [];
    this.searchTerm = node.label;
    this.markDirty();
    this.cdr.markForCheck();
  }

  // ---- Detay paneli getter'ları & Breadcrumb ----
  get selectedLevelLabel(): string {
    if (!this.selectedNode) return '';
    return this.translate.instant('NETWORK_MAP.LEVEL_N', { n: this.selectedNode.depth + 1 });
  }

  get selectedBreadcrumbNodes(): RNode[] {
    if (!this.selectedNode) return [];
    const chain: RNode[] = [];
    let cur: RNode | null = this.selectedNode;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? this.nodeMap.get(cur.parentId) ?? null : null;
    }
    return chain;
  }

  get selectedBreadcrumb(): string[] {
    return this.selectedBreadcrumbNodes.map(n => n.label);
  }

  get selectedPathString(): string {
    return this.selectedBreadcrumb.join('/');
  }

  focusBreadcrumb(node: RNode): void {
    this.selectNode(node);
  }

  get selectedNodeProperties(): { key: string; value: string }[] {
    if (!this.selectedNode?.row) return [];
    return Object.entries(this.selectedNode.row)
      .filter(([k]) => !['password', 'password_hash', 'password_salt'].includes(k.toLowerCase()))
      .map(([key, val]) => ({
        key,
        value: val === null || val === undefined ? '—' : (typeof val === 'object' ? JSON.stringify(val) : String(val)),
      }));
  }

  get focusTitle(): string {
    if (!this.focusId) return this.translate.instant('NETWORK_MAP.OVERVIEW');
    return this.nodeMap.get(this.focusId)?.label || '';
  }

  get rootCount(): number {
    return this.roots.length;
  }

  get zoomPercent(): number {
    return Math.round(this.view.zoom * 100);
  }

  get brandIcon(): string {
    switch (this.themeConfig.theme) {
      case 'factory': return 'fa-industry';
      case 'cyber': return 'fa-network-wired';
      case 'blueprint': return 'fa-drafting-compass';
      case 'crystal': return 'fa-gem';
      case 'cosmic':
      default:
        return 'fa-satellite';
    }
  }

  get pageTitle(): string {
    switch (this.themeConfig.theme) {
      case 'factory': return this.translate.instant('NETWORK_MAP.FACTORY_TITLE');
      case 'cyber': return this.translate.instant('NETWORK_MAP.CYBER_TITLE');
      case 'blueprint': return this.translate.instant('NETWORK_MAP.BLUEPRINT_TITLE');
      case 'crystal': return this.translate.instant('NETWORK_MAP.CRYSTAL_TITLE');
      case 'cosmic':
      default:
        return this.translate.instant('NETWORK_MAP.TITLE');
    }
  }

  get pageSubtitle(): string {
    if (this.selectedPath?.name) return this.selectedPath.name;
    switch (this.themeConfig.theme) {
      case 'factory': return this.translate.instant('NETWORK_MAP.FACTORY_SUBTITLE');
      case 'cyber': return this.translate.instant('NETWORK_MAP.CYBER_SUBTITLE');
      case 'blueprint': return this.translate.instant('NETWORK_MAP.BLUEPRINT_SUBTITLE');
      case 'crystal': return this.translate.instant('NETWORK_MAP.CRYSTAL_SUBTITLE');
      case 'cosmic':
      default:
        return this.translate.instant('NETWORK_MAP.SUBTITLE');
    }
  }

  closeDetail(): void {
    this.selectedNode = null;
    this.cdr.markForCheck();
  }

  // ---- Tema Ayarları & Presets ----
  applyThemePreset(theme: SpaceMapTheme): void {
    const preset = THEME_PRESETS[theme];
    if (!preset) return;
    this.themeConfig = {
      ...this.themeConfig,
      theme,
      nodeShape: preset.nodeShape,
      color1: preset.color1,
      color2: preset.color2,
      color3: preset.color3,
      level1Icon: preset.level1Icon,
      level2Icon: preset.level2Icon,
      level3Icon: preset.level3Icon,
      showOrbits: preset.showOrbits,
      showGrid: preset.showGrid,
    };
    this.bgCache = null;
    this.markDirty();
    this.cdr.markForCheck();
  }

  syncThemeFromPath(): void {
    const smc = (this.selectedPath?.config as any)?.spaceMapConfig;
    if (smc) {
      const validThemes: SpaceMapTheme[] = ['cosmic', 'factory', 'cyber', 'blueprint', 'crystal'];
      const theme: SpaceMapTheme = validThemes.includes(smc.theme) ? smc.theme : 'cosmic';
      const preset = THEME_PRESETS[theme];

      this.themeConfig = {
        theme,
        layout: smc.layout || 'radial',
        nodeShape: smc.nodeShape || preset.nodeShape,
        color1: smc.color1 || preset.color1,
        color2: smc.color2 || preset.color2,
        color3: smc.color3 || preset.color3,
        level1Icon: smc.level1Icon || preset.level1Icon,
        level2Icon: smc.level2Icon || preset.level2Icon,
        level3Icon: smc.level3Icon || preset.level3Icon,
        showOrbits: smc.showOrbits !== undefined ? smc.showOrbits : true,
        showGrid: smc.showGrid !== undefined ? smc.showGrid : true,
      };
    } else {
      this.applyThemePreset('cosmic');
    }
    this.bgCache = null;
    this.markDirty();
    this.cdr.markForCheck();
  }

  openThemeModal(): void {
    this.showThemeModal = true;
  }

  onThemeChange(): void {
    this.bgCache = null;
    this.markDirty();
    this.cdr.markForCheck();
  }

  saveTheme(): void {
    if (!this.selectedPath || !this.selectedPathId) return;
    const config = {
      ...(this.selectedPath.config || {}),
      spaceMapConfig: {
        theme: this.themeConfig.theme,
        nodeShape: this.themeConfig.nodeShape,
        layout: this.themeConfig.layout || 'radial',
        color1: this.themeConfig.color1,
        color2: this.themeConfig.color2,
        color3: this.themeConfig.color3,
        level1Icon: this.themeConfig.level1Icon,
        level2Icon: this.themeConfig.level2Icon,
        level3Icon: this.themeConfig.level3Icon,
        showOrbits: this.themeConfig.showOrbits,
        showGrid: this.themeConfig.showGrid,
      }
    };
    const updated = { ...this.selectedPath, config };
    this.pathService.update(this.selectedPathId, updated).subscribe({
      next: res => {
        this.selectedPath = res.data || updated;
        this.syncThemeFromPath();
        this.showThemeModal = false;
        this.notify('NETWORK_MAP.THEME_SAVED', 'success');
      },
      error: () => {
        this.notify('NETWORK_MAP.COPY_FAILED', 'error');
      }
    });
  }

  goToPathDefiner(): void {
    this.router.navigate(['/table-explorer'], {
      queryParams: {
        pathDefiner: 'true',
        ...(this.selectedDataSourceId ? { dataSourceId: this.selectedDataSourceId } : {})
      }
    });
  }

  // ---- Aksiyonlar (Dashboard, Report, Copy) ----
  copyPath(): void {
    const path = this.selectedPathString;
    if (!path) return;
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path)
        .then(() => this.notify('NETWORK_MAP.COPIED', 'success'))
        .catch(() => this.fallbackCopy(path));
    } else {
      this.fallbackCopy(path);
    }
  }

  private fallbackCopy(text: string): void {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) {
        this.notify('NETWORK_MAP.COPIED', 'success');
      } else {
        this.notify('NETWORK_MAP.COPY_FAILED', 'error');
      }
    } catch {
      this.notify('NETWORK_MAP.COPY_FAILED', 'error');
    }
  }

  addToDashboard(): void {
    const path = this.selectedPathString;
    if (!path) return;
    const label = this.selectedNode?.label || 'Space Map Widget';
    const widget: Widget = {
      id: `sm-${Date.now()}`,
      type: 'line',
      title: label,
      icon: this.brandIcon ? `fas ${this.brandIcon}` : 'fas fa-satellite-dish',
      w: 2,
      h: 2,
      category: 'Analytics',
      description: `${path}`,
      config: {
        visualType: 'Line Chart',
        nodeId: this.selectedNode?.id,
        nodePath: path,
        nodeType: this.selectedLevelLabel,
        dataSourceId: this.selectedDataSourceId,
        queryId: this.selectedPath?.queryId,
      },
      dataSourceType: 'sql',
      assignedQueryId: this.selectedPath?.queryId,
    };

    this.dashEdit.loadMyDashboard().subscribe({
      next: (res) => {
        const layout: Widget[] = (res && res.data && Array.isArray(res.data.layout)) ? res.data.layout : [];
        const updated = [...layout, widget];
        const saveObs = res.data?.id
          ? this.dashEdit.saveDashboardLayout(res.data.id, updated)
          : this.dashEdit.saveMyDashboard(updated);
        saveObs.subscribe({
          next: () => {
            this.notify('NETWORK_MAP.ADDED_TO_DASHBOARD', 'success');
            setTimeout(() => this.router.navigate(['/dashboard']), 500);
          },
          error: () => {
            this.notify('NETWORK_MAP.ADDED_TO_DASHBOARD', 'success');
            setTimeout(() => this.router.navigate(['/dashboard']), 500);
          }
        });
      },
      error: () => {
        this.dashEdit.saveMyDashboard([widget]).subscribe({
          next: () => {
            this.notify('NETWORK_MAP.ADDED_TO_DASHBOARD', 'success');
            setTimeout(() => this.router.navigate(['/dashboard']), 500);
          },
          error: () => this.notify('NETWORK_MAP.ADDED_TO_DASHBOARD', 'error')
        });
      }
    });
  }

  createReport(): void {
    const path = this.selectedPathString;
    if (!path) return;
    const label = this.selectedNode?.label || 'Node Report';
    sessionStorage.setItem('templateBuilderInitialQuery', JSON.stringify({
      queryId: this.selectedPath?.queryId,
      name: `${label} - ${this.selectedPath?.name || 'Report'}`,
      nodePath: path,
    }));
    this.router.navigate(['/template-builder']);
  }

  // ---- Toast ----
  private notify(key: string, type: 'success' | 'error'): void {
    this.toast = this.translate.instant(key);
    this.toastType = type;
    window.setTimeout(() => { this.toast = ''; this.cdr.markForCheck(); }, 2600);
    this.cdr.markForCheck();
  }

  private resetGraph(): void {
    this.roots = [];
    this.nodeMap.clear();
    this.renderNodes = [];
    this.focusId = null;
    this.selectedNode = null;
    this.hoveredNode = null;
    this.totalNodes = 0;
    this.maxDepth = 0;
    this.hasFitted = false;
    this.markDirty();
  }
}

/** Görünür dünya sınırları (culling için). */
interface VisibleBounds { minX: number; maxX: number; minY: number; maxY: number; }
