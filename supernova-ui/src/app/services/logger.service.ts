import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * Logger Service - Konsol loglarını yönetir
 * 
 * environment.enableDebugLogs = false: Sadece error ve warn logları gösterilir
 * environment.enableDebugLogs = true: Tüm loglar gösterilir
 * 
 * Debug modunu açmak için:
 * 1. environment.ts dosyasında enableDebugLogs: true yapın
 * 2. VEYA browser console'da: localStorage.setItem('DEBUG_MODE', 'true')
 */
@Injectable({
  providedIn: 'root'
})
export class LoggerService {
  private get debugMode(): boolean {
    // Önce localStorage'dan kontrol et, sonra environment'tan
    try {
      const localDebug = localStorage.getItem('DEBUG_MODE');
      if (localDebug !== null) {
        return localDebug === 'true';
      }
    } catch {}
    return environment.enableDebugLogs || false;
  }

  constructor() {
    if (this.debugMode) {
      ////console.log('%c🔧 Debug Mode AÇIK - Tüm loglar gösteriliyor', 'background: #4CAF50; color: white; padding: 2px 5px; border-radius: 3px;');
      ////console.log('%cKapatmak için: localStorage.removeItem("DEBUG_MODE") ve sayfayı yenileyin', 'color: #888');
    } else {
      ////console.log('%c🔇 Debug Mode KAPALI - Sadece error ve warning gösteriliyor', 'background: #FF9800; color: white; padding: 2px 5px; border-radius: 3px;');
      ////console.log('%cAçmak için: localStorage.setItem("DEBUG_MODE", "true") ve sayfayı yenileyin', 'color: #888');
    }
  }

  /**
   * Debug seviyesi log (sadece debug mode'da gösterilir)
   */
  debug(...args: any[]): void {
    if (this.debugMode) {
      ////console.log(...args);
    }
  }

  /**
   * Info seviyesi log (sadece debug mode'da gösterilir)
   */
  info(...args: any[]): void {
    if (this.debugMode) {
      ////console.log(...args);
    }
  }

  /**
   * Warning seviyesi log (her zaman gösterilir)
   */
  warn(...args: any[]): void {
    console.warn(...args);
  }

  /**
   * Error seviyesi log (her zaman gösterilir)
   */
  error(...args: any[]): void {
    console.error(...args);
  }
}
