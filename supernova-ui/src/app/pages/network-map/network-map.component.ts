import {
  Component, OnInit, OnDestroy, AfterViewInit, ChangeDetectionStrategy,
  ChangeDetectorRef, ViewChild, ElementRef, HostListener,
} from '@angular/core';
import { Router } from '@angular/router';
import { forkJoin, Subscription, fromEvent } from 'rxjs';
import { throttleTime } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { DataSourceSelectionService } from '../../services/data-source-selection.service';
import { PathService } from '../../services/path.service';
import { QueryService } from '../../services/query.service';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { BuiltStructure, PathDef } from '../../models/path-def.model';
import { SavedQuery } from '../../models/query.model';

// ============================================================================
// Space Map — Path Definer'dan DB bazında otomatik üretilen, sade/profesyonel
// hiyerarşi görselleştirmesi. Canvas 2D + leaf-ağırlıklı radial layout +
// drill-down. "Temiz uzay" teması: derin lacivert, seyrek yıldız, seviye renkleri.
// Büyük DB'lerde hızlı: ekran başına bounded düğüm (drill pencereleme), culling,
// tek-geçiş layout, sürekli animasyon yok.
// ============================================================================

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
    private auth: AuthService,
    private router: Router,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
  ) {}

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  ngOnInit(): void {
    this.canManage = this.auth.hasRole('engineer') || this.auth.hasRole('admin') || this.auth.hasRole('superuser');
    this.dss.load();

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

    // Önce path detayını al (ad gösterimi), sonra build ile yapıyı kur.
    this.pathService.get(pathId).subscribe({
      next: res => {
        this.selectedPath = res.data || null;
        this.buildAndRender(pathId);
      },
      error: () => {
        this.selectedPath = null;
        this.buildAndRender(pathId);
      },
    });
  }

  private buildAndRender(pathId: string): void {
    this.pathService.build(pathId).subscribe({
      next: res => this.onBuilt(res.data),
      error: err => {
        this.isLoading = false;
        this.error = err?.error?.error || err?.message || 'Failed to build path.';
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
    map.forEach(node => {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    });
    // Çocukları kararlı sırala (label) — layout tutarlılığı için.
    roots.forEach(r => this.sortChildren(r));
    roots.forEach(r => this.computeLeaves(r));

    this.roots = roots;
    this.nodeMap = map;
  }

  private sortChildren(node: RNode): void {
    node.children.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    node.children.forEach(c => this.sortChildren(c));
  }

  private computeLeaves(node: RNode): number {
    if (!node.children.length) {
      node.leafCount = 1;
      return 1;
    }
    let sum = 0;
    node.children.forEach(c => (sum += this.computeLeaves(c)));
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

  // ---- Arka plan (temiz uzay): lacivert gradient + seyrek yıldız + hafif ringler ----
  private drawBackground(w: number, h: number): void {
    const ctx = this.ctx!;
    if (!this.bgCache || this.bgCacheSize.w !== w || this.bgCacheSize.h !== h) {
      const cache = document.createElement('canvas');
      cache.width = w; cache.height = h;
      const c = cache.getContext('2d')!;
      const g = c.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#05070f');
      g.addColorStop(0.5, '#080c1a');
      g.addColorStop(1, '#05060d');
      c.fillStyle = g; c.fillRect(0, 0, w, h);

      // Hafif merkez parlama (odak hissi).
      const glow = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
      glow.addColorStop(0, 'rgba(124, 141, 181, 0.10)');
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      c.fillStyle = glow; c.fillRect(0, 0, w, h);

      // Seyrek statik yıldız (deterministic — Math.random yok; hash bazlı).
      c.fillStyle = 'rgba(220, 230, 255, 0.65)';
      const starCount = Math.min(140, Math.floor((w * h) / 14000));
      for (let i = 0; i < starCount; i++) {
        const hx = this.hash(i * 92821 + 1);
        const hy = this.hash(i * 27487 + 7);
        const r = (this.hash(i * 12553 + 3) % 10) / 10 * 1.2 + 0.2;
        c.globalAlpha = 0.25 + (this.hash(i * 61511 + 5) % 60) / 100;
        c.beginPath();
        c.arc(hx * w, hy * h, r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      this.bgCache = cache;
      this.bgCacheSize = { w, h };
    }
    ctx.drawImage(this.bgCache, 0, 0, w, h);

    // Çok hafif yörünge rehber halkaları (pan/zoom ile hareket eden, world-space).
    ctx.save();
    ctx.translate(this.view.panX, this.view.panY);
    ctx.scale(this.view.zoom, this.view.zoom);
    ctx.strokeStyle = 'rgba(124, 141, 181, 0.06)';
    ctx.lineWidth = 1 / this.view.zoom;
    for (let r = 1; r <= this.MAX_DRILL_RING + 1; r++) {
      ctx.beginPath();
      ctx.arc(0, 0, this.RING_RADIUS * r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLinks(bounds: VisibleBounds): void {
    const ctx = this.ctx!;
    ctx.lineWidth = 1.4;
    const showAll = this.renderNodes.length <= 600;
    ctx.globalAlpha = 1;
    for (const node of this.renderNodes) {
      if (!node.parentId) continue;
      const parent = this.nodeMap.get(node.parentId);
      if (!parent) continue;
      // Bağlantı yalnızca her iki uç pencerede ve ekranda görünüyorsa çiz.
      if (!showAll && !this.inBounds(node, bounds) && !this.inBounds(parent, bounds)) continue;
      const color = this.levelColor(node.ring);
      ctx.strokeStyle = this.alpha(color, 0.32);
      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      // Hafif kavisli Bezier (organik uzay hissi).
      const mx = (parent.x + node.x) / 2;
      const my = (parent.y + node.y) / 2;
      ctx.quadraticCurveTo(mx, my, node.x, node.y);
      ctx.stroke();
    }
  }

  private drawNodes(bounds: VisibleBounds): void {
    const ctx = this.ctx!;
    const focus = this.focusId ? this.nodeMap.get(this.focusId) : null;
    const showLabels = this.view.zoom >= 0.55;

    for (const node of this.renderNodes) {
      if (!this.inBounds(node, bounds)) continue;
      const isFocus = focus === node;
      const isHover = this.hoveredNode === node;
      const isSel = this.selectedNode === node;
      const baseR = this.nodeRadius(node.ring);
      const r = isHover || isFocus ? baseR * 1.12 : baseR;
      const color = this.levelColor(node.ring);

      // Halo (yalnızca focus/hover/seçili — perf).
      if (isFocus || isHover || isSel) {
        ctx.shadowColor = color;
        ctx.shadowBlur = isFocus ? 26 : 16;
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // Gövde: radial highlight.
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

      // Çocuk sayısı çipi (yaprak olmayan).
      if (node.children.length && r >= 12) {
        const chip = String(node.children.length);
        ctx.font = `600 ${Math.round(r * 0.55)}px "Space Grotesk", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#0b1020';
        ctx.fillText(chip, node.x, node.y);
      }

      // Etiket.
      if (showLabels || isHover || isFocus) {
        this.drawLabel(node.label, node.x, node.y + r + 12, color, isHover || isFocus);
      }
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
    return this.LEVEL_COLORS[((ring % this.LEVEL_COLORS.length) + this.LEVEL_COLORS.length) % this.LEVEL_COLORS.length];
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
    this.view.targetZoom = Math.min(this.maxZoom, this.view.targetZoom * 1.3);
    this.markDirty();
  }

  zoomOut(): void {
    this.view.targetZoom = Math.max(this.minZoom, this.view.targetZoom / 1.3);
    this.markDirty();
  }

  /** Görünür düğümleri canvas'a sığdır. */
  fitView(): void {
    if (!this.renderNodes.length || !this.canvas) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.renderNodes) {
      const r = this.nodeRadius(n.ring) + 24;
      minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
      minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
    }
    const { w, h } = this.canvasSize;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(w / bw, h / bh) * 0.92));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.view.zoom = zoom;
    this.view.targetZoom = zoom;
    this.view.panX = w / 2 - cx * zoom;
    this.view.panY = h / 2 - cy * zoom;
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
    // Eşleşen düğümü merkeze al → ring 0'da görünür, alt seviyeler açılır.
    this.focusId = node.id;
    this.relayout();
    this.selectedNode = node;
    // Ekrana ortala.
    const { w, h } = this.canvasSize;
    this.view.panX = w / 2 - node.x * this.view.zoom;
    this.view.panY = h / 2 - node.y * this.view.zoom;
    this.searchResults = [];
    this.searchTerm = node.label;
    this.markDirty();
    this.cdr.markForCheck();
  }

  // ---- Detay paneli getter'ları ----
  get selectedLevelLabel(): string {
    if (!this.selectedNode) return '';
    return this.translate.instant('NETWORK_MAP.LEVEL_N', { n: this.selectedNode.depth + 1 });
  }

  get selectedBreadcrumb(): string[] {
    if (!this.selectedNode) return [];
    const chain: RNode[] = [];
    let cur: RNode | null = this.selectedNode;
    while (cur) { chain.unshift(cur); cur = cur.parentId ? this.nodeMap.get(cur.parentId) ?? null : null; }
    return chain.map(n => n.label);
  }

  get selectedPathString(): string {
    return this.selectedBreadcrumb.join('/');
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

  closeDetail(): void {
    this.selectedNode = null;
    this.cdr.markForCheck();
  }

  // ---- Aksiyonlar (az ama işe yarar) ----
  copyPath(): void {
    const path = this.selectedPathString;
    if (!path) return;
    if (!navigator.clipboard) {
      this.notify('NETWORK_MAP.COPY_FAILED', 'error');
      return;
    }
    navigator.clipboard.writeText(path)
      .then(() => this.notify('NETWORK_MAP.COPIED', 'success'))
      .catch(() => this.notify('NETWORK_MAP.COPY_FAILED', 'error'));
  }

  addToDashboard(): void {
    const path = this.selectedPathString;
    if (!path) return;
    const userId = this.auth.getCurrentUser()?.username || 'default';
    const widget: any = {
      id: `sm-${path}-${Date.now()}`.replace(/\s+/g, '_'),
      widget_type: 'line-chart',
      title: this.selectedNode?.label || 'Space Map Widget',
      data_path: '',
      initial_paths: [path],
      position: { x: 0, y: 0, width: 2, height: 2 },
      config: { refreshRate: 10000 },
      is_active: true,
    };
    this.saveWidgetLocal(widget);
    this.apiService.addWidgetToDashboard(userId, widget).subscribe({ next: () => {}, error: () => {} });
    this.notify('NETWORK_MAP.ADDED_TO_DASHBOARD', 'success');
    setTimeout(() => this.router.navigate(['/dashboard']), 600);
  }

  private saveWidgetLocal(widget: any): void {
    try {
      const raw = localStorage.getItem('dashboard-widgets-cache');
      const data = raw ? JSON.parse(raw) : { widgets: [] };
      if (!Array.isArray(data.widgets)) data.widgets = [];
      data.widgets.push({
        id: widget.widget_type,
        instanceId: widget.id,
        title: widget.title,
        icon: 'fas fa-chart-line',
        type: widget.widget_type,
        dataSourceType: 'realtime',
        initialPaths: widget.initial_paths || [],
        configuration: widget.config || {},
        refreshRate: widget.config?.refreshRate || 10000,
        layout: widget.position,
        visible: true,
      });
      localStorage.setItem('dashboard-widgets-cache', JSON.stringify(data));
    } catch { /* yok say */ }
  }

  createReport(): void {
    const path = this.selectedPathString;
    if (!path) return;
    const config = {
      paths: [path],
      stationName: this.selectedNode?.label || '',
      nodeType: this.selectedLevelLabel,
      breadcrumb: this.selectedBreadcrumb.join(' / '),
      autoGenerate: true,
    };
    sessionStorage.setItem('networkMapReportPaths', JSON.stringify([path]));
    sessionStorage.setItem('networkMapReportConfig', JSON.stringify(config));
    sessionStorage.setItem('networkMapOpenReportCreator', '1');
    this.router.navigate(['/reports']);
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
    this.markDirty();
  }
}

/** Görünür dünya sınırları (culling için). */
interface VisibleBounds { minX: number; maxX: number; minY: number; maxY: number; }
