import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, ViewChild, ElementRef, AfterViewInit, HostListener } from '@angular/core';
import { Router } from '@angular/router';
import { NetworkMapService, NetworkNode, NetworkMapData, ElementNode } from '../../services/network-map.service';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { AlarmsService } from '../../services/alarms.service';
import { DataSourceSelectionService } from '../../services/data-source-selection.service';
import { PathService } from '../../services/path.service';
import { PathDef } from '../../models/path-def.model';
import { QueryService } from '../../services/query.service';
import { Report } from '../../models/report.model';
import { Subscription, fromEvent, forkJoin } from 'rxjs';
import { debounceTime, throttleTime } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { CHART_PALETTE, BRAND, STATUS } from '../../shared/theme/palette';
import { ThemeColors } from '../../shared/theme/theme-colors';

// ============================================================================
// INTERFACES
// ============================================================================

interface ViewMode {
  mode: 'overview' | 'station' | 'voltage' | 'equipment';
  selectedNode: NetworkNode | null;
  zoomLevel: number;
  targetZoom: number;
  panOffset: { x: number; y: number };
  minZoom: number;
  maxZoom: number;
}

interface InteractionState {
  isDragging: boolean;
  dragStart: { x: number; y: number };
  lastDragPos: { x: number; y: number };
  mousePos: { x: number; y: number };
  hoveredNode: NetworkNode | null;
  hoveredElement: ElementNode | null;
  selectedElements: Set<string>;
}

interface NodeStatus {
  online: number;
  offline: number;
  alarm: number;
  warning: number;
}

interface VisibleBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface ActionPath {
  path: string;
  b1: string;
  b2: string;
  b3: string;
  element: string;
  info: string;
  nimSatz?: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

@Component({
  standalone: false,
  selector: 'app-network-map-optimized',
  templateUrl: './network-map.component.html',
  styleUrls: ['./network-map.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NetworkMapOptimizedComponent implements OnInit, AfterViewInit, OnDestroy {
  
  // ============================================================================
  // VIEW CHILDREN
  // ============================================================================
  
  @ViewChild('networkCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('mapContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;
  
  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================
  
  networkData: NetworkMapData | null = null;
  isLoading = true;
  error: string | null = null;
  
  viewMode: ViewMode = {
    mode: 'overview',
    selectedNode: null,
    zoomLevel: 1.0,
    targetZoom: 1.0,
    panOffset: { x: 0, y: 0 },
    minZoom: 0.3,
    maxZoom: 4.0
  };
  
  interaction: InteractionState = {
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    lastDragPos: { x: 0, y: 0 },
    mousePos: { x: 0, y: 0 },
    hoveredNode: null,
    hoveredElement: null,
    selectedElements: new Set()
  };
  
  totalStats: NodeStatus = { online: 0, offline: 0, alarm: 0, warning: 0 };
  
  // Filters
  searchTerm = '';
  statusFilter: string[] = ['online', 'offline', 'alarm', 'warning'];
  levelFilter: string[] = ['B1', 'B2', 'B3'];
  
  // Performance optimization
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animationFrameId: number | null = null;
  private visibleNodes: Set<string> = new Set();
  private nodeCache: Map<string, any> = new Map();
  private stationLabelCache: Map<string, string[]> = new Map();
  private stationConnections: Array<{ from: NetworkNode; to: NetworkNode; distance: number }> = [];
  private maxStationConnections = 3;
  private maxConnectionDistance = 650;
  private lastRenderTime = 0;
  private fps = 60;
  private frameInterval = 1000 / this.fps;
  private needsRender = true;
  private hasVisibleAlarm = false;
  private backgroundCache: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRafId: number | null = null;
  private lastCanvasSize = { width: 0, height: 0 };
  private elementHitAreas: Array<{ element: ElementNode; x: number; y: number; width: number; height: number }> = [];

  // Action drawer state
  actionDrawerOpen = false;
  actionSearchQuery = '';
  actionCandidates: ActionPath[] = [];
  actionSelectedPaths = new Set<string>();
  actionWidgetType: 'line-chart' | 'value-card' | 'gauge' = 'line-chart';
  actionFeedback = '';
  actionSearchHint = '';
  actionMaxResults = 200;
  selectedElement: ElementNode | null = null;
  
  // Alarm badge state

  
  // Related reports
  relatedReports: Report[] = [];
  relatedReportsLoading = false;
  
  // Space Map configuration properties
  dataSources: any[] = [];
  pathsList: any[] = [];
  filteredPaths: any[] = [];
  selectedDataSourceId: string | null = null;
  selectedPathId: string | null = null;
  selectedPath: any | null = null;
  spaceMapConfig: any = null;
  showSetupWizard = false;
  wizardConfig: any = {
    theme: 'cosmic',
    layout: 'orbital',
    level1Icon: 'fa-sun',
    level2Icon: 'fa-globe',
    level3Icon: 'fa-satellite',
    color1: '#a855f7',
    color2: '#ec4899',
    color3: '#06b6d4'
  };
  isAdminOrEngineer = false;
  toastMessage = '';
  toastType: 'success' | 'error' = 'success';
  
  // Subscriptions
  private subscriptions: Subscription[] = [];
  
  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  
  constructor(
    private networkMapService: NetworkMapService,
    private apiService: ApiService,
    private authService: AuthService,
    private alarmsService: AlarmsService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private translate: TranslateService,
    private themeColors: ThemeColors,
    public dss: DataSourceSelectionService,
    private pathService: PathService,
    private queryService: QueryService
  ) {}
  
  ngOnInit(): void {
    this.isAdminOrEngineer = this.authService.hasRole('engineer') || 
                             this.authService.hasRole('admin') || 
                             this.authService.hasRole('superuser');
    
    // Load datasources
    this.dss.load();
    this.subscriptions.push(
      this.dss.dataSources$.subscribe(list => {
        this.dataSources = list || [];
        if (!this.selectedDataSourceId && this.dss.selectedId) {
          this.selectedDataSourceId = this.dss.selectedId;
        }
        this.loadQueriesAndPaths();
      })
    );

    // Subscribe to selected datasource changes
    this.subscriptions.push(
      this.dss.selectedId$.subscribe(id => {
        if (id && id !== this.selectedDataSourceId) {
          this.selectedDataSourceId = id;
          this.filterPathsByDataSource();
          if (this.filteredPaths.length > 0) {
            this.selectedPathId = this.filteredPaths[0].id;
            this.loadSelectedPath(this.selectedPathId);
          } else {
            this.selectedPathId = null;
            this.selectedPath = null;
            this.networkData = null;
            this.invalidateRenderCaches();
          }
          this.cdr.markForCheck();
        }
      })
    );

    this.setupRealTimeUpdates();
    this.loadAlarmBadges();
  }
  
  ngAfterViewInit(): void {
    this.initializeCanvas();
    this.setupEventListeners();
    this.startRenderLoop();
    
    // Resize observer
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeRafId !== null) {
        cancelAnimationFrame(this.resizeRafId);
      }
      this.resizeRafId = requestAnimationFrame(() => {
        this.resizeRafId = null;
        this.handleResize();
      });
    });
    
    if (this.containerRef) {
      this.resizeObserver.observe(this.containerRef.nativeElement);
    }
  }
  
  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.resizeRafId !== null) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = null;
    }
  }
  
  // ============================================================================
  // DATA LOADING
  // ============================================================================
  
  loadQueriesAndPaths(): void {
    forkJoin({
      queries: this.queryService.list(),
      paths: this.pathService.list()
    }).subscribe({
      next: (res) => {
        this.queriesList = res.queries.data || [];
        this.pathsList = res.paths.data || [];
        this.filterPathsByDataSource();
        if (!this.selectedPathId && this.filteredPaths.length > 0) {
          this.selectedPathId = this.filteredPaths[0].id;
          this.loadSelectedPath(this.selectedPathId);
        }
        this.cdr.markForCheck();
      }
    });
  }

  filterPathsByDataSource(): void {
    if (!this.selectedDataSourceId) {
      this.filteredPaths = this.pathsList;
      return;
    }
    const queryMap = new Map<string, string>();
    this.queriesList.forEach(q => {
      queryMap.set(q.id, q.dataSourceId || q.data_source_id);
    });
    this.filteredPaths = this.pathsList.filter(p => {
      const dsId = queryMap.get(p.queryId);
      return !dsId || dsId === this.selectedDataSourceId;
    });
  }

  loadSelectedPath(pathId: string): void {
    if (!pathId || pathId === 'null') {
      this.selectedPath = null;
      this.selectedPathId = null;
      this.networkData = null;
      this.invalidateRenderCaches();
      this.cdr.markForCheck();
      return;
    }

    this.isLoading = true;
    this.error = null;
    this.cdr.markForCheck();

    this.pathService.get(pathId).subscribe({
      next: (pathRes) => {
        const pathDef = pathRes.data;
        if (!pathDef) {
          this.error = 'Path definition not found.';
          this.isLoading = false;
          this.cdr.markForCheck();
          return;
        }

        this.selectedPath = pathDef;
        
        // Parse config and check if spaceMapConfig exists
        const spaceMapConfig = (pathDef.config as any)?.spaceMapConfig;
        if (!spaceMapConfig) {
          // Setup wizard needs to be shown!
          this.spaceMapConfig = null;
          this.showSetupWizard = true;
          this.isLoading = false;
          this.cdr.markForCheck();
          return;
        }

        this.spaceMapConfig = spaceMapConfig;
        this.showSetupWizard = false;
        
        // Populate wizardConfig with selected config for edits
        this.wizardConfig = {
          theme: spaceMapConfig.theme || 'cosmic',
          layout: spaceMapConfig.layout || 'orbital',
          level1Icon: spaceMapConfig.level1Icon || 'fa-sun',
          level2Icon: spaceMapConfig.level2Icon || 'fa-globe',
          level3Icon: spaceMapConfig.level3Icon || 'fa-satellite',
          color1: spaceMapConfig.color1 || '#a855f7',
          color2: spaceMapConfig.color2 || '#ec4899',
          color3: spaceMapConfig.color3 || '#06b6d4'
        };

        // Build the path to get the node structures
        this.pathService.build(pathId).subscribe({
          next: (buildRes) => {
            const builtStructure = buildRes.data;
            if (!builtStructure || !builtStructure.nodes) {
              this.error = 'Failed to compile hierarchical node structure.';
              this.isLoading = false;
              this.cdr.markForCheck();
              return;
            }

            // Map and Layout the nodes
            this.layoutAndSetNodes(builtStructure.nodes, spaceMapConfig);
            this.resetView();
            this.isLoading = false;
            this.cdr.markForCheck();
          },
          error: (err) => {
            console.error('Error building path:', err);
            this.error = 'Failed to fetch hierarchical nodes from database.';
            this.isLoading = false;
            this.cdr.markForCheck();
          }
        });
      },
      error: (err) => {
        console.error('Error loading path details:', err);
        this.error = 'Failed to load path definition.';
        this.isLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  layoutAndSetNodes(builtNodes: any[], spaceMapConfig: any): void {
    // 1. Convert builtNodes to hierarchical NetworkNode objects
    const nodeMap = new Map<string, any>();
    
    // Pass 1: create objects
    builtNodes.forEach(bn => {
      nodeMap.set(bn.id, {
        id: bn.id,
        name: bn.label || bn.id,
        status: this.getMockStatus(bn.id),
        type: bn.depth === 0 ? 'B1' : (bn.depth === 1 ? 'B2' : 'B3'),
        parentId: bn.parent || null,
        children: [],
        position: { x: 0, y: 0 }
      });
    });
    
    // Pass 2: link children
    const rootNodes: any[] = [];
    nodeMap.forEach(node => {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId).children.push(node);
      } else {
        rootNodes.push(node);
      }
    });
    
    // 2. Run Layout algorithms
    const layout = spaceMapConfig.layout || 'orbital';
    const centerX = 1500;
    const centerY = 1200;
    
    if (layout === 'orbital') {
      // Nested circular planetary orbits
      const angleStep = (Math.PI * 2) / rootNodes.length;
      const R1 = 600; // Radius for roots
      
      rootNodes.forEach((root, rIdx) => {
        const rAngle = rIdx * angleStep;
        root.position = {
          x: centerX + Math.cos(rAngle) * R1,
          y: centerY + Math.sin(rAngle) * R1
        };
        
        // Children (B2 level) spaced around root
        const b2Nodes = root.children;
        if (b2Nodes.length > 0) {
          const b2AngleStep = (Math.PI * 2) / b2Nodes.length;
          const R2 = 180; // Radius around B1 parent
          
          b2Nodes.forEach((b2, b2Idx) => {
            const b2Angle = b2Idx * b2AngleStep;
            b2.position = {
              x: root.position.x + Math.cos(b2Angle) * R2,
              y: root.position.y + Math.sin(b2Angle) * R2
            };
            
            // Grandchildren (B3 level) spaced around B2
            const b3Nodes = b2.children;
            if (b3Nodes.length > 0) {
              const b3AngleStep = (Math.PI * 2) / b3Nodes.length;
              const R3 = 70; // Radius around B2 parent
              
              b3Nodes.forEach((b3, b3Idx) => {
                const b3Angle = b3Idx * b3AngleStep;
                b3.position = {
                  x: b2.position.x + Math.cos(b3Angle) * R3,
                  y: b2.position.y + Math.sin(b3Angle) * R3
                };
              });
            }
          });
        }
      });
      
    } else if (layout === 'spiral') {
      // Spiral Galaxy Arms
      rootNodes.forEach((root, rIdx) => {
        const arm = rIdx % 2;
        const theta = rIdx * 0.8 + arm * Math.PI;
        const radius = 250 + rIdx * 120;
        
        root.position = {
          x: centerX + Math.cos(theta) * radius,
          y: centerY + Math.sin(theta) * radius
        };
        
        const b2Nodes = root.children;
        b2Nodes.forEach((b2, b2Idx) => {
          const b2Theta = theta + 0.35 + b2Idx * 0.3;
          const b2Radius = radius + 75;
          b2.position = {
            x: centerX + Math.cos(b2Theta) * b2Radius,
            y: centerY + Math.sin(b2Theta) * b2Radius
          };
          
          const b3Nodes = b2.children;
          b3Nodes.forEach((b3, b3Idx) => {
            const b3Theta = b2Theta + 0.2 + b3Idx * 0.25;
            const b3Radius = b2Radius + 50;
            b3.position = {
              x: centerX + Math.cos(b3Theta) * b3Radius,
              y: centerY + Math.sin(b3Theta) * b3Radius
            };
          });
        });
      });
      
    } else {
      // Grid Matrix Constellation
      const cols = Math.ceil(Math.sqrt(rootNodes.length));
      const colSpacing = 800;
      const rowSpacing = 400;
      
      rootNodes.forEach((root, rIdx) => {
        const col = rIdx % cols;
        const row = Math.floor(rIdx / cols);
        const rx = centerX + (col - (cols - 1) / 2) * colSpacing;
        const ry = centerY + (row - 1) * rowSpacing;
        
        root.position = { x: rx, y: ry };
        
        // Children orbit parent root slightly offset
        const b2Nodes = root.children;
        b2Nodes.forEach((b2, b2Idx) => {
          const angle = (b2Idx * (Math.PI * 2)) / b2Nodes.length;
          b2.position = {
            x: rx + Math.cos(angle) * 160,
            y: ry + Math.sin(angle) * 160
          };
          
          const b3Nodes = b2.children;
          b3Nodes.forEach((b3, b3Idx) => {
            const b3Angle = (b3Idx * (Math.PI * 2)) / b3Nodes.length;
            b3.position = {
              x: b2.position.x + Math.cos(b3Angle) * 60,
              y: b2.position.y + Math.sin(b3Angle) * 60
            };
          });
        });
      });
    }
    
    // Flat map of all nodes for B1 connections list and stats calculations
    const allNodes: any[] = Array.from(nodeMap.values());
    
    this.networkData = {
      nodes: allNodes,
      links: [],
      totalCount: allNodes.length
    };
    
    this.invalidateRenderCaches();
    this.buildStationConnections(allNodes.filter(n => n.type === 'B1'));
    this.updatePerformanceBudget(allNodes.length);
    this.calculateStatistics();
    
    // Zoom/center view on nodes
    this.resetView();
    
    this.markDirty();
    this.cdr.markForCheck();
  }

  getMockStatus(nodeId: string): string {
    // Deterministic mock statuses using string hash
    let hash = 0;
    for (let i = 0; i < nodeId.length; i++) {
      hash = nodeId.charCodeAt(i) + ((hash << 5) - hash);
    }
    hash = Math.abs(hash);
    const mod = hash % 100;
    if (mod < 4) return 'alarm';
    if (mod < 12) return 'warning';
    if (mod < 15) return 'offline';
    return 'online';
  }

  getNodeColor(node: NetworkNode): string {
    const config = this.spaceMapConfig;
    if (!config) return '#3b82f6'; // default blue
    
    if (node.status === 'alarm') return '#ef4444';
    if (node.status === 'warning') return '#f59e0b';
    if (node.status === 'offline') return '#6b7280';
    
    // Healthy color based on level
    if (node.type === 'B1') return config.color1 || '#a855f7';
    if (node.type === 'B2') return config.color2 || '#ec4899';
    return config.color3 || '#06b6d4';
  }

  saveWizardConfig(): void {
    if (!this.selectedPath) return;

    const path = this.selectedPath;
    const currentConfig = path.config || {};
    
    // Add spaceMapConfig to path definition config
    currentConfig.spaceMapConfig = {
      theme: this.wizardConfig.theme,
      layout: this.wizardConfig.layout,
      level1Icon: this.wizardConfig.level1Icon,
      level2Icon: this.wizardConfig.level2Icon,
      level3Icon: this.wizardConfig.level3Icon,
      color1: this.wizardConfig.color1,
      color2: this.wizardConfig.color2,
      color3: this.wizardConfig.color3
    };

    this.pathService.update(path.id, {
      config: currentConfig
    }).subscribe({
      next: (res) => {
        this.showSetupWizard = false;
        this.spaceMapConfig = currentConfig.spaceMapConfig;
        
        // Reload path build structure
        this.loadSelectedPath(path.id);
        this.showSuccessToast('Space Map configured successfully!');
      },
      error: (err) => {
        console.error('Error saving wizard config:', err);
        alert('Failed to save configuration. Please try again.');
      }
    });
  }

  showSuccessToast(msg: string): void {
    this.toastMessage = msg;
    this.toastType = 'success';
    setTimeout(() => this.toastMessage = '', 3000);
    this.cdr.markForCheck();
  }

  queriesList: any[] = [];
  private loadNetworkData(): void {
    if (this.selectedPathId) {
      this.loadSelectedPath(this.selectedPathId);
    } else {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }
  
  private setupRealTimeUpdates(): void {
    const sub = this.networkMapService.getNetworkUpdates()
      .pipe(throttleTime(5000))
      .subscribe({
        next: (data) => {
          this.networkData = data;
          this.invalidateRenderCaches();
          this.buildStationConnections(data.nodes);
          this.updatePerformanceBudget(data.nodes.length);
          this.calculateStatistics();
          this.markDirty();
          this.cdr.markForCheck();
          this.updateActionCandidates();
        }
      });
    
    this.subscriptions.push(sub);
  }

  /**
   * Reset caches that depend on network data
   */
  private invalidateRenderCaches(): void {
    this.stationConnections = [];
    this.stationLabelCache.clear();
    this.visibleNodes.clear();
    this.elementHitAreas = [];
  }
  
  /**
   * Keep frame rate reasonable when node count grows
   */
  private updatePerformanceBudget(nodeCount: number): void {
    let targetFps = 60;
    
    if (nodeCount > 180) {
      targetFps = 30;
    } else if (nodeCount > 100) {
      targetFps = 45;
    }
    
    if (targetFps !== this.fps) {
      this.fps = targetFps;
      this.frameInterval = 1000 / this.fps;
    }
  }
  
  /**
   * Precompute lightweight connections between nearby B1 stations
   * to avoid O(n^2) work during every render.
   */
  private buildStationConnections(nodes: NetworkNode[]): void {
    const nodeCount = nodes.length;
    const maxConnections = nodeCount > 25 ? 2 : this.maxStationConnections;
    const maxDistance = nodeCount > 25 ? this.maxConnectionDistance * 0.75 : this.maxConnectionDistance;
    const edgeSet = new Set<string>();
    const connections: Array<{ from: NetworkNode; to: NetworkNode; distance: number }> = [];
    
    nodes.forEach((node, index) => {
      const candidates: Array<{ node: NetworkNode; distance: number }> = [];
      
      for (let i = 0; i < nodes.length; i++) {
        if (i === index) continue;
        const other = nodes[i];
        const dist = this.distance(node.position, other.position);
        if (dist <= maxDistance) {
          candidates.push({ node: other, distance: dist });
        }
      }
      
      candidates
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxConnections)
        .forEach(candidate => {
          const key = this.getConnectionKey(node.id, candidate.node.id);
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            connections.push({ from: node, to: candidate.node, distance: candidate.distance });
          }
        });
    });
    
    this.stationConnections = connections;
  }
  
  private getConnectionKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }
  
  // ============================================================================
  // CANVAS INITIALIZATION
  // ============================================================================
  
  private initializeCanvas(): void {
    if (!this.canvasRef) return;
    
    this.canvas = this.canvasRef.nativeElement;
    const ctx = this.canvas.getContext('2d', { 
      alpha: false,
      desynchronized: true // Better performance
    });
    
    if (ctx) {
      this.ctx = ctx;
      this.resizeCanvas();
      this.generateBackgroundCache();
      this.markDirty();
    }
  }
  
  private resizeCanvas(): void {
    if (!this.canvas || !this.containerRef) return;
    
    const container = this.containerRef.nativeElement;
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    if (!width || !height) return;
    if (width === this.lastCanvasSize.width && height === this.lastCanvasSize.height) return;

    this.lastCanvasSize = { width, height };
    
    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    
    if (this.ctx) {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Enable smooth rendering
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    }
    
    this.generateBackgroundCache();
    this.markDirty();
  }
  
  private handleResize(): void {
    this.resizeCanvas();
  }
  
  // ============================================================================
  // RENDER LOOP
  // ============================================================================
  
  private startRenderLoop(): void {
    const render = (timestamp: number) => {
      // FPS limiting
      const elapsed = timestamp - this.lastRenderTime;
      
      if (elapsed > this.frameInterval) {
        this.lastRenderTime = timestamp - (elapsed % this.frameInterval);
        
        // Smooth zoom animation
        if (Math.abs(this.viewMode.zoomLevel - this.viewMode.targetZoom) > 0.01) {
          this.viewMode.zoomLevel += (this.viewMode.targetZoom - this.viewMode.zoomLevel) * 0.15;
          this.markDirty();
        } else {
          this.viewMode.zoomLevel = this.viewMode.targetZoom;
        }
        
        if (this.needsRender || this.hasAnimatedStates()) {
          this.renderScene();
          this.needsRender = this.hasAnimatedStates();
        }
      }
      
      this.animationFrameId = requestAnimationFrame(render);
    };
    
    this.animationFrameId = requestAnimationFrame(render);
  }
  
  private renderScene(): void {
    if (!this.ctx || !this.canvas || !this.networkData) return;
    
    this.hasVisibleAlarm = false;
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    
    // Clear with SCADA style background
    this.renderBackground(width, height);
    
    // Save context
    this.ctx.save();
    
    // Apply transformations
    this.ctx.translate(this.viewMode.panOffset.x, this.viewMode.panOffset.y);
    this.ctx.scale(this.viewMode.zoomLevel, this.viewMode.zoomLevel);
    
    // Calculate visible bounds for culling
    const bounds = this.calculateVisibleBounds();
    this.visibleNodes.clear();

    // Blueprint grid that moves with pan/zoom
    this.renderGrid();
    
    // Render based on view mode
    switch (this.viewMode.mode) {
      case 'overview':
        this.renderOverview(bounds);
        break;
      case 'station':
        this.renderStationView();
        break;
      case 'voltage':
        this.renderVoltageView();
        break;
      case 'equipment':
        this.renderEquipmentView();
        break;
    }
    
    // Restore context
    this.ctx.restore();
    
    // Render UI overlays (not affected by zoom/pan)
    this.renderUIOverlays(width, height);
  }
  
  // ============================================================================
  // RENDERING METHODS - OVERVIEW
  // ============================================================================
  
  private renderOverview(bounds: VisibleBounds): void {
    if (!this.networkData || !this.ctx) return;

    const visibleStations = this.networkData.nodes.filter(node => this.isNodeVisible(node, bounds));
    this.visibleNodes = new Set(visibleStations.map(node => node.id));

    // Render connections first (behind nodes)
    this.renderOverviewConnections(bounds, this.visibleNodes);
    
    // Render B1 stations
    visibleStations.forEach((node) => {
      this.renderStationNode(node);
    });
  }
  
  private renderOverviewConnections(bounds: VisibleBounds, visibleStations: Set<string>): void {
    if (!this.ctx || !this.networkData) return;

    if (this.stationConnections.length === 0) {
      this.buildStationConnections(this.networkData.nodes);
    }

    const totalStations = this.networkData.nodes.length;
    const focusId = this.viewMode.selectedNode?.id || this.interaction.hoveredNode?.id;
    if (totalStations > 25 && !focusId) {
      return;
    }
    
    const paddedBounds = this.expandBounds(bounds, 140);
    this.ctx.lineWidth = totalStations > 25 ? 1.6 : 2.4;
    this.ctx.setLineDash([12, 10]);
    this.ctx.shadowColor = this.withAlpha(BRAND.tertiary, 0.18);
    this.ctx.shadowBlur = 10;
    
    this.stationConnections.forEach(({ from, to }) => {
      if (focusId && from.id !== focusId && to.id !== focusId) {
        return;
      }
      if (!this.isConnectionWithinBounds(from, to, paddedBounds, visibleStations)) {
        return;
      }
      
      const gradient = this.ctx!.createLinearGradient(
        from.position.x,
        from.position.y,
        to.position.x,
        to.position.y
      );
      gradient.addColorStop(0, this.withAlpha(BRAND.tertiary, 0.55));
      gradient.addColorStop(1, this.withAlpha(STATUS.success, 0.4));
      this.ctx!.strokeStyle = gradient;
      this.ctx!.beginPath();
      this.ctx!.moveTo(from.position.x, from.position.y);
      this.ctx!.lineTo(to.position.x, to.position.y);
      this.ctx!.stroke();

      this.ctx!.fillStyle = this.withAlpha(BRAND.tertiary, 0.25);
      this.ctx!.beginPath();
      this.ctx!.arc(from.position.x, from.position.y, 5, 0, Math.PI * 2);
      this.ctx!.arc(to.position.x, to.position.y, 5, 0, Math.PI * 2);
      this.ctx!.fill();
    });
    
    this.ctx.shadowColor = 'transparent';
    this.ctx.setLineDash([]);
  }
  
  private renderStationNode(node: NetworkNode): void {
    if (!this.ctx) return;
    
    const isHovered = this.interaction.hoveredNode?.id === node.id;
    const isSelected = this.viewMode.selectedNode?.id === node.id;
    const baseRadius = 70;
    const radius = isSelected ? baseRadius * 1.15 : isHovered ? baseRadius * 1.08 : baseRadius;
    const nodeColor = this.getNodeColor(node);
    const { x, y } = node.position;
    
    if (node.status === 'alarm') {
      this.hasVisibleAlarm = true;
    }
    
    this.ctx.save();
    
    // Draw based on configured theme
    const theme = this.spaceMapConfig?.theme || 'cosmic';
    
    if (theme === 'cosmic') {
      // Cosmic Planet Node
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 30 : isHovered ? 20 : 12;
      
      this.ctx.beginPath();
      this.ctx.arc(x, y, radius, 0, Math.PI * 2);
      const gradient = this.ctx.createRadialGradient(x - radius/3, y - radius/3, radius/6, x, y, radius);
      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.3, nodeColor);
      gradient.addColorStop(1, '#0b0d19');
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 2.5;
      this.ctx.strokeStyle = this.withAlpha(nodeColor, 0.4);
      this.ctx.stroke();
      
      this.ctx.shadowColor = 'transparent';
      
      // Flat planetary ring ellipse
      this.ctx.strokeStyle = this.withAlpha(nodeColor, 0.35);
      this.ctx.lineWidth = 3;
      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(-Math.PI / 8);
      this.ctx.scale(1.7, 0.38);
      this.ctx.beginPath();
      this.ctx.arc(0, 0, radius * 0.9, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.restore();
      
      // Icon
      const icon = this.spaceMapConfig?.level1Icon || 'fa-sun';
      this.renderIcon(icon, x, y, 22);
      
    } else if (theme === 'factory') {
      // Mechanical Hexagon Node
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 22 : 12;
      
      this.drawHexagon(x, y, radius);
      const gradient = this.ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
      gradient.addColorStop(0, '#2a2b36');
      gradient.addColorStop(0.5, '#1e1f29');
      gradient.addColorStop(1, nodeColor);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 2.5;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.stroke();
      
      this.ctx.shadowColor = 'transparent';
      
      // Gear outer details
      this.drawHexagon(x, y, radius - 10);
      this.ctx.strokeStyle = this.withAlpha(nodeColor, 0.3);
      this.ctx.stroke();
      
      const icon = this.spaceMapConfig?.level1Icon || 'fa-industry';
      this.renderIcon(icon, x, y, 20);
      
    } else if (theme === 'energy') {
      // Electric Diamond Node
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 25 : 14;
      
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - radius);
      this.ctx.lineTo(x + radius, y);
      this.ctx.lineTo(x, y + radius);
      this.ctx.lineTo(x - radius, y);
      this.ctx.closePath();
      
      const gradient = this.ctx.createLinearGradient(x, y - radius, x, y + radius);
      gradient.addColorStop(0, '#0a1526');
      gradient.addColorStop(1, nodeColor);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 3;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      this.ctx.stroke();
      
      this.ctx.shadowColor = 'transparent';
      
      const icon = this.spaceMapConfig?.level1Icon || 'fa-bolt';
      this.renderIcon(icon, x, y, 20);
      
    } else {
      // Cyber Tech Server Rack Node
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 25 : 12;
      
      this.drawRoundedRect(x - radius, y - radius, radius * 2, radius * 2, 14);
      const gradient = this.ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
      gradient.addColorStop(0, '#081712');
      gradient.addColorStop(0.5, '#0c221a');
      gradient.addColorStop(1, nodeColor);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 2.5;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.stroke();
      
      this.ctx.shadowColor = 'transparent';
      
      const icon = this.spaceMapConfig?.level1Icon || 'fa-server';
      this.renderIcon(icon, x, y, 20);
    }
    
    // Labels & Ribbons below/above
    this.renderTag('SYSTEM', x - radius + 18, y - radius + 19, this.withAlpha(nodeColor, 0.8));
    this.renderTag(node.status.toUpperCase(), x + radius - 18, y - radius + 19, '#000', 'right');
    
    const countLabel = node.children ? `${node.children.length} SUB-LEVEL` : '0 SUB-LEVEL';
    this.renderTag(countLabel, x, y + radius - 10, nodeColor, 'center');
    
    const labelLines = this.getStationLabelLines(node);
    this.renderStationLabel(labelLines, x, y - 2);
    
    if (node.status === 'alarm') {
      this.renderPulseEffect(x, y, radius + 12);
    }
    
    this.ctx.restore();
  }
  
  // ============================================================================
  // RENDERING METHODS - STATION VIEW
  // ============================================================================
  
  private renderStationView(): void {
    if (!this.viewMode.selectedNode || !this.ctx) return;
    
    const station = this.viewMode.selectedNode;
    const { width, height } = this.getCanvasSize();
    const centerX = width * 0.5;
    const centerY = height * 0.52;

    station.position = { x: centerX, y: centerY };
    
    // Render station at center
    this.renderStationNode(station);
    
    // Render B2 voltage levels in a circle around station
    const b2Nodes = station.children;
    if (b2Nodes.length === 0) return;
    
    const angleStep = (Math.PI * 2) / b2Nodes.length;
    const orbitRadius = Math.max(220, Math.min(width, height) * 0.32);
    
    // Render connections first
    if (this.ctx) {
      this.ctx.strokeStyle = this.withAlpha(BRAND.tertiary, 0.3);
      this.ctx.lineWidth = 4;
      this.ctx.setLineDash([12, 10]);
      this.ctx.shadowColor = this.withAlpha(BRAND.tertiary, 0.18);
      this.ctx.shadowBlur = 8;
      
      b2Nodes.forEach((b2Node, index) => {
        if (!this.ctx) return;
        
        const angle = index * angleStep - Math.PI / 2;
        const x = centerX + Math.cos(angle) * orbitRadius;
        const y = centerY + Math.sin(angle) * orbitRadius;
        
        // Connection line
        this.ctx.beginPath();
        this.ctx.moveTo(centerX, centerY);
        this.ctx.lineTo(x, y);
        this.ctx.stroke();
        
        this.ctx.fillStyle = this.withAlpha(BRAND.tertiary, 0.4);
        this.ctx.beginPath();
        this.ctx.arc(x, y, 6, 0, Math.PI * 2);
        this.ctx.fill();
      });
      
      this.ctx.setLineDash([]);
      this.ctx.shadowColor = 'transparent';
    }
    
    // Render B2 nodes
    b2Nodes.forEach((b2Node, index) => {
      const angle = index * angleStep - Math.PI / 2;
      const x = centerX + Math.cos(angle) * orbitRadius;
      const y = centerY + Math.sin(angle) * orbitRadius;
      
      b2Node.position = { x, y };
      this.renderVoltageNode(b2Node);
    });
  }
  
  private renderVoltageNode(node: NetworkNode): void {
    if (!this.ctx) return;
    
    const isHovered = this.interaction.hoveredNode?.id === node.id;
    const isSelected = this.viewMode.selectedNode?.id === node.id;
    const baseRadius = 24;
    const radius = isSelected ? baseRadius * 1.15 : isHovered ? baseRadius * 1.08 : baseRadius;
    const nodeColor = this.getNodeColor(node);
    const { x, y } = node.position;
    
    if (node.status === 'alarm') {
      this.hasVisibleAlarm = true;
    }
    
    this.ctx.save();
    const theme = this.spaceMapConfig?.theme || 'cosmic';
    
    if (theme === 'cosmic') {
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 20 : isHovered ? 14 : 8;
      
      this.ctx.beginPath();
      this.ctx.arc(x, y, radius, 0, Math.PI * 2);
      const gradient = this.ctx.createRadialGradient(x - radius/3, y - radius/3, radius/6, x, y, radius);
      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.4, nodeColor);
      gradient.addColorStop(1, '#0e0b1f');
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      this.ctx.stroke();
    } else if (theme === 'factory') {
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 18 : 10;
      this.drawHexagon(x, y, radius);
      const gradient = this.ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
      gradient.addColorStop(0, '#2d2e3d');
      gradient.addColorStop(1, nodeColor);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 1.8;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.stroke();
    } else if (theme === 'energy') {
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 18 : 10;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - radius);
      this.ctx.lineTo(x + radius, y);
      this.ctx.lineTo(x, y + radius);
      this.ctx.lineTo(x - radius, y);
      this.ctx.closePath();
      const gradient = this.ctx.createLinearGradient(x, y - radius, x, y + radius);
      gradient.addColorStop(0, '#0c162b');
      gradient.addColorStop(1, nodeColor);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      this.ctx.stroke();
    } else {
      // Tech server
      this.ctx.shadowColor = nodeColor;
      this.ctx.shadowBlur = isSelected ? 16 : 8;
      this.drawRoundedRect(x - radius, y - radius, radius * 2, radius * 2, 6);
      const gradient = this.ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
      gradient.addColorStop(0, '#071f1a');
      gradient.addColorStop(1, nodeColor);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.stroke();
    }
    
    this.ctx.shadowColor = 'transparent';
    
    // Label and icon
    const icon = this.spaceMapConfig?.level2Icon || 'fa-globe';
    this.renderIcon(icon, x, y, 13);
    
    this.renderLabel(node.name, x, y + radius + 15, 12, true);
    
    if (node.children.length > 0) {
      this.renderTag(`${node.children.length} SUB`, x, y - radius - 8, nodeColor, 'center');
    }
    
    if (node.status === 'alarm') {
      this.renderPulseEffect(x, y, radius + 8);
    }
    
    this.ctx.restore();
  }
  
  // ============================================================================
  // RENDERING METHODS - VOLTAGE VIEW
  // ============================================================================
  
  private renderVoltageView(): void {
    if (!this.viewMode.selectedNode || !this.ctx) return;
    
    const voltageLevel = this.viewMode.selectedNode;
    const { width, height } = this.getCanvasSize();
    const centerX = width * 0.5;
    const centerY = Math.min(height * 0.22, 220);
    
    // Render voltage level at top
    voltageLevel.position = { x: centerX, y: centerY };
    this.renderVoltageNode(voltageLevel);
    
    // Render B3 equipment below in a grid
    const b3Nodes = voltageLevel.children;
    if (b3Nodes.length === 0) return;
    
    const cols = Math.min(5, Math.ceil(Math.sqrt(b3Nodes.length)));
    const rows = Math.ceil(b3Nodes.length / cols);
    const spacingX = Math.min(220, Math.max(160, width / (cols + 1)));
    const spacingY = Math.min(180, Math.max(120, (height * 0.55) / Math.max(1, rows)));
    const startX = centerX - ((cols - 1) * spacingX) / 2;
    const startY = centerY + Math.min(240, height * 0.3);
    
    // Render connections
    if (this.ctx) {
      this.ctx.strokeStyle = this.withAlpha(BRAND.tertiary, 0.28);
      this.ctx.lineWidth = 3;
      this.ctx.setLineDash([10, 10]);
      
      b3Nodes.forEach((b3Node, index) => {
        if (!this.ctx) return;
        
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = startX + col * spacingX;
        const y = startY + row * spacingY;
        
        // Connection
        this.ctx.beginPath();
        this.ctx.moveTo(centerX, centerY + 40);
        this.ctx.lineTo(x, y - 25);
        this.ctx.stroke();
      });
      
      this.ctx.setLineDash([]);
    }
    
    // Render equipment nodes
    b3Nodes.forEach((b3Node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * spacingX;
      const y = startY + row * spacingY;
      
      b3Node.position = { x, y };
      this.renderEquipmentNode(b3Node);
    });
  }
  
  private renderEquipmentNode(node: NetworkNode): void {
    if (!this.ctx) return;
    
    const isHovered = this.interaction.hoveredNode?.id === node.id;
    const isSelected = this.viewMode.selectedNode?.id === node.id;
    const baseWidth = 110;
    const baseHeight = 26;
    const scale = isSelected ? 1.12 : isHovered ? 1.08 : 1;
    const width = baseWidth * scale;
    const height = baseHeight * scale;
    const nodeColor = this.getNodeColor(node);
    const { x, y } = node.position;
    
    if (node.status === 'alarm') {
      this.hasVisibleAlarm = true;
    }
    
    this.ctx.save();
    this.ctx.shadowColor = nodeColor;
    this.ctx.shadowBlur = isSelected ? 12 : 8;
    
    const theme = this.spaceMapConfig?.theme || 'cosmic';
    
    if (theme === 'cosmic' || theme === 'energy') {
      this.drawRoundedRect(x - width / 2, y - height / 2, width, height, height / 2);
    } else if (theme === 'factory') {
      this.drawRoundedRect(x - width / 2, y - height / 2, width, height, 4);
    } else {
      // Tech grid (Server rack blade)
      this.drawRoundedRect(x - width / 2, y - height / 2, width, height, 2);
    }
    
    const gradient = this.ctx.createLinearGradient(x - width / 2, y - height / 2, x + width / 2, y + height / 2);
    gradient.addColorStop(0, '#0a0a0f');
    gradient.addColorStop(1, nodeColor);
    this.ctx.fillStyle = gradient;
    this.ctx.fill();
    
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    this.ctx.stroke();
    
    this.ctx.shadowColor = 'transparent';
    
    // Icon
    const icon = this.spaceMapConfig?.level3Icon || 'fa-satellite';
    this.renderIcon(icon, x - width / 2 + 15, y, 10);
    
    this.renderLabelWithBackground(node.name, x, y + height / 2 + 10, 11);
    
    if (node.elements && node.elements.length > 0) {
      this.renderTag(`${node.elements.length} EL`, x + width / 2 - 10, y - height / 2 + 10, nodeColor, 'right');
    }
    
    if (node.status === 'alarm') {
      this.renderPulseEffect(x, y, 16);
    }
    
    this.ctx.restore();
  }
  
  // ============================================================================
  // RENDERING METHODS - EQUIPMENT VIEW
  // ============================================================================
  
  private renderEquipmentView(): void {
    if (!this.viewMode.selectedNode || !this.ctx) return;
    
    const equipment = this.viewMode.selectedNode;
    const { width, height } = this.getCanvasSize();
    const centerX = width * 0.5;
    const centerY = Math.min(height * 0.22, 200);
    
    // Render equipment at top
    equipment.position = { x: centerX, y: centerY };
    this.renderEquipmentNode(equipment);
    
    // Render elements below
    if (!equipment.elements || equipment.elements.length === 0) {
      this.renderNoElementsMessage(centerX, centerY + 150);
      return;
    }
    
    const elements = equipment.elements;
    this.elementHitAreas = [];
    const cols = Math.min(6, elements.length);
    const rows = Math.ceil(elements.length / cols);
    const spacingX = Math.min(140, Math.max(90, width / (cols + 1)));
    const spacingY = Math.min(110, Math.max(80, (height * 0.5) / Math.max(1, rows)));
    const startX = centerX - ((cols - 1) * spacingX) / 2;
    const startY = centerY + Math.min(220, height * 0.28);
    
    // Render connection lines
    this.ctx.strokeStyle = this.withAlpha(BRAND.tertiary, 0.22);
    this.ctx.lineWidth = 2.4;
    this.ctx.setLineDash([6, 9]);
    
    elements.forEach((element, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * spacingX;
      const y = startY + row * spacingY;
      
      this.ctx!.beginPath();
      this.ctx!.moveTo(centerX, centerY + 30);
      this.ctx!.lineTo(x, y - 15);
      this.ctx!.stroke();
    });
    this.ctx.setLineDash([]);
    
    // Render element nodes
    elements.forEach((element, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * spacingX;
      const y = startY + row * spacingY;
      
      this.renderElementNode(element, x, y);
      this.elementHitAreas.push({ element, x, y, width: 80, height: 24 });
    });
  }
  
  private renderElementNode(element: ElementNode, x: number, y: number): void {
    if (!this.ctx) return;
    
    const width = 80;
    const height = 24;
    const isSelected = this.selectedElement?.elem === element.elem;
    const isHovered = this.interaction.hoveredElement?.elem === element.elem;
    const accent = isSelected ? CHART_PALETTE[8] : BRAND.tertiary;
    
    this.ctx.save();
    this.drawRoundedRect(x - width / 2, y - height / 2, width, height, 8);
    const gradient = this.ctx.createLinearGradient(x - width / 2, y - height / 2, x + width / 2, y + height / 2);
    gradient.addColorStop(0, '#0b1020');
    gradient.addColorStop(1, isHovered ? CHART_PALETTE[6] : accent);
    this.ctx.fillStyle = gradient;
    this.ctx.fill();
    
    this.ctx.lineWidth = isSelected ? 2 : 1.5;
    this.ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.3)';
    this.ctx.stroke();
    
    // Glyph
    this.renderIcon(element.elem?.toString() || 'EL', x - width / 2 + 16, y + 1, 10);
    
    // Label
    this.renderLabel(element.name, x, y + height / 2 + 6, 10, true);
    
    this.ctx.restore();
  }
  
  private renderNoElementsMessage(x: number, y: number): void {
    if (!this.ctx) return;
    
    this.ctx.fillStyle = this.withAlpha(BRAND.tertiary, 0.3);
    this.ctx.fillRect(x - 150, y - 40, 300, 80);
    
    this.ctx.fillStyle = '#94a3b8';
    this.ctx.font = '14px "Space Grotesk", sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('No elements available', x, y);
    this.ctx.font = '12px "Space Grotesk", sans-serif';
    this.ctx.fillText('for this equipment', x, y + 20);
  }
  
  // ============================================================================
  // HELPER RENDERING METHODS
  // ============================================================================
  private getCanvasSize(): { width: number; height: number } {
    if (!this.canvas) {
      return { width: 1600, height: 900 };
    }
    const dpr = window.devicePixelRatio || 1;
    return {
      width: this.canvas.width / dpr,
      height: this.canvas.height / dpr
    };
  }

  private markDirty(): void {
    this.needsRender = true;
  }
  
  private hasAnimatedStates(): boolean {
    return this.hasVisibleAlarm;
  }
  
  private renderBackground(width: number, height: number): void {
    if (!this.ctx) return;
    
    if (!this.backgroundCache || this.backgroundCache.width !== width || this.backgroundCache.height !== height) {
      this.generateBackgroundCache(width, height);
    }
    
    if (this.backgroundCache) {
      this.ctx.drawImage(this.backgroundCache, 0, 0, width, height);
    }
  }
  
  private generateBackgroundCache(width?: number, height?: number): void {
    if (!this.canvas) return;
    const w = width || this.canvas.width / (window.devicePixelRatio || 1);
    const h = height || this.canvas.height / (window.devicePixelRatio || 1);
    const cache = document.createElement('canvas');
    cache.width = w;
    cache.height = h;
    const ctx = cache.getContext('2d');
    if (!ctx) return;
    
    const theme = this.spaceMapConfig?.theme || 'cosmic';
    
    if (theme === 'cosmic') {
      // Deep space gradient
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#020617'); // slate 950
      gradient.addColorStop(0.5, '#0c0a0f'); // very dark violet
      gradient.addColorStop(1, '#020617');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      
      // Twinkling nebulas
      const nebula1 = ctx.createRadialGradient(w * 0.3, h * 0.4, 50, w * 0.3, h * 0.4, 300);
      nebula1.addColorStop(0, 'rgba(168, 85, 247, 0.12)'); // purple-500
      nebula1.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = nebula1;
      ctx.fillRect(0, 0, w, h);
      
      const nebula2 = ctx.createRadialGradient(w * 0.7, h * 0.6, 50, w * 0.7, h * 0.6, 400);
      nebula2.addColorStop(0, 'rgba(236, 72, 153, 0.08)'); // pink-500
      nebula2.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = nebula2;
      ctx.fillRect(0, 0, w, h);
      
      // Random stars
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      for (let i = 0; i < 150; i++) {
        const sx = Math.random() * w;
        const sy = Math.random() * h;
        const size = Math.random() * 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (theme === 'factory') {
      // Dark industrial steel gradient
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#0f172a');
      gradient.addColorStop(1, '#1e293b');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      
      // Subtle industrial grid pattern
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.04)'; // faint amber/orange
      ctx.lineWidth = 1;
      const gridSpacing = 60;
      for (let x = 0; x < w; x += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    } else if (theme === 'energy') {
      // Substation electric blue gradient
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#020617');
      gradient.addColorStop(1, '#0f172a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      
      // Tech electrical grid circles
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.05)'; // cyan volt
      ctx.lineWidth = 1.5;
      for (let r = 100; r < Math.max(w, h); r += 200) {
        ctx.beginPath();
        ctx.arc(w/2, h/2, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      // Tech grid theme (Matrix/Cyber)
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#020617');
      gradient.addColorStop(1, '#022c22'); // very dark green
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      
      // Glowing cyber grid matrix lines
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.05)'; // emerald
      ctx.lineWidth = 1;
      const spacing = 50;
      for (let x = 0; x < w; x += spacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += spacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
    
    this.backgroundCache = cache;
  }
  
  private drawHexagon(x: number, y: number, radius: number): void {
    if (!this.ctx) return;
    
    this.ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + (Math.PI / 3) * i;
      const px = x + radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      if (i === 0) {
        this.ctx.moveTo(px, py);
      } else {
        this.ctx.lineTo(px, py);
      }
    }
    this.ctx.closePath();
  }
  
  private drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): void {
    if (!this.ctx) return;
    
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
  }
  
  private renderTag(
    text: string,
    x: number,
    y: number,
    color: string,
    align: 'left' | 'center' | 'right' = 'left'
  ): void {
    if (!this.ctx) return;
    
    this.ctx.save();
    this.ctx.font = 'bold 10px "Space Grotesk", sans-serif';
    const metrics = this.ctx.measureText(text);
    const paddingX = 8;
    const width = metrics.width + paddingX * 2;
    const height = 16;
    let startX = x;
    
    if (align === 'center') {
      startX = x - width / 2;
    } else if (align === 'right') {
      startX = x - width;
    }
    
    this.drawRoundedRect(startX, y - height + 4, width, height, 6);
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = 0.9;
    this.ctx.fill();
    
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#0b1220';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(text, startX + width / 2, y - height / 2 + 4);
    this.ctx.restore();
  }
  
  private renderGrid(): void {
    if (!this.ctx || !this.canvas) return;
    
    const gridSize = 90;
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    
    this.ctx.save();
    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = this.themeColors.read('--border-color', 0.18);
    
    // Vertical lines
    for (let x = 0; x <= width; x += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
    
    // Horizontal lines
    for (let y = 0; y <= height; y += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
    
    // Major lines
    this.ctx.strokeStyle = this.themeColors.read('--border-color', 0.30);
    this.ctx.lineWidth = 1.2;
    const majorStep = gridSize * 4;
    
    for (let x = 0; x <= width; x += majorStep) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
    
    for (let y = 0; y <= height; y += majorStep) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
    
    this.ctx.restore();
  }
  
  private renderIcon(icon: string, x: number, y: number, size: number): void {
    if (!this.ctx) return;
    
    if (icon && (icon.startsWith('fa-') || icon.includes('fa '))) {
      this.ctx.font = `900 ${size}px "Font Awesome 6 Free", "Font Awesome 5 Free", sans-serif`;
      // Map icons to unicode symbols
      let symbol = '\uf11b'; // default gamepad or dot
      const name = icon.toLowerCase();
      if (name.includes('sun')) symbol = '\uf185';
      else if (name.includes('globe')) symbol = '\uf0ac';
      else if (name.includes('satellite')) symbol = '\uf7c0';
      else if (name.includes('industry')) symbol = '\uf275';
      else if (name.includes('cogs') || name.includes('gear')) symbol = '\uf085';
      else if (name.includes('cog')) symbol = '\uf013';
      else if (name.includes('wrench')) symbol = '\uf0ad';
      else if (name.includes('bolt')) symbol = '\uf0e7';
      else if (name.includes('plug')) symbol = '\uf1e6';
      else if (name.includes('battery')) symbol = '\uf240';
      else if (name.includes('server')) symbol = '\uf233';
      else if (name.includes('database')) symbol = '\uf1c0';
      else if (name.includes('microchip') || name.includes('cpu')) symbol = '\uf2db';
      else if (name.includes('shield')) symbol = '\uf3ed';
      else if (name.includes('rocket')) symbol = '\uf135';
      else if (name.includes('space-shuttle')) symbol = '\uf197';
      else if (name.includes('atom')) symbol = '\uf5d2';
      
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillStyle = '#f8fafc';
      this.ctx.fillText(symbol, x, y);
    } else {
      this.ctx.font = `700 ${size}px "Space Grotesk", sans-serif`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillStyle = '#e2e8f0';
      this.ctx.fillText(icon || '', x, y);
    }
  }
  
  private getStationLabelLines(node: NetworkNode): string[] {
    const cached = this.stationLabelCache.get(node.id);
    if (cached) return cached;
    
    const maxLineLength = 14;
    const words = node.name.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';
    
    words.forEach(word => {
      const next = currentLine ? `${currentLine} ${word}` : word;
      if (next.length > maxLineLength && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = next;
      }
    });
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    if (lines.length > 2) {
      lines.length = 2;
      const last = lines[1];
      if (last.length > maxLineLength - 1) {
        lines[1] = `${last.slice(0, maxLineLength - 1)}…`;
      }
    }
    
    this.stationLabelCache.set(node.id, lines);
    return lines;
  }
  
  private renderStationLabel(lines: string[], x: number, y: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    
    const lineHeight = 16;
    const startY = y - ((lines.length - 1) * lineHeight) / 2;
    
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 13px "Space Grotesk", sans-serif';
    
    lines.forEach((line, idx) => {
      const lineY = startY + idx * lineHeight;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.lineWidth = 3;
      ctx.strokeText(line, x, lineY);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(line, x, lineY);
    });
  }
  
  private renderLabel(text: string, x: number, y: number, size: number, bold = false): void {
    if (!this.ctx) return;
    
    this.ctx.font = `${bold ? 'bold ' : ''}${size}px "Space Grotesk", sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    
    // Text shadow
    this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.lineWidth = 3;
    this.ctx.strokeText(text, x, y);
    
    // Main text
    this.ctx.fillStyle = '#f8fafc';
    this.ctx.fillText(text, x, y);
  }
  
  private renderLabelWithBackground(text: string, x: number, y: number, size: number): void {
    if (!this.ctx) return;
    
    this.ctx.font = `bold ${size}px "Space Grotesk", sans-serif`;
    const metrics = this.ctx.measureText(text);
    const padding = 6;
    
    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    this.ctx.fillRect(
      x - metrics.width / 2 - padding,
      y - 2,
      metrics.width + padding * 2,
      size + 6
    );
    
    // Text
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillText(text, x, y);
  }
  
  private renderBadge(text: string, x: number, y: number, color: string): void {
    if (!this.ctx) return;
    
    const radius = 14;
    
    // Badge background
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
    
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
    
    // Text
    this.ctx.font = 'bold 11px "Space Grotesk", sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillText(text, x, y);
  }
  
  private renderPulseEffect(x: number, y: number, radius: number): void {
    if (!this.ctx) return;
    
    const time = Date.now() / 1000;
    const pulseRadius = radius + Math.sin(time * 3) * 8;
    const alpha = 0.4 + Math.sin(time * 3) * 0.2;
    
    this.ctx.beginPath();
    this.ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
    this.ctx.strokeStyle = this.withAlpha(STATUS.danger, alpha);
    this.ctx.lineWidth = 3;
    this.ctx.stroke();
  }
  
  private renderUIOverlays(width: number, height: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    
    // Status card on the left
    ctx.save();
    const cardWidth = 260;
    const cardHeight = 110;
    this.drawRoundedRect(20, 20, cardWidth, cardHeight, 12);
    const cardGradient = ctx.createLinearGradient(20, 20, 20, 20 + cardHeight);
    cardGradient.addColorStop(0, 'rgba(15, 23, 42, 0.92)');
    cardGradient.addColorStop(1, 'rgba(30, 41, 59, 0.92)');
    ctx.fillStyle = cardGradient;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    const modeText = this.viewMode.mode.toUpperCase();
    const focusText = this.viewMode.selectedNode ? this.viewMode.selectedNode.name : this.translate.instant('NETWORK_MAP.ALL_STATIONS');
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px "Space Grotesk", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${this.translate.instant('NETWORK_MAP.HUD_MODE')}: ${modeText}`, 32, 32);
    ctx.fillText(`${this.translate.instant('NETWORK_MAP.HUD_FOCUS')}: ${focusText}`, 32, 50);
    ctx.fillText(`${this.translate.instant('NETWORK_MAP.HUD_ZOOM')}: ${Math.round(this.viewMode.zoomLevel * 100)}%`, 32, 68);
    
    const legend = [
      { color: BRAND.tertiary, label: this.translate.instant('NETWORK_MAP.STATION_B1') },
      { color: STATUS.success, label: this.translate.instant('NETWORK_MAP.VOLTAGE_B2') },
      { color: BRAND.primary, label: this.translate.instant('NETWORK_MAP.EQUIPMENT_B3') }
    ];
    
    legend.forEach((item, idx) => {
      const lx = 32 + idx * 70;
      const ly = 94;
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "Space Grotesk", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, lx + 10, ly);
    });
    ctx.restore();
    
    // Zoom capsule on the right
    ctx.save();
    const zoomWidth = 120;
    const zoomHeight = 56;
    const zoomX = width - zoomWidth - 24;
    const zoomY = 20;
    this.drawRoundedRect(zoomX, zoomY, zoomWidth, zoomHeight, 12);
    const zoomGradient = ctx.createLinearGradient(zoomX, zoomY, zoomX, zoomY + zoomHeight);
    zoomGradient.addColorStop(0, this.withAlpha(STATUS.success, 0.9));
    zoomGradient.addColorStop(1, this.withAlpha(BRAND.tertiary, 0.9));
    ctx.fillStyle = zoomGradient;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.stroke();
    
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px "Space Grotesk", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(this.viewMode.zoomLevel * 100)}%`, zoomX + zoomWidth / 2, zoomY + 24);
    ctx.font = '11px "Space Grotesk", sans-serif';
    ctx.fillText(this.translate.instant('NETWORK_MAP.HUD_ZOOM'), zoomX + zoomWidth / 2, zoomY + 42);
    ctx.restore();
  }
  
  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================
  
  private setupEventListeners(): void {
    if (!this.canvas) return;
    
    // Mouse events
    fromEvent<MouseEvent>(this.canvas, 'mousedown').subscribe(e => this.onMouseDown(e));
    fromEvent<MouseEvent>(this.canvas, 'mousemove').pipe(throttleTime(16)).subscribe(e => this.onMouseMove(e));
    fromEvent<MouseEvent>(this.canvas, 'mouseup').subscribe(e => this.onMouseUp(e));
    fromEvent<MouseEvent>(this.canvas, 'click').subscribe(e => this.onClick(e));
    fromEvent<WheelEvent>(this.canvas, 'wheel').subscribe(e => this.onWheel(e));
    
    // Touch support
    fromEvent<TouchEvent>(this.canvas, 'touchstart').subscribe(e => this.onTouchStart(e));
    fromEvent<TouchEvent>(this.canvas, 'touchmove').subscribe(e => this.onTouchMove(e));
    fromEvent<TouchEvent>(this.canvas, 'touchend').subscribe(e => this.onTouchEnd(e));
  }
  
  private onMouseDown(event: MouseEvent): void {
    this.interaction.isDragging = true;
    this.interaction.dragStart = { x: event.clientX, y: event.clientY };
    this.interaction.lastDragPos = { x: event.clientX, y: event.clientY };
    if (this.canvas) this.canvas.style.cursor = 'grabbing';
    this.markDirty();
  }
  
  private onMouseMove(event: MouseEvent): void {
    if (!this.canvas) return;
    
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - this.viewMode.panOffset.x) / this.viewMode.zoomLevel;
    const y = (event.clientY - rect.top - this.viewMode.panOffset.y) / this.viewMode.zoomLevel;
    
    this.interaction.mousePos = { x, y };
    
    if (this.interaction.isDragging) {
      const dx = event.clientX - this.interaction.lastDragPos.x;
      const dy = event.clientY - this.interaction.lastDragPos.y;
      
      this.viewMode.panOffset.x += dx;
      this.viewMode.panOffset.y += dy;
      
      this.interaction.lastDragPos = { x: event.clientX, y: event.clientY };
      this.markDirty();
    } else {
      if (this.viewMode.mode === 'equipment') {
        const hoveredElement = this.findElementAt(x, y);
        if (hoveredElement !== this.interaction.hoveredElement) {
          this.interaction.hoveredElement = hoveredElement;
          this.canvas.style.cursor = hoveredElement ? 'pointer' : 'default';
          this.markDirty();
        }
      } else {
        // Update hover
        const hoveredNode = this.findNodeAt(x, y);
        if (hoveredNode !== this.interaction.hoveredNode) {
          this.interaction.hoveredNode = hoveredNode;
          this.canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
          this.markDirty();
        }
      }
    }
  }
  
  private onMouseUp(event: MouseEvent): void {
    this.interaction.isDragging = false;
    if (this.canvas) {
      this.canvas.style.cursor = (this.interaction.hoveredNode || this.interaction.hoveredElement) ? 'pointer' : 'default';
    }
  }
  
  private onClick(event: MouseEvent): void {
    // Don't select if we were dragging
    const dragDist = this.distance(this.interaction.dragStart, 
      { x: event.clientX, y: event.clientY });
    if (dragDist > 5) return;
    
    if (!this.canvas) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - this.viewMode.panOffset.x) / this.viewMode.zoomLevel;
    const y = (event.clientY - rect.top - this.viewMode.panOffset.y) / this.viewMode.zoomLevel;

    if (this.viewMode.mode === 'equipment') {
      const element = this.findElementAt(x, y);
      if (element) {
        this.setSelectedElement(element);
        return;
      }
      this.clearSelectedElement();
    }

    if (this.interaction.hoveredNode) {
      this.selectNode(this.interaction.hoveredNode);
    }
  }
  
  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    
    const zoomSpeed = 0.001;
    const delta = -event.deltaY * zoomSpeed;
    const newZoom = this.viewMode.targetZoom + delta;
    
    this.viewMode.targetZoom = Math.max(
      this.viewMode.minZoom,
      Math.min(this.viewMode.maxZoom, newZoom)
    );
    this.markDirty();
  }
  
  private onTouchStart(event: TouchEvent): void {
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      this.interaction.isDragging = true;
      this.interaction.dragStart = { x: touch.clientX, y: touch.clientY };
      this.interaction.lastDragPos = { x: touch.clientX, y: touch.clientY };
    }
  }
  
  private onTouchMove(event: TouchEvent): void {
    if (event.touches.length === 1 && this.interaction.isDragging) {
      const touch = event.touches[0];
      const dx = touch.clientX - this.interaction.lastDragPos.x;
      const dy = touch.clientY - this.interaction.lastDragPos.y;
      
      this.viewMode.panOffset.x += dx;
      this.viewMode.panOffset.y += dy;
      
      this.interaction.lastDragPos = { x: touch.clientX, y: touch.clientY };
      this.markDirty();
    }
  }
  
  private onTouchEnd(event: TouchEvent): void {
    this.interaction.isDragging = false;
  }
  
  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        this.navigateBack();
        this.markDirty();
        break;
      case '+':
        this.zoomIn();
        break;
      case '-':
        this.zoomOut();
        break;
      case '0':
        this.resetView();
        break;
    }
  }
  
  // ============================================================================
  // UTILITY METHODS
  // ============================================================================
  
  private findNodeAt(x: number, y: number): NetworkNode | null {
    if (!this.networkData) return null;
    
    // Search in current view based on mode
    let nodesToSearch: NetworkNode[] = [];
    
    switch (this.viewMode.mode) {
      case 'overview':
        nodesToSearch = this.networkData.nodes;
        break;
      case 'station':
        nodesToSearch = this.viewMode.selectedNode?.children || [];
        break;
      case 'voltage':
        nodesToSearch = this.viewMode.selectedNode?.children || [];
        break;
      case 'equipment':
        // Elements are not NetworkNodes, skip for now
        return null;
    }
    
    // Find closest node within click radius
    for (const node of nodesToSearch) {
      const dist = this.distance({ x, y }, node.position);
      const radius = this.getNodeRadius(node.type);
      
      if (dist <= radius) {
        return node;
      }
    }
    
    return null;
  }

  private findElementAt(x: number, y: number): ElementNode | null {
    if (!this.elementHitAreas.length) return null;
    for (const area of this.elementHitAreas) {
      const halfW = area.width / 2;
      const halfH = area.height / 2;
      if (x >= area.x - halfW && x <= area.x + halfW &&
          y >= area.y - halfH && y <= area.y + halfH) {
        return area.element;
      }
    }
    return null;
  }
  
  private getNodeRadius(type: string): number {
    switch (type) {
      case 'B1': return 50;
      case 'B2': return 40;
      case 'B3': return 30;
      default: return 15;
    }
  }
  
  private distance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  private isNodeVisible(node: NetworkNode, bounds: VisibleBounds): boolean {
    return node.position.x >= bounds.minX &&
           node.position.x <= bounds.maxX &&
           node.position.y >= bounds.minY &&
           node.position.y <= bounds.maxY;
  }
  
  private calculateVisibleBounds(): VisibleBounds {
    if (!this.canvas) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }
    
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    
    return {
      minX: -this.viewMode.panOffset.x / this.viewMode.zoomLevel - 100,
      maxX: (width - this.viewMode.panOffset.x) / this.viewMode.zoomLevel + 100,
      minY: -this.viewMode.panOffset.y / this.viewMode.zoomLevel - 100,
      maxY: (height - this.viewMode.panOffset.y) / this.viewMode.zoomLevel + 100
    };
  }
  
  private expandBounds(bounds: VisibleBounds, padding: number): VisibleBounds {
    return {
      minX: bounds.minX - padding,
      maxX: bounds.maxX + padding,
      minY: bounds.minY - padding,
      maxY: bounds.maxY + padding
    };
  }
  
  private isConnectionWithinBounds(
    from: NetworkNode,
    to: NetworkNode,
    bounds: VisibleBounds,
    visibleStations: Set<string>
  ): boolean {
    if (visibleStations.has(from.id) || visibleStations.has(to.id)) {
      return true;
    }
    
    return this.isNodeVisible(from, bounds) || this.isNodeVisible(to, bounds);
  }
  
  /**
   * Palet hex'ini (#RRGGBB) Canvas için rgb/rgba string'ine çevirir.
   * Saydamlık gerektiren gradient/shadow renklerinde paleti tek kaynak
   * tutmak için kullanılır.
   */
  private withAlpha(hex: string, alpha?: number): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return alpha != null ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`;
  }

  private getStatusColors(status: string): { light: string; dark: string; border: string } {
    switch (status) {
      case 'online':
        // ok: sağlıklı = success Yeşili vurgusu, çelik (tertiary) zemin
        return { light: STATUS.success, dark: BRAND.tertiary, border: STATUS.success };
      case 'alarm':
        // hata: danger kırmızısı
        return { light: STATUS.danger, dark: STATUS.danger, border: STATUS.danger };
      case 'warning':
        return { light: STATUS.warning, dark: STATUS.warning, border: STATUS.warning };
      case 'offline':
        // nötr: info (lunar çelik)
        return { light: STATUS.info, dark: STATUS.info, border: STATUS.info };
      default:
        return { light: STATUS.info, dark: STATUS.info, border: STATUS.info };
    }
  }
  
  private getEquipmentColor(name: string): string {
    const lowerName = name.toLowerCase();

    if (lowerName.includes('trafo') || lowerName.includes('transf')) return STATUS.danger;
    if (lowerName.includes('bara') || lowerName.includes('bus')) return BRAND.tertiary;
    if (lowerName.includes('cb') || lowerName.includes('breaker')) return BRAND.secondary;
    if (lowerName.includes('iso')) return CHART_PALETTE[6];
    if (lowerName.includes('line')) return STATUS.warning;

    return CHART_PALETTE[8];
  }
  
  private getEquipmentCode(name: string): string {
    const lowerName = name.toLowerCase();
    
    if (lowerName.includes('trafo') || lowerName.includes('transf')) return 'TR';
    if (lowerName.includes('bara') || lowerName.includes('bus')) return 'BUS';
    if (lowerName.includes('cb') || lowerName.includes('breaker')) return 'CB';
    if (lowerName.includes('iso')) return 'ISO';
    if (lowerName.includes('line')) return 'LN';
    
    return name.slice(0, 3).toUpperCase();
  }
  
  private getVoltageCode(name: string): string {
    const match = name.match(/(\d+)\s*(k?v?)/i);
    if (match && match[1]) {
      return `${match[1]}${match[2] ? match[2].toUpperCase() : ''}`;
    }
    
    return 'B2';
  }
  
  private calculateStatistics(): void {
    if (!this.networkData) return;
    
    this.totalStats = { online: 0, offline: 0, alarm: 0, warning: 0 };
    
    const countNodes = (nodes: NetworkNode[]) => {
      nodes.forEach(node => {
        const status = node.status as keyof NodeStatus;
        if (status in this.totalStats) {
          this.totalStats[status]++;
        }
        countNodes(node.children);
      });
    };
    
    countNodes(this.networkData.nodes);
    this.markDirty();
  }
  
  // ============================================================================
  // PUBLIC METHODS (Called from template)
  // ============================================================================
  
  selectNode(node: NetworkNode): void {
    this.selectedElement = null;
    this.interaction.hoveredElement = null;
    this.actionSelectedPaths.clear();
    this.actionSearchQuery = '';
    this.actionFeedback = '';
    this.actionDrawerOpen = true;

    // Determine next view mode based on current node type
    switch (node.type) {
      case 'B1':
        this.viewMode.mode = 'station';
        this.viewMode.selectedNode = node;
        break;
      case 'B2':
        this.viewMode.mode = 'voltage';
        this.viewMode.selectedNode = node;
        break;
      case 'B3':
        this.viewMode.mode = 'equipment';
        this.viewMode.selectedNode = node;
        break;
    }
    
    // Reset view for clean, centered detail layout
    this.resetView();
    this.updateActionCandidates();
    this.loadRelatedReports(node.name);
    this.markDirty();
    this.cdr.markForCheck();
  }

  private setSelectedElement(element: ElementNode): void {
    this.selectedElement = element;
    this.actionSelectedPaths.clear();
    this.actionFeedback = '';
    this.actionDrawerOpen = true;
    this.updateActionCandidates();
    this.markDirty();
    this.cdr.markForCheck();
  }

  private clearSelectedElement(): void {
    if (this.selectedElement) {
      this.selectedElement = null;
      this.actionSelectedPaths.clear();
      this.updateActionCandidates();
      this.markDirty();
      this.cdr.markForCheck();
    }
  }

  navigateBack(): void {
    switch (this.viewMode.mode) {
      case 'station':
        this.viewMode.mode = 'overview';
        this.viewMode.selectedNode = null;
        break;
      case 'voltage':
        // Go back to station view
        if (this.viewMode.selectedNode?.parentId) {
          const parent = this.findNodeById(this.viewMode.selectedNode.parentId);
          if (parent) {
            this.viewMode.mode = 'station';
            this.viewMode.selectedNode = parent;
          }
        }
        break;
      case 'equipment':
        // Go back to voltage view
        if (this.viewMode.selectedNode?.parentId) {
          const parent = this.findNodeById(this.viewMode.selectedNode.parentId);
          if (parent) {
            this.viewMode.mode = 'voltage';
            this.viewMode.selectedNode = parent;
          }
        }
        break;
    }
    
    this.resetView();
    this.selectedElement = null;
    this.interaction.hoveredElement = null;
    this.actionSelectedPaths.clear();
    this.actionSearchQuery = '';
    this.updateActionCandidates();
    this.markDirty();
    this.cdr.markForCheck();
  }
  
  private findNodeById(id: string): NetworkNode | null {
    if (!this.networkData) return null;
    
    const search = (nodes: NetworkNode[]): NetworkNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = search(node.children);
        if (found) return found;
      }
      return null;
    };
    
    return search(this.networkData.nodes);
  }
  
  private centerOnNode(node: NetworkNode): void {
    if (!this.canvas) return;
    
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    
    this.viewMode.panOffset.x = width / 2 - node.position.x * this.viewMode.zoomLevel;
    this.viewMode.panOffset.y = height / 2 - node.position.y * this.viewMode.zoomLevel;
    this.markDirty();
  }
  
  zoomIn(): void {
    this.viewMode.targetZoom = Math.min(
      this.viewMode.maxZoom,
      this.viewMode.targetZoom * 1.3
    );
    this.markDirty();
  }
  
  zoomOut(): void {
    this.viewMode.targetZoom = Math.max(
      this.viewMode.minZoom,
      this.viewMode.targetZoom / 1.3
    );
    this.markDirty();
  }
  
  resetView(): void {
    if (this.canvas) {
      const e = this.canvas.width / (window.devicePixelRatio || 1);
      const i = this.canvas.height / (window.devicePixelRatio || 1);

      // Calculate bounds of all nodes
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      const nodes = this.networkData ? this.networkData.nodes : [];
      
      if (nodes && nodes.length > 0) {
        nodes.forEach(n => {
          if (n.position) {
            minX = Math.min(minX, n.position.x);
            maxX = Math.max(maxX, n.position.x);
            minY = Math.min(minY, n.position.y);
            maxY = Math.max(maxY, n.position.y);
          }
        });
      }

      // Default bounds fallback if no nodes are loaded yet
      if (minX === Infinity) {
        minX = 1500 - 850;
        maxX = 1500 + 850;
        minY = 1200 - 850;
        maxY = 1200 + 850;
      }

      const padding = 100;
      const contentWidth = (maxX - minX) + 2 * padding;
      const contentHeight = (maxY - minY) + 2 * padding;

      // Detect if search & filter sidebar is visible
      const sidebar = document.querySelector('.network-sidebar');
      const sidebarWidth = (sidebar && (sidebar as HTMLElement).style.display !== 'none') ? 280 : 0;

      // Calculate optimal zoom to fit
      const zoomX = (e - sidebarWidth) / contentWidth;
      const zoomY = i / contentHeight;
      const zoom = Math.max(0.3, Math.min(1.0, Math.min(zoomX, zoomY)));

      this.viewMode.zoomLevel = zoom;
      this.viewMode.targetZoom = zoom;

      // Center node boundaries on the visible viewport center
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const visibleCenterX = sidebarWidth + (e - sidebarWidth) / 2;
      const visibleCenterY = i / 2;

      this.viewMode.panOffset = {
        x: visibleCenterX - centerX * zoom,
        y: visibleCenterY - centerY * zoom
      };
    } else {
      this.viewMode.panOffset = { x: -1000, y: -900 };
    }
    this.markDirty();
  }
  
  refreshData(): void {
    this.networkMapService.clearCache();
    this.invalidateRenderCaches();
    this.loadNetworkData();
  }
  
  applyFilters(): void {
    this.markDirty();
    this.cdr.markForCheck();
  }

  toggleActionDrawer(): void {
    this.actionDrawerOpen = !this.actionDrawerOpen;
  }

  onActionSearchChange(): void {
    this.updateActionCandidates();
  }

  toggleActionCandidate(path: string): void {
    if (this.actionSelectedPaths.has(path)) {
      this.actionSelectedPaths.delete(path);
    } else {
      this.actionSelectedPaths.add(path);
    }
  }

  selectAllActionCandidates(): void {
    this.actionSelectedPaths.clear();
    this.actionCandidates.forEach(candidate => this.actionSelectedPaths.add(candidate.path));
  }

  clearActionSelection(): void {
    this.actionSelectedPaths.clear();
  }

  addSelectionToDashboard(): void {
    const paths = this.getSelectedActionPaths();
    if (!paths.length) {
      this.actionFeedback = this.translate.instant('NETWORK_MAP.SELECT_PATH_FIRST');
      return;
    }

    const userId = this.authService.getCurrentUser()?.username || 'default';
    const widgetId = `nm-${Date.now()}`;
    const title = this.getWidgetTitleFromPaths(paths);

    const widgetData: any = {
      id: widgetId,
      widget_type: this.actionWidgetType,
      title,
      data_path: '',
      initial_paths: paths,
      position: { x: 0, y: 0, width: 2, height: 2 },
      config: { refreshRate: 10000 },
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Save to localStorage as reliable fallback
    this.saveWidgetToLocalDashboard(widgetData);

    // Also try API
    this.apiService.addWidgetToDashboard(userId, widgetData).subscribe({
      next: () => {},
      error: () => {}
    });

    this.actionFeedback = this.translate.instant('NETWORK_MAP.ADDED_TO_DASHBOARD');
    this.cdr.markForCheck();

    // Navigate to dashboard after a brief feedback
    setTimeout(() => {
      this.router.navigate(['/dashboard']);
    }, 600);
  }

  private saveWidgetToLocalDashboard(widgetData: any): void {
    try {
      const cached = localStorage.getItem('dashboard-widgets-cache');
      let data = cached ? JSON.parse(cached) : { widgets: [] };
      if (!Array.isArray(data.widgets)) {
        data.widgets = [];
      }
      data.widgets.push({
        id: widgetData.widget_type,
        instanceId: widgetData.id,
        title: widgetData.title,
        icon: 'fas fa-chart-line',
        type: widgetData.widget_type,
        dataSourceType: 'realtime',
        initialPaths: widgetData.initial_paths || [],
        configuration: widgetData.config || {},
        refreshRate: widgetData.config?.refreshRate || 10000,
        layout: widgetData.position,
        visible: true
      });
      localStorage.setItem('dashboard-widgets-cache', JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save widget to localStorage:', e);
    }
  }

  monitorSelection(): void {
    const paths = this.getSelectedActionPaths();
    if (!paths.length) {
      this.actionFeedback = this.translate.instant('NETWORK_MAP.SELECT_PATH_FIRST');
      return;
    }
    this.addSelectionToDashboard();
    this.router.navigate(['/dashboard']);
  }

  createReportFromSelection(): void {
    const paths = this.getSelectedActionPaths();
    if (!paths.length) {
      this.actionFeedback = this.translate.instant('NETWORK_MAP.SELECT_PATH_FIRST');
      return;
    }

    // Build rich metadata for auto-report creation
    const nodeName = this.actionTargetName || 'Station';
    const nodeType = this.actionTargetType || '';
    const reportConfig = {
      paths,
      stationName: nodeName,
      nodeType,
      breadcrumb: this.actionTargetBreadcrumb || '',
      autoGenerate: true
    };

    sessionStorage.setItem('networkMapReportPaths', JSON.stringify(paths));
    sessionStorage.setItem('networkMapReportConfig', JSON.stringify(reportConfig));
    sessionStorage.setItem('networkMapOpenReportCreator', '1');
    this.router.navigate(['/reports']);
  }

  copySelectionPath(path: string): void {
    if (!navigator.clipboard) {
      this.actionFeedback = this.translate.instant('NETWORK_MAP.COPY_NOT_SUPPORTED');
      return;
    }
    navigator.clipboard.writeText(path).then(() => {
      this.actionFeedback = this.translate.instant('NETWORK_MAP.COPIED');
    }).catch(() => {
      this.actionFeedback = this.translate.instant('NETWORK_MAP.COPY_FAILED');
    });
  }
  
  openReportsForNode(node: NetworkNode): void {
    this.router.navigate(['/reports'], {
      queryParams: {
        nodeId: node.id,
        nodeType: node.type,
        nodeName: node.name
      }
    });
  }
  
  openDashboardForNode(node: NetworkNode): void {
    this.router.navigate(['/dashboard'], {
      queryParams: {
        focus: node.id,
        type: node.type
      }
    });
  }
  
  openAssetDetails(node: NetworkNode): void {
    this.router.navigate(['/assets', node.id], {
      queryParams: {
        type: node.type
      }
    });
  }
  
  // ============================================================================
  // GETTERS FOR TEMPLATE
  // ============================================================================
  
  get isOverviewMode(): boolean {
    return this.viewMode.mode === 'overview';
  }

  get actionTargetName(): string {
    return this.selectedElement?.name || this.viewMode.selectedNode?.name || '';
  }

  get actionTargetType(): string {
    return this.selectedElement ? 'Element' : this.viewMode.selectedNode?.type || '';
  }

  get actionTargetBreadcrumb(): string {
    const parts = this.getNodeBreadcrumb(this.viewMode.selectedNode);
    if (this.selectedElement) {
      parts.push(this.selectedElement.name);
    }
    return parts.join(' / ');
  }

  get actionSelectionCount(): number {
    return this.actionSelectedPaths.size;
  }
  
  get formattedLastUpdate(): string {
    const lang = this.translate.currentLang || 'en';
    const localeMap: Record<string, string> = { tr: 'tr-TR', en: 'en-US', de: 'de-DE' };
    return new Date().toLocaleTimeString(localeMap[lang] || 'en-US');
  }
  
  get selectedNode(): NetworkNode | null {
    return this.viewMode.selectedNode;
  }
  
  get hoveredNode(): NetworkNode | null {
    return this.interaction.hoveredNode;
  }

  // ============================================================================
  // ALARM BADGES & NAVIGATION
  // ============================================================================

  loadAlarmBadges(): void {
    const today = new Date();
    const dayAgo = new Date();
    dayAgo.setDate(today.getDate() - 1);
    const startDate = dayAgo.toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];


  }

  navigateToAlarms(tab: 'alarms' | 'messages'): void {
    this.router.navigate(['/alarms'], { queryParams: { tab } });
  }

  // ============================================================================
  // RELATED REPORTS
  // ============================================================================

  loadRelatedReports(nodeName?: string): void {
    if (!nodeName) {
      this.relatedReports = [];
      return;
    }
    this.relatedReportsLoading = true;
    this.apiService.getReports().subscribe({
      next: (reports) => {
        this.relatedReports = (reports || []).filter(r => {
          const paths = r.selectedPaths || [];
          const nameStr = r.name || '';
          const descStr = r.description || '';
          const searchTerm = nodeName.toLowerCase();
          return nameStr.toLowerCase().includes(searchTerm) ||
                 descStr.toLowerCase().includes(searchTerm) ||
                 paths.some(p => p.toLowerCase().includes(searchTerm));
        }).slice(0, 10);
        this.relatedReportsLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.relatedReports = [];
        this.relatedReportsLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  viewReport(reportId: string | undefined): void {
    if (reportId) {
      this.router.navigate(['/reports'], { queryParams: { id: reportId } });
    }
  }

  // ============================================================================
  // ACTION PATH BUILDERS
  // ============================================================================

  private updateActionCandidates(): void {
    this.actionCandidates = [];
    this.actionSearchHint = '';

    const node = this.viewMode.selectedNode;
    if (!node) {
      return;
    }

    const query = this.actionSearchQuery.trim().toLowerCase();
    if (this.selectedElement) {
      const b3Node = node.type === 'B3' ? node : null;
      if (b3Node) {
        this.actionCandidates = this.buildPathsForElement(b3Node, this.selectedElement, query);
      }
      return;
    }

    const b3Nodes = this.collectB3Nodes(node);

    for (const b3Node of b3Nodes) {
      if (!b3Node.elements || b3Node.elements.length === 0) {
        continue;
      }
      for (const element of b3Node.elements) {
        const entries = this.buildPathsForElement(b3Node, element, query);
        for (const entry of entries) {
          this.actionCandidates.push(entry);
          if (this.actionCandidates.length >= this.actionMaxResults) {
            this.actionSearchHint = this.translate.instant('NETWORK_MAP.RESULT_LIMIT', { count: this.actionMaxResults });
            return;
          }
        }
      }
    }

    if (!this.actionCandidates.length && query) {
      this.actionSearchHint = this.translate.instant('NETWORK_MAP.NO_RESULTS');
    } else if (!this.actionCandidates.length) {
      this.actionSearchHint = this.translate.instant('NETWORK_MAP.EMPTY_SEARCH');
    } else if (!this.actionCandidates.length && node.type === 'B3') {
      this.actionSearchHint = this.translate.instant('NETWORK_MAP.NO_ELEMENTS');
    }
  }

  private buildPathsForElement(b3Node: NetworkNode, element: ElementNode, query: string): ActionPath[] {
    const infoOptions = this.getInfoOptionsForNoElType(element.noElType, element.name);
    if (!infoOptions.length) {
      return [];
    }

    const names = this.getB1B2B3Names(b3Node);
    const results: ActionPath[] = [];

    for (const info of infoOptions) {
      const infoLabel = element.nimSatz ? `${info.name}[${element.nimSatz}]` : info.name;
      const path = `${names.b1}/${names.b2}/${names.b3}/${element.name}/${infoLabel}`;
      const candidate: ActionPath = {
        path,
        b1: names.b1,
        b2: names.b2,
        b3: names.b3,
        element: element.name,
        info: info.name,
        nimSatz: element.nimSatz
      };
      if (query && !this.actionMatchesQuery(candidate, query)) {
        continue;
      }
      results.push(candidate);
    }

    return results;
  }

  private actionMatchesQuery(candidate: ActionPath, query: string): boolean {
    const haystack = `${candidate.b1} ${candidate.b2} ${candidate.b3} ${candidate.element} ${candidate.info}`.toLowerCase();
    return haystack.includes(query);
  }

  private collectB3Nodes(node: NetworkNode): NetworkNode[] {
    if (node.type === 'B3') {
      return [node];
    }

    const b3Nodes: NetworkNode[] = [];
    const stack: NetworkNode[] = [...(node.children || [])];

    while (stack.length) {
      const current = stack.shift();
      if (!current) continue;
      if (current.type === 'B3') {
        b3Nodes.push(current);
      } else if (current.children && current.children.length) {
        stack.push(...current.children);
      }
    }

    return b3Nodes;
  }

  private getB1B2B3Names(b3Node: NetworkNode): { b1: string; b2: string; b3: string } {
    const b2Node = b3Node.parentId ? this.findNodeById(b3Node.parentId) : null;
    const b1Node = b2Node?.parentId ? this.findNodeById(b2Node.parentId) : null;
    return {
      b1: b1Node?.name || 'B1',
      b2: b2Node?.name || 'B2',
      b3: b3Node.name
    };
  }

  private getNodeBreadcrumb(node: NetworkNode | null): string[] {
    if (!node) return [];
    const parts: string[] = [];
    let current: NetworkNode | null = node;
    while (current) {
      parts.unshift(current.name);
      current = current.parentId ? this.findNodeById(current.parentId) : null;
    }
    return parts;
  }

  private getInfoOptionsForNoElType(noElType: number, elemName?: string): Array<{ id: string; name: string }> {
    if (elemName && elemName.endsWith('FaultTm')) {
      return [{ id: '1', name: 'CvOptim' }];
    }
    if (elemName && elemName.endsWith('Fault')) {
      return [{ id: '1', name: 'CvSwitch' }];
    }
    if (noElType === 6) {
      return [{ id: '3', name: 'Status' }];
    }
    if (noElType === 2) {
      return [{ id: '1', name: 'MvMoment' }];
    }
    return [];
  }

  private getSelectedActionPaths(): string[] {
    return Array.from(this.actionSelectedPaths);
  }

  private getWidgetTitleFromPaths(paths: string[]): string {
    if (paths.length === 1) {
      return `NM ${paths[0].split('/').slice(-2, -1)[0] || 'Widget'}`;
    }
    return `NM Selection (${paths.length})`;
  }
}
