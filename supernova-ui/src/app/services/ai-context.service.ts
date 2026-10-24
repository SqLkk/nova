import { Injectable } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { filter } from 'rxjs/operators';

export type AiLanguage = 'python' | 'sql' | 'json';
export interface AiContext {
  page: string;
  active_queries?: Array<{ id: string; name: string; columns?: unknown[] }>;
  current_code?: string;
  data_source_id?: string;
  chat_session_id?: string;
  session_ledger?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface AiEditorBridge {
  context: () => Partial<AiContext>;
  accepts: (language: AiLanguage) => boolean;
  apply: (language: AiLanguage, content: string, artifact?: any) => void;
}

/** Pages register live getters, so context always reflects unsaved editor state. */
@Injectable({ providedIn: 'root' })
export class AiContextService {
  readonly page$ = new BehaviorSubject<string>('dashboard');
  private bridges = new Map<string, AiEditorBridge>();
  readonly labels: Record<string, string> = {
    'python-workspace': 'Python Workspace', 'query-creator': 'SQL Workspace',
    'template-builder': 'Template Builder', 'network-map': 'Network Map',
    'table-explorer': 'Table Explorer', dashboard: 'Dashboard', reports: 'Reports',
    alarms: 'Alarms', settings: 'Settings', profile: 'Profile', admin: 'Admin',
  };

  constructor(router: Router) {
    this.setRoute(router.url);
    router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(event => {
      this.setRoute((event as NavigationEnd).urlAfterRedirects);
    });
  }

  private setRoute(url: string): void {
    const page = url.split('?')[0].split('/').filter(Boolean)[0] || 'login';
    if (page !== this.page$.value) this.page$.next(page);
  }

  register(page: string, bridge: AiEditorBridge): () => void {
    this.bridges.set(page, bridge);
    return () => { if (this.bridges.get(page) === bridge) this.bridges.delete(page); };
  }

  snapshot(): AiContext {
    return { page: this.page$.value, ...this.bridges.get(this.page$.value)?.context() };
  }

  canApply(language: AiLanguage): boolean {
    return this.bridges.get(this.page$.value)?.accepts(language) ?? false;
  }

  apply(language: AiLanguage, content: string, artifact?: any): void {
    const bridge = this.bridges.get(this.page$.value);
    if (!bridge?.accepts(language)) throw new Error('Bu içerik için ilgili editörü açın.');
    bridge.apply(language, content, artifact);
  }
}
