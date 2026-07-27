/**
 * İzin kataloğu — backend (db/database.py PERMISSION_CATALOG) ile aynı anahtarları
 * mirror'lar. Admin panelindeki izin matrisi UI'ı ve hasPermission() bunu kullanır.
 *
 * Etiketler i18n (assets/i18n/*.json → PERMISSIONS.*) tarafından sağlanır; buradaki
 * `label` yalnızca fallback'tir.
 */

export interface PermissionDef {
  key: string;
  label: string;
}

export interface PermissionGroup {
  group: string;
  /** i18n anahtarı: PERMISSIONS.GROUP_<group> */
  permissions: PermissionDef[];
}

export const ROLE_LEVELS: Record<string, number> = {
  superuser: 100,
  admin: 80,
  engineer: 60,
  operator: 40,
  viewer: 20,
};

export const PERMISSION_CATALOG: PermissionGroup[] = [
  {
    group: 'pages',
    permissions: [
      { key: 'page:dashboard', label: 'Dashboard' },
      { key: 'page:reports', label: 'Raporlar' },
      { key: 'page:network-map', label: 'Network Map' },
      { key: 'page:alarms', label: 'Alarmlar' },
      { key: 'page:table-explorer', label: 'Table Explorer' },
      { key: 'page:template-builder', label: 'Template Builder' },
      { key: 'page:query-creator', label: 'Query Creator' },
      { key: 'page:python-workspace', label: 'Python Workspace' },
      { key: 'page:admin', label: 'Admin Panel' },
      { key: 'page:settings', label: 'Ayarlar' },
      { key: 'page:profile', label: 'Profil' },
    ],
  },
  {
    group: 'users',
    permissions: [
      { key: 'user:view', label: 'Kullanıcıları görüntüle' },
      { key: 'user:create', label: 'Kullanıcı oluştur' },
      { key: 'user:edit', label: 'Kullanıcı düzenle' },
      { key: 'user:delete', label: 'Kullanıcı sil' },
      { key: 'user:reset-password', label: 'Şifre sıfırla' },
      { key: 'user:activate', label: 'Aktif/pasif yap' },
    ],
  },
  {
    group: 'roles',
    permissions: [
      { key: 'role:view', label: 'Rolleri görüntüle' },
      { key: 'role:create', label: 'Rol oluştur' },
      { key: 'role:edit', label: 'Rol düzenle' },
      { key: 'role:delete', label: 'Rol sil' },
    ],
  },
  {
    group: 'sharing',
    permissions: [
      { key: 'share:templates', label: 'Template paylaşımı' },
      { key: 'share:paths', label: 'Network-map / path paylaşımı' },
      { key: 'share:queries', label: 'Sorgu paylaşımı' },
      { key: 'share:scripts', label: 'Python script paylaşımı' },
    ],
  },
  {
    group: 'datasources',
    permissions: [
      { key: 'datasource:view', label: 'Veri kaynaklarını görüntüle' },
      { key: 'datasource:manage', label: 'Veri kaynaklarını yönet' },
    ],
  },
];

/** Tüm izin anahtarlarının düz listesi. */
export const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.flatMap(g => g.permissions.map(p => p.key));

/** Sayfa erişim anahtarları (page:*). */
export const PAGE_PERMISSION_KEYS: string[] = ALL_PERMISSION_KEYS.filter(k => k.startsWith('page:'));

/** Bir seviyenin rengini (hex) döndürür — color/border/gradient için. */
export function levelColor(level: number | undefined | null): string {
  const l = level ?? 0;
  if (l >= 100) return '#F5B301'; // gold
  if (l >= 80) return '#FF7A1A'; // flare
  if (l >= 60) return '#7C8DB5'; // lunar
  if (l >= 40) return '#34D399'; // emerald
  return '#A39A89'; // muted
}

function _hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Bir seviye için şeffaflıklı arka plan (rgba) — badge arka planları için. */
export function levelRgba(level: number | undefined | null, alpha = 0.12): string {
  const [r, g, b] = _hexToRgb(levelColor(level));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
