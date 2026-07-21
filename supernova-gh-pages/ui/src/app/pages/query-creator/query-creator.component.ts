import { Component, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { QueryService } from '../../services/query.service';
import { SavedQuery, QueryResult } from '../../models/query.model';
import { DataSource } from '../../models/data-source.model';
import { DataSourceSelectionService } from '../../services/data-source-selection.service';
import { Subscription } from 'rxjs';
import { ConfirmService } from '../../services/confirm.service';
import { PathService } from '../../services/path.service';
import { PathDef } from '../../models/path-def.model';

export interface TableInfo {
  id: string;
  name: string;
  expanded?: boolean;
  columns?: any[];
  previewResult?: QueryResult;
}

@Component({
  standalone: false,
  selector: 'app-query-creator',
  templateUrl: './query-creator.component.html',
  styleUrls: ['./query-creator.component.scss']
})
export class QueryCreatorComponent implements OnInit, OnDestroy {
  // Lists
  queries: SavedQuery[] = [];
  dataSources: DataSource[] = [];
  
  // Active Query
  activeQueryId: string | null = null;
  selectedDataSourceId = '';
  queryName = '';
  queryDescription = '';
  querySql = '';
  allowedRoles = '';
  allowedUsers = '';
  showSaveModal = false;
  
  // Parameter Modal state
  showParamModal = false;
  detectedParams: any[] = [];
  pathDefs: PathDef[] = [];

  // Column search state
  dbSearchMode: 'tables' | 'columns' = 'tables';
  searchTermColumn = '';
  columnSearchResults: any[] = [];
  loadingColumnSearch = false;

  // Functions discovery state
  functionsList: any[] = [];
  loadingFunctions = false;
  searchTermFunction = '';

  // Relationship check modal state
  showRelationshipModal = false;
  activeRelationshipCheck: any = null;
  
  // Results
  previewResult: QueryResult | null = null;
  executing = false;
  errorMessage = '';
  
  // Success toast
  toastMessage = '';
  toastType: 'success' | 'error' = 'success';
  
  // Filter for saved queries
  searchTerm = '';

  // Tables explorer
  tables: TableInfo[] = [];
  loadingTables = false;
  searchTermTable = '';
  selectedTable: string | null = null;
  
  // Layout state
  isSidebarCollapsed = false;
  activeSidebarTab: 'database' | 'saved' | 'functions' = 'database';
  activeBottomTab: 'results' | 'preview' = 'results';
  
  // Table preview state
  tablePreviewLoading = false;
  tablePreviewError = '';
  activePreviewTable: string | null = null;
  activePreviewResult: QueryResult | null = null;

  constructor(
    private queryService: QueryService,
    private http: HttpClient,
    private dss: DataSourceSelectionService,
    private confirmService: ConfirmService,
    private pathService: PathService
  ) {}

  private dssSub?: Subscription;

  ngOnInit(): void {
    this.loadDataSources();
    this.loadQueries();

    // Shared DB seçimine abone ol — aktif saved query düzenlenmiyorsa DS'yi güncelle.
    this.dssSub = this.dss.selectedId$.subscribe(id => {
      if (id && !this.activeQueryId && this.dataSources.some(d => d.id === id)) {
        this.selectedDataSourceId = id;
        this.loadTables();
      }
    });
  }

  ngOnDestroy(): void {
    this.dssSub?.unsubscribe();
  }

  loadDataSources(): void {
    this.queryService.listDatasources().subscribe({
      next: (res) => {
        this.dataSources = res.data || [];
        if (this.dataSources.length > 0 && !this.selectedDataSourceId) {
          // Shared seçimi önceliklendir.
          const shared = this.dss.selectedId;
          const preferred = (shared && this.dataSources.some(d => d.id === shared))
            ? shared
            : this.dataSources[0].id;
          this.selectedDataSourceId = preferred;
          this.loadTables();
        }
      },
      error: () => {
        this.showToast('Failed to load data sources.', 'error');
      }
    });
  }

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: (res) => {
        this.queries = res.data || [];
      },
      error: () => {
        this.showToast('Failed to load queries.', 'error');
      }
    });
  }

  get filteredQueries(): SavedQuery[] {
    if (!this.searchTerm.trim()) return this.queries;
    const term = this.searchTerm.toLowerCase();
    return this.queries.filter(q => 
      q.name.toLowerCase().includes(term) || 
      (q.description && q.description.toLowerCase().includes(term))
    );
  }

  loadQuery(query: SavedQuery): void {
    this.activeQueryId = query.id;
    this.queryName = query.name;
    this.queryDescription = query.description || '';
    this.querySql = query.sql;
    this.selectedDataSourceId = query.dataSourceId;
    this.allowedRoles = (query.allowedRoles || []).join(', ');
    this.allowedUsers = (query.allowedUsers || []).join(', ');
    this.previewResult = null;
    this.errorMessage = '';
    this.loadTables();
  }

  onDataSourceChange(): void {
    this.loadTables();
    if (this.activeSidebarTab === 'functions') {
      this.loadFunctions();
    }
  }

  setSidebarTab(tab: 'database' | 'saved' | 'functions'): void {
    this.activeSidebarTab = tab;
    if (tab === 'functions') {
      this.loadFunctions();
    }
  }

  onColumnSearchChange(): void {
    if (!this.selectedDataSourceId || !this.searchTermColumn.trim()) {
      this.columnSearchResults = [];
      return;
    }
    this.loadingColumnSearch = true;
    this.queryService.searchColumns(this.selectedDataSourceId, this.searchTermColumn).subscribe({
      next: (res) => {
        this.loadingColumnSearch = false;
        this.columnSearchResults = res.data || [];
      },
      error: () => {
        this.loadingColumnSearch = false;
      }
    });
  }

  loadFunctions(): void {
    if (!this.selectedDataSourceId) {
      this.functionsList = [];
      return;
    }
    this.loadingFunctions = true;
    this.queryService.getFunctions(this.selectedDataSourceId).subscribe({
      next: (res) => {
        this.loadingFunctions = false;
        this.functionsList = res.data || [];
      },
      error: () => {
        this.loadingFunctions = false;
        this.functionsList = [];
      }
    });
  }

  get filteredFunctions(): any[] {
    if (!this.searchTermFunction.trim()) {
      return this.functionsList;
    }
    const term = this.searchTermFunction.toLowerCase().trim();
    return this.functionsList.filter(f => 
      (f.name && f.name.toLowerCase().includes(term)) ||
      (f.signature && f.signature.toLowerCase().includes(term)) ||
      (f.packageName && f.packageName.toLowerCase().includes(term)) ||
      (f.description && f.description.toLowerCase().includes(term))
    );
  }

  toggleFuncExpand(func: any, event: MouseEvent): void {
    event.stopPropagation();
    func.expanded = !func.expanded;
  }

  insertFunctionIntoEditor(func: any): void {
    const text = func.signature || `${func.name.toLowerCase()}()`;
    if (this.querySql && !this.querySql.endsWith(' ') && !this.querySql.endsWith('\n')) {
      this.querySql += ' ' + text;
    } else {
      this.querySql += text;
    }
  }

  findMatches(tableName: string, columnName: string): void {
    if (!this.selectedDataSourceId) return;
    this.activeRelationshipCheck = { t1: tableName, c1: columnName, matches: [] };
    this.showRelationshipModal = true;
    
    this.queryService.searchColumns(this.selectedDataSourceId, columnName).subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const list = res.data.filter((x: any) => x.table_name.toLowerCase() !== tableName.toLowerCase());
          this.activeRelationshipCheck.matches = list.map((x: any) => ({
            table_name: x.table_name,
            column_name: x.column_name,
            loading: false,
            overlap: null,
            status: ''
          }));
        }
      }
    });
  }

  verifyConnection(match: any): void {
    if (!this.selectedDataSourceId || !this.activeRelationshipCheck) return;
    match.loading = true;
    this.queryService.checkRelationship(
      this.selectedDataSourceId,
      this.activeRelationshipCheck.t1,
      this.activeRelationshipCheck.c1,
      match.table_name,
      match.column_name
    ).subscribe({
      next: (res) => {
        match.loading = false;
        if (res.success && res.data) {
          match.overlap = res.data.overlap_percentage;
          match.status = res.data.status;
        }
      },
      error: () => {
        match.loading = false;
      }
    });
  }

  setBottomTab(tab: 'results' | 'preview'): void {
    this.activeBottomTab = tab;
  }

  loadTables(forceRefresh = false): void {
    if (!this.selectedDataSourceId) {
      this.tables = [];
      return;
    }
    this.loadingTables = true;
    const url = `${environment.apiUrl}/datasources/${this.selectedDataSourceId}/tables` + (forceRefresh ? '?refresh=1' : '');
    this.http.get<any>(url).subscribe({
      next: (res) => {
        if (res && res.success) {
          this.tables = res.data.map((tableName: string) => ({
            id: tableName,
            name: tableName
          }));
        } else {
          this.tables = [];
        }
        this.loadingTables = false;
      },
      error: (err) => {
        this.tables = [];
        this.loadingTables = false;
        if (forceRefresh) {
          alert(err?.error?.message || 'Failed to refresh table list.');
        }
      }
    });
  }

  get filteredTables(): TableInfo[] {
    if (!this.searchTermTable.trim()) return this.tables;
    const term = this.searchTermTable.toLowerCase();
    return this.tables.filter(t => t.name.toLowerCase().includes(term));
  }

  insertTableIntoEditor(tableName: string): void {
    if (this.querySql && !this.querySql.endsWith(' ') && !this.querySql.endsWith('\n')) {
      this.querySql += ' ' + tableName;
    } else {
      this.querySql += tableName;
    }
  }

  toggleTable(table: TableInfo, event: Event): void {
    event.stopPropagation();
    this.selectedTable = table.id;
    if (table.expanded) {
      table.expanded = false;
      return;
    }
    
    // Collapse other tables
    this.tables.forEach(t => t.expanded = false);
    table.expanded = true;
    this.activePreviewTable = table.name;
    
    // Fetch preview data and columns if not already loaded
    if (!table.previewResult) {
      this.tablePreviewLoading = true;
      this.tablePreviewError = '';
      this.activeBottomTab = 'preview';
      this.activePreviewResult = null;
      
      this.http.get<any>(`${environment.apiUrl}/datasources/${this.selectedDataSourceId}/tables/${table.name}`).subscribe({
        next: (res) => {
          this.tablePreviewLoading = false;
          if (res && res.success && res.data) {
            table.columns = res.data.columns;
            table.previewResult = res.data;
            this.activePreviewResult = table.previewResult || null;
          } else {
            this.tablePreviewError = 'Could not load table preview.';
          }
        },
        error: (err) => {
          this.tablePreviewLoading = false;
          this.tablePreviewError = err.error?.error || 'Failed to load table details.';
        }
      });
    } else {
      this.activeBottomTab = 'preview';
      this.activePreviewResult = table.previewResult;
    }
  }

  toggleSidebar(): void {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
  }

  startNewQuery(): void {
    this.activeQueryId = null;
    this.queryName = '';
    this.queryDescription = '';
    this.querySql = '';
    this.allowedRoles = '';
    this.allowedUsers = '';
    this.previewResult = null;
    this.errorMessage = '';
    if (this.dataSources.length > 0) {
      this.selectedDataSourceId = this.dataSources[0].id;
      this.loadTables();
    }
  }

  loadPathDefs(): void {
    this.pathService.list().subscribe({
      next: (res) => {
        this.pathDefs = res.data || [];
      }
    });
  }

  runQuery(): void {
    if (!this.querySql.trim()) {
      this.showToast('Please write a SQL query.', 'error');
      return;
    }
    if (!this.selectedDataSourceId) {
      this.showToast('Please select a data source.', 'error');
      return;
    }

    // Extract parameters starting with : (e.g. :point_id, :limit)
    const regex = /:([a-zA-Z0-9_]+)/g;
    let match;
    const params: string[] = [];
    while ((match = regex.exec(this.querySql)) !== null) {
      const name = match[1];
      if (!params.includes(name)) {
        params.push(name);
      }
    }

    if (params.length > 0) {
      this.detectedParams = params.map(p => {
        const existing = this.detectedParams.find(x => x.name === p);
        return existing || { name: p, value: '', type: 'string', pathId: '', pathNodeSelected: null, pathNodes: [] };
      });
      if (this.pathDefs.length === 0) {
        this.loadPathDefs();
      }
      this.showParamModal = true;
    } else {
      this.executeWithParams({});
    }
  }

  onPathParamChange(param: any): void {
    if (!param.pathId) {
      param.pathNodes = [];
      param.pathNodeSelected = null;
      return;
    }
    const pathDef = this.pathDefs.find(x => x.id === param.pathId);
    if (pathDef?.materialized?.nodes) {
      param.pathNodes = pathDef.materialized.nodes;
    } else {
      this.pathService.build(param.pathId).subscribe({
        next: (res) => {
          if (res.success && res.data) {
            param.pathNodes = res.data.nodes;
            if (pathDef) {
              pathDef.materialized = res.data;
            }
          }
        }
      });
    }
  }

  executeWithParams(paramsMap: Record<string, any> = {}): void {
    // If modal was shown, collect values
    if (this.showParamModal) {
      paramsMap = {};
      for (const p of this.detectedParams) {
        if (p.type === 'path' && p.pathNodeSelected) {
          const pathDef = this.pathDefs.find(x => x.id === p.pathId);
          const targetCol = pathDef?.config?.target_col || 'id';
          paramsMap[p.name] = p.pathNodeSelected.row?.[targetCol] || p.pathNodeSelected.id;
        } else {
          paramsMap[p.name] = p.type === 'number' ? Number(p.value) : p.value;
        }
      }
      this.showParamModal = false;
    }

    this.executing = true;
    this.errorMessage = '';
    this.previewResult = null;
    this.activeBottomTab = 'results';

    this.queryService.previewAdhoc(
      this.selectedDataSourceId!,
      this.querySql,
      paramsMap,
      100
    ).subscribe({
      next: (res) => {
        this.executing = false;
        if (res.success && res.data) {
          this.previewResult = res.data;
          this.showToast('Query executed successfully.', 'success');
        } else {
          this.errorMessage = res.error || 'Query output is empty.';
        }
      },
      error: (err) => {
        this.executing = false;
        this.errorMessage = err.error?.error || err.message || 'An error occurred while running the query.';
      }
    });
  }

  openSaveModal(): void {
    if (!this.querySql.trim()) {
      this.showToast('Please write a SQL query.', 'error');
      return;
    }
    if (!this.selectedDataSourceId) {
      this.showToast('Please select a data source.', 'error');
      return;
    }
    this.showSaveModal = true;
  }

  closeSaveModal(): void {
    this.showSaveModal = false;
  }

  saveQuery(): void {
    if (!this.queryName.trim()) {
      this.showToast('Please name the query.', 'error');
      return;
    }
    if (!this.selectedDataSourceId) {
      this.showToast('Please select a data source.', 'error');
      return;
    }

    const payload: Partial<SavedQuery> = {
      name: this.queryName,
      description: this.queryDescription,
      sql: this.querySql,
      dataSourceId: this.selectedDataSourceId,
      allowedRoles: this.allowedRoles.split(',').map(s => s.trim()).filter(s => s),
      allowedUsers: this.allowedUsers.split(',').map(s => s.trim()).filter(s => s)
    };

    if (this.activeQueryId) {
      // Update
      this.queryService.update(this.activeQueryId, payload).subscribe({
        next: (res) => {
          this.showToast('Query updated successfully.', 'success');
          this.closeSaveModal();
          this.loadQueries();
        },
        error: (err) => {
          this.showToast('Query update failed: ' + (err.error?.error || err.message), 'error');
        }
      });
    } else {
      // Create
      this.queryService.create(payload).subscribe({
        next: (res) => {
          this.showToast('Query saved successfully.', 'success');
          if (res.data && res.data.id) {
            this.activeQueryId = res.data.id;
          }
          this.closeSaveModal();
          this.loadQueries();
        },
        error: (err) => {
          this.showToast('Could not save query: ' + (err.error?.error || err.message), 'error');
        }
      });
    }
  }

  async deleteQuery(q: SavedQuery, event: Event): Promise<void> {
    event.stopPropagation();
    if (!await this.confirmService.confirm(`Are you sure you want to delete query "${q.name}"?`)) return;

    this.queryService.remove(q.id).subscribe({
      next: () => {
        this.showToast('Query deleted.', 'success');
        if (this.activeQueryId === q.id) {
          this.startNewQuery();
        }
        this.loadQueries();
      },
      error: (err) => {
        this.showToast('Could not delete query: ' + (err.error?.error || err.message), 'error');
      }
    });
  }

  private showToast(message: string, type: 'success' | 'error' = 'success'): void {
    this.toastMessage = message;
    this.toastType = type;
    setTimeout(() => {
      if (this.toastMessage === message) {
        this.toastMessage = '';
      }
    }, 4000);
  }
}
