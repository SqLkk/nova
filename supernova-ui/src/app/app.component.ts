import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';
import { environment } from '../environments/environment';

const ALLOWED_DEMO_PREFIXES = [
  '/dashboard',
  '/network-map',
  '/reports',
  '/template-builder',
  '/query-creator',
  '/python-workspace',
  '/table-explorer',
  '/alarms',
  '/admin',
  '/login',
];

@Component({
  standalone: false,
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, OnDestroy {
  showNavigation = false; // Modern navigation bar için
  copilotDocked = false;
  copilotWide = false;

  private readonly demoMessageListener = (event: MessageEvent) => {
    if (!(environment as any).demoMode || typeof window === 'undefined') return;
    if (event.origin !== window.location.origin) return;
    const payload = event.data;
    if (!payload || payload.type !== 'NOV4_DEMO_CMD') return;

    if (typeof payload.user === 'string' && payload.user.trim()) {
      const targetUser = payload.user.trim().toLowerCase();
      this.authService.applyDemoPersona(targetUser);
      if (targetUser === 'login') {
        void this.router.navigateByUrl('/login');
        return;
      }
    }

    if (typeof payload.route === 'string' && payload.route.trim()) {
      const safeRoute = this.sanitizeDemoRoute(payload.route);
      if (safeRoute) {
        if (!this.authService.isLoggedIn() && safeRoute !== '/login') {
          this.authService.applyDemoPersona('utku');
        }
        void this.router.navigateByUrl(safeRoute);
      }
    }
  };

  constructor(
    private router: Router,
    private authService: AuthService,
    private themeService: ThemeService
  ) {
    // Router olaylarını dinle ve login sayfasında navigation'ı gizle
    this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe((event) => {
        if (event instanceof NavigationEnd) {
          const currentUrl = event.urlAfterRedirects || event.url;
          this.showNavigation =
            !currentUrl.includes('/login') &&
            currentUrl !== '/';
        }
      });
  }

  ngOnInit(): void {
    // İlk yüklemede saklanan/sistem temasını uygula
    this.themeService.init();

    // Giriş yapmış kullanıcının tema tercihi varsa onu uygula
    this.authService.currentUser$.subscribe(user => {
      const pref = user?.preferences?.theme;
      if (pref === 'light' || pref === 'dark') {
        this.themeService.set(pref);
      }
    });

    if ((environment as any).demoMode && typeof window !== 'undefined') {
      window.addEventListener('message', this.demoMessageListener);
      const params = new URLSearchParams(window.location.search || '');
      const demoView = params.get('demoView');
      const demoUser = (params.get('demoUser') || '').toLowerCase();
      if (demoUser === 'login') {
        void this.authService.waitForInitialization().then(() => {
          void this.router.navigateByUrl('/login');
        });
      } else if (demoView) {
        const safeRoute = this.sanitizeDemoRoute(demoView);
        if (safeRoute) {
          void this.authService.waitForInitialization().then(() => {
            void this.router.navigateByUrl(safeRoute);
          });
        }
      }
    }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.demoMessageListener);
    }
  }

  private sanitizeDemoRoute(raw: string): string | null {
    const cleaned = raw.startsWith('/') ? raw.trim() : `/${raw.trim()}`;
    const ok = ALLOWED_DEMO_PREFIXES.some(
      (prefix) => cleaned === prefix || cleaned.startsWith(`${prefix}/`) || cleaned.startsWith(`${prefix}?`)
    );
    return ok ? cleaned : null;
  }
}
