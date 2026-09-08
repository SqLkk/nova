import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../environments/environment';

// ---- Tipler (admin paneli) -------------------------------------------------

export interface Role {
  id: string; key: string; name: string; description: string;
  level: number; isSystem: boolean; isActive: boolean; color: string;
  memberCount: number; permissions: string[]; canManage: boolean;
  createdAt?: string; updatedAt?: string;
}

export interface AdminUser {
  id: string; username: string; displayName: string; email: string;
  role: string; roleId: string; roleKey: string; roleName: string;
  level: number; roleColor?: string; isActive: boolean;
  canManage: boolean; createdAt?: string; updatedAt?: string;
}

export interface AdminUserDetail extends AdminUser {
  permissions: string[];
  allowedPages: string[];
  overrides: { permission_key: string; granted: number }[];
  ownedCounts: { templates: number; paths: number; queries: number; scripts: number; dashboards?: number };
}

export interface SharingItem {
  id: string; name: string; owner: string; ownerName: string;
  allowedRoles: string[]; allowedUsers: string[];
}

export type SharingType = 'templates' | 'paths' | 'queries' | 'scripts' | 'dashboards';

@Injectable({ providedIn: 'root' })
export class AdminService {
  private apiUrl = environment.apiUrl || 'http://localhost:5001/api';

  constructor(private http: HttpClient) {}

  /** Başarılı yanıttan .data'yı çıkarır; değilse ham yanıtı döndürür. */
  private get<T>(path: string): Observable<T> {
    return this.http.get<any>(`${this.apiUrl}${path}`).pipe(
      map(res => (res && res.success ? (res.data as T) : (res as any))),
      catchError(e => throwError(() => e))
    );
  }

  private call(path: string, method: 'post' | 'put' | 'delete', body?: any): Observable<any> {
    const req = method === 'post' ? this.http.post(`${this.apiUrl}${path}`, body ?? {})
              : method === 'put' ? this.http.put(`${this.apiUrl}${path}`, body ?? {})
              : this.http.delete(`${this.apiUrl}${path}`);
    return req.pipe(catchError(e => throwError(() => e)));
  }

  // ---- İzin kataloğu -------------------------------------------------------
  getPermissionCatalog(): Observable<any[]> {
    return this.get<any[]>('/permissions');
  }

  // ---- Roller --------------------------------------------------------------
  getRoles(): Observable<Role[]> {
    return this.get<Role[]>('/roles');
  }
  createRole(dto: Partial<Role>): Observable<any> {
    return this.call('/roles', 'post', dto);
  }
  updateRole(id: string, dto: Partial<Role>): Observable<any> {
    return this.call(`/roles/${id}`, 'put', dto);
  }
  deleteRole(id: string): Observable<any> {
    return this.call(`/roles/${id}`, 'delete');
  }

  // ---- Kullanıcı yönetimi --------------------------------------------------
  getAdminUsers(): Observable<AdminUser[]> {
    return this.get<AdminUser[]>('/admin/users');
  }
  getAdminUser(id: string): Observable<AdminUserDetail> {
    return this.get<AdminUserDetail>(`/admin/users/${id}`);
  }
  createAdminUser(dto: any): Observable<any> {
    return this.call('/admin/users', 'post', dto);
  }
  updateAdminUser(id: string, dto: any): Observable<any> {
    return this.call(`/admin/users/${id}`, 'put', dto);
  }
  deleteAdminUser(id: string): Observable<any> {
    return this.call(`/admin/users/${id}`, 'delete');
  }
  resetUserPassword(id: string, password: string): Observable<any> {
    return this.call(`/admin/users/${id}/password`, 'put', { password });
  }
  setUserPermissions(id: string, overrides: any[]): Observable<any> {
    return this.call(`/admin/users/${id}/permissions`, 'put', { overrides });
  }

  // ---- Nesne yetkilendirme (paylaşım) -------------------------------------
  listSharing(type: SharingType): Observable<SharingItem[]> {
    return this.get<SharingItem[]>(`/admin/sharing/${type}`);
  }
  updateSharing(type: SharingType, id: string, allowedRoles: string[], allowedUsers: string[]): Observable<any> {
    return this.call(`/admin/sharing/${type}/${id}`, 'put', { allowedRoles, allowedUsers });
  }

  // ---- Veri kaynakları -----------------------------------------------------
  getDatasources(): Observable<any[]> {
    return this.http.get<any>(`${this.apiUrl}/datasources`).pipe(
      map(res => (res && res.success ? res.data : [])),
      catchError(() => of([]))
    );
  }
  testDatasource(dto: any): Observable<any> {
    return this.call('/datasources/test', 'post', dto);
  }
  createDatasource(dto: any): Observable<any> {
    return this.call('/datasources', 'post', dto);
  }

  // ---- Legacy (reports.component uyumu) ------------------------------------
  /** Tüm kullanıcıların özet listesi (paylaşım seçicileri için). */
  getUsers(): Observable<any[]> {
    return this.http.get<any>(`${this.apiUrl}/users`).pipe(
      map(res => (res && res.success ? res.data : [])),
      catchError(() => of([]))
    );
  }
  getSystemSettings(): Observable<any> { return of({ theme: 'supernova', version: '2.0.0' }); }
  syncDatasources(): Observable<any> { return of({ success: true }); }
}
