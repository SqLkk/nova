import { Component, OnInit } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';

@Component({
  standalone: false,
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  showNavigation = false; // Modern navigation bar için

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
          // Login, root path ve Template Builder (tam ekran odak modu) hariç:
          // builder'da nav kaybolsun, kullanıcı sadece şablonla ilgilensin.
          this.showNavigation =
            !event.url.includes('/login') &&
            event.url !== '/' &&
            !event.url.includes('/template-builder');
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
  }
}
