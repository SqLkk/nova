import { Component, EventEmitter, Input, Output, OnChanges, SimpleChanges } from '@angular/core';
import { TableExplorerService, SavedExploration } from '../../services/table-explorer.service';
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
  selectedQueryId = '';
  selectedQuery: SavedExploration | null = null;
  selectedQueryColumns: string[] = [];
  isLoadingQueries = false;

  tempHeaders: Array<{name: string, filterable: boolean}> = [];
  tempSqlIds: string[] = [];

  constructor(
    private tableExplorerService: TableExplorerService,
    private authService: AuthService
  ) {}

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
        
        // Pre-select if there is an existing saved query ID
        try {
          const savedIds = JSON.parse(this.queryViewerSqlQueries || '[]');
          if (savedIds && savedIds.length > 0) {
            this.onQuerySelect(savedIds[0]);
          } else {
            this.selectedQueryId = '';
            this.selectedQuery = null;
            this.selectedQueryColumns = [];
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
    if (q) {
      this.selectedQuery = q;
      this.selectedQueryId = q.id;
      
      // Auto-populate title if empty or default
      if (!this.title || this.title === 'Query Viewer' || this.title === '') {
        this.title = `${q.name} Viewer`;
        this.editedTitle = this.title;
      }
      
      // Extract columns
      const cols: string[] = (q.columns || []).map((c: any) => {
        if (typeof c === 'string') return c;
        return c.alias || c.name || '';
      });
      this.selectedQueryColumns = cols;
      
      // Map to tempSqlIds and tempHeaders
      this.tempSqlIds = [q.id];
      this.tempHeaders = cols.map(name => ({ name, filterable: true }));
    }
  }

  clearSelection(): void {
    this.selectedQueryId = '';
    this.selectedQuery = null;
    this.selectedQueryColumns = [];
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
