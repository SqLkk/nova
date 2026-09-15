import { Component, OnInit } from '@angular/core';
import { AdminService, Role, AdminUser, AdminUserDetail, SharingItem, SharingType } from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { PERMISSION_CATALOG, levelColor, levelRgba } from '../../services/permission-catalog';

type Tab = 'users' | 'roles' | 'sharing' | 'datasources';
type OverrideState = 'inherit' | 'grant' | 'deny';

@Component({
  selector: 'app-admin',
  templateUrl: './admin.component.html',
  styleUrls: ['./admin.component.scss'],
  standalone: false
})
export class AdminComponent implements OnInit {
  activeTab: Tab = 'users';
  catalog = PERMISSION_CATALOG;
  levelColor = levelColor;
  levelRgba = levelRgba;

  // küçük bildirim (toast)
  toast: { type: 'success' | 'error' | 'info'; msg: string } | null = null;
  private toastTimer: any;

  // ---- Users ----
  users: AdminUser[] = [];
  usersLoading = false;
  userSearch = '';
  userRoleFilter = '';
  selectedUser: AdminUserDetail | null = null;
  detailTab: 'general' | 'permissions' | 'security' | 'activity' = 'general';
  showUserModal = false;
  userModalMode: 'create' | 'edit' = 'create';
  userForm: any = {};
  resetPwdValue = '';
  showResetPwd = false;
  overrideState: Record<string, OverrideState> = {};

  // ---- Roles ----
  roles: Role[] = [];
  rolesLoading = false;
  showRoleModal = false;
  roleModalMode: 'create' | 'edit' = 'create';
  roleForm: any = {};
  rolePerms: Set<string> = new Set();

  // ---- Sharing ----
  sharingType: SharingType = 'templates';
  sharingItems: SharingItem[] = [];
  sharingLoading = false;
  showSharingModal = false;
  sharingItem: SharingItem | null = null;
  shareSelectedRoles: string[] = [];
  shareSelectedUsers: string[] = [];
  pickerUsers: any[] = [];
  sharingSearch = '';

  // ---- Datasources ----
  dataSources: any[] = [];
  showDsModal = false;
  dsTesting = false;
  dsSaving = false;
  dsTestResult: { success: boolean; message: string } | null = null;
  showDsPassword = false;
  dsForm: any = {};
  dbTypes = [
    { id: 'sqlite', name: 'SQLite (Yerel)' },
    { id: 'oracle', name: 'Oracle' },
    { id: 'postgres', name: 'PostgreSQL' },
    { id: 'mysql', name: 'MySQL' }
  ];

  constructor(
    public admin: AdminService,
    public auth: AuthService,
    private confirmSvc: ConfirmService
  ) {}

  ngOnInit(): void {
    this.loadUsers();
    this.loadRoles();
    this.loadDataSources();
    this.admin.getUsers().subscribe(u => this.pickerUsers = u);
    // varsayılan sekme: ilk görebildiği
    if (!this.showUsersTab && this.showRolesTab) this.activeTab = 'roles';
    else if (!this.showUsersTab && this.showSharingTab) this.activeTab = 'sharing';
    else if (!this.showUsersTab && this.showDatasourcesTab) this.activeTab = 'datasources';
    if (this.showSharingTab) this.loadSharing();
  }

  // ---- yardımcılar ----
  can(k: string): boolean { return this.auth.hasPermission(k); }
  get myLevel(): number { return this.auth.userLevel(); }
  notify(type: 'success' | 'error' | 'info', msg: string): void {
    this.toast = { type, msg };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast = null, 3600);
  }
  errMsg(e: any, fallback = 'İşlem başarısız'): string { return e?.error?.error || e?.error?.message || fallback; }
  permGroupLabel(group: string): string {
    const m: Record<string, string> = {
      pages: 'Sayfalar / Menü', users: 'Kullanıcı Yönetimi', roles: 'Rol Yönetimi',
      sharing: 'Nesne Yetkilendirmesi', datasources: 'Veri Kaynakları'
    };
    return m[group] || group;
  }
  permLabel(key: string): string {
    for (const g of this.catalog) for (const p of g.permissions) if (p.key === key) return p.label;
    return key;
  }
  initials(name: string): string {
    if (!name) return '?';
    return name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  }

  // sekme görünürlüğü
  get showUsersTab(): boolean { return this.can('user:view'); }
  get showRolesTab(): boolean { return this.can('role:view'); }
  get showSharingTab(): boolean {
    return this.can('share:templates') || this.can('share:paths') || this.can('share:queries') || this.can('share:scripts') || this.can('share:dashboards');
  }
  get showDatasourcesTab(): boolean { return this.can('datasource:view'); }

  // ================= USERS =================
  loadUsers(): void {
    if (!this.showUsersTab) return;
    this.usersLoading = true;
    this.admin.getAdminUsers().subscribe({
      next: d => { this.users = d; this.usersLoading = false; },
      error: () => { this.usersLoading = false; }
    });
  }
  get filteredUsers(): AdminUser[] {
    const q = this.userSearch.trim().toLowerCase();
    return this.users.filter(u =>
      (!q || `${u.username} ${u.displayName} ${u.email}`.toLowerCase().includes(q)) &&
      (!this.userRoleFilter || u.roleKey === this.userRoleFilter)
    );
  }
  assignableRoles(): Role[] { return this.roles.filter(r => r.level < this.myLevel); }
  openUserCreate(): void {
    this.userModalMode = 'create';
    const first = this.assignableRoles()[0];
    this.userForm = { username: '', displayName: '', email: '', roleId: first?.id || '', password: '', isActive: true };
    this.showUserModal = true;
  }
  openUserEdit(u: AdminUser): void {
    this.userModalMode = 'edit';
    this.userForm = { id: u.id, username: u.username, displayName: u.displayName, email: u.email, roleId: u.roleId, isActive: u.isActive };
    this.showUserModal = true;
  }
  saveUser(): void {
    if (this.userModalMode === 'create') {
      if (!this.userForm.username || !this.userForm.password || !this.userForm.roleId) {
        this.notify('error', 'Kullanıcı adı, şifre ve rol zorunludur.'); return;
      }
      this.admin.createAdminUser(this.userForm).subscribe({
        next: () => { this.showUserModal = false; this.notify('success', 'Kullanıcı oluşturuldu'); this.loadUsers(); },
        error: e => this.notify('error', this.errMsg(e))
      });
    } else {
      this.admin.updateAdminUser(this.userForm.id, {
        displayName: this.userForm.displayName, email: this.userForm.email,
        roleId: this.userForm.roleId, isActive: this.userForm.isActive
      }).subscribe({
        next: () => {
          this.showUserModal = false; this.notify('success', 'Kullanıcı güncellendi'); this.loadUsers();
          if (this.selectedUser?.id === this.userForm.id) this.selectUser(this.userForm.id);
        },
        error: e => this.notify('error', this.errMsg(e))
      });
    }
  }
  async deleteUser(u: AdminUser): Promise<void> {
    if (!u.canManage || !this.can('user:delete')) return;
    if (!await this.confirmSvc.confirm(`${u.displayName || u.username} kullanıcısı silinsin mi? Bu işlem geri alınamaz.`)) return;
    this.admin.deleteAdminUser(u.id).subscribe({
      next: () => { this.notify('success', 'Kullanıcı silindi'); this.loadUsers(); if (this.selectedUser?.id === u.id) this.selectedUser = null; },
      error: e => this.notify('error', this.errMsg(e))
    });
  }
  selectUser(id: string): void {
    this.detailTab = 'general';
    this.showResetPwd = false; this.resetPwdValue = '';
    this.admin.getAdminUser(id).subscribe({
      next: d => { this.selectedUser = d; this.initOverrides(d); },
      error: e => this.notify('error', this.errMsg(e))
    });
  }
  closeDetail(): void { this.selectedUser = null; }
  initOverrides(d: AdminUserDetail): void {
    this.overrideState = {};
    for (const g of this.catalog) for (const p of g.permissions) this.overrideState[p.key] = 'inherit';
    for (const o of (d.overrides || [])) this.overrideState[o.permission_key] = o.granted ? 'grant' : 'deny';
  }
  saveOverrides(): void {
    if (!this.selectedUser) return;
    const overrides = Object.entries(this.overrideState)
      .filter(([, v]) => v !== 'inherit')
      .map(([k, v]) => ({ permission_key: k, granted: v === 'grant' ? 1 : 0 }));
    this.admin.setUserPermissions(this.selectedUser.id, overrides).subscribe({
      next: () => { this.notify('success', 'İzinler kaydedildi'); this.selectUser(this.selectedUser!.id); },
      error: e => this.notify('error', this.errMsg(e))
    });
  }
  resetPassword(): void {
    if (!this.selectedUser) return;
    if (!this.resetPwdValue || this.resetPwdValue.length < 4) { this.notify('error', 'Şifre en az 4 karakter olmalı'); return; }
    this.admin.resetUserPassword(this.selectedUser.id, this.resetPwdValue).subscribe({
      next: () => { this.resetPwdValue = ''; this.showResetPwd = false; this.notify('success', 'Şifre güncellendi'); },
      error: e => this.notify('error', this.errMsg(e))
    });
  }
  toggleActive(u: AdminUserDetail): void {
    this.admin.updateAdminUser(u.id, { isActive: !u.isActive }).subscribe({
      next: () => { this.notify('success', u.isActive ? 'Pasifleştirildi' : 'Aktifleştirildi'); this.selectUser(u.id); this.loadUsers(); },
      error: e => this.notify('error', this.errMsg(e))
    });
  }
  groupedEffective(): { group: string; items: string[] }[] {
    const have = new Set(this.selectedUser?.permissions || []);
    return this.catalog
      .map(g => ({ group: g.group, items: g.permissions.filter(p => have.has(p.key)).map(p => p.key) }))
      .filter(g => g.items.length);
  }

  // ================= ROLES =================
  loadRoles(): void {
    if (!this.showRolesTab) return;
    this.rolesLoading = true;
    this.admin.getRoles().subscribe({
      next: d => { this.roles = d; this.rolesLoading = false; },
      error: () => { this.rolesLoading = false; }
    });
  }
  openRoleCreate(): void {
    this.roleModalMode = 'create';
    this.roleForm = { name: '', key: '', description: '', level: Math.max(20, this.myLevel - 1), color: '#a78bfa', isSystem: false };
    this.rolePerms = new Set();
    this.showRoleModal = true;
  }
  openRoleEdit(r: Role): void {
    this.roleModalMode = 'edit';
    this.roleForm = { id: r.id, name: r.name, key: r.key, description: r.description, level: r.level, color: r.color, isSystem: r.isSystem };
    this.rolePerms = new Set(r.permissions || []);
    this.showRoleModal = true;
  }
  permChecked(k: string): boolean { return this.rolePerms.has(k); }
  togglePerm(k: string): void { this.rolePerms.has(k) ? this.rolePerms.delete(k) : this.rolePerms.add(k); }
  toggleGroupAll(group: string, on: boolean): void {
    const g = this.catalog.find(x => x.group === group);
    if (!g) return;
    g.permissions.forEach(p => on ? this.rolePerms.add(p.key) : this.rolePerms.delete(p.key));
  }
  saveRole(): void {
    if (!this.roleForm.name) { this.notify('error', 'Rol adı zorunludur'); return; }
    const dto: any = {
      name: this.roleForm.name,
      description: this.roleForm.description,
      color: this.roleForm.color,
      permissions: Array.from(this.rolePerms)
    };
    if (!this.roleForm.isSystem) dto.level = this.roleForm.level;
    if (this.roleModalMode === 'create') {
      dto.key = this.roleForm.key;
      this.admin.createRole(dto).subscribe({
        next: () => { this.showRoleModal = false; this.notify('success', 'Rol oluşturuldu'); this.loadRoles(); },
        error: e => this.notify('error', this.errMsg(e))
      });
    } else {
      this.admin.updateRole(this.roleForm.id, dto).subscribe({
        next: () => { this.showRoleModal = false; this.notify('success', 'Rol güncellendi'); this.loadRoles(); },
        error: e => this.notify('error', this.errMsg(e))
      });
    }
  }
  async deleteRole(r: Role): Promise<void> {
    if (!r.canManage || r.isSystem || !this.can('role:delete')) return;
    if (!await this.confirmSvc.confirm(`"${r.name}" rolü silinsin mi?`)) return;
    this.admin.deleteRole(r.id).subscribe({
      next: () => { this.notify('success', 'Rol silindi'); this.loadRoles(); },
      error: e => this.notify('error', this.errMsg(e))
    });
  }

  // ================= SHARING =================
  loadSharing(): void {
    if (!this.showSharingTab) return;
    if (!this.can(this._sharePermFor(this.sharingType))) { this.sharingItems = []; return; }
    this.sharingLoading = true;
    this.admin.listSharing(this.sharingType).subscribe({
      next: d => { this.sharingItems = d; this.sharingLoading = false; },
      error: () => { this.sharingLoading = false; }
    });
  }
  private _sharePermFor(t: SharingType): string { return `share:${t === 'scripts' ? 'scripts' : t}`; }
  switchSharingType(t: SharingType): void { this.sharingType = t; this.sharingSearch = ''; this.loadSharing(); }
  get filteredSharing(): SharingItem[] {
    const q = this.sharingSearch.trim().toLowerCase();
    return this.sharingItems.filter(i => !q || i.name.toLowerCase().includes(q));
  }
  canShareType(t: SharingType): boolean { return this.can(`share:${t}`); }
  openSharing(item: SharingItem): void {
    this.sharingItem = item;
    this.shareSelectedRoles = [...item.allowedRoles];
    this.shareSelectedUsers = [...item.allowedUsers];
    this.showSharingModal = true;
  }
  toggleShareRole(k: string): void {
    const i = this.shareSelectedRoles.indexOf(k);
    if (i >= 0) this.shareSelectedRoles.splice(i, 1); else this.shareSelectedRoles.push(k);
  }
  toggleShareUser(id: string): void {
    const i = this.shareSelectedUsers.indexOf(id);
    if (i >= 0) this.shareSelectedUsers.splice(i, 1); else this.shareSelectedUsers.push(id);
  }
  saveSharing(): void {
    if (!this.sharingItem) return;
    this.admin.updateSharing(this.sharingType, this.sharingItem.id, this.shareSelectedRoles, this.shareSelectedUsers).subscribe({
      next: () => { this.showSharingModal = false; this.notify('success', 'Paylaşım güncellendi'); this.loadSharing(); },
      error: e => this.notify('error', this.errMsg(e))
    });
  }
  sharedSummary(item: SharingItem): string {
    const n = item.allowedRoles.length + item.allowedUsers.length;
    if (!n) return 'Sadece sahip / admin';
    const parts: string[] = [];
    if (item.allowedRoles.length) parts.push(`${item.allowedRoles.length} rol`);
    if (item.allowedUsers.length) parts.push(`${item.allowedUsers.length} kullanıcı`);
    return parts.join(' + ');
  }
  ownerName(ownerId: string): string {
    const u = this.pickerUsers.find(x => x.id === ownerId || x.username === ownerId);
    return u ? (u.display_name || u.username) : (ownerId === 'system' ? 'Sistem' : (ownerId || '—'));
  }

  // ================= DATASOURCES =================
  loadDataSources(): void {
    if (!this.showDatasourcesTab) return;
    this.admin.getDatasources().subscribe(d => this.dataSources = d);
  }
  openDsCreate(): void {
    this.dsForm = { name: '', db_type: 'sqlite', host: '', port: 0, username: '', password: '', database_name: '' };
    this.dsTestResult = null;
    this.showDsModal = true;
  }
  testDs(): void {
    this.dsTesting = true; this.dsTestResult = null;
    this.admin.testDatasource(this.dsForm).subscribe({
      next: () => { this.dsTesting = false; this.dsTestResult = { success: true, message: 'Bağlantı başarılı' }; },
      error: e => { this.dsTesting = false; this.dsTestResult = { success: false, message: this.errMsg(e, 'Bağlantı başarısız') }; }
    });
  }
  saveDs(): void {
    if (!this.dsForm.name) { this.notify('error', 'İsim zorunludur'); return; }
    this.dsSaving = true; this.dsTestResult = null;
    this.admin.testDatasource(this.dsForm).subscribe({
      next: () => {
        this.admin.createDatasource(this.dsForm).subscribe({
          next: () => { this.dsSaving = false; this.showDsModal = false; this.notify('success', 'Veri kaynağı eklendi'); this.loadDataSources(); },
          error: e => { this.dsSaving = false; this.dsTestResult = { success: false, message: 'Test OK, kayıt başarısız: ' + this.errMsg(e) }; }
        });
      },
      error: e => { this.dsSaving = false; this.dsTestResult = { success: false, message: 'Bağlantı başarısız: ' + this.errMsg(e) }; }
    });
  }
}
