import { Component, EventEmitter, Input, Output, OnChanges, SimpleChanges } from '@angular/core';
import { TableExplorerService, SavedExploration } from '../../services/table-explorer.service';
import { QueryService } from '../../services/query.service';
import { AuthService } from '../../services/auth.service';

@Component({
  standalone: false,
  selector: 'app-query-viewer-dialog',
  templateUrl: './query-viewer-dialog.component.html',
  styleUrls: ['./query-viewer-dialog.component.scss']
})
export class QueryViewerDialogComponent implements OnChanges {
  @Input() visible = false;
  @Input() title = 'Query Viewer';
  @Input() queryViewerHeaders = '[]';
  @Input() queryViewerSqlQueries = '[]';
  @Input() queryViewerCode = '';
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() cancel = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<{ title: string, headers: string, sqlQueries: string, code: string }>();

  isEditingTitle = false;
  editedTitle = '';

  savedQueries: SavedExploration[] = [];
  sourceFilter: 'all' | 'sql' | 'python' = 'all';
  searchTerm = '';

  selectedQueryId = '';
  selectedDataset = '';
  selectedQuery: SavedExploration | null = null;
  selectedQueryColumns: string[] = [];
  isLoadingQueries = false;

  // Live preview state
  isRunningPreview = false;
  previewRows: Array<Record<string, any>> = [];
  previewTotalRows = 0;
  previewExecutionMs = 0;
  previewError = '';

  tempHeaders: Array<{name: string, filterable: boolean}> = [];
  tempSqlIds: string[] = [];

  constructor(
    private tableExplorerService: TableExplorerService,
    private queryService: QueryService,
    private authService: AuthService
  ) {}

  get filteredQueries(): SavedExploration[] {
    const q = (this.searchTerm || '').trim().toLowerCase();
    return this.savedQueries.filter(item => {
      if (this.sourceFilter !== 'all' && item.source !== this.sourceFilter) {
        return false;
      }
      if (!q) return true;
      return (
        (item.name || '').toLowerCase().includes(q) ||
        (item.description || '').toLowerCase().includes(q) ||
        (item.id || '').toLowerCase().includes(q)
      );
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible'] && this.visible) {
      this.editedTitle = this.title;
      this.isEditingTitle = false;
      this.loadSavedQueries();
    }
  }

  loadSavedQueries(): void {
    this.isLoadingQueries = true;
    this.tableExplorerService.listSaved().subscribe({
      next: res => {
        this.savedQueries = res || [];
        this.isLoadingQueries = false;

        try {
          const savedIds = JSON.parse(this.queryViewerSqlQueries || '[]');
          if (savedIds && savedIds.length > 0) {
            const rawRef = String(savedIds[0] || '');
            if (rawRef.startsWith('py:')) {
              const parts = rawRef.split(':');
              this.selectedDataset = parts[2] || '';
              this.onQuerySelect(parts[1] || rawRef);
            } else {
              this.onQuerySelect(rawRef);
            }
          } else {
            this.selectedQueryId = '';
            this.selectedQuery = null;
            this.selectedQueryColumns = [];
            this.previewRows = [];
          }
        } catch (e) {
          this.selectedQueryId = '';
        }
      },
      error: () => {
        this.isLoadingQueries = false;
      }
    });
  }

  onQuerySelect(id: string): void {
    const q = this.savedQueries.find(item => item.id === id);
    if (!q) return;

    this.selectedQuery = q;
    this.selectedQueryId = q.id;
    if (q.source === 'python') {
      const dsList = q.datasetNames || [];
      if (!this.selectedDataset || !dsList.includes(this.selectedDataset)) {
        this.selectedDataset = dsList[0] || '';
      }
    } else {
      this.selectedDataset = '';
    }

    if (!this.title || this.title === 'Query Viewer' || this.title === '') {
      this.title = q.name;
      this.editedTitle = this.title;
    }

    const cols: string[] = (q.columns || []).map((c: any) => {
      if (typeof c === 'string') return c;
      return c.alias || c.name || '';
    }).filter(Boolean);
    this.selectedQueryColumns = cols;
    this.syncOutputBindings();
    this.runLivePreview();
  }

  onDatasetChange(ds: string): void {
    this.selectedDataset = ds;
    this.syncOutputBindings();
    this.runLivePreview();
  }

  private syncOutputBindings(): void {
    if (!this.selectedQuery) return;
    if (this.selectedQuery.source === 'python') {
      const ref = this.selectedDataset
        ? `py:${this.selectedQuery.id}:${this.selectedDataset}`
        : `py:${this.selectedQuery.id}`;
      this.tempSqlIds = [ref];
    } else {
      this.tempSqlIds = [this.selectedQuery.id];
    }
    this.tempHeaders = this.selectedQueryColumns.map(name => ({ name, filterable: true }));
  }

  runLivePreview(): void {
    if (!this.selectedQuery) return;
    this.isRunningPreview = true;
    this.previewError = '';
    this.previewRows = [];

    if (this.selectedQuery.source === 'python') {
      this.queryService.runSavedPythonScript(this.selectedQuery.id, {}, this.selectedDataset).subscribe({
        next: (res) => {
          this.isRunningPreview = false;
          const data = res?.data;
          const cols = (data?.columns || []).map((c: any) => typeof c === 'string' ? c : c.name).filter(Boolean);
          if (cols.length) {
            this.selectedQueryColumns = cols;
            this.syncOutputBindings();
          }
          if (data?.datasetNames?.length && !this.selectedDataset) {
            this.selectedDataset = data.datasetName || data.datasetNames[0];
            this.syncOutputBindings();
          }
          this.previewRows = (data?.rows || []).slice(0, 10);
          this.previewTotalRows = data?.totalRows ?? (data?.rows || []).length;
          this.previewExecutionMs = data?.executionMs || 0;
        },
        error: (err) => {
          this.isRunningPreview = false;
          this.previewError = err?.error?.error || 'Python script çalıştırılamadı.';
        }
      });
    } else {
      this.queryService.preview(this.selectedQuery.id, {}, 25).subscribe({
        next: (res) => {
          this.isRunningPreview = false;
          const data = res?.data;
          const cols = (data?.columns || []).map((c: any) => typeof c === 'string' ? c : c.name).filter(Boolean);
          if (cols.length) {
            this.selectedQueryColumns = cols;
            this.syncOutputBindings();
          }
          this.previewRows = (data?.rows || []).slice(0, 10);
          this.previewTotalRows = data?.totalRows ?? (data?.rows || []).length;
          this.previewExecutionMs = data?.executionMs || 0;
        },
        error: (err) => {
          this.isRunningPreview = false;
          this.previewError = err?.error?.error || 'SQL sorgusu çalıştırılamadı.';
        }
      });
    }
  }

  clearSelection(): void {
    this.selectedQueryId = '';
    this.selectedDataset = '';
    this.selectedQuery = null;
    this.selectedQueryColumns = [];
    this.previewRows = [];
    this.previewTotalRows = 0;
    this.previewError = '';
    this.tempSqlIds = [];
    this.tempHeaders = [];
    this.title = 'Query Viewer';
    this.editedTitle = 'Query Viewer';
  }

  startEditing(): void {
    this.isEditingTitle = true;
    this.editedTitle = this.title;
  }

  saveTitle(): void {
    this.title = this.editedTitle;
    this.isEditingTitle = false;
  }

  cancelEditing(): void {
    this.editedTitle = this.title;
    this.isEditingTitle = false;
  }

  onClose(): void {
    this.visible = false;
    this.visibleChange.emit(false);
    this.cancel.emit();
  }

  onCancel(): void {
    this.onClose();
  }

  onConfirm(): void {
    if (this.isEditingTitle) {
      this.saveTitle();
    }
    this.confirm.emit({
      title: this.title || 'Query Viewer',
      headers: JSON.stringify(this.tempHeaders),
      sqlQueries: JSON.stringify(this.tempSqlIds),
      code: ''
    });
    this.visible = false;
    this.visibleChange.emit(false);
  }
}
