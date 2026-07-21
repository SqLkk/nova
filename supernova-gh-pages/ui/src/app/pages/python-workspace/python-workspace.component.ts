import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { QueryService } from '../../services/query.service';
import { SavedQuery, QueryResult, SavedPythonScript } from '../../models/query.model';
import { DataSourceSelectionService } from '../../services/data-source-selection.service';
import { ConfirmService } from '../../services/confirm.service';

interface ResultDataset {
  name: string;
  data: QueryResult;
}

@Component({
  standalone: false,
  selector: 'app-python-workspace',
  templateUrl: './python-workspace.component.html',
  styleUrls: ['./python-workspace.component.scss']
})
export class PythonWorkspaceComponent implements OnInit, OnDestroy {
  // Sidebar tab: 'queries' (SQL Queries checklist) or 'scripts' (Saved Python scripts list)
  activeSidebarTab: 'queries' | 'scripts' = 'queries';

  /** Kayıtlı SQL sorguları — seçilenler sql_data olarak inject edilir. */
  queries: SavedQuery[] = [];
  selectedSqlQueries: string[] = [];
  searchTerm = '';

  /** Kayıtlı Python script'leri. */
  pythonScripts: SavedPythonScript[] = [];
  activeScriptId: string | null = null;
  searchTermScripts = '';

  /** Editör içeriği. */
  code = `# Secure Python sandbox — runs in an isolated process (read-only, no file/network access).
# Available variables: sql_data (dict), queries, filters, json, math, datetime
# Output: out('name').append({'column': value})

total = 0
for row in sql_data.get('SourceQueryName', []):
    total = total + row.get('field', 0)

out('summary').append({'total': total, 'count': len(sql_data.get('SourceQueryName', []))})
`;

  executing = false;
  errorMessage = '';
  results: ResultDataset[] = [];
  searchTermResult = '';

  // Save Modal state
  showSaveModal = false;
  scriptName = '';
  scriptDescription = '';
  allowedRoles = '';
  allowedUsers = '';

  // Toast
  toastMessage = '';
  toastType: 'success' | 'error' = 'success';

  constructor(
    private queryService: QueryService,
    private dss: DataSourceSelectionService,
    private confirmService: ConfirmService
  ) {}

  /** Seçili DB id'si (query filtresi için). */
  scopedDataSourceId: string | null = null;
  private dssSub?: Subscription;

  ngOnInit(): void {
    this.dss.load();
    this.loadQueries();
    this.loadPythonScripts();

    this.dssSub = this.dss.selectedId$.subscribe(id => {
      this.scopedDataSourceId = id;
    });
  }

  ngOnDestroy(): void {
    this.dssSub?.unsubscribe();
  }

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: res => { this.queries = res.data || []; },
      error: () => { /* sessiz */ }
    });
  }

  loadPythonScripts(): void {
    this.queryService.listPythonScripts().subscribe({
      next: res => { this.pythonScripts = res.data || []; },
      error: () => { /* sessiz */ }
    });
  }

  setSidebarTab(tab: 'queries' | 'scripts'): void {
    this.activeSidebarTab = tab;
  }

  get filteredQueries(): SavedQuery[] {
    let list = this.queries;
    // DB scope: seçili DB varsa sadece o DB'nin sorgularını göster.
    if (this.scopedDataSourceId) {
      list = list.filter(q => q.dataSourceId === this.scopedDataSourceId);
    }
    const t = this.searchTerm.trim().toLowerCase();
    if (!t) return list;
    return list.filter(q => q.name.toLowerCase().includes(t));
  }

  get filteredScripts(): SavedPythonScript[] {
    const t = this.searchTermScripts.trim().toLowerCase();
    if (!t) return this.pythonScripts;
    return this.pythonScripts.filter(s => s.name.toLowerCase().includes(t));
  }

  toggleQuery(id: string): void {
    const i = this.selectedSqlQueries.indexOf(id);
    if (i >= 0) {
      this.selectedSqlQueries.splice(i, 1);
    } else {
      this.selectedSqlQueries.push(id);
    }
  }

  startNewScript(): void {
    this.activeScriptId = null;
    this.scriptName = '';
    this.scriptDescription = '';
    this.code = `# Secure Python sandbox — runs in an isolated process (read-only, no file/network access).
# Available variables: sql_data (dict), queries, filters, json, math, datetime
# Output: out('name').append({'column': value})
`;
    this.selectedSqlQueries = [];
    this.allowedRoles = '';
    this.allowedUsers = '';
    this.errorMessage = '';
    this.results = [];
  }

  loadScript(script: SavedPythonScript): void {
    this.activeScriptId = script.id;
    this.scriptName = script.name;
    this.scriptDescription = script.description || '';
    this.code = script.code;
    this.selectedSqlQueries = script.sqlQueryIds || [];
    this.allowedRoles = (script.allowedRoles || []).join(', ');
    this.allowedUsers = (script.allowedUsers || []).join(', ');
    this.errorMessage = '';
    this.results = [];
  }

  openSaveModal(): void {
    if (!this.code.trim()) {
      this.showToast('Please write Python code.', 'error');
      return;
    }
    this.showSaveModal = true;
  }

  closeSaveModal(): void {
    this.showSaveModal = false;
  }

  saveScript(): void {
    if (!this.scriptName.trim()) {
      this.showToast('Please specify a script name.', 'error');
      return;
    }

    const payload: Partial<SavedPythonScript> = {
      name: this.scriptName.trim(),
      description: this.scriptDescription.trim(),
      code: this.code,
      sqlQueryIds: this.selectedSqlQueries,
      allowedRoles: this.allowedRoles.split(',').map(s => s.trim()).filter(s => s),
      allowedUsers: this.allowedUsers.split(',').map(s => s.trim()).filter(s => s)
    };

    if (this.activeScriptId) {
      this.queryService.updatePythonScript(this.activeScriptId, payload).subscribe({
        next: (res) => {
          this.showToast('Script updated successfully.', 'success');
          this.closeSaveModal();
          this.loadPythonScripts();
        },
        error: (err) => {
          this.showToast(err.error?.error || 'Script could not be updated.', 'error');
        }
      });
    } else {
      this.queryService.createPythonScript(payload).subscribe({
        next: (res) => {
          this.showToast('Script saved successfully.', 'success');
          this.activeScriptId = res.data.id;
          this.closeSaveModal();
          this.loadPythonScripts();
        },
        error: (err) => {
          this.showToast(err.error?.error || 'Script could not be saved.', 'error');
        }
      });
    }
  }

  async deleteScript(script: SavedPythonScript, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!await this.confirmService.confirm(`Are you sure you want to delete script "${script.name}"?`)) {
      return;
    }
    this.queryService.removePythonScript(script.id).subscribe({
      next: () => {
        this.showToast('Script deleted.', 'success');
        if (this.activeScriptId === script.id) {
          this.startNewScript();
        }
        this.loadPythonScripts();
      },
      error: (err) => {
        this.showToast(err.error?.error || 'Could not delete script.', 'error');
      }
    });
  }

  showToast(msg: string, type: 'success' | 'error' = 'success'): void {
    this.toastMessage = msg;
    this.toastType = type;
    setTimeout(() => {
      this.toastMessage = '';
    }, 3000);
  }

  run(): void {
    if (!this.code.trim()) {
      this.errorMessage = 'Please write Python code first.';
      return;
    }
    this.executing = true;
    this.errorMessage = '';
    this.results = [];

    this.queryService.runPython(this.code, this.selectedSqlQueries, {}).subscribe({
      next: res => {
        this.executing = false;
        if (res.success && res.data) {
          this.results = Object.entries(res.data).map(([name, data]) => ({ name, data }));
          if (!this.results.length) {
            this.errorMessage = "No output. Use out('name').append({...}) in your script for results.";
          }
        } else {
          this.errorMessage = res.error || 'Execution error.';
        }
      },
      error: err => {
        this.executing = false;
        this.errorMessage = err.error?.error || err.message || 'Server error.';
      }
    });
  }
}
