import { Injectable } from '@angular/core';
import { CanActivate, ActivatedRouteSnapshot, RouterStateSnapshot, Router } from '@angular/router';
import { Observable } from 'rxjs';
import { AuthService } from '../services/auth.service';

@Injectable({
  providedIn: 'root'
})
export class AuthGuard implements CanActivate {

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot
  ): Observable<boolean> | Promise<boolean> | boolean {
    
    // AuthService'in initialization'ını bekle
    return this.authService.waitForInitialization().then(() => {
      if (this.authService.isLoggedIn()) {
        // Sayfa izin kontrolü (Grup Yetki Matrisi) varsa
        const pageKey = route.data['pageKey'];
        if (pageKey && !this.authService.hasPageAccess(pageKey)) {
          const currentUser = this.authService.getCurrentUser();
          console.warn('Sayfa yetkisi yok:', pageKey, 'kullanıcı:', currentUser?.username);
          this.router.navigate(['/dashboard']); // Ana dashboard'a yönlendir
          return false;
        }

        return true;
      }

      // Login'e yönlendir
      this.router.navigate(['/login'], { 
        queryParams: { returnUrl: state.url } 
      });
      return false;
    });
  }
}

@Injectable({
  providedIn: 'root'
})
export class LoginGuard implements CanActivate {

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  canActivate(): Promise<boolean> {
    return this.authService.waitForInitialization().then(() => {
      if (this.authService.isLoggedIn()) {
        // Zaten giriş yapmışsa dashboard'a yönlendir
        this.router.navigate(['/dashboard']);
        return false;
      }
      return true;
    });
  }
}
