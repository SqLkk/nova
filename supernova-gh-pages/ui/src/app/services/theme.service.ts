import { Injectable, Renderer2, RendererFactory2, Inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { BehaviorSubject, Observable } from 'rxjs';

export type Theme = 'light' | 'dark';

/**
 * Uygulamanın tek tema sahibi.
 *
 * Önceden tema geçiş mantığı 3 yerde kopyalanmıştı (app.component,
 * navigation.component, settings.component) ve iki farklı localStorage
 * anahtarı ('ui-theme', 'theme') kullanıyordu. Bu servis ikisini de birleştirir:
 *   - CSS değişkenleri: body.light-theme / body.dark-theme
 *   - Tailwind dark: varyantı: html.dark
 * her ikisini birlikte değiştirir.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** localStorage anahtarı (navigation ile uyumlu). */
  private readonly STORAGE_KEY = 'ui-theme';

  private readonly renderer: Renderer2;
  private readonly theme$ = new BehaviorSubject<Theme>(this.resolveInitial());

  constructor(
    rendererFactory: RendererFactory2,
    @Inject(DOCUMENT) private readonly document: Document,
  ) {
    this.renderer = rendererFactory.createRenderer(null, null);
  }

  /** Mevcut tema. */
  get current(): Theme {
    return this.theme$.value;
  }

  /** Tema değişimlerini dinlemek için. */
  get themeChanges$(): Observable<Theme> {
    return this.theme$.asObservable();
  }

  /** İlk yüklemede çağrılır — saklanan/tercih edilen temayı uygular. */
  init(): void {
    this.apply(this.theme$.value);
  }

  /** Koyu/açık arasında geçiş yapar. */
  toggle(): void {
    this.set(this.theme$.value === 'dark' ? 'light' : 'dark');
  }

  /** Belirli bir temayı ayarlar, uygular ve kalıcılaştırır. */
  set(theme: Theme): void {
    this.persist(theme);
    this.apply(theme);
    if (theme !== this.theme$.value) {
      this.theme$.next(theme);
    }
  }

  // --- Dahili ---

  private apply(theme: Theme): void {
    const body = this.document.body;
    const html = this.document.documentElement;
    if (!body || !html) return;

    const isLight = theme === 'light';

    // CSS değişkenleri (styles.scss)
    this.renderer.removeClass(body, 'light-theme');
    this.renderer.removeClass(body, 'dark-theme');
    this.renderer.addClass(body, isLight ? 'light-theme' : 'dark-theme');

    // Tailwind dark: varyantı
    if (isLight) {
      this.renderer.removeClass(html, 'dark');
    } else {
      this.renderer.addClass(html, 'dark');
    }
  }

  private persist(theme: Theme): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, theme);
    } catch {
      /* SSR veya gizli mod — yok say */
    }
  }

  /** Başlangıç teması: saklanan > sistem tercihi > dark. */
  private resolveInitial(): Theme {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(this.STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored === 'light' || stored === 'dark') return stored;

    const prefersLight =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }
}
