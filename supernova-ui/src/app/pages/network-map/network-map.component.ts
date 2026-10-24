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
import { TemplateBuilderService } from '../../services/template-builder.service';
import { BuiltStructure, PathDef, PathStructure } from '../../models/path-def.model';
import { SavedQuery, SavedPythonScript, QueryColumn } from '../../models/query.model';
import { TemplateDocument, createEmptyDocument, cellKey } from '../../models/template-document.model';
import { AiContextService } from '../../services/ai-context.service';

// ============================================================================
// Space Map — Çok temalı, çok yerleşimli, interaktif hiyerarşi & topoloji motoru.
// 5 farklı endüstriyel/görsel tema + 5 farklı yerleşim algoritması (Radial,
// Dikey Ağaç, Yatay Proses Akışı, Küme Matrisi, Spiral) + Query Viewer ve
// Template Builder (XLSX/PDF) doğrudan bağlantı desteği.
// ============================================================================

export type SpaceMapTheme = 'cosmic' | 'factory' | 'cyber' | 'blueprint' | 'crystal';
export type SpaceMapShape = 'auto' | 'planet' | 'hexagon' | 'cyber' | 'blueprint' | 'diamond' | 'circle';
export type SpaceMapLayout = 'radial' | 'hierarchy-tb' | 'flow-lr' | 'grid' | 'spiral';

export interface SpaceMapConfig {
  theme: SpaceMapTheme;
  nodeShape: SpaceMapShape;
  color1: string;
  color2: string;
  color3: string;
  level1Icon: string;
  level2Icon: string;
  level3Icon: string;
  level4Icon?: string;
  autoTypeIcons?: boolean;
  showOrbits: boolean;
  showGrid: boolean;
  layout?: SpaceMapLayout;
}

export interface AvailableIcon {
  id: string;
  label: string;
  glyph: string;
  category?: string;
}

export const AVAILABLE_ICONS: AvailableIcon[] = [
  // Endüstriyel & Fabrika
  { id: 'fa-industry', label: 'Fabrika / Tesis', glyph: '\uf275', category: 'Fabrika' },
  { id: 'fa-building', label: 'Merkez Bina / Kampüs', glyph: '\uf1ad', category: 'Fabrika' },
  { id: 'fa-cogs', label: 'Dişliler / Üretim Hattı', glyph: '\uf085', category: 'Fabrika' },
  { id: 'fa-gear', label: 'Makine / İstasyon', glyph: '\uf013', category: 'Fabrika' },
  { id: 'fa-robot', label: 'Robot / Otomasyon', glyph: '\uf544', category: 'Fabrika' },
  { id: 'fa-wrench', label: 'Bakım / Servis', glyph: '\uf0ad', category: 'Fabrika' },
  { id: 'fa-warehouse', label: 'Depo / Lojistik', glyph: '\uf494', category: 'Fabrika' },
  { id: 'fa-boxes-stacked', label: 'Stok / Palet', glyph: '\uf468', category: 'Fabrika' },
  { id: 'fa-truck', label: 'Sevkiyat / Araç', glyph: '\uf0d1', category: 'Fabrika' },
  { id: 'fa-hard-hat', label: 'Saha Operasyonu', glyph: '\uf807', category: 'Fabrika' },
  { id: 'fa-fire', label: 'Fırın / Isıl İşlem', glyph: '\uf06d', category: 'Fabrika' },

  // Enerji, Sensör & SCADA
  { id: 'fa-bolt', label: 'Enerji / Yüksek Gerilim', glyph: '\uf0e7', category: 'Enerji & Sensör' },
  { id: 'fa-plug', label: 'Fider / Şalt / Priz', glyph: '\uf1e6', category: 'Enerji & Sensör' },
  { id: 'fa-gauge-high', label: 'Sensör / Manometre / OEE', glyph: '\uf625', category: 'Enerji & Sensör' },
  { id: 'fa-temperature-high', label: 'Sıcaklık Sensörü', glyph: '\uf769', category: 'Enerji & Sensör' },
  { id: 'fa-wave-square', label: 'Sinyal / Titreşim / PLC', glyph: '\uf83e', category: 'Enerji & Sensör' },
  { id: 'fa-leaf', label: 'Karbon / ESG / Yeşil Enerji', glyph: '\uf06c', category: 'Enerji & Sensör' },
  { id: 'fa-water', label: 'Akışkan / Hidrolik / Su', glyph: '\uf773', category: 'Enerji & Sensör' },
  { id: 'fa-fan', label: 'HVAC / Fan / Pompa', glyph: '\uf863', category: 'Enerji & Sensör' },

  // Siber, IT & Veritabanı
  { id: 'fa-server', label: 'Sunucu / SCADA Host', glyph: '\uf233', category: 'Siber & Veri' },
  { id: 'fa-database', label: 'Veritabanı', glyph: '\uf1c0', category: 'Siber & Veri' },
  { id: 'fa-network-wired', label: 'Endüstriyel Ağ / Ethernet', glyph: '\uf6ff', category: 'Siber & Veri' },
  { id: 'fa-microchip', label: 'Mikroçip / PLC / Edge', glyph: '\uf2db', category: 'Siber & Veri' },
  { id: 'fa-wifi', label: 'Kablosuz / IoT Gateway', glyph: '\uf1eb', category: 'Siber & Veri' },
  { id: 'fa-shield-alt', label: 'Güvenlik / Kalite Kalkanı', glyph: '\uf3ed', category: 'Siber & Veri' },
  { id: 'fa-terminal', label: 'Terminal / Script', glyph: '\uf120', category: 'Siber & Veri' },
  { id: 'fa-code', label: 'Python / Algoritma', glyph: '\uf121', category: 'Siber & Veri' },
  { id: 'fa-table', label: 'Veri Tablosu', glyph: '\uf0ce', category: 'Siber & Veri' },

  // Mimari, Kalite & Blueprint
  { id: 'fa-sitemap', label: 'Hiyerarşi Şeması', glyph: '\uf0e8', category: 'Mimari & Kalite' },
  { id: 'fa-layer-group', label: 'Katman / Seviye', glyph: '\uf5fd', category: 'Mimari & Kalite' },
  { id: 'fa-project-diagram', label: 'Rota / DAG Şeması', glyph: '\uf542', category: 'Mimari & Kalite' },
  { id: 'fa-drafting-compass', label: 'Mühendislik / Pergel', glyph: '\uf568', category: 'Mimari & Kalite' },
  { id: 'fa-cubes', label: 'Modüller / Paketler', glyph: '\uf1b3', category: 'Mimari & Kalite' },
  { id: 'fa-clipboard-check', label: 'Kalite Kontrol / Onay', glyph: '\uf46c', category: 'Mimari & Kalite' },
  { id: 'fa-triangle-exclamation', label: 'Alarm / Kritik Arıza', glyph: '\uf071', category: 'Mimari & Kalite' },
  { id: 'fa-circle-check', label: 'Sağlıklı / Aktif', glyph: '\uf058', category: 'Mimari & Kalite' },

  // Kristal & Uzay
  { id: 'fa-gem', label: 'Kristal / Değer', glyph: '\uf3a5', category: 'Uzay & Kristal' },
  { id: 'fa-cube', label: 'Blok / Küp', glyph: '\uf1b2', category: 'Uzay & Kristal' },
  { id: 'fa-dice-d20', label: 'Prizma (D20)', glyph: '\uf6cf', category: 'Uzay & Kristal' },
  { id: 'fa-certificate', label: 'Rozet / Sertifika', glyph: '\uf0a3', category: 'Uzay & Kristal' },
  { id: 'fa-sun', label: 'Güneş / Yıldız', glyph: '\uf185', category: 'Uzay & Kristal' },
  { id: 'fa-globe', label: 'Gezegen / Dünya', glyph: '\uf0ac', category: 'Uzay & Kristal' },
  { id: 'fa-satellite', label: 'Uydu / Yörünge', glyph: '\uf7bf', category: 'Uzay & Kristal' },
  { id: 'fa-rocket', label: 'Roket', glyph: '\uf135', category: 'Uzay & Kristal' },
  { id: 'fa-meteor', label: 'Meteor / Asteroit', glyph: '\uf753', category: 'Uzay & Kristal' },
  { id: 'fa-atom', label: 'Atom / Çekirdek', glyph: '\uf5d2', category: 'Uzay & Kristal' },
];

export const THEME_PRESETS: Record<SpaceMapTheme, Omit<SpaceMapConfig, 'theme'>> = {
  factory: {
    nodeShape: 'hexagon',
    color1: '#F59E0B',
    color2: '#10B981',
    color3: '#06B6D4',
    level1Icon: 'fa-industry',
    level2Icon: 'fa-cogs',
    level3Icon: 'fa-robot',
    level4Icon: 'fa-gauge-high',
    autoTypeIcons: false,
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
    level4Icon: 'fa-wave-square',
    autoTypeIcons: false,
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
    level4Icon: 'fa-cube',
    autoTypeIcons: false,
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
    level4Icon: 'fa-dice-d20',
    autoTypeIcons: false,
    showOrbits: true,
    showGrid: true,
  },
  cosmic: {
    nodeShape: 'planet',
    color1: '#60A5FA',
    color2: '#22D3EE',
    color3: '#A78BFA',
    level1Icon: 'fa-sun',
    level2Icon: 'fa-globe',
    level3Icon: 'fa-satellite',
    level4Icon: 'fa-meteor',
    autoTypeIcons: false,
    showOrbits: true,
    showGrid: true,
  },
};

const FA_GLYPHS: Record<string, string> = {};
AVAILABLE_ICONS.forEach(item => {
  FA_GLYPHS[item.id] = item.glyph;
  FA_GLYPHS[item.id.replace('fa-', '')] = item.glyph;
});
FA_GLYPHS['gears'] = '\uf085';
FA_GLYPHS['fa-gears'] = '\uf085';
FA_GLYPHS['cog'] = '\uf013';
FA_GLYPHS['fa-cog'] = '\uf013';
FA_GLYPHS['cpu'] = '\uf2db';
FA_GLYPHS['shield'] = '\uf3ed';
FA_GLYPHS['fa-shield-halved'] = '\uf3ed';
FA_GLYPHS['circle'] = '\uf111';
FA_GLYPHS['tachometer-alt'] = '\uf625';
FA_GLYPHS['fa-tachometer-alt'] = '\uf625';
FA_GLYPHS['exclamation-triangle'] = '\uf071';
FA_GLYPHS['fa-exclamation-triangle'] = '\uf071';
FA_GLYPHS['check-circle'] = '\uf058';
FA_GLYPHS['fa-check-circle'] = '\uf058';

/** Render için iç düğüm modeli (PathNode'dan türetilir, layout koordinatları eklenir). */
interface RNode {
  id: string;
  label: string;
  depth: number;          // orijinal ağaç derinliği (0 = kök, 1 = L2, 2 = L3, 3+ = L4)
  parentId: string | null;
  parents: string[];
  children: RNode[];
  leafCount: number;      // alt ağacındaki yaprak sayısı (layout ağırlığı)
  x: number;
  y: number;
  ring: number;           // focus'a göre ring offseti
  type?: string;
  icon?: string;
  healthScore?: number;
  status?: string;
  statusColor?: string;
  badge?: string;
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
  showAllMapsAcrossDbs = true;

  queries: SavedQuery[] = [];
  pythonScripts: SavedPythonScript[] = [];
  paths: PathDef[] = [];
  filteredPaths: PathDef[] = [];
  selectedPathId: string | null = null;
  selectedPath: PathDef | null = null;

  isLoading = false;
  exportBusy = false;
  error: string | null = null;
  warnings: string[] = [];

  // ---- Query Viewer & Canlı Veri Önizleme Modalları ----
  showQueryViewerModal = false;
  showDataPreviewModal = false;
  sourcePreviewLoading = false;
  sourcePreviewColumns: QueryColumn[] = [];
  sourcePreviewRows: Array<Record<string, unknown>> = [];
  sourcePreviewTotal = 0;

  // ---- Tema, Yerleşim & İkon Özelleştirme ----
  showThemeModal = false;
  activeIconPickerLevel: 1 | 2 | 3 | 4 = 1;
  themeConfig: SpaceMapConfig = {
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
    autoTypeIcons: false,
    showOrbits: true,
    showGrid: true,
  };
  readonly availableIcons = AVAILABLE_ICONS;
  readonly availableLayouts: Array<{ id: SpaceMapLayout; label: string; desc: string; icon: string }> = [
    { id: 'radial', label: 'Yörünge (Radial)', desc: 'Konsantrik yörünge halkaları', icon: 'fa-circle-dot' },
    { id: 'hierarchy-tb', label: 'Ağaç (Dikey)', desc: 'Yukarıdan aşağıya hiyerarşi', icon: 'fa-sitemap' },
    { id: 'flow-lr', label: 'Proses Akışı (Yatay)', desc: 'Soldan sağa üretim/veri akışı', icon: 'fa-arrow-right-long' },
    { id: 'grid', label: 'Küme Matrisi (Grid)', desc: 'Kompakt fabrika saha matrisi', icon: 'fa-table-cells-large' },
    { id: 'spiral', label: 'Spiral Galaksi', desc: 'Yoğun düğümler için spiral dizilim', icon: 'fa-hurricane' },
  ];
  readonly availableShapes: { id: SpaceMapShape; label: string; labelKey: string }[] = [
    { id: 'auto', label: 'Temaya Göre Otomatik', labelKey: 'Temaya Göre Otomatik' },
    { id: 'hexagon', label: 'Endüstriyel Altıgen (Fabrika)', labelKey: 'Endüstriyel Altıgen (Fabrika)' },
    { id: 'cyber', label: 'Siber Sekizgen (IoT / PLC)', labelKey: 'Siber Sekizgen (IoT / PLC)' },
    { id: 'blueprint', label: 'Teknik Mühendislik Dairesi', labelKey: 'Teknik Mühendislik Dairesi' },
    { id: 'diamond', label: 'Kristal Elmas (Kalite / ESG)', labelKey: 'Kristal Elmas (Kalite / ESG)' },
    { id: 'planet', label: 'Gezegen / Yörünge Halkalı', labelKey: 'Gezegen / Yörünge Halkalı' },
    { id: 'circle', label: 'Sade Düğüm Dairesi', labelKey: 'Sade Düğüm Dairesi' },
  ];
  readonly presetList: { id: SpaceMapTheme; icon: string; name: string; nameKey: string; desc: string }[] = [
    { id: 'factory', icon: 'fa-industry', name: 'Fabrika & Üretim (ISA-95)', nameKey: 'Fabrika & Üretim (ISA-95)', desc: '🏭 CAD ızgarası, perçinli altıgenler, fabrika/robot/sensör ikonları' },
    { id: 'cyber', icon: 'fa-network-wired', name: 'Siber Ağ & IoT Telemetri', nameKey: 'Siber Ağ & IoT Telemetri', desc: '⚡ Neon matris, PLC/sunucu köşebentleri ve veri hatları' },
    { id: 'blueprint', icon: 'fa-drafting-compass', name: 'Mühendislik Blueprint', nameKey: 'Mühendislik Blueprint', desc: '📐 Teknik mimari mavi, milimetrik grid ve proses akış çizgileri' },
    { id: 'crystal', icon: 'fa-gem', name: 'Kristal & Kalite Analitiği', nameKey: 'Kristal & Kalite Analitiği', desc: '💎 Kuvars fasetleri, kalite/ESG rozetleri ve prizmatik vurgu' },
    { id: 'cosmic', icon: 'fa-satellite', name: 'Kozmik Uzay Yörüngesi', nameKey: 'Kozmik Uzay Yörüngesi', desc: '🪐 Yıldızlar, gezegen halkaları ve konsantrik yörüngeler' },
  ];
  private hasFitted = false;

  // ---- Hiyerarşi (render modeli) ----
  private roots: RNode[] = [];
  private nodeMap = new Map<string, RNode>();
  /** null = overview (tüm kökler); aksi halde focus düğümü merkeze koy. */
  focusId: string | null = null;
  /** Şu anda layout'lanıp ekrana gelen pencere (culling + hit-test için). */
  private renderNodes: RNode[] = [];
  totalNodes = 0;
  maxDepth = 0;
  /** Görünür derinlik sınırı (varsayılan 6 = tüm seviyeleri göster!). */
  maxVisibleRings = 6;

  // ---- Etkileşim / görünüm ----
  selectedNode: RNode | null = null;
  hoveredNode: RNode | null = null;
  private view = { zoom: 1, targetZoom: 1, panX: 0, panY: 0 };
  private readonly minZoom = 0.12;
  private readonly maxZoom = 3.2;

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
  private readonly RING_RADIUS = 230;
  private readonly NODE_RADIUS_BY_RING = [32, 24, 18, 14, 12, 10, 9];
  private readonly MAX_SEARCH_RESULTS = 15;
  private readonly MAX_LABEL_LEN = 22;

  constructor(
    private dss: DataSourceSelectionService,
    private pathService: PathService,
    private queryService: QueryService,
    private apiService: ApiService,
    private dashEdit: DashboardEditService,
    private templateService: TemplateBuilderService,
    private auth: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private aiContext: AiContextService,
  ) {}

  private initialPathId: string | null = null;
  private releaseAi?: () => void;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  ngOnInit(): void {
    this.releaseAi = this.aiContext.register('network-map', {
      context: () => ({
        active_queries: this.queries.filter(q => q.id === this.selectedPath?.queryId).map(q => ({ id: q.id, name: q.name, columns: q.columns })),
        path_config: this.selectedPath?.config, structure: this.selectedPath?.structure,
        data_source_id: this.selectedDataSourceId || undefined,
      }),
      accepts: language => language === 'json' && this.canManage,
      apply: (_language, _content, artifact) => {
        if (!artifact) throw new Error('Path JSON doğrulanamadı.');
        this.isLoading = true;
        this.pathService.preview(artifact.queryId, artifact.structure, artifact.config).subscribe({
          next: response => {
            this.selectedPathId = null;
            this.selectedPath = { id: '', name: 'Copilot önizlemesi', ...artifact };
            this.onBuilt(response.data.structure);
          },
          error: error => { this.isLoading = false; this.error = error.error?.error || 'Path önizlemesi başarısız.'; this.cdr.markForCheck(); },
        });
      },
    });
    this.canManage = this.auth.hasRole('engineer');
    this.dss.load();

    this.subs.push(
      this.route.queryParams.subscribe(params => {
        if (params['pathId']) {
          this.initialPathId = params['pathId'];
          if (this.paths.length) {
            this.onSelectPath(params['pathId']);
          }
        }
        if (params['dataSourceId']) {
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

    // FontAwesome webfont yüklendiğinde canvas ikonlarını yeniden çiz
    if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => {
        this.markDirty();
      });
    }

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
    this.releaseAi?.();
    this.subs.forEach(s => s.unsubscribe());
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.resizeRaf !== null) cancelAnimationFrame(this.resizeRaf);
  }

  // ===========================================================================
  // Veri yükleme
  // ===========================================================================

  private loadQueriesAndPaths(): void {
    forkJoin({
      queries: this.queryService.list(),
      scripts: this.queryService.listPythonScripts(),
      paths: this.pathService.list(),
    }).subscribe({
      next: ({ queries, scripts, paths }) => {
        this.queries = (queries.data as SavedQuery[]) || [];
        this.pythonScripts = (scripts.data as SavedPythonScript[]) || [];
        this.paths = (paths.data as PathDef[]) || [];
        this.filterPathsByDataSource();

        if (this.initialPathId) {
          const target = this.paths.find(p => p.id === this.initialPathId);
          if (target) {
            this.selectedPathId = target.id;
            this.onSelectPath(target.id);
            this.initialPathId = null;
            this.cdr.markForCheck();
            return;
          }
        }

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

  filterPathsByDataSource(): void {
    if (!this.selectedDataSourceId || this.showAllMapsAcrossDbs) {
      this.filteredPaths = this.paths;
      return;
    }
    const dsByQuery = new Map<string, string>();
    this.queries.forEach(q => dsByQuery.set(q.id, (q as any).dataSourceId || (q as any).data_source_id));
    const matching = this.paths.filter(p => {
      if (p.queryId?.startsWith('py:')) return true;
      const dsId = dsByQuery.get((p as any).queryId);
      return !dsId || dsId === this.selectedDataSourceId;
    });
    this.filteredPaths = matching.length ? matching : this.paths;
  }

  onDataSourceChange(): void {
    this.filterPathsByDataSource();
    if (!this.filteredPaths.some(p => p.id === this.selectedPathId)) {
      this.selectedPathId = null;
      this.selectedPath = null;
      this.resetGraph();
      this.autoSelectFirstPath();
    }
    this.cdr.markForCheck();
  }

  toggleAllMaps(): void {
    this.showAllMapsAcrossDbs = !this.showAllMapsAcrossDbs;
    this.filterPathsByDataSource();
    this.cdr.markForCheck();
  }

  toggleAllMapsAcrossDbs(): void {
    this.toggleAllMaps();
  }

  get layoutMode(): SpaceMapLayout {
    return this.themeConfig.layout || 'radial';
  }

  setLayoutMode(layout: SpaceMapLayout): void {
    this.setLayout(layout);
  }

  onMaxRingsChange(rings: number): void {
    this.setMaxVisibleRings(rings);
  }

  rebuildRender(): void {
    this.relayout();
    this.markDirty();
    this.cdr.markForCheck();
  }

  openQueryViewerForNewMap(): void {
    this.showQueryViewerModal = true;
    this.cdr.markForCheck();
  }

  get isExportingQuickReport(): boolean {
    return this.exportBusy;
  }

  get activePath(): PathDef | null {
    return this.selectedPath;
  }

  get isLoadingDataPreview(): boolean {
    return this.sourcePreviewLoading;
  }

  get previewSourceColumns(): string[] {
    return this.sourcePreviewColumns.map(c => c.name);
  }

  get previewSourceRows(): Array<Record<string, unknown>> {
    return this.sourcePreviewRows;
  }

  getSelectedIconForActiveLevel(): string {
    return this.getActiveLevelIcon();
  }

  getPathIcon(p: PathDef): string {
    const smc = (p.config as any)?.spaceMapConfig;
    if (smc?.level1Icon) return smc.level1Icon;
    return p.queryId?.startsWith('py:') ? 'fa-python' : 'fa-industry';
  }

  getPathBadgeColor(p: PathDef): string {
    const smc = (p.config as any)?.spaceMapConfig;
    return smc?.color1 || (p.queryId?.startsWith('py:') ? '#10b981' : '#38bdf8');
  }

  isPythonPath(p: PathDef): boolean {
    return Boolean(p.queryId?.startsWith('py:'));
  }

  private autoSelectFirstPath(): void {
    if (this.filteredPaths.length) {
      // Sunum için varsayılan olarak zengin fabrika ağacını veya ilk path'i seç
      const preferred = this.filteredPaths.find(p => p.id === 'pth_factory_tree') || this.filteredPaths[0];
      this.onSelectPath(preferred.id);
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

    this.pathService.get(pathId).subscribe({
      next: res => {
        this.selectedPath = res.data || null;
        this.syncThemeFromPath();
        const hasMaterialized = !!(this.selectedPath?.materialized?.nodes?.length);
        if (hasMaterialized && this.selectedPath?.materialized) {
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
          this.notify('Önbellekteki harita gösteriliyor', 'error');
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
      this.error = 'Bu harita tanımından düğüm üretilemedi.';
      this.resetGraph();
      this.cdr.markForCheck();
      return;
    }
    this.error = null;
    this.warnings = built.stats?.warnings || [];
    this.totalNodes = built.stats?.node_count || built.nodes.length;
    this.maxDepth = built.stats?.max_depth || 0;

    this.buildForest(built);
    // Tek kök varsa doğrudan ona odaklan; çok köklü ise overview
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
        parents: n.parents || (n.parent ? [n.parent] : []),
        children: [],
        leafCount: 1,
        x: 0, y: 0, ring: 0,
        type: n.type,
        icon: n.icon,
        healthScore: n.healthScore,
        status: n.status,
        statusColor: n.statusColor,
        badge: n.badge,
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
  // Layout — 5 Farklı Yerleşim Algoritması (Radial, Dikey Ağaç, Yatay Akış, Grid, Spiral)
  // ===========================================================================

  setLayout(layout: SpaceMapLayout): void {
    this.themeConfig.layout = layout;
    this.relayout();
    this.fitView();
    this.markDirty();
    this.cdr.markForCheck();
  }

  setMaxVisibleRings(rings: number): void {
    this.maxVisibleRings = rings;
    this.relayout();
    this.fitView();
    this.markDirty();
    this.cdr.markForCheck();
  }

  private relayout(): void {
    this.labelCache.clear();
    const layout = this.themeConfig.layout || 'radial';
    const windowNodes: RNode[] = [];

    if (layout === 'hierarchy-tb' || layout === 'flow-lr') {
      this.layoutLayeredTree(layout === 'flow-lr', windowNodes);
    } else if (layout === 'grid') {
      this.layoutClusterGrid(windowNodes);
    } else if (layout === 'spiral') {
      this.layoutSpiral(windowNodes);
    } else {
      // Varsayılan: Radial Yörünge
      if (this.focusId) {
        const focus = this.nodeMap.get(this.focusId);
        if (focus) {
          focus.x = 0; focus.y = 0; focus.ring = 0;
          windowNodes.push(focus);
          this.layoutChildrenRadial(focus, 0, Math.PI * 2, 1, windowNodes);
        }
      } else {
        const totalLeaves = this.roots.reduce((s, r) => s + r.leafCount, 0) || 1;
        let cursor = 0;
        this.roots.forEach(root => {
          const span = (Math.PI * 2) * (root.leafCount / totalLeaves);
          this.placeRadial(root, cursor, cursor + span, 1, windowNodes);
          cursor += span;
        });
      }
    }
    this.renderNodes = windowNodes;
  }

  private placeRadial(node: RNode, start: number, end: number, ring: number, out: RNode[]): void {
    const mid = (start + end) / 2;
    node.ring = ring;
    node.x = Math.cos(mid) * this.RING_RADIUS * ring;
    node.y = Math.sin(mid) * this.RING_RADIUS * ring;
    out.push(node);
    if (ring >= this.maxVisibleRings) return;

    const total = node.children.reduce((s, c) => s + c.leafCount, 0) || 1;
    let cursor = start;
    node.children.forEach(child => {
      const span = (end - start) * (child.leafCount / total);
      this.placeRadial(child, cursor, cursor + span, ring + 1, out);
      cursor += span;
    });
  }

  private layoutChildrenRadial(node: RNode, start: number, end: number, ring: number, out: RNode[]): void {
    const total = node.children.reduce((s, c) => s + c.leafCount, 0) || 1;
    let cursor = start;
    node.children.forEach(child => {
      const span = (end - start) * (child.leafCount / total);
      this.placeRadial(child, cursor, cursor + span, ring, out);
      cursor += span;
    });
  }

  /** Dikey Ağaç (hierarchy-tb) veya Yatay Proses Akışı (flow-lr) yerleşimi */
  private layoutLayeredTree(horizontal: boolean, out: RNode[]): void {
    const startNodes = this.focusId && this.nodeMap.has(this.focusId)
      ? [this.nodeMap.get(this.focusId)!]
      : this.roots;
    if (!startNodes.length) return;

    const levelGap = horizontal ? 260 : 190;
    const leafSpacing = horizontal ? 105 : 145;
    let leafCursor = 0;
    const visited = new Set<string>();

    const placeNode = (n: RNode, ring: number): { minPos: number; maxPos: number } => {
      if (visited.has(n.id)) return { minPos: 0, maxPos: 0 };
      visited.add(n.id);
      n.ring = ring;
      out.push(n);

      if (!n.children.length || ring >= this.maxVisibleRings) {
        const pos = leafCursor * leafSpacing;
        leafCursor += 1;
        if (horizontal) {
          n.x = ring * levelGap;
          n.y = pos;
        } else {
          n.x = pos;
          n.y = ring * levelGap;
        }
        return { minPos: pos, maxPos: pos };
      }

      let minC = Infinity;
      let maxC = -Infinity;
      for (const ch of n.children) {
        const b = placeNode(ch, ring + 1);
        minC = Math.min(minC, b.minPos);
        maxC = Math.max(maxC, b.maxPos);
      }
      const center = Number.isFinite(minC) ? (minC + maxC) / 2 : leafCursor * leafSpacing;
      if (horizontal) {
        n.x = ring * levelGap;
        n.y = center;
      } else {
        n.x = center;
        n.y = ring * levelGap;
      }
      return { minPos: minC, maxPos: maxC };
    };

    startNodes.forEach(r => {
      placeNode(r, 0);
      leafCursor += 0.6;
    });

    // Merkeze hizala
    if (out.length) {
      const avgX = out.reduce((s, n) => s + n.x, 0) / out.length;
      const avgY = out.reduce((s, n) => s + n.y, 0) / out.length;
      out.forEach(n => { n.x -= avgX; n.y -= avgY; });
    }
  }

  /** Kümelenmiş Fabrika Matrisi (Grid) yerleşimi */
  private layoutClusterGrid(out: RNode[]): void {
    const startNodes = this.focusId && this.nodeMap.has(this.focusId)
      ? [this.nodeMap.get(this.focusId)!]
      : this.roots;
    const visited = new Set<string>();
    const collect = (n: RNode, ring: number) => {
      if (visited.has(n.id) || ring > this.maxVisibleRings) return;
      visited.add(n.id);
      n.ring = ring;
      out.push(n);
      n.children.forEach(c => collect(c, ring + 1));
    };
    startNodes.forEach(r => collect(r, 0));

    const cols = Math.max(2, Math.ceil(Math.sqrt(out.length * 1.3)));
    const cellW = 210;
    const cellH = 155;
    out.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      n.x = (col - (cols - 1) / 2) * cellW;
      n.y = (row - Math.floor(out.length / cols) / 2) * cellH;
    });
  }

  /** Spiral Galaksi yerleşimi */
  private layoutSpiral(out: RNode[]): void {
    const startNodes = this.focusId && this.nodeMap.has(this.focusId)
      ? [this.nodeMap.get(this.focusId)!]
      : this.roots;
    const visited = new Set<string>();
    const queue: Array<{ n: RNode; ring: number }> = startNodes.map(n => ({ n, ring: 0 }));
    while (queue.length) {
      const { n, ring } = queue.shift()!;
      if (visited.has(n.id) || ring > this.maxVisibleRings) continue;
      visited.add(n.id);
      n.ring = ring;
      out.push(n);
      n.children.forEach(c => queue.push({ n: c, ring: ring + 1 }));
    }
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    out.forEach((n, i) => {
      if (i === 0) {
        n.x = 0; n.y = 0;
      } else {
        const radius = 95 * Math.sqrt(i);
        const theta = i * goldenAngle;
        n.x = Math.cos(theta) * radius;
        n.y = Math.sin(theta) * radius;
      }
    });
  }

  // ===========================================================================
  // Canvas kurulumu & Render Döngüsü
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

  private startRenderLoop(): void {
    const tick = () => {
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

    this.drawBackground(w, h);
    if (!this.renderNodes.length) return;

    ctx.save();
    ctx.translate(this.view.panX, this.view.panY);
    ctx.scale(this.view.zoom, this.view.zoom);

    const bounds = this.visibleBounds();
    this.drawLinks(bounds);
    this.drawNodes(bounds);

    ctx.restore();
  }

  private drawBackground(w: number, h: number): void {
    const ctx = this.ctx!;
    const theme = this.themeConfig.theme;
    const showGrid = this.themeConfig.showGrid !== false;

    if (!this.bgCache || this.bgCacheSize.w !== w || this.bgCacheSize.h !== h) {
      const cache = document.createElement('canvas');
      cache.width = w; cache.height = h;
      const c = cache.getContext('2d')!;

      if (theme === 'factory') {
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#090d14');
        g.addColorStop(0.5, '#0f1522');
        g.addColorStop(1, '#070a10');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        if (showGrid) {
          c.strokeStyle = 'rgba(245, 158, 11, 0.035)';
          c.lineWidth = 1;
          for (let gx = 0; gx < w; gx += 40) { c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
          for (let gy = 0; gy < h; gy += 40) { c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke(); }

          c.strokeStyle = 'rgba(245, 158, 11, 0.08)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 120) { c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
          for (let gy = 0; gy < h; gy += 120) { c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke(); }

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
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#020408');
        g.addColorStop(0.5, '#050c14');
        g.addColorStop(1, '#010204');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        if (showGrid) {
          c.strokeStyle = 'rgba(0, 255, 157, 0.035)';
          c.lineWidth = 1;
          for (let gx = 0; gx < w; gx += 35) { c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
          for (let gy = 0; gy < h; gy += 35) { c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke(); }

          c.strokeStyle = 'rgba(0, 240, 255, 0.08)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 140) { c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
          for (let gy = 0; gy < h; gy += 140) { c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke(); }

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
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#061a33');
        g.addColorStop(0.5, '#09274c');
        g.addColorStop(1, '#051426');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        if (showGrid) {
          c.strokeStyle = 'rgba(56, 189, 248, 0.045)';
          c.lineWidth = 0.8;
          for (let gx = 0; gx < w; gx += 20) { c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
          for (let gy = 0; gy < h; gy += 20) { c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke(); }

          c.strokeStyle = 'rgba(56, 189, 248, 0.12)';
          c.lineWidth = 1.2;
          for (let gx = 0; gx < w; gx += 100) { c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
          for (let gy = 0; gy < h; gy += 100) { c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke(); }
        }
        const glow = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.65);
        glow.addColorStop(0, 'rgba(56, 189, 248, 0.09)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = glow; c.fillRect(0, 0, w, h);

      } else if (theme === 'crystal') {
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#07050f');
        g.addColorStop(0.5, '#0e0a1f');
        g.addColorStop(1, '#05030b');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        const a1 = c.createRadialGradient(w * 0.35, h * 0.4, 30, w * 0.35, h * 0.4, Math.max(w, h) * 0.5);
        a1.addColorStop(0, 'rgba(236, 72, 153, 0.10)');
        a1.addColorStop(0.6, 'rgba(139, 92, 246, 0.04)');
        a1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = a1; c.fillRect(0, 0, w, h);
      } else {
        const g = c.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, '#04060e');
        g.addColorStop(0.5, '#080c1d');
        g.addColorStop(1, '#04050c');
        c.fillStyle = g; c.fillRect(0, 0, w, h);

        const n1 = c.createRadialGradient(w * 0.3, h * 0.35, 20, w * 0.3, h * 0.35, Math.max(w, h) * 0.48);
        n1.addColorStop(0, 'rgba(167, 139, 250, 0.11)');
        n1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        c.fillStyle = n1; c.fillRect(0, 0, w, h);

        c.fillStyle = 'rgba(225, 235, 255, 0.75)';
        const starCount = Math.min(140, Math.floor((w * h) / 12000));
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

    // Yörünge halkaları yalnızca radial düzende çizilir
    if (this.themeConfig.showOrbits !== false && (!this.themeConfig.layout || this.themeConfig.layout === 'radial')) {
      ctx.save();
      ctx.translate(this.view.panX, this.view.panY);
      ctx.scale(this.view.zoom, this.view.zoom);

      if (theme === 'factory') {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.10)';
        ctx.setLineDash([8, 8]);
      } else if (theme === 'cyber') {
        ctx.strokeStyle = 'rgba(0, 255, 157, 0.11)';
        ctx.setLineDash([4, 12]);
      } else if (theme === 'blueprint') {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
        ctx.setLineDash([6, 6]);
      } else if (theme === 'crystal') {
        ctx.strokeStyle = 'rgba(236, 72, 153, 0.10)';
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(124, 141, 181, 0.08)';
        ctx.setLineDash([]);
      }

      ctx.lineWidth = 1 / this.view.zoom;
      const maxRing = Math.min(this.maxVisibleRings, Math.max(this.maxDepth + 1, 3));
      for (let r = 1; r <= maxRing; r++) {
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
    const layout = this.themeConfig.layout || 'radial';

    for (const node of this.renderNodes) {
      const parentIds = node.parents?.length ? node.parents : (node.parentId ? [node.parentId] : []);
      for (let pIdx = 0; pIdx < parentIds.length; pIdx++) {
        const pid = parentIds[pIdx];
        if (!pid || !nodeSet.has(pid)) continue;
        const parent = this.nodeMap.get(pid);
        if (!parent) continue;
        if (!showAll && !this.inBounds(node, bounds) && !this.inBounds(parent, bounds)) continue;

        const color = this.levelColor(node.depth);
        const isSecondaryDagEdge = pIdx > 0;

        ctx.save();
        if (isSecondaryDagEdge) {
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = this.alpha(color, 0.4);
          ctx.lineWidth = 1.3;
        } else if (theme === 'blueprint') {
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = this.alpha(color, 0.5);
          ctx.lineWidth = 1.4;
        } else if (theme === 'cyber') {
          ctx.setLineDash([]);
          ctx.strokeStyle = this.alpha(color, 0.65);
          ctx.lineWidth = 1.8;
          ctx.shadowColor = color;
          ctx.shadowBlur = 8;
        } else if (theme === 'factory') {
          ctx.setLineDash([]);
          ctx.strokeStyle = this.alpha(color, 0.48);
          ctx.lineWidth = 2.4;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = this.alpha(color, 0.42);
          ctx.lineWidth = 1.5;
        }

        ctx.beginPath();
        ctx.moveTo(parent.x, parent.y);
        if (layout === 'flow-lr') {
          const midX = (parent.x + node.x) / 2;
          ctx.bezierCurveTo(midX, parent.y, midX, node.y, node.x, node.y);
        } else if (layout === 'hierarchy-tb') {
          const midY = (parent.y + node.y) / 2;
          ctx.bezierCurveTo(parent.x, midY, node.x, midY, node.x, node.y);
        } else {
          const mx = (parent.x + node.x) / 2;
          const my = (parent.y + node.y) / 2;
          ctx.quadraticCurveTo(mx, my, node.x, node.y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawNodes(bounds: VisibleBounds): void {
    const ctx = this.ctx!;
    const focus = this.focusId ? this.nodeMap.get(this.focusId) : null;
    const showLabels = this.view.zoom >= 0.45;
    const shape = this.resolveNodeShape();

    for (const node of this.renderNodes) {
      if (!this.inBounds(node, bounds)) continue;
      const isFocus = focus === node;
      const isHover = this.hoveredNode === node;
      const isSel = this.selectedNode === node;
      const baseR = this.nodeRadius(node.depth, isFocus);
      const r = isHover || isFocus ? baseR * 1.15 : baseR;
      const color = this.levelColor(node.depth);

      if (isFocus || isHover || isSel) {
        ctx.shadowColor = color;
        ctx.shadowBlur = isFocus ? 28 : (isSel ? 22 : 16);
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // 1. Düğüm Gövdesi
      if (shape === 'hexagon') {
        this.drawHexagon(ctx, node.x, node.y, r);
        const grad = ctx.createLinearGradient(node.x - r, node.y - r, node.x + r, node.y + r);
        grad.addColorStop(0, '#1c2430');
        grad.addColorStop(0.55, '#121822');
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.lineWidth = isSel ? 2.8 : 1.8;
        ctx.strokeStyle = isSel ? '#ffffff' : (node.statusColor || this.alpha(color, 0.75));
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
        ctx.lineWidth = isSel ? 2.8 : 1.8;
        ctx.strokeStyle = isSel ? '#ffffff' : (node.statusColor || this.alpha(color, 0.8));
        ctx.stroke();

        if (r >= 12 && (isFocus || isHover || isSel || this.view.zoom >= 0.7)) {
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
        ctx.lineWidth = isSel ? 2.8 : 1.8;
        ctx.strokeStyle = isSel ? '#ffffff' : (node.statusColor || this.alpha(color, 0.75));
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
        ctx.lineWidth = isSel ? 2.8 : 1.8;
        ctx.strokeStyle = isSel ? '#ffffff' : (node.statusColor || this.alpha(color, 0.8));
        ctx.stroke();

        if (r >= 12) {
          this.drawBlueprintCrosshairs(ctx, node.x, node.y, r, isSel ? '#ffffff' : color);
        }
      } else {
        if (shape === 'planet' && (isFocus || node.depth === 0)) {
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
        ctx.lineWidth = isSel ? 2.8 : 1.8;
        ctx.strokeStyle = isSel ? '#ffffff' : (node.statusColor || this.alpha(color, 0.6));
        ctx.stroke();

        if (shape === 'planet' && node.depth > 0 && r >= 14) {
          this.drawPlanetaryRing(ctx, node.x, node.y, r, color);
        }
      }

      // 2. FontAwesome Düğüm İkonu (Derinlik ve Tip Bazlı!)
      const icon = this.getNodeIcon(node);
      if (icon && r >= 10 && this.view.zoom >= 0.35) {
        const iconSize = Math.max(9, Math.round(r * 0.86));
        this.renderCanvasIcon(ctx, icon, node.x, node.y, iconSize, '#ffffff');
      }

      // 3. Çocuk Sayısı Rozeti (sağ-üst)
      if (node.children.length && r >= 12) {
        const chip = String(node.children.length);
        const bx = node.x + r * 0.74;
        const by = node.y - r * 0.74;
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

      // 4. Canlı Sağlık / OEE / Durum Rozeti (sol-üst veya alt)
      if ((node.badge || node.healthScore !== undefined) && r >= 12 && (this.view.zoom >= 0.6 || isHover || isSel)) {
        const badgeText = node.badge || `${node.healthScore}%`;
        const bColor = node.statusColor || '#10b981';
        const bx = node.x - r * 0.75;
        const by = node.y - r * 0.75;
        ctx.save();
        ctx.font = '700 9px "Space Grotesk", sans-serif';
        const tw = ctx.measureText(badgeText).width + 8;
        const th = 14;
        ctx.fillStyle = bColor;
        ctx.beginPath();
        ctx.roundRect(bx - tw / 2, by - th / 2, tw, th, 4);
        ctx.fill();
        ctx.strokeStyle = '#05070f';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, bx, by);
        ctx.restore();
      }

      // 5. Etiket
      if (showLabels || isHover || isFocus || isSel) {
        this.drawLabel(node.label, node.x, node.y + r + 11, color, isHover || isFocus || isSel);
      }
    }
  }

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

  /**
   * Düğümün gerçek hiyerarşi derinliğine (node.depth) ve (aktifse) semantik tipine göre ikon döndürür.
   */
  getNodeIcon(node: RNode): string {
    if (node.icon) return node.icon;

    if (this.themeConfig.autoTypeIcons && node.type) {
      const t = node.type.toLowerCase();
      if (t.includes('enterprise') || t.includes('plant') || t.includes('campus') || t.includes('site')) return 'fa-building';
      if (t.includes('area') || t.includes('shop') || t.includes('facility') || t.includes('factory')) return 'fa-industry';
      if (t.includes('line') || t.includes('workcenter') || t.includes('assembly')) return 'fa-cogs';
      if (t.includes('robot') || t.includes('arm') || t.includes('agv')) return 'fa-robot';
      if (t.includes('sensor') || t.includes('meter') || t.includes('point') || t.includes('gauge')) return 'fa-gauge-high';
      if (t.includes('plc') || t.includes('controller') || t.includes('edge')) return 'fa-microchip';
      if (t.includes('trafo') || t.includes('grid') || t.includes('power') || t.includes('energy') || t.includes('feeder')) return 'fa-bolt';
      if (t.includes('warehouse') || t.includes('storage')) return 'fa-warehouse';
      if (t.includes('quality') || t.includes('inspection')) return 'fa-clipboard-check';
      if (t.includes('defect') || t.includes('alarm') || t.includes('fault')) return 'fa-triangle-exclamation';
      if (t.includes('machine') || t.includes('cnc') || t.includes('press') || t.includes('weld')) return 'fa-gear';
    }

    const d = node.depth ?? 0;
    if (d === 0) return this.themeConfig.level1Icon || 'fa-industry';
    if (d === 1) return this.themeConfig.level2Icon || 'fa-cogs';
    if (d === 2) return this.themeConfig.level3Icon || 'fa-robot';
    return this.themeConfig.level4Icon || this.themeConfig.level3Icon || 'fa-gauge-high';
  }

  private renderCanvasIcon(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, size: number, color = '#ffffff'): void {
    if (!icon) return;
    const clean = icon.trim();
    const glyph = FA_GLYPHS[clean] || FA_GLYPHS[clean.replace('fa-', '')] || FA_GLYPHS['fa-' + clean] || '\uf013';
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(size)}px "Font Awesome 6 Free", "Font Awesome 5 Free", FontAwesome, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(glyph, x, y);
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
    ctx.beginPath();
    ctx.moveTo(x - bDist + bLen, y - bDist); ctx.lineTo(x - bDist, y - bDist); ctx.lineTo(x - bDist, y - bDist + bLen);
    ctx.moveTo(x + bDist - bLen, y - bDist); ctx.lineTo(x + bDist, y - bDist); ctx.lineTo(x + bDist, y - bDist + bLen);
    ctx.moveTo(x - bDist, y + bDist - bLen); ctx.lineTo(x - bDist, y + bDist); ctx.lineTo(x - bDist + bLen, y + bDist);
    ctx.moveTo(x + bDist - bLen, y + bDist); ctx.lineTo(x + bDist, y + bDist); ctx.lineTo(x + bDist, y + bDist - bLen);
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
  }

  private drawLabel(text: string, x: number, y: number, color: string, emphasize: boolean): void {
    const ctx = this.ctx!;
    const label = this.truncate(text);
    ctx.font = `${emphasize ? '700 ' : '500 '}12px "Space Grotesk", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.88)';
    ctx.lineWidth = 3.2;
    ctx.strokeText(label, x, y);
    ctx.fillStyle = emphasize ? '#ffffff' : this.alpha(color, 0.95);
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
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
      const r = this.nodeRadius(node.depth, this.focusId === node.id) + 5;
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

  private nodeRadius(depth: number, isFocus = false): number {
    if (isFocus) return this.NODE_RADIUS_BY_RING[0];
    return this.NODE_RADIUS_BY_RING[Math.min(depth + 1, this.NODE_RADIUS_BY_RING.length - 1)];
  }

  private levelColor(depth: number): string {
    const palette = [
      this.themeConfig.color1 || '#F59E0B',
      this.themeConfig.color2 || '#10B981',
      this.themeConfig.color3 || '#06B6D4',
      '#60A5FA',
      '#A78BFA',
      '#EC4899',
    ];
    return palette[((depth % palette.length) + palette.length) % palette.length];
  }

  private truncate(text: string): string {
    if (text.length <= this.MAX_LABEL_LEN) return text;
    return text.slice(0, this.MAX_LABEL_LEN - 1) + '…';
  }

  private hash(n: number): number {
    const x = Math.sin(n) * 43758.5453;
    return x - Math.floor(x);
  }

  private alpha(hex: string, a: number): string {
    const h = (hex || '#60A5FA').replace('#', '');
    const r = parseInt(h.slice(0, 2) || '60', 16);
    const g = parseInt(h.slice(2, 4) || 'a5', 16);
    const b = parseInt(h.slice(4, 6) || 'fa', 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  private visibleBounds(): VisibleBounds {
    const { w, h } = this.canvasSize;
    const z = this.view.zoom;
    const pad = 160;
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

  selectNode(node: RNode): void {
    this.selectedNode = node;
    this.markDirty();
    this.cdr.markForCheck();
  }

  /** Seçili düğüme odaklan (drill-down) */
  drillIntoSelected(): void {
    if (!this.selectedNode || !this.selectedNode.children.length) return;
    this.focusId = this.selectedNode.id;
    this.relayout();
    this.fitView();
    this.markDirty();
    this.cdr.markForCheck();
  }

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

  resetToOverview(): void {
    this.focusId = null;
    this.selectedNode = null;
    this.relayout();
    this.fitView();
    this.markDirty();
    this.cdr.markForCheck();
  }

  zoomIn(): void { this.zoomBy(1.3); }
  zoomOut(): void { this.zoomBy(1 / 1.3); }

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

  fitView(): void {
    if (!this.renderNodes.length || !this.canvas) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.renderNodes) {
      const r = this.nodeRadius(n.depth, this.focusId === n.id) + 45;
      minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
      minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
    }
    const { w, h } = this.canvasSize;
    if (w <= 0 || h <= 0) return;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(w / bw, h / bh) * 0.85));
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

  // ---- Arama ----
  onSearch(): void {
    const q = this.searchTerm.trim().toLowerCase();
    if (!q) {
      this.searchResults = [];
      this.searchHint = '';
      return;
    }
    const matches: RNode[] = [];
    for (const node of this.nodeMap.values()) {
      if (node.label.toLowerCase().includes(q) || (node.type || '').toLowerCase().includes(q)) {
        matches.push(node);
        if (matches.length >= this.MAX_SEARCH_RESULTS) break;
      }
    }
    this.searchResults = matches;
    this.searchHint = matches.length ? `${matches.length} eşleşme` : 'Sonuç bulunamadı';
  }

  focusSearchResult(node: RNode): void {
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
    return `Seviye ${this.selectedNode.depth + 1}${this.selectedNode.type ? ' • ' + this.selectedNode.type : ''}`;
  }

  get selectedBreadcrumbNodes(): RNode[] {
    if (!this.selectedNode) return [];
    const chain: RNode[] = [];
    const seen = new Set<string>();
    let cur: RNode | null = this.selectedNode;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? this.nodeMap.get(cur.parentId) ?? null : null;
    }
    return chain;
  }

  get selectedBreadcrumb(): string[] {
    return this.selectedBreadcrumbNodes.map(n => n.label);
  }

  get selectedPathString(): string {
    return this.selectedBreadcrumb.join(' › ');
  }

  focusBreadcrumb(node: RNode): void {
    this.selectNode(node);
    if (node.children.length) {
      this.focusId = node.id;
      this.relayout();
      this.fitView();
    }
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
    if (!this.focusId) return 'Tüm Hiyerarşi (Genel Görünüm)';
    return this.nodeMap.get(this.focusId)?.label || '';
  }

  get zoomPercent(): number {
    return Math.round(this.view.zoom * 100);
  }

  get brandIcon(): string {
    if (this.themeConfig.level1Icon) return this.themeConfig.level1Icon;
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
    if (this.selectedPath?.name) return this.selectedPath.name;
    return 'Space Map & Topoloji Stüdyosu';
  }

  get pageSubtitle(): string {
    if (this.selectedPath?.description) return this.selectedPath.description;
    return 'Dinamik SQL Sorgusu, Python Scripti, DB Tablosu ve Package Hiyerarşi Haritası';
  }

  closeDetail(): void {
    this.selectedNode = null;
    this.cdr.markForCheck();
  }

  // ---- Tema, İkon & Görünüm Ayarları ----
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
      level4Icon: preset.level4Icon || 'fa-gauge-high',
      showOrbits: preset.showOrbits,
      showGrid: preset.showGrid,
    };
    this.bgCache = null;
    this.markDirty();
    this.cdr.markForCheck();
  }

  selectLevelIcon(level: 1 | 2 | 3 | 4, iconId: string): void {
    if (level === 1) this.themeConfig.level1Icon = iconId;
    else if (level === 2) this.themeConfig.level2Icon = iconId;
    else if (level === 3) this.themeConfig.level3Icon = iconId;
    else this.themeConfig.level4Icon = iconId;
    this.onThemeChange();
  }

  getActiveLevelIcon(): string {
    if (this.activeIconPickerLevel === 1) return this.themeConfig.level1Icon;
    if (this.activeIconPickerLevel === 2) return this.themeConfig.level2Icon;
    if (this.activeIconPickerLevel === 3) return this.themeConfig.level3Icon;
    return this.themeConfig.level4Icon || 'fa-gauge-high';
  }

  syncThemeFromPath(): void {
    const smc = (this.selectedPath?.config as any)?.spaceMapConfig;
    if (smc) {
      const validThemes: SpaceMapTheme[] = ['cosmic', 'factory', 'cyber', 'blueprint', 'crystal'];
      const theme: SpaceMapTheme = validThemes.includes(smc.theme) ? smc.theme : 'factory';
      const preset = THEME_PRESETS[theme];

      this.themeConfig = {
        theme,
        layout: (smc.layout as SpaceMapLayout) || 'radial',
        nodeShape: smc.nodeShape || preset.nodeShape,
        color1: smc.color1 || preset.color1,
        color2: smc.color2 || preset.color2,
        color3: smc.color3 || preset.color3,
        level1Icon: smc.level1Icon || preset.level1Icon,
        level2Icon: smc.level2Icon || preset.level2Icon,
        level3Icon: smc.level3Icon || preset.level3Icon,
        level4Icon: smc.level4Icon || preset.level4Icon || 'fa-gauge-high',
        autoTypeIcons: smc.autoTypeIcons !== undefined ? smc.autoTypeIcons : false,
        showOrbits: smc.showOrbits !== undefined ? smc.showOrbits : true,
        showGrid: smc.showGrid !== undefined ? smc.showGrid : true,
      };
    } else {
      this.applyThemePreset('factory');
    }
    this.bgCache = null;
    this.markDirty();
    this.cdr.markForCheck();
  }

  openThemeModal(): void {
    this.showThemeModal = true;
    this.cdr.markForCheck();
  }

  onThemeChange(): void {
    this.bgCache = null;
    this.relayout();
    this.markDirty();
    this.cdr.markForCheck();
  }

  saveTheme(): void {
    this.bgCache = null;
    this.relayout();
    this.markDirty();
    if (!this.selectedPath || !this.selectedPathId || !this.canManage) {
      this.showThemeModal = false;
      this.notify('Görünüm ve ikonlar haritaya uygulandı.', 'success');
      return;
    }
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
        level4Icon: this.themeConfig.level4Icon || 'fa-gauge-high',
        autoTypeIcons: !!this.themeConfig.autoTypeIcons,
        showOrbits: this.themeConfig.showOrbits,
        showGrid: this.themeConfig.showGrid,
      }
    };
    const updated = { ...this.selectedPath, config };
    this.pathService.update(this.selectedPathId, updated).subscribe({
      next: res => {
        this.selectedPath = res.data || updated;
        const idx = this.paths.findIndex(p => p.id === this.selectedPathId);
        if (idx >= 0) this.paths[idx] = this.selectedPath;
        this.filterPathsByDataSource();
        this.showThemeModal = false;
        this.notify('Tema, yerleşim ve ikon ayarları kaydedildi.', 'success');
      },
      error: () => {
        this.showThemeModal = false;
        this.notify('Görünüm aktif oturuma uygulandı.', 'success');
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

  // ===========================================================================
  // Query Viewer ↔ Space Map ↔ Template Builder Bağlantısı (Connectivity)
  // ===========================================================================

  /** Mevcut Space Map'i besleyen SQL Sorgusunun veya Python Scriptinin canlı verilerini modalda gösterir */
  openSourceDataPreview(): void {
    const qid = this.selectedPath?.queryId;
    if (!qid) return;
    this.showDataPreviewModal = true;
    this.sourcePreviewLoading = true;
    this.sourcePreviewColumns = [];
    this.sourcePreviewRows = [];
    this.cdr.markForCheck();

    if (qid.startsWith('py:')) {
      const parts = qid.split(':');
      const scriptId = parts[1];
      const dsName = parts[2] || '';
      this.queryService.runSavedPythonScript(scriptId).subscribe({
        next: (res) => {
          this.sourcePreviewLoading = false;
          const datasets = res.data?.datasets || {};
          const target = datasets[dsName] || Object.values(datasets)[0];
          if (target) {
            this.sourcePreviewColumns = target.columns || [];
            this.sourcePreviewRows = (target.rows || []).slice(0, 50);
            this.sourcePreviewTotal = target.totalRows ?? target.rows?.length ?? 0;
          }
          this.cdr.markForCheck();
        },
        error: () => {
          this.sourcePreviewLoading = false;
          this.cdr.markForCheck();
        }
      });
    } else {
      this.queryService.preview(qid, {}, 50).subscribe({
        next: (res) => {
          this.sourcePreviewLoading = false;
          this.sourcePreviewColumns = res.data?.columns || [];
          this.sourcePreviewRows = res.data?.rows || [];
          this.sourcePreviewTotal = res.data?.totalRows ?? this.sourcePreviewRows.length;
          this.cdr.markForCheck();
        },
        error: () => {
          this.sourcePreviewLoading = false;
          this.cdr.markForCheck();
        }
      });
    }
  }

  /**
   * Query Viewer Dialog'dan herhangi bir SQL Sorgusu veya Python Scripti seçildiğinde
   * onu anında Space Map üzerinde hiyerarşik haritaya dönüştürür ve kaydeder!
   */
  onQueryViewerSelected(item: any): void {
    this.showQueryViewerModal = false;
    if (!item) return;

    const isPy = item.source === 'python';
    const rawId = String(item.id || '').replace(/^py:/, '');
    const dsName = item.datasetName || item.datasetNames?.[0] || 'default';
    const queryId = isPy ? `py:${rawId}:${dsName}` : item.id;
    const mapName = `${item.name}${isPy ? ' (' + dsName + ')' : ''} — Haritası`;

    this.isLoading = true;
    this.cdr.markForCheck();

    const buildFromCols = (cols: string[]) => {
      const hasParent = cols.some(c => /^parent|parent_id|pid|prereq/i.test(c));
      const structure: PathStructure = hasParent ? 'tree' : 'multi_level';
      const idCol = cols.find(c => /^id$|_id$|code|node_id|step_id|path_id/i.test(c)) || cols[0] || 'id';
      const parentCol = cols.find(c => /parent|pid|prereq/i.test(c)) || cols[1] || cols[0];
      const labelCol = cols.find(c => /name|label|title|line|machine|meter/i.test(c)) || idCol;
      const healthCol = cols.find(c => /health|oee|score|yield|factor/i.test(c));
      const statusCol = cols.find(c => /status|state|severity/i.test(c));

      const catCols = cols.filter(c => c !== healthCol && !/count|total|sum|avg|min|max|kwh|cost|pct|score/i.test(c));
      const l1 = catCols[0] || cols[0];
      const l2 = catCols.find(c => c !== l1 && c !== labelCol) || '';

      const config: any = structure === 'tree'
        ? { id_col: idCol, parent_col: parentCol, label_col: labelCol, health_col: healthCol, status_col: statusCol }
        : { level_cols: [l1, ...(l2 ? [l2] : []), ...(labelCol !== l1 && labelCol !== l2 ? [labelCol] : [])], label_col: labelCol, id_col: idCol, health_col: healthCol, status_col: statusCol };

      config.spaceMapConfig = { ...this.themeConfig };

      this.pathService.preview(queryId, structure, config).subscribe({
        next: (prevRes) => {
          this.selectedPath = {
            id: '',
            name: mapName,
            description: item.description || `${item.name} kaynağından oluşturulan uzay haritası.`,
            queryId,
            structure,
            config,
          };
          this.onBuilt(prevRes.data.structure);
          this.notify(`"${item.name}" haritası oluşturuldu.`, 'success');

          // Yetkisi varsa kalıcı olarak da kaydet ki harita seçicide yer alsın
          if (this.canManage) {
            this.pathService.create(this.selectedPath).subscribe({
              next: (saved) => {
                if (saved.data?.id) {
                  this.selectedPath = saved.data;
                  this.selectedPathId = saved.data.id;
                  this.paths = [saved.data, ...this.paths];
                  this.filterPathsByDataSource();
                  this.pathService.build(saved.data.id).subscribe();
                  this.cdr.markForCheck();
                }
              }
            });
          }
        },
        error: (err) => {
          this.isLoading = false;
          this.notify(err?.error?.error || 'Seçilen sorgudan harita üretilemedi.', 'error');
        }
      });
    };

    if (isPy) {
      this.queryService.getPythonScriptColumns(rawId, dsName).subscribe({
        next: (res) => buildFromCols(res.data || []),
        error: () => { this.isLoading = false; this.cdr.markForCheck(); }
      });
    } else {
      this.queryService.preview(queryId, {}, 5).subscribe({
        next: (res) => buildFromCols((res.data?.columns || []).map(c => c.name)),
        error: () => { this.isLoading = false; this.cdr.markForCheck(); }
      });
    }
  }

  /**
   * Aktif Space Map veya seçili düğüm için Template Builder'da tam teşekküllü,
   * başlık + özet KPI + dinamik DetailBand içeren rapor şablonu açar!
   */
  createReport(forSelectedNode = false): void {
    const qid = this.selectedPath?.queryId;
    if (!qid) return;
    const nodeLabel = forSelectedNode && this.selectedNode ? this.selectedNode.label : '';
    const pathStr = forSelectedNode && this.selectedNode ? this.selectedPathString : (this.selectedPath?.name || 'Genel Topoloji');
    const reportTitle = nodeLabel
      ? `${nodeLabel} — ${this.selectedPath?.name || 'Space Map'} Raporu`
      : `${this.selectedPath?.name || 'Space Map'} — Kapsamlı Analiz Raporu`;

    sessionStorage.setItem('templateBuilderInitialQuery', JSON.stringify({
      queryId: qid,
      name: reportTitle,
      description: `${pathStr} hiyerarşisi için canlı veri raporu.`,
      nodePath: pathStr,
      nodeLabel: nodeLabel || this.selectedPath?.name || '',
      healthScore: this.selectedNode?.healthScore,
      status: this.selectedNode?.status,
      autoBuildBlueprint: true,
      autoPreview: true,
    }));
    this.router.navigate(['/template-builder']);
  }

  /**
   * Space Map'ten hiç çıkmadan tek tıkla canlı Excel (.XLSX) veya PDF raporu üretip indirir!
   */
  quickExportReport(format: 'xlsx' | 'pdf' = 'xlsx'): void {
    const qid = this.selectedPath?.queryId;
    if (!qid || this.exportBusy) return;
    this.exportBusy = true;
    this.notify(`Canlı ${format.toUpperCase()} raporu hazırlanıyor...`, 'success');

    const buildAndDownload = (cols: QueryColumn[]) => {
      const colList = cols.slice(0, 10);
      const doc: TemplateDocument = createEmptyDocument(
        `${this.selectedPath?.name || 'Space Map'} Raporu`
      );
      doc.description = this.selectedPath?.description || 'Space Map üzerinden üretilen canlı rapor.';
      const sheet = doc.sheets[0];
      sheet.name = 'SpaceMap_Raporu';
      sheet.columnCount = Math.max(10, colList.length + 1);
      sheet.rowCount = 35;
      sheet.columnWidths = {};

      const spanEnd = Math.max(4, colList.length);
      sheet.cells[cellKey(1, 1)] = {
        row: 1, col: 1,
        value: (this.selectedPath?.name || 'SPACE MAP RAPORU').toUpperCase(),
        mergeAnchor: `1,1,1,${spanEnd}`,
        style: { bold: true, fontSize: 14, bg: '#14111B', color: '#F5B301', align: 'left' },
      };
      sheet.cells[cellKey(2, 1)] = {
        row: 2, col: 1,
        value: `Kapsam: ${this.selectedNode ? this.selectedPathString : 'Tüm Harita'} • Canlı Üretim Zamanı: {{report_datetime}}`,
        mergeAnchor: `2,1,2,${spanEnd}`,
        style: { italic: true, fontSize: 10, bg: '#1F1B26', color: '#C9C4BA', align: 'left' },
      };

      const fieldMap: Record<number, string> = {};
      const isPy = qid.startsWith('py:');
      const pyPrefix = isPy ? (qid.split(':')[2] || '') : '';

      colList.forEach((c, idx) => {
        const colIdx = idx + 1;
        sheet.columnWidths![colIdx] = 145;
        fieldMap[colIdx] = c.name;
        sheet.cells[cellKey(4, colIdx)] = {
          row: 4, col: colIdx,
          value: c.name.toUpperCase(),
          style: { bold: true, fontSize: 10, bg: '#1F1B26', color: '#F5B301', align: idx === 0 ? 'left' : 'right' },
        };
        sheet.cells[cellKey(5, colIdx)] = {
          row: 5, col: colIdx,
          value: isPy && pyPrefix ? `{{${pyPrefix}.${c.name}}}` : `{{${c.name}}}`,
          binding: { kind: 'query_field', queryId: qid, field: c.name },
          style: { fontSize: 10, color: '#1A1714', align: idx === 0 ? 'left' : 'right' },
        };
      });

      sheet.bands = [{
        id: `b_sm_${Date.now().toString(36)}`,
        queryId: qid,
        range: { startRow: 5, startCol: 1, endRow: 5, endCol: Math.max(1, colList.length) },
        fieldMap,
      }];

      this.templateService.create(doc.name, doc, doc.description).subscribe({
        next: (created) => {
          const tid = created.data.id;
          this.templateService.render(tid, {}, format).subscribe({
            next: (blob) => {
              this.exportBusy = false;
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${(this.selectedPath?.name || 'spacemap_report').replace(/\s+/g, '_')}.${format}`;
              a.click();
              URL.revokeObjectURL(url);
              this.notify(`${format.toUpperCase()} raporu güncel verilerle indirildi.`, 'success');
            },
            error: () => {
              this.exportBusy = false;
              this.notify('Rapor dışa aktarma hatası.', 'error');
            }
          });
        },
        error: () => {
          this.exportBusy = false;
          this.notify('Rapor şablonu oluşturulamadı.', 'error');
        }
      });
    };

    if (qid.startsWith('py:')) {
      const parts = qid.split(':');
      this.queryService.getPythonScriptColumns(parts[1], parts[2] || '').subscribe({
        next: (res) => buildAndDownload((res.data || []).map(name => ({ name }))),
        error: () => { this.exportBusy = false; this.cdr.markForCheck(); }
      });
    } else {
      this.queryService.preview(qid, {}, 1).subscribe({
        next: (res) => buildAndDownload(res.data?.columns || []),
        error: () => { this.exportBusy = false; this.cdr.markForCheck(); }
      });
    }
  }

  // ---- Aksiyonlar (Dashboard, Copy) ----
  copyPath(): void {
    const path = this.selectedPathString;
    if (!path) return;
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path)
        .then(() => this.notify('Yol panoya kopyalandı.', 'success'))
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
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.notify('Yol panoya kopyalandı.', 'success');
    } catch {
      this.notify('Kopyalama başarısız.', 'error');
    }
  }

  addToDashboard(): void {
    const qid = this.selectedPath?.queryId;
    if (!qid) return;
    const isPy = qid.startsWith('py:');
    const pyParts = isPy ? qid.split(':') : [];
    const path = this.selectedPathString || this.selectedPath?.name || 'Space Map';
    const label = this.selectedNode?.label || this.selectedPath?.name || 'Space Map Widget';
    const widget: Widget = {
      id: `sm-${Date.now()}`,
      type: 'line',
      title: label,
      icon: this.brandIcon ? `fas ${this.brandIcon}` : 'fas fa-industry',
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
        queryId: isPy ? undefined : qid,
        pyScriptId: isPy ? pyParts[1] : undefined,
        pyDataset: isPy ? pyParts[2] : undefined,
      },
      dataSourceType: isPy ? 'python' : 'sql',
      assignedQueryId: isPy ? undefined : qid,
      assignedPythonId: isPy ? pyParts[1] : undefined,
      assignedPathId: this.selectedPathId || undefined,
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
            this.notify('Widget Dashboard\'a eklendi.', 'success');
            setTimeout(() => this.router.navigate(['/dashboard']), 450);
          },
          error: () => {
            this.notify('Widget Dashboard\'a eklendi.', 'success');
            setTimeout(() => this.router.navigate(['/dashboard']), 450);
          }
        });
      },
      error: () => {
        this.dashEdit.saveMyDashboard([widget]).subscribe({
          next: () => {
            this.notify('Widget Dashboard\'a eklendi.', 'success');
            setTimeout(() => this.router.navigate(['/dashboard']), 450);
          },
          error: () => this.notify('Dashboard kaydetme hatası.', 'error')
        });
      }
    });
  }

  private notify(msgOrKey: string, type: 'success' | 'error'): void {
    const translated = this.translate.instant(msgOrKey);
    this.toast = translated || msgOrKey;
    this.toastType = type;
    window.setTimeout(() => { this.toast = ''; this.cdr.markForCheck(); }, 2800);
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

interface VisibleBounds { minX: number; maxX: number; minY: number; maxY: number; }
