import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { CdkDrag } from '@angular/cdk/drag-drop';
import { Subscription, firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import {
  AiService, AiHealth, AiReportProposal, AiReportSummaryItem,
  AiInteractiveDialog, AiDialogOption,
  AiChatSessionSummary, AiMemoryItem,
} from '../../services/ai.service';
import { AiContextService, AiContext, AiLanguage } from '../../services/ai-context.service';
import {
  AiCoworkerService, CoworkerStepLog, CoworkerVisualState,
} from '../../services/ai-coworker.service';
import { AuthService } from '../../services/auth.service';
import { QueryService } from '../../services/query.service';
import { PathService } from '../../services/path.service';
import { TemplateBuilderService } from '../../services/template-builder.service';

export interface RichInlineToken {
  kind: 'text' | 'bold' | 'code' | 'italic';
  value: string;
  bold?: boolean;
}

export interface RichTextBlock {
  kind: 'heading' | 'bullet' | 'paragraph';
  bulletPrefix?: string;
  tokens: RichInlineToken[];
}

interface MessagePart {
  kind: 'text' | 'code';
  text: string;
  blocks?: RichTextBlock[];
  language?: AiLanguage;
  complete?: boolean;
  isTemplateJson?: boolean;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  parts: MessagePart[];
  context: AiContext;
  timestamp: string;
  error?: string;
  interrupted?: boolean;
  reportProposal?: AiReportProposal;
  dialog?: AiInteractiveDialog;
  coworkerSteps?: CoworkerStepLog[];
  coworkerRunning?: boolean;
}

@Component({
  standalone: false,
  selector: 'app-ai-copilot',
  templateUrl: './ai-copilot.component.html',
  styleUrls: ['./ai-copilot.component.scss'],
})
export class AiCopilotComponent implements OnInit, OnDestroy {
  @Output() dockChange = new EventEmitter<boolean>();
  @Output() wideChange = new EventEmitter<boolean>();
  @ViewChild('composer') composer?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('conversation') conversation?: ElementRef<HTMLDivElement>;
  @ViewChild('launcher') launcher?: ElementRef<HTMLButtonElement>;
  @ViewChild(CdkDrag) drag?: CdkDrag;
  open = false;
  docked = false;
  wideMode = false;
  autoCoworker = true;
  coworkerState: CoworkerVisualState = {
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
  loggedIn = false;
  checking = false;
  sending = false;
  health: AiHealth = { available: false, reason: 'checking', optional: true };
  prompt = '';
  messages: ChatMessage[] = [];
  page = 'dashboard';
  notice = '';
  noticeError = false;
  offlineNotice = false;
  launcherHidden = false;
  toolLabel = '';
  actionBusy = false;
  preview: { columns: string[]; rows: Record<string, unknown>[]; title: string } | null = null;
  activeChatId = '';
  activeChatTitle = '';
  historyOpen = false;
  historyTab: 'chats' | 'memory' = 'chats';
  loadingHistory = false;
  savedSessions: AiChatSessionSummary[] = [];
  memories: AiMemoryItem[] = [];
  newMemoryNote = '';
  confirmClearChats = false;
  confirmClearMemory = false;
  private userStartedBlankChat = false;
  private controller?: AbortController;
  private subscriptions = new Subscription();
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private confirmTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private sequence = 0;
  private sessionId?: string;

  constructor(
    public context: AiContextService,
    public coworker: AiCoworkerService,
    private ai: AiService,
    private auth: AuthService,
    private queries: QueryService,
    private paths: PathService,
    private templateBuilder: TemplateBuilderService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  get pageLabel(): string { return this.context.labels[this.page] || 'SuperNova'; }
  get visible(): boolean { return this.loggedIn && this.page !== 'login' && !this.launcherHidden; }
  get queryCount(): number { return this.context.snapshot().active_queries?.length || 0; }
  get totalHistoryBadge(): number { return this.savedSessions.length + this.memories.length; }
  get statusText(): string {
    if (this.checking) return 'Bağlantı kontrol ediliyor';
    if (this.health.mock) return 'Geliştirme önizlemesi';
    if (this.health.available) return 'Yerel model hazır';
    return this.health.reason === 'disabled' ? 'Tak-çıkar modu' : 'Yerel AI çevrimdışı';
  }
  get suggestions(): Array<{ icon: string; title: string; detail: string; prompt: string }> {
    const options: Record<string, typeof defaults> = {
      'python-workspace': [
        { icon: 'fa-code', title: 'Scriptimi iyileştir', detail: 'Sandbox kurallarına uygun optimizasyon', prompt: 'Mevcut scriptimi incele ve sandbox kurallarına uygun şekilde optimize et.' },
        { icon: 'fa-table-columns', title: 'Tablo Seçici & JOIN Sihirbazı', detail: 'Hangi tablolarla çalışacağını seç', prompt: 'Veritabanındaki tablolarda kararsızım; hangi tabloları ve JOIN kombinasyonlarını kullanabileceğimi seçeneklerle sor.' },
      ],
      'query-creator': [
        { icon: 'fa-table-columns', title: 'Tablo Seçici & JOIN Sihirbazı', detail: 'Aday tabloları gör ve otomatik JOIN kur', prompt: 'Veritabanındaki tablolarda kararsızım; hangi tabloları ve JOIN kombinasyonlarını kullanabileceğimi seçeneklerle sor.' },
        { icon: 'fa-wand-magic-sparkles', title: 'SQL sorgumu iyileştir', detail: 'Daha açık ve verimli sorgular', prompt: 'Mevcut SQL sorgumu incele, iyileştir ve değişiklikleri kısaca açıkla.' },
      ],
      'template-builder': [
        { icon: 'fa-file-excel', title: 'Sensör Telemetri & Değer Raporu', detail: 'Veritabanından sorgula ve Excel şablonu kur', prompt: 'Bana veritabanındaki sensör ve telemetri tablolarını kullanıp bir ölçüm değer raporu oluşturur musun?' },
        { icon: 'fa-industry', title: 'Üretim Batch & OEE Raporu', detail: 'Grafik, özet KPI ve tablo ile tam şablon', prompt: 'Apex Smart Factory üretim batch ve OEE verilerini kullanarak bir Excel raporu oluştur.' },
        { icon: 'fa-table-columns', title: 'Tablo Karşılaştır & Seçerek Raporla', detail: 'Hangi tabloları birleştireceğini Copilot sorsun', prompt: 'Üretim, kalite ve arıza tabloları arasında kararsızım; uygun tabloları ve JOIN seçeneklerini bana sor.' },
      ],
      'network-map': [
        { icon: 'fa-sitemap', title: 'Çok Katmanlı Space Map kur', detail: 'Sorgu veya tablolardan hiyerarşi üret', prompt: 'Seçili sorguyu kullanarak Path Definer için multi_level veya tree yapılandırması üret.' },
        { icon: 'fa-table-columns', title: 'Tablo Seçerek Topoloji Oluştur', detail: 'Veritabanı tablolarını seç ve haritalandır', prompt: 'Space Map için hangi veritabanı tablolarını kullanabileceğimi seçeneklerle sor.' },
      ],
    };
    const defaults = [
      { icon: 'fa-industry', title: 'Üretim Batch & OEE Raporu oluştur', detail: 'Sorguyu hazırla ve Excel şablonunu kur', prompt: 'Bana Apex Smart Factory den üretim batch ve OEE raporu oluşturur musun?' },
      { icon: 'fa-file-excel', title: 'Sensör & Telemetri Değer Raporu', detail: 'Sensör noktaları ve ölçüm özet şablonu', prompt: 'Bana veritabanındaki sensör ve telemetri tablolarını kullanıp bir ölçüm değer raporu oluşturur musun?' },
      { icon: 'fa-table-columns', title: 'Tablo Seçici & JOIN Sihirbazı', detail: 'Kararsız kaldığın tabloları karşılaştır ve seç', prompt: 'Veritabanındaki tablolarda kararsızım; üretim, kalite, duruş ve sensör tablolarını karşılaştırıp hangi tabloları kullanmak istediğimi bana sor.' },
    ];
    return options[this.page] || defaults;
  }

  ngOnInit(): void {
    this.subscriptions.add(this.coworker.state$.subscribe(st => {
      this.coworkerState = st;
      this.cdr.markForCheck();
    }));
    this.subscriptions.add(this.context.page$.subscribe(page => {
      this.page = page;
      if (page === 'login') {
        this.stop();
        this.messages = [];
        this.preview = null;
        this.prompt = '';
        this.notice = '';
        this.activeChatId = '';
        this.activeChatTitle = '';
        this.savedSessions = [];
        this.memories = [];
        this.historyOpen = false;
        this.userStartedBlankChat = false;
        this.close();
      }
      this.cdr.markForCheck();
    }));
    this.subscriptions.add(this.auth.currentUser$.subscribe(user => {
      this.loggedIn = !!user;
      if (this.sessionId !== user?.id) {
        this.stop();
        this.messages = [];
        this.preview = null;
        this.activeChatId = '';
        this.activeChatTitle = '';
        this.savedSessions = [];
        this.memories = [];
        this.historyOpen = false;
        this.launcherHidden = false;
        this.userStartedBlankChat = false;
        this.sessionId = user?.id;
      }
      if (user) {
        void this.refreshHealth();
        void this.refreshHistory(false);
      } else {
        this.prompt = '';
        this.notice = '';
        this.close();
      }
      this.cdr.markForCheck();
    }));
    this.healthTimer = setInterval(() => {
      if (this.visible && !this.sending && this.health.reason !== 'disabled') {
        void this.refreshHealth();
      }
    }, 30000);
  }

  ngOnDestroy(): void {
    this.stop(); this.coworker.stop(); this.subscriptions.unsubscribe();
    clearInterval(this.healthTimer); clearTimeout(this.noticeTimer); clearTimeout(this.confirmTimer);
  }

  async refreshHealth(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try { this.health = await this.ai.checkHealth(); }
    finally { this.checking = false; this.cdr.markForCheck(); }
    if (this.health.available) this.offlineNotice = false;
  }

  toggle(): void {
    if (this.open) { this.close(); return; }
    if (!this.health.available) {
      this.offlineNotice = !this.offlineNotice;
      if (this.health.reason !== 'disabled') void this.refreshHealth();
      void this.refreshHistory(false);
      return;
    }
    this.open = true;
    this.offlineNotice = false;
    this.dockChange.emit(this.docked);
    this.wideChange.emit(this.wideMode);
    void this.refreshHistory(!this.messages.length && !this.userStartedBlankChat);
    setTimeout(() => this.composer?.nativeElement.focus());
  }

  openHistoryOffline(): void {
    this.offlineNotice = false;
    this.open = true;
    this.historyOpen = true;
    this.historyTab = 'chats';
    this.dockChange.emit(this.docked);
    this.wideChange.emit(this.wideMode);
    void this.refreshHistory(!this.messages.length && !this.userStartedBlankChat);
  }

  dismissLauncher(): void {
    this.launcherHidden = true;
    this.offlineNotice = false;
    this.close();
  }

  close(): void {
    this.stop(); this.coworker.stop(); this.open = false; this.offlineNotice = false;
    this.dockChange.emit(false);
    this.wideChange.emit(false);
    setTimeout(() => this.launcher?.nativeElement.focus());
  }

  toggleDock(): void {
    this.docked = !this.docked; this.drag?.reset();
    this.dockChange.emit(this.docked);
  }

  toggleWide(): void {
    this.wideMode = !this.wideMode;
    this.drag?.reset();
    this.wideChange.emit(this.wideMode);
  }

  toggleAutoCoworker(): void {
    this.autoCoworker = !this.autoCoworker;
    this.notify(
      this.autoCoworker
        ? 'Canlı Ekran (Co-Worker) modu açıldı: Copilot işlemleri ekranda adım adım uygulayacak.'
        : 'Canlı Ekran (Co-Worker) modu kapatıldı: Yanıtlar yalnızca sohbet içinde gösterilecek.'
    );
  }

  stopCoworker(): void {
    this.coworker.stop();
    for (const m of this.messages) m.coworkerRunning = false;
    this.notify('Canlı ekran otomasyonu durduruldu.');
  }

  private ensureDockedForLiveView(): void {
    if (!this.docked) {
      this.docked = true;
      this.drag?.reset();
      this.dockChange.emit(true);
    }
  }

  private nowTimeStr(): string {
    return new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  async copyMessage(message: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.content || '');
      this.notify('Yanıt panoya kopyalandı.');
    } catch {
      this.notify('Panoya erişilemedi.', true);
    }
  }

  @HostListener('document:keydown', ['$event']) onShortcut(event: KeyboardEvent): void {
    if (this.visible && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault(); this.toggle();
    }
    if (event.key === 'Escape') {
      if (this.coworkerState.active) { this.stopCoworker(); return; }
      if (this.open || this.offlineNotice) this.close();
    }
  }

  composerKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); }
  }

  useSuggestion(value: string): void { this.prompt = value; this.composer?.nativeElement.focus(); }

  newChat(): void {
    this.stop();
    this.coworker.stop();
    this.userStartedBlankChat = true;
    this.activeChatId = '';
    this.activeChatTitle = '';
    this.messages = [];
    this.preview = null;
    this.prompt = '';
    this.historyOpen = false;
  }

  toggleHistoryDrawer(tab?: 'chats' | 'memory'): void {
    if (tab) {
      if (this.historyOpen && this.historyTab === tab) {
        this.historyOpen = false;
        return;
      }
      this.historyTab = tab;
      this.historyOpen = true;
    } else {
      this.historyOpen = !this.historyOpen;
    }
    this.confirmClearChats = false;
    this.confirmClearMemory = false;
    if (this.historyOpen) {
      void this.refreshHistory(false);
    }
  }

  memoryCategoryIcon(category: string): string {
    switch (category) {
      case 'preference': return 'fa-sliders';
      case 'table': return 'fa-table';
      case 'report': return 'fa-file-excel';
      case 'query': return 'fa-database';
      default: return 'fa-brain';
    }
  }

  memoryCategoryLabel(category: string): string {
    switch (category) {
      case 'preference': return 'Tercih';
      case 'table': return 'Tablo';
      case 'report': return 'Rapor';
      case 'query': return 'Sorgu';
      default: return 'Hafıza';
    }
  }

  pageChipLabel(pageKey: string): string {
    return this.context.labels[pageKey] || pageKey || 'Workspace';
  }

  formatRelativeDate(raw: string): string {
    if (!raw) return '';
    const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
    const dt = new Date(normalized);
    if (Number.isNaN(dt.getTime())) return raw.slice(0, 16);
    const now = new Date();
    const sameDay = dt.toDateString() === now.toDateString();
    const hm = dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Bugün ${hm}`;
    return `${dt.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })} ${hm}`;
  }

  private shortTimeFromRaw(raw: string): string {
    if (!raw) return this.nowTimeStr();
    const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
    const dt = new Date(normalized);
    if (Number.isNaN(dt.getTime())) return raw.slice(11, 16) || this.nowTimeStr();
    return dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  async refreshHistory(autoRestoreLatest = false): Promise<void> {
    if (!this.loggedIn) return;
    this.loadingHistory = true;
    try {
      const overview = await this.ai.getHistory();
      this.savedSessions = overview.sessions || [];
      this.memories = overview.memories || [];
      if (autoRestoreLatest && !this.messages.length && !this.userStartedBlankChat && this.savedSessions.length > 0) {
        await this.loadChatSession(this.savedSessions[0].id, true);
      }
    } finally {
      this.loadingHistory = false;
      this.cdr.markForCheck();
    }
  }

  async loadChatSession(chatId: string, silent = false): Promise<void> {
    if (!chatId) return;
    this.stop();
    this.coworker.stop();
    const detail = await this.ai.getSession(chatId);
    if (!detail) {
      if (!silent) this.notify('Sohbet geçmişi yüklenemedi.', true);
      return;
    }
    const restored: ChatMessage[] = [];
    for (const item of detail.messages || []) {
      const role = item.role === 'user' ? 'user' : 'assistant';
      const content = item.content || '';
      const parts: MessagePart[] = role === 'user'
        ? [{ kind: 'text', text: content, blocks: this.tokenizeRichBlocks(content) }]
        : this.parse(content);
      restored.push({
        id: ++this.sequence,
        role,
        content,
        parts,
        context: { page: item.page || detail.session.lastPage || this.page },
        timestamp: this.shortTimeFromRaw(item.timestamp),
        reportProposal: item.reportProposal,
        dialog: item.dialog,
        coworkerSteps: item.coworkerSteps,
      });
    }
    this.messages = restored;
    this.activeChatId = detail.session.id;
    this.activeChatTitle = detail.session.title;
    this.userStartedBlankChat = false;
    this.preview = null;
    if (!silent) {
      this.historyOpen = false;
      this.notify(`"${detail.session.title}" yerel veritabanından yüklendi.`);
    }
    this.cdr.markForCheck();
    requestAnimationFrame(() => {
      const el = this.conversation?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async deleteChatSession(chatId: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    const ok = await this.ai.deleteSession(chatId);
    if (!ok) {
      this.notify('Sohbet silinemedi.', true);
      return;
    }
    this.savedSessions = this.savedSessions.filter(s => s.id !== chatId);
    if (this.activeChatId === chatId) {
      this.activeChatId = '';
      this.activeChatTitle = '';
      this.messages = [];
      this.userStartedBlankChat = true;
    }
    this.notify('Sohbet yerel geçmişten silindi.');
    this.cdr.markForCheck();
  }

  async clearAllChats(): Promise<void> {
    if (!this.confirmClearChats) {
      this.confirmClearChats = true;
      clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => { this.confirmClearChats = false; this.cdr.markForCheck(); }, 4000);
      return;
    }
    this.confirmClearChats = false;
    await this.ai.clearHistory();
    this.savedSessions = [];
    this.activeChatId = '';
    this.activeChatTitle = '';
    this.messages = [];
    this.userStartedBlankChat = true;
    this.notify('Tüm sohbet geçmişi yerel veritabanından temizlendi.');
    this.cdr.markForCheck();
  }

  async submitMemoryNote(): Promise<void> {
    const note = this.newMemoryNote.trim();
    if (!note || this.actionBusy) return;
    this.actionBusy = true;
    try {
      await this.ai.addMemoryNote(note);
      this.newMemoryNote = '';
      await this.refreshHistory(false);
      this.notify('Tercih kalıcı hafızaya kaydedildi — yeni sohbetlerde otomatik hatırlanacak.');
    } catch (err: any) {
      this.notify(err?.error?.error || err?.message || 'Hafıza notu kaydedilemedi.', true);
    } finally {
      this.actionBusy = false;
      this.cdr.markForCheck();
    }
  }

  async removeMemoryItem(mem: AiMemoryItem, event?: Event): Promise<void> {
    event?.stopPropagation();
    const ok = await this.ai.deleteMemory(mem.id);
    if (ok) {
      this.memories = this.memories.filter(m => m.id !== mem.id);
      this.notify('Hafıza kaydı silindi.');
      this.cdr.markForCheck();
    }
  }

  async clearAllMemories(): Promise<void> {
    if (!this.confirmClearMemory) {
      this.confirmClearMemory = true;
      clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => { this.confirmClearMemory = false; this.cdr.markForCheck(); }, 4000);
      return;
    }
    this.confirmClearMemory = false;
    await this.ai.clearMemories();
    this.memories = [];
    this.notify('Kalıcı yapay zeka hafızası sıfırlandı.');
    this.cdr.markForCheck();
  }

  private async syncLatestAssistantMeta(target?: ChatMessage): Promise<void> {
    if (!this.activeChatId) return;
    const msg = target || [...this.messages].reverse().find(m => m.role === 'assistant');
    if (!msg) return;
    await this.ai.syncSessionMeta(this.activeChatId, {
      reportProposal: msg.reportProposal,
      dialog: msg.dialog,
      coworkerSteps: msg.coworkerSteps,
    });
  }

  stop(): void {
    if (this.controller) {
      this.controller.abort(); this.controller = undefined;
      const last = this.messages.at(-1);
      if (last?.role === 'assistant' && this.sending) last.interrupted = true;
    }
    this.sending = false; this.toolLabel = '';
  }

  private buildSessionLedger(): Record<string, unknown> {
    const reports: string[] = [];
    const queries: string[] = [];
    let lastSql = '';
    let lastQueryId = '';
    for (const msg of this.messages) {
      if (msg.reportProposal) {
        if (msg.reportProposal.reportName && !reports.includes(msg.reportProposal.reportName)) {
          reports.push(msg.reportProposal.reportName);
        }
        if (msg.reportProposal.queryId) {
          lastQueryId = msg.reportProposal.queryId;
          if (!queries.includes(msg.reportProposal.queryId)) queries.push(msg.reportProposal.queryId);
        }
        if (msg.reportProposal.sql) lastSql = msg.reportProposal.sql;
      }
      for (const p of msg.parts || []) {
        if (p.kind === 'code' && p.language === 'sql' && p.text) {
          lastSql = p.text;
        }
      }
    }
    return { reports: reports.slice(-5), queries: queries.slice(-5), lastSql: lastSql.slice(0, 4000), lastQueryId };
  }

  async send(extraContext?: Record<string, unknown>): Promise<void> {
    const text = this.prompt.trim();
    if (!text || this.sending || !this.health.available) return;
    if (text.length > 6000) { this.notify('Mesaj en fazla 6.000 karakter olabilir.', true); return; }
    if (this.messages.length >= 36) { this.notify('Yeni bir sohbet başlatın; bağlam sınırına ulaşıldı.', true); return; }
    this.coworker.stop();
    this.userStartedBlankChat = false;
    this.historyOpen = false;
    const snapshot: AiContext = {
      ...this.context.snapshot(),
      chat_session_id: this.activeChatId || undefined,
      session_ledger: this.buildSessionLedger(),
      ...(extraContext || {}),
    };
    this.messages.push({
      id: ++this.sequence,
      role: 'user',
      content: text,
      parts: [{ kind: 'text', text, blocks: this.tokenizeRichBlocks(text) }],
      context: snapshot,
      timestamp: this.nowTimeStr(),
    });
    const history = this.messages.filter(m => !m.error && !m.interrupted && m.content).map(m => ({ role: m.role, content: m.content }));
    const answer: ChatMessage = {
      id: ++this.sequence,
      role: 'assistant',
      content: '',
      parts: [],
      context: snapshot,
      timestamp: this.nowTimeStr(),
    };
    this.messages.push(answer); this.prompt = ''; this.sending = true;
    const controller = new AbortController(); this.controller = controller;
    const streamTimeout = Math.max(15000, Math.min(310000, ((this.health.timeout_seconds || 80) + 10) * 1000));
    const deadline = setTimeout(() => controller.abort(), streamTimeout);
    this.scroll();
    try {
      await this.ai.stream(history, snapshot, controller.signal, event => {
        if (controller.signal.aborted) return;
        if (event.type === 'content') {
          if (answer.content.length + (event.content?.length || 0) > 64000) {
            controller.abort(); answer.error = 'Yanıt boyut sınırına ulaşıldı.'; return;
          }
          answer.content += event.content || '';
          answer.parts = this.parse(answer.content);
          this.scroll();
        }
        if (event.type === 'tool') {
          this.toolLabel = event.data.state === 'running' ? 'Veritabanı şeması ve kalıcı hafıza doğrulanıyor' : '';
        }
        if (event.type === 'proposal' && event.data) {
          answer.reportProposal = event.data as AiReportProposal;
          answer.parts = this.parse(answer.content);
          this.scroll();
        }
        if (event.type === 'dialog' && event.data) {
          const dlg = event.data as AiInteractiveDialog;
          if (!dlg.targetAction) dlg.targetAction = 'auto';
          if (dlg.options?.length && !dlg.options.some(o => o.selected)) {
            const rec = dlg.options.find(o => o.recommended) || dlg.options[0];
            if (rec) rec.selected = true;
          }
          answer.dialog = dlg;
          this.scroll();
        }
        if (event.type === 'session' && event.data?.sessionId) {
          this.activeChatId = event.data.sessionId;
          if (event.data.title) this.activeChatTitle = event.data.title;
        }
        this.cdr.markForCheck();
      });
    } catch (error: any) {
      if (!controller.signal.aborted) { answer.error = error.message || 'Yanıt alınamadı.'; void this.refreshHealth(); }
    } finally {
      clearTimeout(deadline);
      if (controller.signal.aborted && !answer.error) answer.interrupted = true;
      if (this.controller === controller) { this.controller = undefined; this.sending = false; this.toolLabel = ''; }
      this.cdr.markForCheck();
      this.scroll();
      void this.refreshHistory(false);
      // Trigger live human-like screen automation automatically if enabled!
      if (!answer.error && !answer.interrupted && this.autoCoworker) {
        void this.maybeAutoRunCoworker(answer);
      }
    }
  }

  private async maybeAutoRunCoworker(answer: ChatMessage): Promise<void> {
    // 1. If a Report Proposal was prepared, run the full SQL Studio -> Template Builder -> Live Execute choreography!
    if (answer.reportProposal) {
      await this.runLiveReportOnScreen(answer.reportProposal, answer);
      return;
    }
    // 2. If Copilot is waiting for a Table Disambiguation choice without code yet, let user pick first
    if (answer.dialog?.dialogType === 'table_disambiguation' && !answer.parts.some(p => p.kind === 'code')) {
      return;
    }
    // 3. If a Space Map JSON, SQL query, or Python script was generated, execute it live on the respective workspace!
    const codePart = answer.parts.find(p => p.kind === 'code' && p.complete && !p.isTemplateJson);
    if (codePart) {
      await this.runLiveCodeOnScreen(codePart, answer);
    }
  }

  async runLiveReportOnScreen(proposal: AiReportProposal, message?: ChatMessage): Promise<void> {
    if (this.coworkerState.active) this.coworker.stop();
    this.ensureDockedForLiveView();
    if (message) message.coworkerRunning = true;
    try {
      await this.coworker.runReportWorkflow(proposal, steps => {
        if (message) {
          message.coworkerSteps = steps;
          this.cdr.markForCheck();
          this.scroll();
        }
      });
      this.notify(`"${proposal.reportName}" ekranda canlı olarak oluşturuldu ve çalıştırıldı!`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.notify(err?.error?.error || err?.message || 'Canlı rapor kurulumunda hata oluştu.', true);
      }
    } finally {
      if (message) {
        message.coworkerRunning = false;
        void this.syncLatestAssistantMeta(message);
      }
      void this.refreshHistory(false);
      this.cdr.markForCheck();
    }
  }

  async runLiveCodeOnScreen(part: MessagePart, message?: ChatMessage): Promise<void> {
    if (this.coworkerState.active) this.coworker.stop();
    this.ensureDockedForLiveView();
    if (message) message.coworkerRunning = true;
    const onSteps = (steps: CoworkerStepLog[]) => {
      if (message) {
        message.coworkerSteps = steps;
        this.cdr.markForCheck();
        this.scroll();
      }
    };
    try {
      if (this.isSpaceMapJson(part)) {
        await this.coworker.runSpaceMapWorkflow(part.text, onSteps);
        this.notify('Space Map topolojisi ekranda canlı olarak kuruldu!');
      } else if (part.language === 'sql') {
        const dsId = message?.context?.data_source_id || 'ds_apex_factory';
        await this.coworker.runSqlWorkflow(part.text, dsId, '[Copilot] Canlı SQL Sorgusu', onSteps);
        this.notify('SQL Studio açıldı ve sorgu canlı olarak çalıştırıldı!');
      } else if (part.language === 'python') {
        const qIds = message?.context?.active_queries?.map(q => q.id) || [];
        await this.coworker.runPythonWorkflow(part.text, qIds, onSteps);
        this.notify('Python Workspace açıldı ve sandbox canlı çalıştırıldı!');
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        this.notify(err?.error?.error || err?.message || 'Canlı ekran işlemi tamamlanamadı.', true);
      }
    } finally {
      if (message) {
        message.coworkerRunning = false;
        void this.syncLatestAssistantMeta(message);
      }
      this.cdr.markForCheck();
    }
  }

  private isTemplateArtifactText(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return false;
    return trimmed.includes('"charts"') || trimmed.includes('"cells"');
  }

  private parse(content: string): MessagePart[] {
    const parts: MessagePart[] = [];
    const pattern = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
    let match: RegExpExecArray | null, last = 0;
    while ((match = pattern.exec(content))) {
      if (match.index > last) {
        this.pushTextOrRawJsonParts(parts, content.slice(last, match.index));
      }
      const tag = match[1].trim().toLowerCase();
      const body = match[2].trimEnd();
      const isTpl = (tag === 'json' || !tag) && this.isTemplateArtifactText(body);
      const language = tag === 'py' || tag === 'python' ? 'python' : tag === 'sql' ? 'sql' : (tag === 'json' || isTpl) ? 'json' : undefined;
      parts.push({
        kind: 'code',
        text: body,
        language,
        complete: match[3] === '```',
        isTemplateJson: isTpl,
      });
      last = pattern.lastIndex;
    }
    if (last < content.length) {
      this.pushTextOrRawJsonParts(parts, content.slice(last));
    }
    return parts;
  }

  private pushTextOrRawJsonParts(parts: MessagePart[], segment: string): void {
    const trimmed = segment.trim();
    if (!trimmed) return;
    if (this.isTemplateArtifactText(trimmed)) {
      parts.push({
        kind: 'code',
        text: trimmed,
        language: 'json',
        complete: trimmed.endsWith('}'),
        isTemplateJson: true,
      });
      return;
    }
    parts.push({
      kind: 'text',
      text: trimmed,
      blocks: this.tokenizeRichBlocks(trimmed),
    });
  }

  private tokenizeRichBlocks(raw: string): RichTextBlock[] {
    const blocks: RichTextBlock[] = [];
    const lines = raw.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^#{1,4}\s+/.test(line)) {
        blocks.push({
          kind: 'heading',
          tokens: this.tokenizeInline(line.replace(/^#{1,4}\s+/, '')),
        });
        continue;
      }
      const bulletMatch = line.match(/^(?:([•\-*])|(\d+\.))\s+(.*)$/);
      if (bulletMatch) {
        blocks.push({
          kind: 'bullet',
          bulletPrefix: bulletMatch[2] || '•',
          tokens: this.tokenizeInline(bulletMatch[3]),
        });
        continue;
      }
      if (/^\*\*[^*]+\*\*:?$/.test(line) && line.length < 90) {
        blocks.push({
          kind: 'heading',
          tokens: this.tokenizeInline(line),
        });
        continue;
      }
      blocks.push({
        kind: 'paragraph',
        tokens: this.tokenizeInline(line),
      });
    }
    return blocks;
  }

  private tokenizeInline(text: string): RichInlineToken[] {
    const tokens: RichInlineToken[] = [];
    // Match **`code`**, `code`, **bold**, or _italic_ safely without any innerHTML
    const pattern = /\*\*`([^`]+)`\*\*|`([^`]+)`|\*\*([^*]+)\*\*|_([^_]+)_/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) {
        tokens.push({ kind: 'text', value: text.slice(last, m.index) });
      }
      if (m[1] !== undefined) {
        tokens.push({ kind: 'code', value: m[1], bold: true });
      } else if (m[2] !== undefined) {
        tokens.push({ kind: 'code', value: m[2] });
      } else if (m[3] !== undefined) {
        tokens.push({ kind: 'bold', value: m[3] });
      } else if (m[4] !== undefined) {
        tokens.push({ kind: 'italic', value: m[4] });
      }
      last = pattern.lastIndex;
    }
    if (last < text.length) {
      tokens.push({ kind: 'text', value: text.slice(last) });
    }
    return tokens.length ? tokens : [{ kind: 'text', value: text }];
  }

  // ---- Interactive Report Proposal Actions ----

  async onProposalQueryChange(proposal: AiReportProposal, newQueryId: string): Promise<void> {
    if (!newQueryId || newQueryId === proposal.queryId || this.actionBusy) return;
    this.actionBusy = true;
    try {
      const updated = await this.ai.inspectReportQuery(newQueryId, proposal.reportName);
      if (updated.queryId) proposal.queryId = updated.queryId;
      if (updated.queryName) proposal.queryName = updated.queryName;
      if (updated.dataSourceId) proposal.dataSourceId = updated.dataSourceId;
      if (updated.dataSourceName) proposal.dataSourceName = updated.dataSourceName;
      if (updated.sql) proposal.sql = updated.sql;
      if (typeof updated.rowCount === 'number') proposal.rowCount = updated.rowCount;
      if (updated.columns) proposal.columns = updated.columns;
      if (updated.selectedColumns) proposal.selectedColumns = updated.selectedColumns;
      if (updated.previewRows) proposal.previewRows = updated.previewRows;
      if (updated.chart) proposal.chart = updated.chart;
      if (updated.summaries) proposal.summaries = updated.summaries;
      proposal.templateId = undefined;
      proposal.executedFormat = undefined;
      void this.syncLatestAssistantMeta();
      this.notify(`"${proposal.queryName}" sorgusu ve verileri yüklendi.`);
    } catch (error: any) {
      this.notify(error.error?.error || error.message || 'Sorgu detayları alınamadı.', true);
    } finally {
      this.actionBusy = false;
      this.cdr.markForCheck();
    }
  }

  setProposalChartType(proposal: AiReportProposal, type: 'bar' | 'line' | 'pie' | 'none'): void {
    if (type === 'none') {
      proposal.chart.include = false;
    } else {
      proposal.chart.include = true;
      proposal.chart.type = type;
    }
    proposal.executedFormat = undefined;
    void this.syncLatestAssistantMeta();
  }

  toggleProposalColumn(proposal: AiReportProposal, col: string): void {
    const idx = proposal.selectedColumns.indexOf(col);
    if (idx >= 0) {
      if (proposal.selectedColumns.length > 1) {
        proposal.selectedColumns.splice(idx, 1);
      }
    } else {
      proposal.selectedColumns.push(col);
    }
    proposal.executedFormat = undefined;
    void this.syncLatestAssistantMeta();
  }

  toggleProposalSummary(proposal: AiReportProposal, item: AiReportSummaryItem): void {
    item.checked = !item.checked;
    proposal.executedFormat = undefined;
    void this.syncLatestAssistantMeta();
  }

  async executeReportProposal(proposal: AiReportProposal, format: 'xlsx' | 'pdf' = 'xlsx'): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = true;
    try {
      this.notify('Rapor şablonu kaydediliyor ve veritabanı sorgusu çalıştırılıyor…');
      const built = await this.ai.buildReport(proposal);
      proposal.templateId = built.templateId;
      proposal.reportName = built.name;

      const blob = await firstValueFrom(
        this.templateBuilder.render(built.templateId, {}, format).pipe(timeout(45000))
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (built.name || 'rapor').replace(/\s+/g, '_');
      a.href = url;
      a.download = `${safeName}.${format}`;
      a.click();
      URL.revokeObjectURL(url);

      proposal.executedFormat = format;
      void this.syncLatestAssistantMeta();
      void this.refreshHistory(false);
      this.notify(`"${built.name}" raporu oluşturuldu ve .${format} olarak indirildi!`);
    } catch (error: any) {
      this.notify(error.error?.error || error.message || 'Rapor çalıştırılırken hata oluştu.', true);
    } finally {
      this.actionBusy = false;
      this.cdr.markForCheck();
    }
  }

  async openProposalInBuilder(proposal: AiReportProposal): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = true;
    try {
      const built = await this.ai.buildReport(proposal);
      proposal.templateId = built.templateId;
      proposal.reportName = built.name;
      void this.syncLatestAssistantMeta();
      void this.refreshHistory(false);
      this.notify(`"${built.name}" Template Builder editöründe açılıyor…`);
      await this.router.navigate(['/template-builder', built.templateId]);
    } catch (error: any) {
      this.notify(error.error?.error || error.message || 'Şablon açılamadı.', true);
    } finally {
      this.actionBusy = false;
      this.cdr.markForCheck();
    }
  }

  submitProposalRevision(proposal: AiReportProposal): void {
    const note = (proposal.customNote || '').trim();
    if (!note || this.sending) return;
    this.prompt = `"${proposal.reportName}" raporu (${proposal.queryId}) için şu değişikliği uygula: ${note}`;
    proposal.customNote = '';
    void this.send({
      user_selection: {
        selectedOptionIds: ['sql_add_filter'],
        previousSql: proposal.sql,
        previousQueryId: proposal.queryId,
        targetAction: 'report',
        customText: note,
      },
    });
  }

  // ---- Interactive Question & Table Disambiguation Dialog Actions ----

  selectDialogOption(dialog: AiInteractiveDialog, option: AiDialogOption): void {
    if (dialog.submitted) return;
    if (dialog.multiSelect) {
      const nextState = !option.selected;
      // If user selects a pre-built JOIN recipe, unselect individual tables unless they explicitly add more
      if (nextState && option.actionType === 'table_join') {
        for (const opt of dialog.options) {
          if (opt.id !== option.id) opt.selected = false;
        }
      } else if (nextState && option.actionType === 'table_select') {
        for (const opt of dialog.options) {
          if (opt.actionType === 'table_join') opt.selected = false;
        }
      }
      option.selected = nextState;
    } else {
      for (const opt of dialog.options) opt.selected = (opt.id === option.id);
    }
  }

  setDialogTargetAction(dialog: AiInteractiveDialog, target: 'auto' | 'report' | 'sql' | 'python' | 'spacemap'): void {
    if (dialog.submitted) return;
    dialog.targetAction = target;
  }

  getSelectedTablesSummary(dialog: AiInteractiveDialog): string {
    const tables: string[] = [];
    for (const opt of dialog.options || []) {
      if (opt.selected && opt.tables?.length) {
        for (const t of opt.tables) {
          if (!tables.includes(t)) tables.push(t);
        }
      }
    }
    if (tables.length >= 2) {
      return `${tables.length} tablo seçildi (${tables.join(' ⋈ ')}) → Otomatik JOIN yapılacak`;
    }
    if (tables.length === 1) {
      return `Seçili tablo: ${tables[0]} (Çoklu JOIN için başka bir tabloya daha tıklayabilirsiniz)`;
    }
    return '';
  }

  submitDialog(dialog: AiInteractiveDialog): void {
    if (dialog.submitted || this.sending) return;
    const selectedOpts = dialog.options.filter(o => o.selected);
    const chosen = selectedOpts.map(o => o.prompt || o.label);
    const custom = (dialog.customText || '').trim();
    if (!chosen.length && !custom) {
      this.notify('Lütfen bir seçenek belirleyin veya notunuzu yazın.', true);
      return;
    }
    dialog.submitted = true;
    const dialogOwner = [...this.messages].reverse().find(m => m.dialog === dialog);
    void this.syncLatestAssistantMeta(dialogOwner);

    const selectedOptionIds = selectedOpts.map(o => o.id);
    const selectedTables: string[] = [];
    let selectedQueryId = '';
    for (const opt of selectedOpts) {
      if (opt.tables?.length) {
        for (const t of opt.tables) {
          if (!selectedTables.includes(t)) selectedTables.push(t);
        }
      }
      if (!selectedQueryId && opt.queryId) selectedQueryId = opt.queryId;
    }

    const ledger = this.buildSessionLedger();
    const targetAction = dialog.targetAction || 'auto';
    const targetLabelMap: Record<string, string> = {
      report: 'Excel Raporu oluştur',
      sql: 'SQL Sorgusu üret',
      spacemap: 'Space Map Topolojisi kur',
      python: 'Python Analiz Scripti yaz',
    };
    const actionSuffix = targetAction !== 'auto' && targetLabelMap[targetAction]
      ? `Hedef: ${targetLabelMap[targetAction]}`
      : '';

    const combined = [
      ...chosen,
      ...(actionSuffix ? [actionSuffix] : []),
      ...(custom ? [`Ek tercih: ${custom}`] : []),
    ].join(' — ');
    this.prompt = combined;
    void this.send({
      user_selection: {
        dialogId: dialog.id,
        dialogType: dialog.dialogType,
        selectedOptionIds,
        selectedTables,
        selectedQueryId,
        dataSourceId: dialog.dataSourceId || 'ds_apex_factory',
        targetAction,
        customText: custom,
        previousSql: ledger['lastSql'] || '',
        previousQueryId: ledger['lastQueryId'] || '',
      },
    });
  }

  convertSqlPartToReport(part: MessagePart): void {
    if (this.sending || !part.text) return;
    this.prompt = 'Bu SQL sorgusunu kullanarak grafik ve özet KPI içeren bir Excel raporu oluştur.';
    void this.send({
      user_selection: {
        selectedOptionIds: ['sql_to_report'],
        previousSql: part.text,
        targetAction: 'report',
      },
    });
  }

  convertSqlPartToSpaceMap(part: MessagePart): void {
    if (this.sending || !part.text) return;
    this.prompt = 'Bu SQL sorgusunu kullanarak Space Map için Path Definer topolojisi oluştur.';
    void this.send({
      user_selection: {
        selectedOptionIds: ['sql_to_spacemap'],
        previousSql: part.text,
        targetAction: 'spacemap',
      },
    });
  }

  openTableWizardForSqlPart(part: MessagePart): void {
    if (this.sending || !part.text) return;
    this.prompt = 'Bu sorguyu veritabanındaki ilişkili diğer tablolarla JOIN yaparak zenginleştir.';
    void this.send({
      user_selection: {
        selectedOptionIds: ['sql_join_more'],
        previousSql: part.text,
        targetAction: 'sql',
      },
    });
  }

  isSpaceMapJson(part: MessagePart): boolean {
    if (part.language !== 'json' || part.isTemplateJson) return false;
    return part.text.includes('"structure"') && part.text.includes('"queryId"');
  }

  async openJsonPartInSpaceMap(part: MessagePart): Promise<void> {
    if (this.actionBusy || !this.isSpaceMapJson(part)) return;
    this.actionBusy = true;
    try {
      const parsed = JSON.parse(part.text);
      const config = parsed.config || parsed;
      const payload = {
        name: parsed.name || `Copilot Space Map (${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})`,
        description: 'SuperNova Copilot tarafından oluşturuldu.',
        queryId: parsed.queryId,
        structure: parsed.structure || 'multi_level',
        config,
      };
      const res = await firstValueFrom(this.paths.create(payload).pipe(timeout(15000)));
      const newId = res?.data?.id;
      this.notify(`"${payload.name}" kaydedildi ve Space Map üzerinde açılıyor…`);
      await this.router.navigate(['/network-map'], newId ? { queryParams: { pathId: newId } } : {});
    } catch (error: any) {
      this.notify(error.error?.error || error.message || 'Space Map yapılandırması kaydedilemedi.', true);
    } finally {
      this.actionBusy = false;
      this.cdr.markForCheck();
    }
  }

  canApply(part: MessagePart): boolean { return !!part.language && this.context.canApply(part.language); }
  canTest(part: MessagePart): boolean {
    return (part.language === 'python' && this.page === 'python-workspace') || (part.language === 'sql' && this.page === 'query-creator');
  }
  actionLabel(part: MessagePart): string {
    return part.language === 'json' ? this.page === 'template-builder' ? 'Şablona ekle' : 'Haritaya aktar' : 'Editöre aktar';
  }

  async copy(part: MessagePart): Promise<void> {
    try { await navigator.clipboard.writeText(part.text); this.notify('Panoya kopyalandı.'); }
    catch { this.notify('Panoya erişilemedi; kodu seçerek kopyalayabilirsiniz.', true); }
  }

  async apply(part: MessagePart): Promise<void> {
    if (!part.language || this.actionBusy) return;
    this.actionBusy = true;
    const page = this.page;
    const sessionId = this.sessionId;
    try {
      let artifact: any;
      if (part.language === 'json') artifact = await this.ai.validate(page === 'template-builder' ? 'template' : 'path', JSON.parse(part.text));
      if (part.language === 'python') await this.ai.validate('python', part.text);
      if (this.page !== page || this.sessionId !== sessionId) return;
      this.context.apply(part.language, part.text, artifact);
      this.notify('İçerik editöre aktarıldı.');
    } catch (error: any) { if (this.sessionId === sessionId) this.notify(error.error?.error || error.message || 'İçerik doğrulanamadı.', true); }
    finally { this.actionBusy = false; this.cdr.markForCheck(); }
  }

  async test(part: MessagePart, message: ChatMessage): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = true; this.preview = null;
    const page = this.page;
    const sessionId = this.sessionId;
    try {
      if (part.language === 'python') {
        const result = await firstValueFrom(this.queries.runPython(part.text, message.context.active_queries?.map(q => q.id) || []).pipe(timeout(30000)));
        const datasets = Object.entries(result.data || {});
        const [name, data] = datasets[0] || ['Sonuç', { rows: [], columns: [] }];
        if (this.page === page && this.sessionId === sessionId) this.preview = { title: `${datasets.length} dataset · ${name}`, columns: data.columns.map(c => c.name), rows: data.rows.slice(0, 5) };
      } else {
        const sourceId = message.context.data_source_id || 'ds_apex_factory';
        const result = await firstValueFrom(this.queries.previewAdhoc(sourceId, part.text, {}, 5).pipe(timeout(30000)));
        if (this.page === page && this.sessionId === sessionId) this.preview = { title: 'SQL önizlemesi · ilk 5 satır', columns: result.data.columns.map(c => c.name), rows: result.data.rows.slice(0, 5) };
      }
      if (this.page === page && this.sessionId === sessionId) this.notify('Test tamamlandı.');
    } catch (error: any) { if (this.sessionId === sessionId) this.notify(error.error?.error || error.message || 'Test başarısız.', true); }
    finally { this.actionBusy = false; this.cdr.markForCheck(); this.scroll(); }
  }

  trackMessage(_index: number, message: ChatMessage): number { return message.id; }
  private notify(message: string, error = false): void {
    this.notice = message; this.noticeError = error; clearTimeout(this.noticeTimer);
    this.cdr.markForCheck();
    this.noticeTimer = setTimeout(() => { this.notice = ''; this.cdr.markForCheck(); }, 6000);
  }
  private scroll(): void {
    requestAnimationFrame(() => {
      const el = this.conversation?.nativeElement;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 260) el.scrollTop = el.scrollHeight;
    });
  }
}
