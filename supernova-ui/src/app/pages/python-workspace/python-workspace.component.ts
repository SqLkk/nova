import { ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription, firstValueFrom } from 'rxjs';
import { QueryService } from '../../services/query.service';
import {
  SavedQuery,
  QueryResult,
  SavedPythonScript,
  SharingRoleOption,
  SharingUserOption,
} from '../../models/query.model';
import { DataSourceSelectionService } from '../../services/data-source-selection.service';
import { ConfirmService } from '../../services/confirm.service';
import { AiContextService } from '../../services/ai-context.service';
import { AiCoworkerService } from '../../services/ai-coworker.service';

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
  activeSidebarTab: 'queries' | 'scripts' = 'scripts';

  /** Kayıtlı SQL sorguları — seçilenler sql_data olarak inject edilir. */
  queries: SavedQuery[] = [];
  selectedSqlQueries: string[] = [];
  inspectedQuery: SavedQuery | null = null;
  filterQueriesByScopedDb = false;
  searchTerm = '';

  /** Kayıtlı Python script'leri. */
  pythonScripts: SavedPythonScript[] = [];
  activeScriptId: string | null = null;
  searchTermScripts = '';

  /** Editör içeriği. */
  code = `# Güvenli Python Sandbox — İzole süreçte çalışır (salt-okunur, dosya/ağ erişimi kapalı).
# Kullanılabilir değişkenler: sql_data (dict), queries, filters, json, math, datetime
# Çıktı üretmek için: out('veri_seti_adi', liste) veya out('veri_seti_adi').append({'kolon': deger})

rows = sql_data.get('q_ind_production_oee', [])
summary = []
for r in rows[:20]:
    summary.append({
        'batch_id': r.get('batch_id'),
        'line_id': r.get('line_id'),
        'produced_qty': r.get('produced_qty', 0),
        'oee_percentage': r.get('oee_percentage', 0)
    })

out('summary', summary)
`;

  executing = false;
  errorMessage = '';
  results: ResultDataset[] = [];
  searchTermResult = '';

  // Save & Sharing Modal state
  showSaveModal = false;
  scriptName = '';
  scriptDescription = '';
  allowedRoles = '';
  allowedUsers = '';
  selectedRoleKeys: string[] = ['admin', 'superuser', 'engineer', 'operator', 'viewer'];
  selectedUsernames: string[] = [];
  availableRoles: SharingRoleOption[] = [
    { id: 'r_super', key: 'superuser', name: 'Superuser' },
    { id: 'r_admin', key: 'admin', name: 'Admin' },
    { id: 'r_engineer', key: 'engineer', name: 'Engineer' },
    { id: 'r_operator', key: 'operator', name: 'Operator' },
    { id: 'r_viewer', key: 'viewer', name: 'Viewer' },
  ];
  availableUsers: SharingUserOption[] = [];

  // Toast
  toastMessage = '';
  toastType: 'success' | 'error' = 'success';

  constructor(
    private queryService: QueryService,
    private dss: DataSourceSelectionService,
    private confirmService: ConfirmService,
    private aiContext: AiContextService,
    private aiCoworker: AiCoworkerService,
    private cdr: ChangeDetectorRef,
  ) {}

  /** Seçili DB id'si (query filtresi için). */
  scopedDataSourceId: string | null = null;
  private dssSub?: Subscription;
  private releaseAi?: () => void;
  private releaseCoworker?: () => void;

  ngOnInit(): void {
    this.releaseAi = this.aiContext.register('python-workspace', {
      context: () => ({
        current_code: this.code.slice(0, 24000),
        active_queries: this.queries.filter(q => this.selectedSqlQueries.includes(q.id)).map(q => ({ id: q.id, name: q.name, columns: q.columns })),
        data_source_id: this.scopedDataSourceId || undefined,
      }),
      accepts: language => language === 'python',
      apply: (_language, content) => { this.code = content; this.errorMessage = ''; this.results = []; this.cdr.markForCheck(); },
    });
    this.releaseCoworker = this.aiCoworker.registerPythonWorkspace({
      prepareScript: (name, queryIds) => {
        this.activeScriptId = null;
        this.scriptName = name;
        this.activeSidebarTab = 'queries';
        if (queryIds?.length) this.selectedSqlQueries = [...queryIds];
        this.errorMessage = '';
        this.results = [];
        this.cdr.markForCheck();
      },
      setCodeText: (code) => {
        this.code = code;
        // Auto-select referenced saved queries so sql_data is populated when running
        const matches = Array.from(code.matchAll(/sql_data\.get\(\s*['"]([^'"]+)['"]/g));
        for (const m of matches) {
          const ref = m[1];
          const found = this.queries.find(q => q.id === ref || q.name === ref);
          if (found && !this.selectedSqlQueries.includes(found.id)) {
            this.selectedSqlQueries.push(found.id);
          }
        }
        this.cdr.markForCheck();
      },
      runLiveSandbox: async () => {
        this.executing = true;
        this.errorMessage = '';
        this.results = [];
        this.cdr.markForCheck();
        try {
          const qRes = await firstValueFrom(this.queryService.list());
          this.queries = qRes?.data || this.queries;
          const matches = Array.from(this.code.matchAll(/sql_data\.get\(\s*['"]([^'"]+)['"]/g));
          for (const m of matches) {
            const ref = m[1];
            const found = this.queries.find(q => q.id === ref || q.name === ref);
            if (found && !this.selectedSqlQueries.includes(found.id)) {
              this.selectedSqlQueries.push(found.id);
            }
          }
          const res = await firstValueFrom(this.queryService.runPython(this.code, this.selectedSqlQueries, {}));
          if (res?.success && res.data) {
            this.results = Object.entries(res.data).map(([name, data]) => ({ name, data }));
          }
        } finally {
          this.executing = false;
          this.cdr.markForCheck();
        }
      },
    });
    this.dss.load();
    this.loadQueries();
    this.loadPythonScripts();
    this.loadSharingOptions();

    this.dssSub = this.dss.selectedId$.subscribe(id => {
      this.scopedDataSourceId = id;
    });
  }

  ngOnDestroy(): void {
    this.releaseAi?.();
    this.releaseCoworker?.();
    this.dssSub?.unsubscribe();
  }

  loadSharingOptions(): void {
    this.queryService.getSharingOptions().subscribe({
      next: res => {
        if (res?.data?.roles?.length) {
          this.availableRoles = res.data.roles;
        }
        if (res?.data?.users?.length) {
          this.availableUsers = res.data.users;
        }
      },
      error: () => {}
    });
  }

  loadQueries(): void {
    this.queryService.list().subscribe({
      next: res => { this.queries = res.data || []; },
      error: () => { /* sessiz */ }
    });
  }

  loadPythonScripts(): void {
    this.queryService.listPythonScripts().subscribe({
      next: res => {
        this.pythonScripts = res.data || [];
        if (this.pythonScripts.length > 0 && !this.activeScriptId) {
          this.loadScript(this.pythonScripts[0]);
        }
      },
      error: () => { /* sessiz */ }
    });
  }

  setSidebarTab(tab: 'queries' | 'scripts'): void {
    this.activeSidebarTab = tab;
  }

  get filteredQueries(): SavedQuery[] {
    let list = this.queries;
    if (this.filterQueriesByScopedDb && this.scopedDataSourceId) {
      list = list.filter(q => q.dataSourceId === this.scopedDataSourceId || this.selectedSqlQueries.includes(q.id));
    }
    const t = this.searchTerm.trim().toLowerCase();
    if (!t) return list;
    return list.filter(q =>
      q.name.toLowerCase().includes(t) ||
      (q.description || '').toLowerCase().includes(t) ||
      q.id.toLowerCase().includes(t)
    );
  }

  get filteredScripts(): SavedPythonScript[] {
    const t = this.searchTermScripts.trim().toLowerCase();
    if (!t) return this.pythonScripts;
    return this.pythonScripts.filter(s =>
      s.name.toLowerCase().includes(t) ||
      (s.description || '').toLowerCase().includes(t) ||
      s.id.toLowerCase().includes(t)
    );
  }

  toggleQuery(id: string): void {
    const i = this.selectedSqlQueries.indexOf(id);
    if (i >= 0) {
      this.selectedSqlQueries.splice(i, 1);
    } else {
      this.selectedSqlQueries.push(id);
    }
  }

  inspectQuery(q: SavedQuery, event?: Event): void {
    if (event) event.stopPropagation();
    this.inspectedQuery = this.inspectedQuery?.id === q.id ? null : q;
  }

  insertQuerySnippet(q: SavedQuery, event?: Event): void {
    if (event) event.stopPropagation();
    if (!this.selectedSqlQueries.includes(q.id)) {
      this.selectedSqlQueries.push(q.id);
    }
    const snippet = `\n# ${q.name} (${q.id})\nrows_${q.id.replace(/[^a-zA-Z0-9_]/g, '_')} = sql_data.get('${q.id}', [])\n`;
    this.code = (this.code || '') + snippet;
    this.showToast(`"${q.name}" sorgusu seçildi ve koda eklendi.`, 'success');
  }

  startNewScript(): void {
    this.activeScriptId = null;
    this.scriptName = '';
    this.scriptDescription = '';
    this.code = `# Güvenli Python Sandbox — İzole süreçte çalışır (salt-okunur, dosya/ağ erişimi kapalı).
# Kullanılabilir değişkenler: sql_data (dict), queries, filters, json, math, datetime
# Çıktı üretmek için: out('veri_seti_adi', liste) veya out('veri_seti_adi').append({'kolon': deger})
`;
    this.selectedSqlQueries = [];
    this.selectedRoleKeys = ['admin', 'superuser', 'engineer', 'operator', 'viewer'];
    this.selectedUsernames = [];
    this.allowedRoles = this.selectedRoleKeys.join(', ');
    this.allowedUsers = '';
    this.errorMessage = '';
    this.results = [];
  }

  loadScript(script: SavedPythonScript): void {
    this.activeScriptId = script.id;
    this.scriptName = script.name;
    this.scriptDescription = script.description || '';
    this.code = script.code;
    this.selectedSqlQueries = [...(script.sqlQueryIds || [])];
    this.selectedRoleKeys = (script.allowedRoles && script.allowedRoles.length)
      ? [...script.allowedRoles]
      : ['admin', 'superuser', 'engineer', 'operator', 'viewer'];
    this.selectedUsernames = [...(script.allowedUsers || [])];
    this.allowedRoles = this.selectedRoleKeys.join(', ');
    this.allowedUsers = this.selectedUsernames.join(', ');
    this.errorMessage = '';
    this.results = [];
    if (this.code && this.code.trim()) {
      this.run();
    }
  }

  toggleRole(roleKey: string): void {
    const idx = this.selectedRoleKeys.indexOf(roleKey);
    if (idx >= 0) {
      this.selectedRoleKeys.splice(idx, 1);
    } else {
      this.selectedRoleKeys.push(roleKey);
    }
    this.allowedRoles = this.selectedRoleKeys.join(', ');
  }

  isRoleSelected(roleKey: string): boolean {
    return this.selectedRoleKeys.includes(roleKey);
  }

  selectAllRoles(): void {
    this.selectedRoleKeys = this.availableRoles.map(r => r.key);
    this.allowedRoles = this.selectedRoleKeys.join(', ');
  }

  toggleUser(username: string): void {
    const idx = this.selectedUsernames.indexOf(username);
    if (idx >= 0) {
      this.selectedUsernames.splice(idx, 1);
    } else {
      this.selectedUsernames.push(username);
    }
    this.allowedUsers = this.selectedUsernames.join(', ');
  }

  isUserSelected(username: string): boolean {
    return this.selectedUsernames.includes(username);
  }

  openSaveModal(): void {
    if (!this.code.trim()) {
      this.showToast('Lütfen önce Python kodu yazın.', 'error');
      return;
    }
    this.showSaveModal = true;
  }

  closeSaveModal(): void {
    this.showSaveModal = false;
  }

  saveScript(): void {
    if (!this.scriptName.trim()) {
      this.showToast('Lütfen bir script adı girin.', 'error');
      return;
    }

    const payload: Partial<SavedPythonScript> = {
      name: this.scriptName.trim(),
      description: this.scriptDescription.trim(),
      code: this.code,
      sqlQueryIds: this.selectedSqlQueries,
      allowedRoles: this.selectedRoleKeys.length ? this.selectedRoleKeys : ['admin', 'superuser', 'engineer', 'operator', 'viewer'],
      allowedUsers: this.selectedUsernames
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
