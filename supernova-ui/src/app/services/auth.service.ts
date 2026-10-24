import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { catchError, map, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { TranslateService } from '@ngx-translate/core';

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: 'superuser' | 'admin' | 'engineer' | 'operator' | 'user' | 'viewer';
  level?: number;        // hiyerarşi sırası (backend roles.level) — hasRole/hasPermission için
  roleId?: string;
  permissions?: string[]; // efektif izin anahtarları (backend → /users/<id>/permissions)
  avatar?: string;
  lastLogin?: Date;
  preferences: UserPreferences;
  allowedPages?: string[];
}

export interface UserPreferences {
  theme: 'light' | 'dark';
  language: 'tr' | 'en';
  dashboardRefreshInterval: number; // saniye
  dateFormat: string;
  timezone: string;
}

export interface LoginResponse {
  success: boolean;
  user?: User;
  token?: string;
  refreshToken?: string;
  message?: string;
}

export interface ProfileUpdateResponse {
  success: boolean;
  user?: User;
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  // Initialization için Promise
  private initializationPromise: Promise<void>;

  private apiUrl = environment.apiUrl || 'http://localhost:5000/api';
  private tokenKey = 'auth_token';
  private refreshTokenKey = 'refresh_token';
  private userKey = 'current_user';

  constructor(
    private router: Router,
    private http: HttpClient,
    private translate: TranslateService
  ) {
    // LocalStorage'dan kullanıcıyı yükle ve Promise olarak sakla
    this.initializationPromise = this.loadUserFromStorageAsync();
  }

  /**
   * Initialization tamamlanmasını bekle
   */
  public async waitForInitialization(): Promise<void> {
    return this.initializationPromise;
  }

  /**
   * LocalStorage'dan kullanıcı bilgilerini async yükle
   */
  private async loadUserFromStorageAsync(): Promise<void> {
    try {
      const userJson = localStorage.getItem(this.userKey);
      if (userJson) {
        const user = JSON.parse(userJson);
        this.currentUserSubject.next(user);
        ////console.log('User loaded from storage:', user.username);

        // Load permissions on startup/refresh
        this.loadUserPermissions(user.id);

        const headers = new HttpHeaders().set('Authorization', `Bearer ${this.getToken() || ''}`);

        // Asynchronously refresh the user profile from the database to keep role and settings in sync
        this.http.get<any>(`${this.apiUrl}/users/${user.id}/profile`, { headers }).subscribe({
          next: (res) => {
            if (res && res.user) {
              const freshUser = { ...user, ...res.user };
              if (localStorage.getItem(this.userKey)) {
                localStorage.setItem(this.userKey, JSON.stringify(freshUser));
                this.currentUserSubject.next(freshUser);
              }
            }
          },
          error: (err) => {
            console.warn('Could not refresh user profile from DB, using cached profile', err);
          }
        });
      }
    } catch (error) {
      console.error('Error loading user from storage:', error);
      this.logout();
    }
  }

  /**
   * Login işlemi - API'ye gönder (fallback ile)
   */
  login(username: string, password: string): Observable<LoginResponse> {
    ////console.log('Login attempt:', username);

    // API'yi dene (timeout ile)
    return this.http.post<LoginResponse>(`${this.apiUrl}/auth/login`, {
      username,
      password
    }).pipe(
      tap((response: LoginResponse) => {
        ////console.log('API response:', response);
        if (response.success && response.user && response.token) {
          // Token ve kullanıcı bilgilerini sakla
          localStorage.setItem(this.tokenKey, response.token);
          if (response.refreshToken) {
            localStorage.setItem(this.refreshTokenKey, response.refreshToken);
          }
          localStorage.setItem(this.userKey, JSON.stringify(response.user));

          // BehaviorSubject'i güncelle
          this.currentUserSubject.next(response.user);

          // Kullanıcı izinlerini yükle
          this.loadUserPermissions(response.user.id);
        }
      }),
      catchError(error => {
        // If it's an HTTP validation or auth error (e.g., 400, 401, 403, 404), the API is online but rejected the attempt.
        // Do not fallback. Return the actual error message.
        if (error && error.status !== 0 && error.status < 500) {
          const errMsg = error.error?.error || error.error?.message || this.translate.instant('HARDCODED.INVALID_CREDENTIALS') || 'Geçersiz kullanıcı adı veya şifre';
          return of({
            success: false,
            message: errMsg
          });
        }
        ////console.log('API unreachable, using local fallback:', error);
        // API çalışmıyorsa fallback kullan
        return this.fallbackLogin(username, password);
      })
    );
  }

  /**
   * Logout işlemi
   */
  logout(): void {
    // Best-effort: sunucudaki refresh token'ı iptal et (yanıt beklenmez).
    const refreshToken = this.getRefreshToken();
    if (refreshToken) {
      this.http.post(`${this.apiUrl}/auth/logout`, { refreshToken }).subscribe({
        error: () => { /* oturum zaten kapanıyor */ }
      });
    }
    // LocalStorage'ı temizle
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.refreshTokenKey);
    localStorage.removeItem(this.userKey);

    // BehaviorSubject'i sıfırla
    this.currentUserSubject.next(null);

    // Login sayfasına yönlendir
    this.router.navigate(['/login']);
  }

  /**
   * Kullanıcının giriş yapıp yapmadığını kontrol et
   */
  isLoggedIn(): boolean {
    return this.currentUserSubject.value !== null;
  }

  /**
   * Mevcut kullanıcıyı getir
   */
  getCurrentUser(): User | null {
    return this.currentUserSubject.value;
  }

  /**
   * Kullanıcının belirli bir role sahip olup olmadığını kontrol et (hiyerarşi ile)
   */
  /**
   * Kullanıcının seviyesi (backend roles.level). user.level yoksa rol adından türetir.
   */
  userLevel(): number {
    const user = this.getCurrentUser();
    if (!user) return 0;
    if (user.level != null) return user.level;
    const roleHierarchy: { [key: string]: number } = {
      'viewer': 20, 'user': 40, 'operator': 40, 'engineer': 60, 'admin': 80, 'superuser': 100
    };
    return roleHierarchy[user.role] || 0;
  }

  /**
   * Hiyerarşi: kullanıcının seviyesi, istenen rolün seviyesine eşit veya üstün mü?
   */
  hasRole(requiredRole: string): boolean {
    const roleHierarchy: { [key: string]: number } = {
      'viewer': 20, 'user': 40, 'operator': 40, 'engineer': 60, 'admin': 80, 'superuser': 100
    };
    return this.userLevel() >= (roleHierarchy[requiredRole] || 0);
  }

  /**
   * Admin olup olmadığını kontrol et
   */
  isAdmin(): boolean {
    return this.hasRole('admin');
  }

  /**
   * Superuser olup olmadığını kontrol et
   */
  isSuperUser(): boolean {
    return this.userLevel() >= 100;
  }

  /**
   * İzin anahtarına göre kontrol (RBAC). 'page:<key>' sayfa erişimidir.
   * permissions yüklenmişse onu kullanır; yoksa page:* için allowedPages'e düşer.
   */
  hasPermission(key: string): boolean {
    const user = this.getCurrentUser();
    if (!user) return false;
    if (user.permissions && user.permissions.length) {
      if (user.permissions.includes('*')) return true;
      return user.permissions.includes(key);
    }
    // İzinler yüklenmediyse page:* için legacy allowedPages fallback
    if (key.startsWith('page:') && user.allowedPages) {
      return user.allowedPages.includes(key.substring(5));
    }
    return false;
  }

  /**
   * Kullanıcının belirli bir sayfaya erişip erişemediğini kontrol et
   */
  hasPageAccess(pageKey: string): boolean {
    const user = this.getCurrentUser();
    if (!user) return false;
    // İzinler yüklenmişse tek kaynak RBAC izin matrisi.
    if (user.permissions && user.permissions.length) {
      return this.hasPermission(`page:${pageKey}`);
    }
    // Legacy: admin/superuser her şeyi; dashboard herkese açık.
    if (user.role === 'superuser' || user.role === 'admin') return true;
    if (pageKey === 'dashboard') return true;
    if (!user.allowedPages) {
      console.warn('hasPageAccess: İzinler yüklenemedi, erişim engellendi. sayfa:', pageKey);
      return false;
    }
    return user.allowedPages.includes(pageKey);
  }

  /**
   * Verilen seviye, mevcut kullanıcının seviyesinden DÜŞÜK mü? (hiyerarşi yönetimi)
   */
  canManageLevel(level: number | undefined | null): boolean {
    return (level ?? 0) < this.userLevel();
  }

  hasFolderAccess(folderName: string): boolean {
    const user = this.getCurrentUser();
    if (!user) return false;
    if (user.role === 'superuser' || user.role === 'admin') return true;

    // Klasörleri ilgili dinamik sayfa yetkileriyle eşle
    const folderPageMapping: Record<string, string> = {
      'System': 'reports',
      'Alarms': 'alarms',
      'Outages': 'app/outages',
      'Management': 'admin'
    };

    const requiredPage = folderPageMapping[folderName];
    if (!requiredPage) {
      // Tanımlı olmayan klasörlere herkes erişebilir
      return true;
    }
    return this.hasPageAccess(requiredPage);
  }

  /**
   * Kullanıcının izin verilen sayfalarını API'den yükle
   */
  loadUserPermissions(userId: string): void {
    const apiUrl = environment.apiUrl || 'http://localhost:5000/api';
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.getToken() || ''}`);
    this.http.get<{ user_id: string; allowed_pages: string[]; permissions?: string[]; level?: number; role?: string }>(
      `${apiUrl}/users/${userId}/permissions`,
      { headers }
    ).pipe(
      catchError(() => of(null))
    ).subscribe(res => {
      if (res && res.allowed_pages) {
        const user = this.getCurrentUser();
        if (user) {
          user.allowedPages = res.allowed_pages;
          if (res.permissions) user.permissions = res.permissions;
          if (res.level != null) user.level = res.level;
          if (res.role) user.role = res.role as User['role'];
          localStorage.setItem(this.userKey, JSON.stringify(user));
          this.currentUserSubject.next(user);
        }
      }
    });
  }

  /**
   * Token'ı getir
   */
  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  /**
   * Refresh token'ı getir (erişim token'ı dolduğunda yenileme için).
   */
  getRefreshToken(): string | null {
    return localStorage.getItem(this.refreshTokenKey);
  }

  /**
   * Kullanıcı profilini güncelle
   */
  updateUserProfile(updates: Partial<User>): Observable<ProfileUpdateResponse> {
    const user = this.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    return this.http.put<ProfileUpdateResponse>(`${this.apiUrl}/users/${user.id}/profile`, updates).pipe(
      tap((response: ProfileUpdateResponse) => {
        if (response.success && response.user) {
          // Mevcut kullanıcının izinlerini ve rolünü koru (sunucu yanıtında yoksa)
          const updatedUser: User = {
            ...user,
            ...response.user,
            role: response.user.role || user.role,
            allowedPages: response.user.allowedPages || user.allowedPages
          };
          // Local storage'ı güncelle
          localStorage.setItem(this.userKey, JSON.stringify(updatedUser));
          // BehaviorSubject'i güncelle
          this.currentUserSubject.next(updatedUser);
        }
      }),
      catchError(error => {
        console.error('Update profile API error:', error);
        // Fallback: Local update
        const updatedUser = { ...user, ...updates };
        localStorage.setItem(this.userKey, JSON.stringify(updatedUser));
        this.currentUserSubject.next(updatedUser);
        return of({ success: true, user: updatedUser });
      })
    );
  }

  /**
   * Kullanıcı tercihlerini güncelle
   */
  updateUserPreferences(preferences: Partial<UserPreferences>): Observable<any> {
    const user = this.getCurrentUser();
    if (!user) {
      return of({ success: false, message: this.translate.instant('HARDCODED.SESSION_NOT_FOUND') });
    }

    const updatedPreferences = { ...user.preferences, ...preferences };

    return this.updateUserProfile({ preferences: updatedPreferences });
  }

  /**
   * Fallback login (API çalışmıyorsa demo kullanıcıları kullan)
   */
  private fallbackLogin(username: string, password: string): Observable<LoginResponse> {
    ////console.log('Using fallback login for:', username);

    // Demo kullanıcıları
    const demoUsers: User[] = [
      {
        id: 'superuser-001',
        username: 'developer',
        displayName: this.translate.instant('HARDCODED.DEVELOPER') || 'Geliştirici (Superuser)',
        email: 'developer@supernovacorp.com',
        role: 'superuser',
        avatar: 'assets/avatars/developer.png',
        preferences: {
          theme: 'dark',
          language: 'tr',
          dashboardRefreshInterval: 10,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      },
      {
        id: 'admin-001',
        username: 'admin',
        displayName: this.translate.instant('HARDCODED.SYSTEM_ADMIN'),
        email: 'admin@supernovacorp.com',
        role: 'admin',
        avatar: 'assets/avatars/admin.png',
        preferences: {
          theme: 'light',
          language: 'tr',
          dashboardRefreshInterval: 30,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      },
      {
        id: 'admin-002',
        username: 'utku',
        displayName: this.translate.instant('HARDCODED.DEVELOPER'),
        email: 'utku@supernovacorp.com',
        role: 'superuser',
        avatar: 'assets/avatars/utku.png',
        preferences: {
          theme: 'dark',
          language: 'tr',
          dashboardRefreshInterval: 30,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      },
      {
        id: 'engineer-001',
        username: 'engineer',
        displayName: 'Mühendis (Industrial Automation)',
        email: 'engineer@supernovacorp.com',
        role: 'engineer',
        avatar: 'assets/default-avatar.png',
        preferences: {
          theme: 'dark',
          language: 'tr',
          dashboardRefreshInterval: 30,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      },
      {
        id: 'user-001',
        username: 'operator',
        displayName: this.translate.instant('HARDCODED.SYSTEM_OPERATOR'),
        email: 'operator@supernovacorp.com',
        role: 'operator',
        avatar: 'assets/default-avatar.png',
        preferences: {
          theme: 'dark',
          language: 'tr',
          dashboardRefreshInterval: 60,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      },
      {
        id: 'user-002',
        username: 'user',
        displayName: 'Standart Kullanıcı (Düz User)',
        email: 'user@supernovacorp.com',
        role: 'operator',
        avatar: 'assets/default-avatar.png',
        preferences: {
          theme: 'dark',
          language: 'tr',
          dashboardRefreshInterval: 60,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      },
      {
        id: 'viewer-001',
        username: 'viewer',
        displayName: this.translate.instant('HARDCODED.VIEWER'),
        email: 'viewer@supernovacorp.com',
        role: 'viewer',
        preferences: {
          theme: 'light',
          language: 'tr',
          dashboardRefreshInterval: 120,
          dateFormat: 'DD/MM/YYYY HH:mm',
          timezone: 'Europe/Istanbul'
        }
      }
    ];

    // Demo credentials (both secure and easy passwords accepted)
    const credentials: { [username: string]: string[] } = {
      'developer': ['Nova_Super#4302', 'dev123'],
      'admin': ['Nova_Admin#9841', 'admin123'],
      'engineer': ['Nova_Engineer#5544', 'engineer123'],
      'utku': ['utku123', 'Nova_Super#4302'],
      'operator': ['Nova_Operator#1520', 'operator123', 'user123'],
      'user': ['Nova_Operator#1520', 'user123', 'operator123'],
      'viewer': ['Nova_Viewer#7611', 'viewer123']
    };

    // Credential kontrolü
    const allowedPw = credentials[username];
    if (allowedPw && (allowedPw.includes(password) || password === '123456' || password === 'demo')) {
      const user = demoUsers.find(u => u.username === username);
      if (user) {
        // Fallback modunda backend erişilemediği için seviye + izinleri rolden türet.
        const LEVELS: Record<string, number> = { superuser: 100, admin: 80, engineer: 60, operator: 40, user: 40, viewer: 20 };
        const PAGE_PERMS: Record<string, string[]> = {
          engineer: ['page:dashboard','page:reports','page:network-map','page:alarms','page:table-explorer','page:template-builder','page:query-creator','page:python-workspace','page:settings','page:profile'],
          operator: ['page:dashboard','page:network-map','page:reports','page:alarms','page:settings','page:profile'],
          user: ['page:dashboard','page:network-map','page:reports','page:alarms','page:settings','page:profile'],
          viewer: ['page:dashboard','page:network-map','page:reports','page:alarms','page:profile'],
        };
        user.level = LEVELS[user.role] ?? 20;
        user.permissions = (user.role === 'superuser' || user.role === 'admin')
          ? ['*']
          : (PAGE_PERMS[user.role] ?? ['page:dashboard', 'page:profile']);
        user.allowedPages = user.permissions.filter(p => p.startsWith('page:')).map(p => p.substring(5));

        // Token ve kullanıcı bilgilerini sakla
        const token = `demo_token_${user.id}`;
        localStorage.setItem(this.tokenKey, token);
        localStorage.setItem(this.userKey, JSON.stringify(user));

        // BehaviorSubject'i güncelle
        this.currentUserSubject.next(user);

        return of({
          success: true,
          user: user,
          token: token
        });
      }
    }

    ////console.log('Fallback login failed for:', username);
    return of({
      success: false,
      message: this.translate.instant('HARDCODED.INVALID_CREDENTIALS')
    });
  }
}
