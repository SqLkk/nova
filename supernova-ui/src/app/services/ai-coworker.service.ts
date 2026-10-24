import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { AiReportProposal, AiReportSummaryItem, AiService } from './ai.service';
import { PathService } from './path.service';

export interface CoworkerStepLog {
  id: string;
  pageBadge: string;
  label: string;
  detail?: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface CoworkerSpotlight {
  visible: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CoworkerVisualState {
  active: boolean;
  workflowTitle: string;
  stepLabel: string;
  stepIndex: number;
  totalSteps: number;
  cursorVisible: boolean;
  cursorX: number;
  cursorY: number;
  cursorTag: string;
  clicking: boolean;
  spotlight: CoworkerSpotlight;
}

export interface QueryStudioLiveController {
  prepareLiveQuery: (dataSourceId: string, name: string, description?: string) => void;
  setSqlText: (sql: string) => void;
  executeLiveQuery: () => Promise<{ rowCount: number; executionMs: number }>;
}

export interface TemplateLiveController {
  initLiveSheet: (reportName: string, queryId: string, totalCols: number, totalRows: number) => Promise<void>;
  writeBannerStep: (reportName: string, subtitle: string, tableWidth: number) => void;
  writeSummaryStep: (colIdx: number, rowStart: number, queryId: string, item: AiReportSummaryItem) => void;
  writeDetailTableStep: (headerRow: number, selectedCols: string[], numericCols: string[], queryId: string) => void;
  placeChartStep: (
    type: 'bar' | 'line' | 'pie',
    title: string,
    queryId: string,
    xAxis: string,
    yAxis: string[],
    anchorRow: number,
    anchorCol: number,
  ) => void;
  finalizeAndRunLivePreview: (templateId?: string) => Promise<void>;
}

export interface PythonLiveController {
  prepareScript: (name: string, queryIds: string[]) => void;
  setCodeText: (code: string) => void;
  runLiveSandbox: () => Promise<void>;
}

const INITIAL_VISUAL_STATE: CoworkerVisualState = {
  active: false,
  workflowTitle: '',
  stepLabel: '',
  stepIndex: 0,
  totalSteps: 0,
  cursorVisible: false,
  cursorX: 340,
  cursorY: 220,
  cursorTag: 'Copilot',
  clicking: false,
  spotlight: { visible: false, top: 0, left: 0, width: 0, height: 0 },
};

@Injectable({ providedIn: 'root' })
export class AiCoworkerService {
  readonly state$ = new BehaviorSubject<CoworkerVisualState>({ ...INITIAL_VISUAL_STATE });

  private queryCtrl?: QueryStudioLiveController;
  private templateCtrl?: TemplateLiveController;
  private pythonCtrl?: PythonLiveController;
  private abortCtrl?: AbortController;

  constructor(
    private router: Router,
    private ai: AiService,
    private paths: PathService,
  ) {}

  get isRunning(): boolean {
    return this.state$.value.active;
  }

  registerQueryStudio(ctrl: QueryStudioLiveController): () => void {
    this.queryCtrl = ctrl;
    return () => {
      if (this.queryCtrl === ctrl) this.queryCtrl = undefined;
    };
  }

  registerTemplateBuilder(ctrl: TemplateLiveController): () => void {
    this.templateCtrl = ctrl;
    return () => {
      if (this.templateCtrl === ctrl) this.templateCtrl = undefined;
    };
  }

  registerPythonWorkspace(ctrl: PythonLiveController): () => void {
    this.pythonCtrl = ctrl;
    return () => {
      if (this.pythonCtrl === ctrl) this.pythonCtrl = undefined;
    };
  }

  stop(): void {
    if (this.abortCtrl) {
      this.abortCtrl.abort();
      this.abortCtrl = undefined;
    }
    this.state$.next({ ...INITIAL_VISUAL_STATE });
  }

  // ---------------------------------------------------------------------------
  // 1. FULL HUMAN-LIKE REPORT WORKFLOW (SQL Studio -> Template Builder -> Live)
  // ---------------------------------------------------------------------------
  async runReportWorkflow(
    proposal: AiReportProposal,
    onStepUpdate?: (steps: CoworkerStepLog[]) => void,
    options?: { skipSqlStudio?: boolean },
  ): Promise<void> {
    this.stop();
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    const sig = ctrl.signal;

    const showSql = !options?.skipSqlStudio && !!proposal.sql?.trim();
    const steps: CoworkerStepLog[] = [
      ...(showSql
        ? [{
            id: 'sql_verify',
            pageBadge: 'SQL STUDIO',
            label: 'SQL Studio açılıyor, sorgu yazılıp veritabanında test ediliyor',
            detail: proposal.queryName || proposal.queryId,
            status: 'pending' as const,
          }]
        : []),
      {
        id: 'nav_tb',
        pageBadge: 'SAYFA GEÇİŞİ',
        label: 'Sorgu tamamlandı — Template Builder ekranına geçiyorum',
        detail: proposal.reportName,
        status: 'pending',
      },
      {
        id: 'tb_banner_kpi',
        pageBadge: 'TEMPLATE BUILDER',
        label: 'Başlık bandı ve özet KPI formülleri hücrelere canlı ekleniyor',
        detail: `${(proposal.summaries || []).filter(s => s.checked).length} adet KPI formülü`,
        status: 'pending',
      },
      {
        id: 'tb_table_chart',
        pageBadge: 'TEMPLATE BUILDER',
        label: 'Veritabanı detay tablosu (#EACH) ve grafik şablona yerleştiriliyor',
        detail: `${proposal.selectedColumns?.length || proposal.columns?.length || 0} kolon · ${proposal.chart?.include ? proposal.chart.type.toUpperCase() + ' Grafik' : 'Tablo'}`,
        status: 'pending',
      },
      {
        id: 'tb_live_exec',
        pageBadge: 'CANLI ÇALIŞTIRMA',
        label: 'Şablon bitti — Canlı Çalıştır & Önizle ile veriler rapora çekiliyor',
        detail: `${proposal.rowCount} satır canlı veri`,
        status: 'pending',
      },
    ];

    const emitSteps = () => onStepUpdate?.(steps.map(s => ({ ...s })));
    const markStep = (id: string, status: CoworkerStepLog['status'], detail?: string) => {
      const idx = steps.findIndex(s => s.id === id);
      if (idx >= 0) {
        steps[idx].status = status;
        if (detail) steps[idx].detail = detail;
        this.patchState({
          stepIndex: idx + 1,
          totalSteps: steps.length,
          stepLabel: steps[idx].label,
        });
      }
      emitSteps();
    };

    try {
      this.patchState({
        active: true,
        workflowTitle: `Canlı Kurulum: ${proposal.reportName}`,
        stepLabel: 'Ekran otomasyonu başlatılıyor…',
        stepIndex: 1,
        totalSteps: steps.length,
        cursorVisible: true,
        cursorTag: 'Copilot Çalışıyor',
      });
      emitSteps();

      // ── STAGE 1: SQL STUDIO (Write & Run Live SQL) ──
      if (showSql) {
        markStep('sql_verify', 'running');
        await this.moveToElement('.nav-group, a.nav-item[href*="/table-explorer"]', 'SQL Studio açılıyor', true, 260, sig);
        await this.router.navigate(['/query-creator']);
        const qCtrl = await this.waitFor(() => this.queryCtrl, 4000, sig);
        if (qCtrl) {
          qCtrl.prepareLiveQuery(
            proposal.dataSourceId || 'ds_apex_factory',
            proposal.queryName || `[Copilot] ${proposal.reportName}`,
            `${proposal.reportName} için canlı rapor sorgusu`,
          );
          await this.sleep(160, sig);
          await this.moveToElement('.sql-textarea', 'SQL sorgusu yazılıyor', false, 180, sig);
          await this.streamTextChunks(proposal.sql, 4, 95, sig, partial => qCtrl.setSqlText(partial));
          await this.moveToElement('.editor-header .btn-secondary', 'Sorgu çalıştırılıyor', true, 220, sig);
          const execInfo = await qCtrl.executeLiveQuery();
          await this.moveToElement('.results-panel', `${execInfo.rowCount} satır doğrulandı`, false, 520, sig);
          markStep('sql_verify', 'done', `${execInfo.rowCount} satır · ${execInfo.executionMs} ms`);
        } else {
          markStep('sql_verify', 'done');
        }
      }

      // ── STAGE 2: NAVIGATE TO TEMPLATE BUILDER ──
      markStep('nav_tb', 'running');
      await this.moveToElement('a.nav-item[href*="/template-builder"]', 'Sorgu bitti · Template Builder\'a geçiyorum', true, 340, sig);
      await this.router.navigate(['/template-builder']);
      const tbCtrl = await this.waitFor(() => this.templateCtrl, 4500, sig);
      if (!tbCtrl) throw new Error('Template Builder ekranına erişilemedi.');

      const cols = proposal.columns || [];
      const selectedCols = (proposal.selectedColumns?.length ? proposal.selectedColumns : cols.slice(0, 8)).filter(c => cols.includes(c));
      const finalCols = selectedCols.length ? selectedCols : cols.slice(0, 8);
      const activeSummaries = (proposal.summaries || []).filter(s => s.checked && cols.includes(s.field));
      const tableWidth = Math.max(finalCols.length, activeSummaries.length, 4);
      const totalCols = Math.max(tableWidth + 9, 16);

      await tbCtrl.initLiveSheet(proposal.reportName, proposal.queryId, totalCols, 45);
      await this.sleep(220, sig);
      await this.moveToElement('.tb-name', 'Şablon adı tanımlanıyor', true, 220, sig);
      markStep('nav_tb', 'done', `${proposal.reportName} sayfası hazır`);

      // ── STAGE 3: WRITE BANNER & KPI SUMMARY CARDS CELL-BY-CELL ──
      markStep('tb_banner_kpi', 'running');
      await this.moveToElement('td.tb-cell[data-cell="1,1"]', 'Başlık bandı yazılıyor (A1)', true, 240, sig);
      tbCtrl.writeBannerStep(
        proposal.reportName,
        `Kaynak: ${proposal.dataSourceName} · Sorgu: ${proposal.queryName} · Canlı Çalıştırma: {{report_datetime}}`,
        tableWidth,
      );
      await this.sleep(220, sig);

      let currentRow = 4;
      if (activeSummaries.length > 0) {
        const capped = activeSummaries.slice(0, 8);
        for (let i = 0; i < capped.length; i++) {
          const colIdx = i + 1;
          const item = capped[i];
          await this.moveToElement(
            `td.tb-cell[data-cell="${currentRow},${colIdx}"], .tb-grid`,
            `KPI ekleniyor: ${item.operation}(${item.field})`,
            true,
            150,
            sig,
          );
          tbCtrl.writeSummaryStep(colIdx, currentRow, proposal.queryId, item);
        }
        currentRow += 3;
      }
      markStep('tb_banner_kpi', 'done', `${activeSummaries.length} özet KPI hücresi bağlandı`);

      // ── STAGE 4: DETAIL BAND TABLE & LIVE CHART ──
      markStep('tb_table_chart', 'running');
      const numericCols = this.inferNumericCols(proposal);
      if (proposal.includeDetailTable !== false && finalCols.length > 0) {
        await this.moveToElement(
          `td.tb-cell[data-cell="${currentRow},1"], .tb-grid`,
          `Detay tablosu kuruluyor (${finalCols.length} kolon)`,
          true,
          260,
          sig,
        );
        tbCtrl.writeDetailTableStep(currentRow, finalCols, numericCols, proposal.queryId);
        await this.sleep(260, sig);
      }

      if (proposal.chart?.include) {
        const chartCol = (proposal.includeDetailTable !== false && finalCols.length > 0) ? finalCols.length + 2 : 1;
        const chartRow = (proposal.includeDetailTable !== false && finalCols.length > 0) ? 4 : currentRow;
        await this.moveToElement(
          `td.tb-cell[data-cell="${chartRow},${Math.min(chartCol, 8)}"], .tb-grid`,
          `${proposal.chart.type.toUpperCase()} grafiği ekleniyor`,
          true,
          260,
          sig,
        );
        tbCtrl.placeChartStep(
          proposal.chart.type || 'bar',
          proposal.chart.title || proposal.reportName,
          proposal.queryId,
          proposal.chart.xAxis || finalCols[0] || cols[0] || '',
          proposal.chart.yAxis?.length ? proposal.chart.yAxis : [cols[cols.length - 1] || ''],
          chartRow,
          chartCol,
        );
        await this.sleep(240, sig);
      }
      markStep('tb_table_chart', 'done', 'Tablo ve grafik şablona işlendi');

      // ── STAGE 5: SAVE TO DB & TRIGGER LIVE EXECUTION PREVIEW ──
      markStep('tb_live_exec', 'running');
      const built = await this.ai.buildReport(proposal);
      proposal.templateId = built.templateId;
      proposal.reportName = built.name;

      await this.moveToElement(
        '[data-coworker="tb-live-preview"]',
        'Canlı Çalıştır & Önizle tıklanıyor',
        true,
        300,
        sig,
      );
      await tbCtrl.finalizeAndRunLivePreview(built.templateId);
      await this.sleep(450, sig);
      markStep('tb_live_exec', 'done', `Canlı rapor hazır (${built.rowCount} satır)`);
    } catch (err: any) {
      if (!sig.aborted) {
        const running = steps.find(s => s.status === 'running');
        if (running) running.status = 'error';
        emitSteps();
      }
      throw err;
    } finally {
      if (this.abortCtrl === ctrl) {
        this.abortCtrl = undefined;
        this.state$.next({ ...INITIAL_VISUAL_STATE });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. LIVE SQL STUDIO WORKFLOW
  // ---------------------------------------------------------------------------
  async runSqlWorkflow(
    sql: string,
    dataSourceId = 'ds_apex_factory',
    queryName = '[Copilot] Canlı SQL Sorgusu',
    onStepUpdate?: (steps: CoworkerStepLog[]) => void,
  ): Promise<void> {
    this.stop();
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    const sig = ctrl.signal;

    const steps: CoworkerStepLog[] = [
      { id: 'nav_sql', pageBadge: 'GEÇİŞ', label: 'SQL Studio ekranına geçiliyor', status: 'running' },
      { id: 'write_sql', pageBadge: 'SQL STUDIO', label: 'SQL sorgusu editöre yazılıyor', status: 'pending' },
      { id: 'exec_sql', pageBadge: 'CANLI SORGU', label: 'Sorgu veritabanında çalıştırılıyor', status: 'pending' },
    ];
    const emit = () => onStepUpdate?.(steps.map(s => ({ ...s })));

    try {
      this.patchState({
        active: true,
        workflowTitle: 'SQL Studio Canlı Çalışma',
        stepLabel: steps[0].label,
        stepIndex: 1,
        totalSteps: 3,
        cursorVisible: true,
        cursorTag: 'SQL Yazılıyor',
      });
      emit();

      await this.moveToElement('.nav-group, a.nav-item[href*="/table-explorer"]', 'SQL Studio\'ya geçiliyor', true, 240, sig);
      await this.router.navigate(['/query-creator']);
      const qCtrl = await this.waitFor(() => this.queryCtrl, 4000, sig);
      steps[0].status = 'done';

      steps[1].status = 'running';
      this.patchState({ stepIndex: 2, stepLabel: steps[1].label });
      emit();

      if (qCtrl) {
        qCtrl.prepareLiveQuery(dataSourceId, queryName, 'Copilot tarafından canlı oluşturuldu');
        await this.moveToElement('.sql-textarea', 'SQL kodu aktarılıyor', false, 180, sig);
        await this.streamTextChunks(sql, 5, 90, sig, partial => qCtrl.setSqlText(partial));
        steps[1].status = 'done';

        steps[2].status = 'running';
        this.patchState({ stepIndex: 3, stepLabel: steps[2].label, cursorTag: 'Çalıştırılıyor' });
        emit();

        await this.moveToElement('.editor-header .btn-secondary', 'Run Query tıklanıyor', true, 240, sig);
        const res = await qCtrl.executeLiveQuery();
        await this.moveToElement('.results-panel', `${res.rowCount} satır getirildi`, false, 450, sig);
        steps[2].status = 'done';
        steps[2].detail = `${res.rowCount} satır · ${res.executionMs} ms`;
        emit();
      }
    } finally {
      if (this.abortCtrl === ctrl) {
        this.abortCtrl = undefined;
        this.state$.next({ ...INITIAL_VISUAL_STATE });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. LIVE SPACE MAP WORKFLOW
  // ---------------------------------------------------------------------------
  async runSpaceMapWorkflow(
    pathJsonText: string,
    onStepUpdate?: (steps: CoworkerStepLog[]) => void,
  ): Promise<void> {
    this.stop();
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    const sig = ctrl.signal;

    const steps: CoworkerStepLog[] = [
      { id: 'save_path', pageBadge: 'PATH DEFINER', label: 'Topoloji tanımı kaydediliyor ve doğrulanıyor', status: 'running' },
      { id: 'nav_map', pageBadge: 'SPACE MAP', label: 'Space Map ekranına geçiliyor ve harita çiziliyor', status: 'pending' },
    ];
    const emit = () => onStepUpdate?.(steps.map(s => ({ ...s })));

    try {
      this.patchState({
        active: true,
        workflowTitle: 'Space Map Canlı Kurulum',
        stepLabel: steps[0].label,
        stepIndex: 1,
        totalSteps: 2,
        cursorVisible: true,
        cursorTag: 'Topoloji Kuruluyor',
      });
      emit();

      const parsed = JSON.parse(pathJsonText);
      const config = parsed.config || parsed;
      const payload = {
        name: parsed.name || `Copilot Space Map (${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})`,
        description: 'SuperNova Copilot canlı otomasyonu ile oluşturuldu.',
        queryId: parsed.queryId,
        structure: parsed.structure || 'multi_level',
        config,
      };
      const created = await firstValueFrom(this.paths.create(payload).pipe(timeout(15000)));
      const newId = created?.data?.id;
      steps[0].status = 'done';
      steps[0].detail = payload.name;

      steps[1].status = 'running';
      this.patchState({ stepIndex: 2, stepLabel: steps[1].label });
      emit();

      await this.moveToElement('a.nav-item[href*="/network-map"]', 'Space Map açılıyor', true, 280, sig);
      await this.router.navigate(['/network-map'], newId ? { queryParams: { pathId: newId } } : {});
      await this.sleep(550, sig);
      await this.moveToElement('.map-viewport, .network-map-page', 'Canlı topoloji hazır', false, 500, sig);
      steps[1].status = 'done';
      steps[1].detail = `${(parsed.structure || 'multi_level').toUpperCase()} görünümü aktif`;
      emit();
    } finally {
      if (this.abortCtrl === ctrl) {
        this.abortCtrl = undefined;
        this.state$.next({ ...INITIAL_VISUAL_STATE });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. LIVE PYTHON WORKSPACE WORKFLOW
  // ---------------------------------------------------------------------------
  async runPythonWorkflow(
    code: string,
    queryIds: string[],
    onStepUpdate?: (steps: CoworkerStepLog[]) => void,
  ): Promise<void> {
    this.stop();
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    const sig = ctrl.signal;

    const steps: CoworkerStepLog[] = [
      { id: 'nav_py', pageBadge: 'GEÇİŞ', label: 'Python Workspace ekranına geçiliyor', status: 'running' },
      { id: 'write_py', pageBadge: 'PYTHON SANDBOX', label: 'Veri dönüşüm scripti editöre yazılıyor', status: 'pending' },
      { id: 'exec_py', pageBadge: 'TEST & ÇIKTI', label: 'İzole Python sandbox çalıştırılıyor', status: 'pending' },
    ];
    const emit = () => onStepUpdate?.(steps.map(s => ({ ...s })));

    try {
      this.patchState({
        active: true,
        workflowTitle: 'Python Workspace Canlı Çalışma',
        stepLabel: steps[0].label,
        stepIndex: 1,
        totalSteps: 3,
        cursorVisible: true,
        cursorTag: 'Python Sandbox',
      });
      emit();

      await this.moveToElement('a.nav-item[href*="/python-workspace"]', 'Python Workspace açılıyor', true, 260, sig);
      await this.router.navigate(['/python-workspace']);
      const pyCtrl = await this.waitFor(() => this.pythonCtrl, 4000, sig);
      steps[0].status = 'done';

      steps[1].status = 'running';
      this.patchState({ stepIndex: 2, stepLabel: steps[1].label });
      emit();

      if (pyCtrl) {
        pyCtrl.prepareScript('[Copilot] Analiz Scripti', queryIds);
        await this.moveToElement('[data-coworker="py-code-editor"], textarea', 'Python kodu yazılıyor', false, 180, sig);
        await this.streamTextChunks(code, 5, 90, sig, partial => pyCtrl.setCodeText(partial));
        steps[1].status = 'done';

        steps[2].status = 'running';
        this.patchState({ stepIndex: 3, stepLabel: steps[2].label, cursorTag: 'Çalıştırılıyor' });
        emit();

        await this.moveToElement('[data-coworker="py-run-btn"], button', 'Sandbox çalıştırılıyor', true, 240, sig);
        await pyCtrl.runLiveSandbox();
        await this.sleep(400, sig);
        steps[2].status = 'done';
        steps[2].detail = 'Dataset çıktısı üretildi';
        emit();
      }
    } finally {
      if (this.abortCtrl === ctrl) {
        this.abortCtrl = undefined;
        this.state$.next({ ...INITIAL_VISUAL_STATE });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // INTERNAL ANIMATION & SYNCHRONIZATION HELPERS
  // ---------------------------------------------------------------------------

  private inferNumericCols(proposal: AiReportProposal): string[] {
    const nums = new Set<string>();
    for (const s of proposal.summaries || []) {
      if (s.operation !== 'COUNT') nums.add(s.field);
    }
    for (const r of proposal.previewRows || []) {
      for (const [k, v] of Object.entries(r || {})) {
        if (typeof v === 'number') nums.add(k);
      }
    }
    return Array.from(nums);
  }

  private patchState(partial: Partial<CoworkerVisualState>): void {
    this.state$.next({ ...this.state$.value, ...partial });
  }

  private async moveToElement(
    selector: string,
    tag: string,
    click: boolean,
    dwellMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const targetX = Math.min(window.innerWidth - 40, Math.max(24, rect.left + Math.min(rect.width * 0.45, 140)));
        const targetY = Math.min(window.innerHeight - 30, Math.max(24, rect.top + Math.min(rect.height * 0.5, 48)));
        this.patchState({
          cursorVisible: true,
          cursorX: Math.round(targetX),
          cursorY: Math.round(targetY),
          cursorTag: tag,
          clicking: false,
          spotlight: {
            visible: true,
            top: Math.round(rect.top - 4),
            left: Math.round(rect.left - 4),
            width: Math.round(rect.width + 8),
            height: Math.round(rect.height + 8),
          },
        });
        await this.sleep(Math.max(140, Math.round(dwellMs * 0.65)), signal);
        if (click) {
          this.patchState({ clicking: true });
          await this.sleep(130, signal);
          this.patchState({ clicking: false });
        }
        return;
      }
    }
    this.patchState({ cursorTag: tag });
    await this.sleep(Math.min(dwellMs, 180), signal);
  }

  private async streamTextChunks(
    fullText: string,
    chunks: number,
    delayMs: number,
    signal: AbortSignal,
    applyChunk: (partial: string) => void,
  ): Promise<void> {
    const lines = fullText.split('\n');
    if (lines.length <= 2) {
      applyChunk(fullText);
      await this.sleep(delayMs, signal);
      return;
    }
    const step = Math.max(1, Math.ceil(lines.length / chunks));
    for (let i = step; i < lines.length; i += step) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      applyChunk(lines.slice(0, i).join('\n'));
      await this.sleep(delayMs, signal);
    }
    applyChunk(fullText);
    await this.sleep(delayMs, signal);
  }

  private async waitFor<T>(
    getter: () => T | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const val = getter();
      if (val) return val;
      await this.sleep(60, signal);
    }
    return getter();
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
