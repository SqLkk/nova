import { Injectable } from '@angular/core';

/**
 * Runtime tema renk yardımcıları.
 *
 * Grafiklerin (Chart.js opsiyonları, Canvas 2D çizimleri) koyu/açık temaya
 * duyarlı olması için CSS değişkenlerini `getComputedStyle` ile okur. Bu,
 * `widget.component.ts:getChartOptions` içinde kullanılan mevcut deseni
 * genelleştirir; böylece grafikler de tek kaynak (styles.scss) üzerinden
 * beslenir ve tema değişince anında uyum sağlar.
 */
@Injectable({ providedIn: 'root' })
export class ThemeColors {
  /** Bir CSS değişkeninin triplet ("R G B") değerini rgb(...) olarak döndürür. */
  read(name: string, alpha?: number): string {
    if (typeof document === 'undefined' || !document.documentElement) {
      return alpha != null ? 'rgba(0,0,0,0)' : 'rgb(0,0,0)';
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return alpha != null ? 'rgba(0,0,0,0)' : 'rgb(0,0,0)';
    return alpha != null ? `rgb(${raw} / ${alpha})` : `rgb(${raw})`;
  }

  /** Şu an koyu tema mı? (html.dark sınıfına bakar) */
  isDark(): boolean {
    if (typeof document === 'undefined') return true;
    return document.documentElement.classList.contains('dark');
  }

  // --- Grafikler için sık kullanılan değerler ---

  /** Eksen etiket rengi. */
  axis(): string {
    return this.read('--text-muted', this.isDark() ? 0.6 : 0.8);
  }

  /** Izgara (grid) çizgi rengi — tema nötründen düşük alfa ile. */
  grid(): string {
    return this.read('--text-muted', this.isDark() ? 0.1 : 0.14);
  }

  /** Tooltip arka planı. */
  tooltipBg(): string {
    return this.read('--bg-elevated', 0.96);
  }

  /** Tooltip ana metin rengi. */
  tooltipText(): string {
    return this.read('--text-primary');
  }

  /** Tooltip ikincil metin rengi. */
  tooltipMuted(): string {
    return this.read('--text-secondary');
  }

  /** Tooltip kenarlığı (marka tonunda, düşük alfa). */
  tooltipBorder(): string {
    return this.read('--accent-primary', 0.25);
  }
}
