import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { AiContext } from './ai-context.service';

export interface AiHealth {
  available: boolean;
  reason: string;
  demo_locked?: boolean;
  model?: string;
  provider?: string;
  timeout_seconds?: number;
  mock?: boolean;
  optional?: boolean;
  memory_enabled?: boolean;
  session_count?: number;
  memory_count?: number;
}

export interface AiReportSummaryItem {
  field: string;
  operation: string;
  checked: boolean;
  value?: number | string;
}

export interface AiReportChartConfig {
  include: boolean;
  type: 'bar' | 'line' | 'pie';
  title: string;
  xAxis: string;
  yAxis: string[];
}

export interface AiReportProposal {
  reportName: string;
  queryId: string;
  queryName: string;
  dataSourceId: string;
  dataSourceName: string;
  sql: string;
  rowCount: number;
  columns: string[];
  selectedColumns: string[];
  previewRows: Record<string, unknown>[];
  includeDetailTable: boolean;
  chart: AiReportChartConfig;
  summaries: AiReportSummaryItem[];
  candidateQueries?: Array<{ id: string; name: string; columns: string[] }>;
  templateId?: string;
  executedFormat?: 'xlsx' | 'pdf';
  showSqlPreview?: boolean;
  customNote?: string;
}

export interface AiDialogOption {
  id: string;
  label: string;
  prompt: string;
  description?: string;
  badge?: string;
  icon?: string;
  tables?: string[];
  queryId?: string;
  dataSourceId?: string;
  columns?: string[];
  rowCount?: number;
  actionType?: string;
  recommended?: boolean;
  selected?: boolean;
}

export interface AiInteractiveDialog {
  id?: string;
  dialogType?: 'table_disambiguation' | 'followup' | 'clarification';
  title: string;
  prompt: string;
  multiSelect?: boolean;
  targetAction?: 'auto' | 'report' | 'sql' | 'python' | 'spacemap';
  dataSourceId?: string;
  options: AiDialogOption[];
  customText?: string;
  submitted?: boolean;
}

export interface AiChatSessionSummary {
  id: string;
  title: string;
  lastPage: string;
  messageCount: number;
  summary?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AiPersistedMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  page?: string;
  reportProposal?: AiReportProposal;
  dialog?: AiInteractiveDialog;
  coworkerSteps?: any[];
}

export interface AiMemoryItem {
  id: number;
  key: string;
  category: 'preference' | 'table' | 'report' | 'query' | 'context' | string;
  label: string;
  payload?: Record<string, any>;
  hitCount: number;
  updatedAt: string;
}

export interface AiHistoryOverview {
  sessions: AiChatSessionSummary[];
  memories: AiMemoryItem[];
}

export interface AiStreamEvent {
  type: 'content' | 'metadata' | 'tool' | 'proposal' | 'dialog' | 'session' | 'done';
  content?: string;
  data?: any;
}

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly base = `${environment.apiUrl}/ai`;
  constructor(private http: HttpClient, private auth: AuthService) {}

  async checkHealth(): Promise<AiHealth> {
    try {
      return await firstValueFrom(this.http.get<AiHealth>(`${this.base}/status`).pipe(timeout(2000)));
    } catch { return { available: false, reason: 'offline', optional: true }; }
  }

  async getHistory(): Promise<AiHistoryOverview> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ success: boolean; data: AiHistoryOverview }>(`${this.base}/history`).pipe(timeout(5000))
      );
      return res?.data || { sessions: [], memories: [] };
    } catch {
      return { sessions: [], memories: [] };
    }
  }

  async getSession(sessionId: string): Promise<{ session: AiChatSessionSummary; messages: AiPersistedMessage[] } | null> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ success: boolean; data: { session: AiChatSessionSummary; messages: AiPersistedMessage[] } }>(
          `${this.base}/history/${encodeURIComponent(sessionId)}`
        ).pipe(timeout(6000))
      );
      return res?.data || null;
    } catch {
      return null;
    }
  }

  async syncSessionMeta(sessionId: string, meta: Record<string, unknown>): Promise<void> {
    if (!sessionId) return;
    try {
      await firstValueFrom(
        this.http.post(`${this.base}/history/${encodeURIComponent(sessionId)}/meta`, meta).pipe(timeout(5000))
      );
    } catch {
      // Optional sync — never disrupt UI
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.delete<{ success: boolean; deleted: boolean }>(`${this.base}/history/${encodeURIComponent(sessionId)}`).pipe(timeout(5000))
      );
      return !!res?.deleted;
    } catch {
      return false;
    }
  }

  async clearHistory(): Promise<number> {
    try {
      const res = await firstValueFrom(
        this.http.delete<{ success: boolean; cleared: number }>(`${this.base}/history`).pipe(timeout(5000))
      );
      return res?.cleared || 0;
    } catch {
      return 0;
    }
  }

  async addMemoryNote(note: string): Promise<AiMemoryItem | null> {
    const res = await firstValueFrom(
      this.http.post<{ success: boolean; data: AiMemoryItem }>(`${this.base}/memory`, { note }).pipe(timeout(5000))
    );
    return res?.data || null;
  }

  async deleteMemory(memId: number): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.delete<{ success: boolean; deleted: boolean }>(`${this.base}/memory/${memId}`).pipe(timeout(5000))
      );
      return !!res?.deleted;
    } catch {
      return false;
    }
  }

  async clearMemories(): Promise<number> {
    try {
      const res = await firstValueFrom(
        this.http.delete<{ success: boolean; cleared: number }>(`${this.base}/memory`).pipe(timeout(5000))
      );
      return res?.cleared || 0;
    } catch {
      return 0;
    }
  }

  validate(kind: 'python' | 'path' | 'template' | 'admin', artifact: unknown): Promise<any> {
    return firstValueFrom(this.http.post<{ success: boolean; data: any }>(
      `${this.base}/artifacts/validate`, { kind, artifact }).pipe(timeout(10000))).then(result => result.data);
  }

  inspectReportQuery(queryId: string, prompt?: string): Promise<Partial<AiReportProposal>> {
    return firstValueFrom(this.http.post<{ success: boolean; data: Partial<AiReportProposal> }>(
      `${this.base}/reports/inspect-query`, { queryId, prompt }).pipe(timeout(15000))).then(r => r.data);
  }

  buildReport(proposal: AiReportProposal): Promise<{ templateId: string; name: string; queryId: string; rowCount: number; columns: string[] }> {
    return firstValueFrom(this.http.post<{ success: boolean; data: { templateId: string; name: string; queryId: string; rowCount: number; columns: string[] } }>(
      `${this.base}/reports/build`, proposal).pipe(timeout(20000))).then(r => r.data);
  }

  async stream(messages: Array<{ role: string; content: string }>, context: AiContext,
               signal: AbortSignal, onEvent: (event: AiStreamEvent) => void): Promise<void> {
    // Fetch supports streaming POST; Bearer auth and refresh remain consistent with HttpClient.
    const send = () => fetch(`${this.base}/chat/stream`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'text/event-stream',
        Authorization: `Bearer ${this.auth.getToken() || ''}`,
      }, body: JSON.stringify({ messages, context }), signal,
    });
    let response = await send();
    if (response.status === 401 && !signal.aborted) {
      await response.body?.cancel();
      // Existing interceptor performs the single-flight token refresh and retries.
      await firstValueFrom(this.http.get(`${this.base}/status`).pipe(timeout(10000)));
      if (signal.aborted) return;
      response = await send();
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(response.status === 429 ? 'İstek sınırına ulaşıldı. Biraz sonra tekrar deneyin.' :
        response.status === 403 ? 'Bu sayfa bağlamını kullanma yetkiniz yok.' : 'Yerel AI servisine ulaşılamıyor.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', done = false;
    const processFrame = (frame: string) => {
      let event = 'message';
      const lines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      }
      if (!lines.length) return;
      const raw = lines.join('\n');
      if (raw === '[DONE]') { done = true; onEvent({ type: 'done' }); return; }
      const data = JSON.parse(raw);
      if (event === 'error') throw new Error(data.message || 'AI yanıtı tamamlanamadı.');
      if (event === 'metadata' || event === 'tool' || event === 'proposal' || event === 'dialog' || event === 'session') {
        onEvent({ type: event, data });
      } else {
        const content = data.choices?.[0]?.delta?.content;
        if (typeof content === 'string') onEvent({ type: 'content', content });
      }
    };
    try {
      while (!signal.aborted && !done) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        buffer = buffer.replace(/\r\n/g, '\n');
        if (buffer.length > 131072) throw new Error('AI yanıtı boyut sınırını aştı.');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          processFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (done) break;
        }
        if (chunk.done) break;
      }
      if (!done && !signal.aborted) throw new Error('Bağlantı kesildi; yanıt tamamlanamadı.');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
