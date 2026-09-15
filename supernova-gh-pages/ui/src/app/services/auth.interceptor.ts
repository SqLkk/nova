import { Injectable } from '@angular/core';
import {
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpInterceptor,
  HttpErrorResponse,
  HttpClient
} from '@angular/common/http';
import { Observable, BehaviorSubject, throwError } from 'rxjs';
import { catchError, filter, switchMap, take, finalize } from 'rxjs/operators';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';

/**
 * Tüm API isteklerine `Authorization: Bearer <access>` ekler.
 *
 * 401 (erişim token'ı süresi doldu / geçersiz) durumunda, varsa refresh token ile
 * TEK SEFER yeni {access, refresh} çifti alır ve bekleyen istekler dahil hepsini
 * yeni access token'la tekrar gönderir. Refresh başarısız olursa oturumu temizleyip
 * login'e yönlendirir.
 *
 * AuthService'i enjekte etmek yerine localStorage'ı doğrudan okur — böylece
 * HttpClient → Interceptor → AuthService → HttpClient döngüsünden kaçınır.
 * (Auth uç noktaları login/refresh/logout: bunlara access token eklenmez ve
 * 401'lerinde refresh denenmez.)
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private readonly tokenKey = 'auth_token';
  private readonly refreshKey = 'refresh_token';
  private readonly userKey = 'current_user';
  private readonly apiUrl = environment.apiUrl || 'http://localhost:5000/api';

  // Aynı anda yalnızca tek refresh; sürerken gelen 401'ler yeni token'ı bekler.
  private isRefreshing = false;
  private refreshSubject = new BehaviorSubject<string | null>(null);

  constructor(private router: Router, private http: HttpClient) {}

  private isAuthEndpoint(url: string): boolean {
    return /\/auth\/(login|refresh|logout)/.test(url);
  }

  private withToken(req: HttpRequest<unknown>, token: string): HttpRequest<unknown> {
    return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  private forceLogout(): void {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.refreshKey);
    localStorage.removeItem(this.userKey);
    if (this.router.url !== '/login') {
      this.router.navigate(['/login']);
    }
  }

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const skipAuth = this.isAuthEndpoint(req.url);
    const token = localStorage.getItem(this.tokenKey);
    const authReq = (!skipAuth && token) ? this.withToken(req, token) : req;

    return next.handle(authReq).pipe(
      catchError((err: HttpErrorResponse) => {
        // Yalnızca 401 ve refresh uygulanabilir istekler için refresh dene.
        if (err.status === 401 && !skipAuth && localStorage.getItem(this.refreshKey)) {
          return this.handle401(req, next);
        }
        if (err.status === 401) {
          this.forceLogout();
        }
        return throwError(() => err);
      })
    );
  }

  private handle401(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    if (!this.isRefreshing) {
      this.isRefreshing = true;
      this.refreshSubject.next(null);
      const refreshToken = localStorage.getItem(this.refreshKey);

      return this.http.post<{ token?: string; refreshToken?: string }>(
        `${this.apiUrl}/auth/refresh`, { refreshToken }
      ).pipe(
        switchMap((res) => {
          if (res && res.token) {
            localStorage.setItem(this.tokenKey, res.token);
            if (res.refreshToken) localStorage.setItem(this.refreshKey, res.refreshToken);
            this.refreshSubject.next(res.token); // bekleyen 401'leri serbest bırak
            return next.handle(this.withToken(req, res.token));
          }
          this.forceLogout();
          return throwError(() => new HttpErrorResponse({ status: 401 }));
        }),
        catchError((e) => {
          this.forceLogout();
          return throwError(() => e);
        }),
        finalize(() => {
          this.isRefreshing = false;
        })
      );
    }

    // Refresh sürüyor → yeni token yayınlanınca isteği tekrarla.
    return this.refreshSubject.pipe(
      filter((t): t is string => t !== null),
      take(1),
      switchMap((token) => next.handle(this.withToken(req, token))),
      catchError((e) => throwError(() => e))
    );
  }
}
