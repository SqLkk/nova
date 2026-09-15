import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { AdminService, AdminUser } from '../../services/admin.service';
import { TemplateBuilderService, TemplateSummary } from '../../services/template-builder.service';
import { ROLE_LEVELS } from '../../services/permission-catalog';
import { ConfirmService } from '../../services/confirm.service';

/**
 * Reports & Templates merkezi.
 *
 * Backend'de "rapor = template"tir. Bu sayfa `/api/templates` üzerinde şablon
 * kütüphanesini sunar: görünürlük rozetleri (ACL), tek tık Excel üretimi
 * (render → .xlsx), düzenleme (template-builder editörüne bağlanır), kopyalama,
 * silme ve görünürlük/paylaşım yönetimi. Backend ACL'i zaten doğru modelde
 * (owner_id + allowed_roles + allowed_users); UI sadece doğru gösterir/yönetir.
 */
type VisibilityKind = 'private' | 'roles' | 'users' | 'shared-with-me';

interface VisibilityInfo {
  kind: VisibilityKind;
  roles: string[];
  userCount: number;
  sharedWithMe: boolean;
}

@Component({
  standalone: false,
  selector: 'app-reports',
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.scss'],
})
export class ReportsComponent implements OnInit, OnDestroy {
  templates: TemplateSummary[] = [];
  filtered: TemplateSummary[] = [];
  loading = true;
  error: string | null = null;

  searchTerm = '';
  visibilityFilter: 'all' | 'mine' | 'shared' = 'all';

  currentUserId = '';
  /** Render (Excel üretimi) sırasındaki şablon id'leri. */
  generating = new Set<string>();

  // Toast
  toast = '';
  private toastTimer: any;

  // ---- Paylaşım / görünürlük modalı ----
  showSharing = false;
  shareSaving = false;
  shareTemplate: TemplateSummary | null = null;
  shareRoles = new Set<string>();
  shareUsers: string[] = [];
  shareUserInput = '';
  shareUsersList: AdminUser[] = [];
  loadingUsers = false;

  /** Rolle checklist'i için sabit hiyerarşi (backend çağrısı gerekmez). */
  readonly roleKeys = Object.keys(ROLE_LEVELS);

  private subs = new Subscription();

  constructor(
    private router: Router,
    private auth: AuthService,
    private admin: AdminService,
    private templateService: TemplateBuilderService,
    private confirm: ConfirmService,
    private translate: TranslateService,
  ) {}

  ngOnInit(): void {
    const me = this.auth.getCurrentUser();
    this.currentUserId = me?.id || '';
    this.loadTemplates();
    // Admin/superuser paylaşım modalı için kullanıcı listesini önceden yükle.
    if (this.canAllManage()) this.loadUsersList();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // ---- Yükleme ----

  loadTemplates(): void {
    this.loading = true;
    this.error = null;
    const sub = this.templateService.list().subscribe({
      next: (res) => {
        this.templates = res.data || [];
        this.applyFilters();
        this.loading = false;
      },
      error: (err) => {
        console.error('Templates load error:', err);
        this.error = this.translate.instant('REPORTS.REPORTS_LOAD_ERROR');
        this.loading = false;
      },
    });
    this.subs.add(sub);
  }

  private loadUsersList(): void {
    this.loadingUsers = true;
    const sub = this.admin.getAdminUsers().subscribe({
      next: (users) => {
        // Kendi kullanıcımızı listeden çıkar (kendiyle paylaşma anlamsız).
        this.shareUsersList = (users || []).filter((u) => u.id !== this.currentUserId);
        this.loadingUsers = false;
      },
      error: () => { this.shareUsersList = []; this.loadingUsers = false; },
    });
    this.subs.add(sub);
  }

  // ---- Filtreleme / arama ----

  applyFilters(): void {
    const term = this.searchTerm.trim().toLowerCase();
    let out = this.templates;
    if (term) {
      out = out.filter((t) =>
        (t.name || '').toLowerCase().includes(term) ||
        (t.description || '').toLowerCase().includes(term));
    }
    if (this.visibilityFilter === 'mine') {
      out = out.filter((t) => t.owner === this.currentUserId);
    } else if (this.visibilityFilter === 'shared') {
      out = out.filter((t) => t.owner !== this.currentUserId);
    }
    this.filtered = out;
  }

  onSearch(): void { this.applyFilters(); }
  setFilter(f: 'all' | 'mine' | 'shared'): void {
    this.visibilityFilter = f;
    this.applyFilters();
  }

  // ---- Yetki gate'leri (backend ACL ile birebir uyumlu) ----
  // _can_modify_query = admin/superuser VEYA sahip.
  isOwner(t: TemplateSummary): boolean { return !!t.owner && t.owner === this.currentUserId; }
  canAllManage(): boolean { return this.auth.isAdmin() || this.auth.isSuperUser(); }
  canModify(t: TemplateSummary): boolean { return this.isOwner(t) || this.canAllManage(); }
  // Görünürlük: _can_modify_query VEYA share:templates.
  canManageVisibility(t: TemplateSummary): boolean {
    return this.canModify(t) || this.auth.hasPermission('share:templates');
  }
  /** Paylaşım modalında kullanıcı checklist'i (admin) mi, yoksa username input mu? */
  userChecklistMode(): boolean { return this.canAllManage(); }

  // ---- Görünürlük rozeti ----

  visibilityOf(t: TemplateSummary): VisibilityInfo {
    const roles = t.allowedRoles || [];
    const users = t.allowedUsers || [];
    const sharedWithMe = !this.isOwner(t);
    let kind: VisibilityKind;
    if (roles.length) kind = 'roles';
    else if (users.length) kind = 'users';
    else kind = sharedWithMe ? 'shared-with-me' : 'private';
    return { kind, roles, userCount: users.length, sharedWithMe };
  }

  // ---- Aksiyonlar ----

  newTemplate(): void {
    this.router.navigate(['/template-builder']);
  }

  edit(t: TemplateSummary): void {
    if (!this.canModify(t)) return;
    this.router.navigate(['/template-builder', t.id]);
  }

  generate(t: TemplateSummary): void {
    if (this.generating.has(t.id)) return;
    this.generating.add(t.id);
    const sub = this.templateService.render(t.id).subscribe({
      next: (blob) => {
        this.generating.delete(t.id);
        this.downloadBlob(blob, `${(t.name || 'template').replace(/\s+/g, '_')}.xlsx`);
        this.notify(this.translate.instant('REPORTS.GENERATED'));
      },
      error: (e) => {
        this.generating.delete(t.id);
        const detail = e?.error?.error ? `: ${e.error.error}` : '';
        this.notify(this.translate.instant('REPORTS.GENERATE_ERROR') + detail);
      },
    });
    this.subs.add(sub);
  }

  isGenerating(id: string): boolean { return this.generating.has(id); }

  duplicate(t: TemplateSummary): void {
    const sub = this.templateService.duplicate(t.id, `${t.name} (copy)`).subscribe({
      next: () => {
        this.notify(this.translate.instant('REPORTS.DUPLICATED'));
        this.loadTemplates();
      },
      error: () => this.notify(this.translate.instant('REPORTS.DUPLICATE_ERROR')),
    });
    this.subs.add(sub);
  }

  async delete(t: TemplateSummary): Promise<void> {
    if (!this.canModify(t)) return;
    const msg = this.translate.instant('REPORTS.DELETE_TEMPLATE_CONFIRM', { name: t.name });
    if (!await this.confirm.confirm(msg)) return;
    const sub = this.templateService.remove(t.id).subscribe({
      next: () => {
        this.notify(this.translate.instant('REPORTS.TEMPLATE_DELETED'));
        this.loadTemplates();
      },
      error: () => this.notify(this.translate.instant('REPORTS.DELETE_ERROR')),
    });
    this.subs.add(sub);
  }

  // ---- Paylaşım / görünürlük modalı ----

  openSharing(t: TemplateSummary): void {
    if (!this.canManageVisibility(t)) return;
    this.shareTemplate = t;
    this.shareRoles = new Set(t.allowedRoles || []);
    this.shareUsers = [...(t.allowedUsers || [])];
    this.shareUserInput = '';
    this.showSharing = true;
    if (this.userChecklistMode() && !this.shareUsersList.length && !this.loadingUsers) {
      this.loadUsersList();
    }
  }

  closeSharing(): void {
    this.showSharing = false;
    this.shareTemplate = null;
  }

  toggleRole(key: string): void {
    if (this.shareRoles.has(key)) this.shareRoles.delete(key);
    else this.shareRoles.add(key);
  }
  isRoleOn(key: string): boolean { return this.shareRoles.has(key); }

  /** Admin: kullanıcı checklist'i üzerinden aç/kapat. */
  toggleUser(id: string): void {
    const i = this.shareUsers.indexOf(id);
    if (i >= 0) this.shareUsers.splice(i, 1);
    else this.shareUsers.push(id);
  }
  isUserOn(id: string): boolean { return this.shareUsers.includes(id); }

  /** Sahip (admin olmayan) için username ile chip ekle. Backend username/uid eşler. */
  addUserInput(): void {
    const v = this.shareUserInput.trim();
    if (!v) return;
    if (!this.shareUsers.some((u) => u.toLowerCase() === v.toLowerCase())) {
      this.shareUsers.push(v);
    }
    this.shareUserInput = '';
  }
  removeUser(name: string): void {
    this.shareUsers = this.shareUsers.filter((u) => u !== name);
  }

  saveSharing(): void {
    const t = this.shareTemplate;
    if (!t) return;
    this.shareSaving = true;
    const sub = this.templateService
      .updateSharing(t.id, [...this.shareRoles], this.shareUsers)
      .subscribe({
        next: () => {
          this.shareSaving = false;
          this.notify(this.translate.instant('REPORTS.SHARE_SAVED'));
          this.closeSharing();
          this.loadTemplates();
        },
        error: () => {
          this.shareSaving = false;
          this.notify(this.translate.instant('REPORTS.SHARE_ERROR'));
        },
      });
    this.subs.add(sub);
  }

  // ---- Yardımcılar ----

  roleLabel(key: string): string {
    return this.translate.instant(`REPORTS.ROLE_${key.toUpperCase()}`);
  }

  ownerDisplay(ownerId?: string): string {
    if (!ownerId) return '—';
    if (ownerId === this.currentUserId) return this.translate.instant('REPORTS.YOU');
    const u = this.shareUsersList.find((x) => x.id === ownerId);
    return u ? (u.displayName || u.username) : ownerId;
  }

  relTime(iso?: string): string {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '—';
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60000);
    if (m < 1) return this.translate.instant('REPORTS.REL_JUST_NOW');
    if (m < 60) return this.translate.instant('REPORTS.REL_MIN_AGO', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return this.translate.instant('REPORTS.REL_HOURS_AGO', { count: h });
    const d = Math.floor(h / 24);
    if (d < 30) return this.translate.instant('REPORTS.REL_DAYS_AGO', { count: d });
    return new Date(iso).toLocaleDateString();
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private notify(msg: string): void {
    this.toast = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = ''), 3500);
  }

  hideToast(): void { this.toast = ''; }
}
