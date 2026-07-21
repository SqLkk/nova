import { Injectable } from '@angular/core';
import {
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpInterceptor,
  HttpErrorResponse
} from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Router } from '@angular/router';

/**
 * Tüm API isteklerine `Authorization: Bearer <token>` ekler.
 * 401 (geçersiz/süresi dolmuş oturum) durumunda oturumu temizleyip login'e yönlendirir.
 *
 * AuthService'i enjekte etmek yerine token'ı doğrudan localStorage'dan okur;
 * böylece HttpClient → Interceptor → AuthService → HttpClient döngüsünden kaçınır.
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private readonly tokenKey = 'auth_token';
  private readonly userKey = 'current_user';

  constructor(private router: Router) {}

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const token = localStorage.getItem(this.tokenKey);
    const authReq = token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

    return next.handle(authReq).pipe(
      catchError((err: HttpErrorResponse) => {
        // 401: oturum artık geçersiz — temizle ve login'e dön (login sayfasındaysak no-op).
        if (err.status === 401) {
          localStorage.removeItem(this.tokenKey);
          localStorage.removeItem(this.userKey);
          if (this.router.url !== '/login') {
            this.router.navigate(['/login']);
          }
        }
        return throwError(() => err);
      })
    );
  }
}
