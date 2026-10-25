import { TemplateDocument } from '../models/template-document.model';
import { PathDef, BuiltStructure, PathNode, PathConfig, PathStructure } from '../models/path-def.model';

export interface MockUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  level: number;
  permissions: string[];
  allowedPages: string[];
  avatar: string;
  preferences?: Record<string, any>;
}

export const MOCK_USERS: MockUser[] = [
  {
    id: 'usr_utku',
    username: 'utku',
    displayName: 'Baş Mimar (Süper Kullanıcı)',
    email: 'architect@nov4.com.tr',
    role: 'superuser',
    level: 100,
    permissions: ['*'],
    allowedPages: [
      'admin', 'dashboard', 'reports', 'network-map', 'alarms',
      'table-explorer', 'template-builder', 'query-creator', 'python-workspace',
      'settings', 'profile',
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 15 },
  },
  {
    id: 'usr_admin',
    username: 'admin',
    displayName: 'Sistem Yöneticisi',
    email: 'admin@nov4.com.tr',
    role: 'admin',
    level: 80,
    permissions: ['*'],
    allowedPages: [
      'admin', 'dashboard', 'reports', 'network-map', 'alarms',
      'table-explorer', 'template-builder', 'query-creator', 'python-workspace',
      'settings', 'profile',
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 15 },
  },
  {
    id: 'usr_engineer',
    username: 'engineer',
    displayName: 'Otomasyon & Veri Mühendisi',
    email: 'engineer@nov4.com.tr',
    role: 'engineer',
    level: 60,
    permissions: [
      'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
      'page:table-explorer', 'page:template-builder', 'page:query-creator',
      'page:python-workspace', 'page:settings', 'page:profile',
      'share:templates', 'share:paths', 'share:queries', 'share:scripts', 'share:dashboards',
      'datasource:view', 'export:reports',
    ],
    allowedPages: [
      'dashboard', 'reports', 'network-map', 'alarms',
      'table-explorer', 'template-builder', 'query-creator', 'python-workspace',
      'settings', 'profile',
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 20 },
  },
  {
    id: 'usr_operator',
    username: 'operator',
    displayName: 'Vardiya Hat Operatörü',
    email: 'operator@nov4.com.tr',
    role: 'operator',
    level: 40,
    permissions: [
      'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
      'page:profile', 'page:settings', 'export:reports',
    ],
    allowedPages: ['dashboard', 'reports', 'network-map', 'alarms', 'profile', 'settings'],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 30 },
  },
  {
    id: 'usr_viewer',
    username: 'viewer',
    displayName: 'Yönetim İzleyici (Salt Okunur)',
    email: 'viewer@nov4.com.tr',
    role: 'viewer',
    level: 20,
    permissions: ['page:dashboard', 'page:reports', 'page:network-map', 'page:alarms', 'page:profile'],
    allowedPages: ['dashboard', 'reports', 'network-map', 'alarms', 'profile'],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 60 },
  },
];

// ============================================================================
// 1. RICH INDUSTRIAL TABLES (6 TABLES)
// ============================================================================

export const DEMO_TABLES: Record<string, { columns: Array<{ name: string; dataType: string; isPrimaryKey?: boolean; nullable?: boolean }>; rows: Record<string, any>[] }> = {
  locations: {
    columns: [
      { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
      { name: 'code', dataType: 'TEXT', nullable: false },
      { name: 'name', dataType: 'TEXT', nullable: false },
      { name: 'city', dataType: 'TEXT', nullable: false },
      { name: 'daily_capacity', dataType: 'INTEGER', nullable: false },
      { name: 'plant_oee_pct', dataType: 'REAL', nullable: false },
    ],
    rows: [
      { id: 1, code: 'PLT-IZM', name: 'İzmir Ana Gövde & Robotik Kampüsü', city: 'İzmir', daily_capacity: 1850, plant_oee_pct: 91.4 },
      { id: 2, code: 'PLT-BRS', name: 'Bursa Güç Aktarma & CNC Tesisi', city: 'Bursa', daily_capacity: 1420, plant_oee_pct: 84.8 },
      { id: 3, code: 'PLT-KOC', name: 'Kocaeli Batarya & Elektronik Fabrikası', city: 'Kocaeli', daily_capacity: 2200, plant_oee_pct: 93.2 },
      { id: 4, code: 'PLT-ESK', name: 'Eskişehir Hassas Döküm & Kalite Merkezi', city: 'Eskişehir', daily_capacity: 960, plant_oee_pct: 88.1 },
    ],
  },
  production_lines: {
    columns: [
      { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
      { name: 'line_code', dataType: 'TEXT', nullable: false },
      { name: 'line_name', dataType: 'TEXT', nullable: false },
      { name: 'location_id', dataType: 'INTEGER', nullable: false },
      { name: 'plant_name', dataType: 'TEXT', nullable: false },
      { name: 'target_uph', dataType: 'INTEGER', nullable: false },
      { name: 'actual_uph', dataType: 'INTEGER', nullable: false },
      { name: 'availability_pct', dataType: 'REAL', nullable: false },
      { name: 'performance_pct', dataType: 'REAL', nullable: false },
      { name: 'quality_pct', dataType: 'REAL', nullable: false },
      { name: 'oee_pct', dataType: 'REAL', nullable: false },
      { name: 'status', dataType: 'TEXT', nullable: false },
    ],
    rows: [
      { id: 101, line_code: 'LN-A1', line_name: 'Şasi Lazer Kaynak Hattı A1', location_id: 1, plant_name: 'İzmir Kampüsü', target_uph: 95, actual_uph: 91, availability_pct: 96.4, performance_pct: 95.8, quality_pct: 99.1, oee_pct: 91.5, status: 'online' },
      { id: 102, line_code: 'LN-A2', line_name: 'Robotik Gövde Montaj Hattı A2', location_id: 1, plant_name: 'İzmir Kampüsü', target_uph: 88, actual_uph: 85, availability_pct: 95.2, performance_pct: 96.6, quality_pct: 99.3, oee_pct: 91.3, status: 'online' },
      { id: 201, line_code: 'LN-B1', line_name: '5-Eksen CNC Blok İşleme B1', location_id: 2, plant_name: 'Bursa CNC Tesisi', target_uph: 72, actual_uph: 58, availability_pct: 84.5, performance_pct: 89.2, quality_pct: 97.6, oee_pct: 73.6, status: 'warning' },
      { id: 202, line_code: 'LN-B2', line_name: 'Dişli Taşlama & Isıl İşlem B2', location_id: 2, plant_name: 'Bursa CNC Tesisi', target_uph: 110, actual_uph: 104, availability_pct: 94.8, performance_pct: 94.5, quality_pct: 98.9, oee_pct: 88.6, status: 'online' },
      { id: 301, line_code: 'LN-C1', line_name: 'Yüksek Hızlı SMT Dizgi Hattı C1', location_id: 3, plant_name: 'Kocaeli Elektronik', target_uph: 240, actual_uph: 234, availability_pct: 97.8, performance_pct: 97.5, quality_pct: 99.6, oee_pct: 95.0, status: 'online' },
      { id: 302, line_code: 'LN-C2', line_name: 'Batarya Modül Paketleme Hattı C2', location_id: 3, plant_name: 'Kocaeli Elektronik', target_uph: 130, actual_uph: 123, availability_pct: 95.0, performance_pct: 96.2, quality_pct: 99.4, oee_pct: 90.8, status: 'online' },
      { id: 401, line_code: 'LN-D1', line_name: 'Alüminyum Basınçlı Döküm D1', location_id: 4, plant_name: 'Eskişehir Döküm', target_uph: 64, actual_uph: 59, availability_pct: 92.1, performance_pct: 94.0, quality_pct: 98.2, oee_pct: 85.0, status: 'online' },
      { id: 402, line_code: 'LN-D2', line_name: 'CMM Optik Kalite & X-Ray D2', location_id: 4, plant_name: 'Eskişehir Döküm', target_uph: 80, actual_uph: 77, availability_pct: 96.8, performance_pct: 96.3, quality_pct: 99.7, oee_pct: 92.9, status: 'online' },
    ],
  },
  machines: {
    columns: [
      { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
      { name: 'code', dataType: 'TEXT', nullable: false },
      { name: 'name', dataType: 'TEXT', nullable: false },
      { name: 'type', dataType: 'TEXT', nullable: false },
      { name: 'line_id', dataType: 'INTEGER', nullable: false },
      { name: 'line_name', dataType: 'TEXT', nullable: false },
      { name: 'status', dataType: 'TEXT', nullable: false },
      { name: 'health_score', dataType: 'INTEGER', nullable: false },
      { name: 'spindle_temp_c', dataType: 'REAL', nullable: false },
      { name: 'vibration_mm_s', dataType: 'REAL', nullable: false },
      { name: 'power_kw', dataType: 'REAL', nullable: false },
      { name: 'model', dataType: 'TEXT', nullable: false },
    ],
    rows: [
      { id: 1, code: 'RB-101', name: 'KUKA Lazer Kaynak Hücresi #1', type: 'Robot', line_id: 101, line_name: 'Şasi Lazer Kaynak A1', status: 'online', health_score: 96, spindle_temp_c: 44.2, vibration_mm_s: 1.1, power_kw: 28.4, model: 'KUKA KR-210 R2700' },
      { id: 2, code: 'RB-102', name: 'KUKA Lazer Kaynak Hücresi #2', type: 'Robot', line_id: 101, line_name: 'Şasi Lazer Kaynak A1', status: 'online', health_score: 94, spindle_temp_c: 46.0, vibration_mm_s: 1.3, power_kw: 29.1, model: 'KUKA KR-210 R2700' },
      { id: 3, code: 'LS-103', name: 'Trumpf Fiber Lazer Kesim', type: 'Laser', line_id: 101, line_name: 'Şasi Lazer Kaynak A1', status: 'online', health_score: 92, spindle_temp_c: 51.5, vibration_mm_s: 0.9, power_kw: 42.0, model: 'TruLaser Cell 7040' },
      { id: 4, code: 'RB-104', name: 'ABB Gövde Perçin Robotu', type: 'Robot', line_id: 102, line_name: 'Robotik Gövde Montaj A2', status: 'online', health_score: 95, spindle_temp_c: 41.8, vibration_mm_s: 1.2, power_kw: 24.6, model: 'ABB IRB-6700' },
      { id: 5, code: 'AGV-105', name: 'Otonom Şasi Taşıyıcı Filo', type: 'AGV', line_id: 102, line_name: 'Robotik Gövde Montaj A2', status: 'online', health_score: 91, spindle_temp_c: 36.4, vibration_mm_s: 0.7, power_kw: 8.5, model: 'MiR-1350 Heavy' },
      { id: 6, code: 'CNC-201', name: 'Mazak 5-Eksen İşleme Merkezi #1', type: 'CNC', line_id: 201, line_name: '5-Eksen CNC Blok B1', status: 'alarm', health_score: 52, spindle_temp_c: 94.6, vibration_mm_s: 6.8, power_kw: 64.2, model: 'Mazak Integrex i-400' },
      { id: 7, code: 'CNC-202', name: 'Mazak 5-Eksen İşleme Merkezi #2', type: 'CNC', line_id: 201, line_name: '5-Eksen CNC Blok B1', status: 'warning', health_score: 74, spindle_temp_c: 78.3, vibration_mm_s: 3.9, power_kw: 55.8, model: 'Mazak Integrex i-400' },
      { id: 8, code: 'CNC-203', name: 'Okuma Hassas Torna Hücresi', type: 'CNC', line_id: 201, line_name: '5-Eksen CNC Blok B1', status: 'online', health_score: 90, spindle_temp_c: 58.1, vibration_mm_s: 1.6, power_kw: 38.0, model: 'Okuma Multus U3000' },
      { id: 9, code: 'HT-204', name: 'Vakum İndüksiyon Isıl İşlem Fırını', type: 'Furnace', line_id: 202, line_name: 'Dişli Taşlama B2', status: 'online', health_score: 89, spindle_temp_c: 860.0, vibration_mm_s: 0.5, power_kw: 118.5, model: 'Ipsen TurboTreater' },
      { id: 10, code: 'GR-205', name: 'Studer Silindirik Dişli Taşlama', type: 'Grinder', line_id: 202, line_name: 'Dişli Taşlama B2', status: 'online', health_score: 93, spindle_temp_c: 49.2, vibration_mm_s: 1.0, power_kw: 31.4, model: 'Studer S41' },
      { id: 11, code: 'SMT-301', name: 'Fuji NXT-III Dizgi Modülü', type: 'SMT', line_id: 301, line_name: 'SMT Dizgi Hattı C1', status: 'online', health_score: 98, spindle_temp_c: 38.0, vibration_mm_s: 0.4, power_kw: 19.2, model: 'Fuji AIMEX III' },
      { id: 12, code: 'RF-302', name: 'Azotlu 12-Bölge Reflow Fırın', type: 'Oven', line_id: 301, line_name: 'SMT Dizgi Hattı C1', status: 'warning', health_score: 79, spindle_temp_c: 248.5, vibration_mm_s: 0.8, power_kw: 52.0, model: 'Heller 2043 MK7' },
      { id: 13, code: 'BAT-303', name: 'Fanuc Lazer Hücre Kaynak Robotu', type: 'Robot', line_id: 302, line_name: 'Batarya Paketleme C2', status: 'online', health_score: 95, spindle_temp_c: 42.1, vibration_mm_s: 0.9, power_kw: 26.8, model: 'Fanuc R-2000iC' },
      { id: 14, code: 'EOL-304', name: 'Yüksek Gerilim İzolasyon & EOL Test', type: 'Tester', line_id: 302, line_name: 'Batarya Paketleme C2', status: 'online', health_score: 97, spindle_temp_c: 33.5, vibration_mm_s: 0.3, power_kw: 14.5, model: 'Chroma 17040E' },
      { id: 15, code: 'DC-401', name: 'Bühler 1600T Basınçlı Döküm Presi', type: 'Press', line_id: 401, line_name: 'Basınçlı Döküm D1', status: 'online', health_score: 87, spindle_temp_c: 672.0, vibration_mm_s: 2.4, power_kw: 145.0, model: 'Bühler Carat 160' },
      { id: 16, code: 'CMM-402', name: 'Zeiss 3B Koordinat & X-Ray Kontrol', type: 'CMM', line_id: 402, line_name: 'CMM Optik Kalite D2', status: 'online', health_score: 99, spindle_temp_c: 21.5, vibration_mm_s: 0.1, power_kw: 9.8, model: 'Zeiss PRISMO' },
    ],
  },
  production_batches: {
    columns: [
      { name: 'batch_code', dataType: 'TEXT', isPrimaryKey: true, nullable: false },
      { name: 'batch_date', dataType: 'TEXT', nullable: false },
      { name: 'shift', dataType: 'TEXT', nullable: false },
      { name: 'line_name', dataType: 'TEXT', nullable: false },
      { name: 'product_family', dataType: 'TEXT', nullable: false },
      { name: 'planned_qty', dataType: 'INTEGER', nullable: false },
      { name: 'good_qty', dataType: 'INTEGER', nullable: false },
      { name: 'scrap_qty', dataType: 'INTEGER', nullable: false },
      { name: 'oee_pct', dataType: 'REAL', nullable: false },
      { name: 'energy_kwh', dataType: 'REAL', nullable: false },
    ],
    rows: [
      { batch_code: 'B-2610-01', batch_date: '2026-10-25', shift: 'Vardiya A (07-15)', line_name: 'Şasi Lazer Kaynak A1', product_family: 'EV-Platform Şasi', planned_qty: 760, good_qty: 738, scrap_qty: 6, oee_pct: 92.1, energy_kwh: 1180 },
      { batch_code: 'B-2610-02', batch_date: '2026-10-25', shift: 'Vardiya A (07-15)', line_name: 'Robotik Gövde Montaj A2', product_family: 'EV-Platform Gövde', planned_qty: 700, good_qty: 682, scrap_qty: 5, oee_pct: 91.4, energy_kwh: 940 },
      { batch_code: 'B-2610-03', batch_date: '2026-10-25', shift: 'Vardiya A (07-15)', line_name: '5-Eksen CNC Blok B1', product_family: 'E-Aks Gövde Blok', planned_qty: 580, good_qty: 446, scrap_qty: 19, oee_pct: 73.6, energy_kwh: 1620 },
      { batch_code: 'B-2610-04', batch_date: '2026-10-25', shift: 'Vardiya A (07-15)', line_name: 'Dişli Taşlama B2', product_family: 'Redüktör Dişli Seti', planned_qty: 880, good_qty: 842, scrap_qty: 8, oee_pct: 88.9, energy_kwh: 1490 },
      { batch_code: 'B-2610-05', batch_date: '2026-10-25', shift: 'Vardiya A (07-15)', line_name: 'SMT Dizgi Hattı C1', product_family: 'BMS Kontrol Kartı', planned_qty: 1920, good_qty: 1894, scrap_qty: 7, oee_pct: 95.3, energy_kwh: 680 },
      { batch_code: 'B-2610-06', batch_date: '2026-10-25', shift: 'Vardiya A (07-15)', line_name: 'Batarya Paketleme C2', product_family: '800V Batarya Modülü', planned_qty: 1040, good_qty: 998, scrap_qty: 6, oee_pct: 91.0, energy_kwh: 890 },
      { batch_code: 'B-2610-07', batch_date: '2026-10-25', shift: 'Vardiya B (15-23)', line_name: 'Şasi Lazer Kaynak A1', product_family: 'EV-Platform Şasi', planned_qty: 760, good_qty: 729, scrap_qty: 8, oee_pct: 90.8, energy_kwh: 1205 },
      { batch_code: 'B-2610-08', batch_date: '2026-10-25', shift: 'Vardiya B (15-23)', line_name: '5-Eksen CNC Blok B1', product_family: 'E-Aks Gövde Blok', planned_qty: 580, good_qty: 492, scrap_qty: 14, oee_pct: 79.4, energy_kwh: 1580 },
      { batch_code: 'B-2610-09', batch_date: '2026-10-25', shift: 'Vardiya B (15-23)', line_name: 'Basınçlı Döküm D1', product_family: 'Alüminyum Taşıyıcı', planned_qty: 510, good_qty: 478, scrap_qty: 9, oee_pct: 85.4, energy_kwh: 2140 },
      { batch_code: 'B-2610-10', batch_date: '2026-10-25', shift: 'Vardiya B (15-23)', line_name: 'CMM Optik Kalite D2', product_family: 'Kalite Lot Denetim', planned_qty: 640, good_qty: 628, scrap_qty: 2, oee_pct: 93.1, energy_kwh: 410 },
    ],
  },
  downtime_events: {
    columns: [
      { name: 'event_code', dataType: 'TEXT', isPrimaryKey: true, nullable: false },
      { name: 'started_at', dataType: 'TEXT', nullable: false },
      { name: 'line_name', dataType: 'TEXT', nullable: false },
      { name: 'machine_name', dataType: 'TEXT', nullable: false },
      { name: 'root_cause', dataType: 'TEXT', nullable: false },
      { name: 'duration_min', dataType: 'INTEGER', nullable: false },
      { name: 'lost_units', dataType: 'INTEGER', nullable: false },
      { name: 'severity', dataType: 'TEXT', nullable: false },
    ],
    rows: [
      { event_code: 'DT-901', started_at: '2026-10-25 09:14', line_name: '5-Eksen CNC Blok B1', machine_name: 'Mazak 5-Eksen #1', root_cause: 'Spindle Rulman Termal Alarmı (>90°C)', duration_min: 68, lost_units: 82, severity: 'Kritik' },
      { event_code: 'DT-902', started_at: '2026-10-25 10:42', line_name: 'Basınçlı Döküm D1', machine_name: 'Bühler 1600T Pres', root_cause: 'Kalıp Soğutma Hattı Basınç Düşümü', duration_min: 34, lost_units: 36, severity: 'Yüksek' },
      { event_code: 'DT-903', started_at: '2026-10-25 11:20', line_name: 'SMT Dizgi Hattı C1', machine_name: 'Azotlu Reflow Fırın', root_cause: 'Bölge-7 Termokupl Kalibrasyon Sapması', duration_min: 22, lost_units: 45, severity: 'Orta' },
      { event_code: 'DT-904', started_at: '2026-10-25 13:05', line_name: '5-Eksen CNC Blok B1', machine_name: 'Mazak 5-Eksen #2', root_cause: 'Kesici Takım Aşınma Otomatik Değişimi', duration_min: 19, lost_units: 23, severity: 'Orta' },
      { event_code: 'DT-905', started_at: '2026-10-25 14:18', line_name: 'Şasi Lazer Kaynak A1', machine_name: 'Trumpf Fiber Lazer', root_cause: 'Koruyucu Lens Temizliği & Gaz Kontrolü', duration_min: 14, lost_units: 18, severity: 'Düşük' },
      { event_code: 'DT-906', started_at: '2026-10-25 15:50', line_name: 'Batarya Paketleme C2', machine_name: 'AGV Besleme İstasyonu', root_cause: 'Hücre Palet Barkod Okuma Gecikmesi', duration_min: 11, lost_units: 15, severity: 'Düşük' },
    ],
  },
  energy_telemetry: {
    columns: [
      { name: 'feeder_code', dataType: 'TEXT', isPrimaryKey: true, nullable: false },
      { name: 'zone_name', dataType: 'TEXT', nullable: false },
      { name: 'active_kwh', dataType: 'REAL', nullable: false },
      { name: 'peak_kw', dataType: 'REAL', nullable: false },
      { name: 'power_factor', dataType: 'REAL', nullable: false },
      { name: 'compressed_air_m3', dataType: 'REAL', nullable: false },
      { name: 'co2_kg', dataType: 'REAL', nullable: false },
    ],
    rows: [
      { feeder_code: 'FDR-01', zone_name: 'İzmir Lazer Kaynak & Gövde', active_kwh: 2840, peak_kw: 412, power_factor: 0.97, compressed_air_m3: 1620, co2_kg: 1192.8 },
      { feeder_code: 'FDR-02', zone_name: 'Bursa CNC & Talaşlı İmalat', active_kwh: 3490, peak_kw: 528, power_factor: 0.93, compressed_air_m3: 2180, co2_kg: 1465.8 },
      { feeder_code: 'FDR-03', zone_name: 'Bursa Vakum Isıl İşlem Fırınları', active_kwh: 4120, peak_kw: 610, power_factor: 0.95, compressed_air_m3: 540, co2_kg: 1730.4 },
      { feeder_code: 'FDR-04', zone_name: 'Kocaeli Temiz Oda & SMT Dizgi', active_kwh: 1690, peak_kw: 245, power_factor: 0.98, compressed_air_m3: 890, co2_kg: 709.8 },
      { feeder_code: 'FDR-05', zone_name: 'Kocaeli Batarya Paketleme & EOL', active_kwh: 1920, peak_kw: 286, power_factor: 0.97, compressed_air_m3: 760, co2_kg: 806.4 },
      { feeder_code: 'FDR-06', zone_name: 'Eskişehir Basınçlı Döküm Presleri', active_kwh: 4680, peak_kw: 695, power_factor: 0.92, compressed_air_m3: 2640, co2_kg: 1965.6 },
      { feeder_code: 'FDR-07', zone_name: 'Çatı GES Güneş Üretim Mahsubu', active_kwh: -2350, peak_kw: -380, power_factor: 0.99, compressed_air_m3: 0, co2_kg: -987.0 },
    ],
  },
};

// ============================================================================
// 2. SAVED SQL QUERIES (6 QUERIES) + EXECUTOR
// ============================================================================

export const DEMO_QUERIES: any[] = [
  {
    id: 'q_oee_lines',
    name: 'Hat Bazlı Canlı OEE, Hız & Kalite Performansı',
    description: 'Tüm tesislerdeki 8 üretim hattının anlık OEE (%), hedef/gerçekleşen UPH hızı ve kalite oranlarını listeler.',
    dataSourceId: 'ds_factory',
    data_source_id: 'ds_factory',
    sql: 'SELECT line_code, line_name, plant_name, target_uph, actual_uph, availability_pct, quality_pct, oee_pct, status FROM production_lines ORDER BY oee_pct DESC',
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    isActive: true,
    createdAt: '2026-10-10T08:00:00Z',
    updatedAt: '2026-10-25T08:30:00Z',
  },
  {
    id: 'q_batch_production',
    name: 'Vardiya Üretim Partileri & Fire Analizi',
    description: 'Vardiya A ve B üretim partilerinin planlanan/sağlam/fire adetlerini, OEE yüzdesini ve kWh enerji tüketimini getirir.',
    dataSourceId: 'ds_factory',
    data_source_id: 'ds_factory',
    sql: 'SELECT batch_code, shift, line_name, product_family, planned_qty, good_qty, scrap_qty, oee_pct, energy_kwh FROM production_batches ORDER BY batch_code',
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    isActive: true,
    createdAt: '2026-10-12T09:15:00Z',
    updatedAt: '2026-10-25T09:00:00Z',
  },
  {
    id: 'q_energy_esg',
    name: 'Fider Bazlı Enerji Tüketimi (kWh) & Karbon Yoğunluğu',
    description: 'Ana trafo fiderleri ve Çatı GES mahsubu dahil aktif enerji (kWh), pik güç (kW), cosφ ve CO₂ salım tablosu.',
    dataSourceId: 'ds_energy',
    data_source_id: 'ds_energy',
    sql: 'SELECT feeder_code, zone_name, active_kwh, peak_kw, power_factor, compressed_air_m3, co2_kg FROM energy_telemetry',
    owner: 'usr_engineer',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    isActive: true,
    createdAt: '2026-10-14T11:00:00Z',
    updatedAt: '2026-10-25T09:10:00Z',
  },
  {
    id: 'q_downtime_pareto',
    name: 'Plansız Duruş Kök Neden & Kayıp Süre Pareto',
    description: 'Kritik ve orta seviye ekipman duruşlarını kök neden, kayıp dakika ve kayıp ürün adedine göre sıralar.',
    dataSourceId: 'ds_factory',
    data_source_id: 'ds_factory',
    sql: 'SELECT event_code, started_at, line_name, machine_name, root_cause, duration_min, lost_units, severity FROM downtime_events ORDER BY duration_min DESC',
    owner: 'usr_engineer',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    isActive: true,
    createdAt: '2026-10-15T14:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
  },
  {
    id: 'q_factory_tree',
    name: 'Tesis → Hat → Makine Canlı Sağlık Hiyerarşisi',
    description: 'Space Map topolojisini besleyen 3 katmanlı fabrika, üretim hattı ve robot/CNC sağlık skoru hiyerarşi sorgusu.',
    dataSourceId: 'ds_factory',
    data_source_id: 'ds_factory',
    sql: "SELECT 'loc_' || id AS node_id, NULL AS parent_id, name AS label, 'Plant' AS node_type, plant_oee_pct AS health_score, 'online' AS status FROM locations UNION ALL SELECT 'line_' || id, 'loc_' || location_id, line_name, 'Line', oee_pct, status FROM production_lines UNION ALL SELECT 'mach_' || id, 'line_' || line_id, name, type, health_score, status FROM machines",
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    isActive: true,
    createdAt: '2026-10-10T08:00:00Z',
    updatedAt: '2026-10-25T08:00:00Z',
  },
  {
    id: 'q_machine_telemetry',
    name: 'CNC & Robot Termal / Titreşim Sensör Özeti',
    description: 'Tüm sahadaki 16 kritik robot, lazer ve CNC istasyonunun anlık sıcaklık (°C), titreşim (mm/s) ve sağlık puanları.',
    dataSourceId: 'ds_factory',
    data_source_id: 'ds_factory',
    sql: 'SELECT code, name, type, line_name, status, health_score, spindle_temp_c, vibration_mm_s, power_kw FROM machines ORDER BY health_score ASC',
    owner: 'usr_engineer',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    isActive: true,
    createdAt: '2026-10-18T10:00:00Z',
    updatedAt: '2026-10-25T09:30:00Z',
  },
];

export function evaluateDemoSql(sql: string, queryId = ''): Record<string, any>[] {
  if (queryId === 'q_oee_lines') return [...DEMO_TABLES['production_lines'].rows];
  if (queryId === 'q_batch_production') return [...DEMO_TABLES['production_batches'].rows];
  if (queryId === 'q_energy_esg') return [...DEMO_TABLES['energy_telemetry'].rows];
  if (queryId === 'q_downtime_pareto') return [...DEMO_TABLES['downtime_events'].rows];
  if (queryId === 'q_machine_telemetry') {
    return [...DEMO_TABLES['machines'].rows].sort((a, b) => a['health_score'] - b['health_score']);
  }
  if (queryId === 'q_factory_tree') {
    const out: Record<string, any>[] = [];
    DEMO_TABLES['locations'].rows.forEach((l) =>
      out.push({ node_id: `loc_${l['id']}`, parent_id: '', label: l['name'], node_type: 'Tesis', health_score: Math.round(l['plant_oee_pct']), status: 'online' })
    );
    DEMO_TABLES['production_lines'].rows.forEach((pl) =>
      out.push({ node_id: `line_${pl['id']}`, parent_id: `loc_${pl['location_id']}`, label: pl['line_name'], node_type: 'Hat', health_score: Math.round(pl['oee_pct']), status: pl['status'] })
    );
    DEMO_TABLES['machines'].rows.forEach((m) =>
      out.push({ node_id: `mach_${m['id']}`, parent_id: `line_${m['line_id']}`, label: m['name'], node_type: m['type'], health_score: m['health_score'], status: m['status'] })
    );
    return out;
  }

  const clean = (sql || '').toLowerCase();
  if (clean.includes('union all') || clean.includes('node_id')) return evaluateDemoSql('', 'q_factory_tree');
  if (clean.includes('production_batches')) return [...DEMO_TABLES['production_batches'].rows];
  if (clean.includes('downtime_events')) return [...DEMO_TABLES['downtime_events'].rows];
  if (clean.includes('energy_telemetry')) return [...DEMO_TABLES['energy_telemetry'].rows];
  if (clean.includes('production_lines')) return [...DEMO_TABLES['production_lines'].rows];
  if (clean.includes('locations')) return [...DEMO_TABLES['locations'].rows];
  if (clean.includes("status = 'alarm'")) return DEMO_TABLES['machines'].rows.filter((m) => m['status'] === 'alarm');
  if (clean.includes("status = 'warning'")) return DEMO_TABLES['machines'].rows.filter((m) => m['status'] === 'warning');
  return [...DEMO_TABLES['machines'].rows];
}

export function buildColumnsMeta(rows: Record<string, any>[]): Array<{ name: string; dataType: string; label: string }> {
  if (!rows.length) return [];
  return Object.keys(rows[0]).map((k) => ({
    name: k,
    label: k,
    dataType: typeof rows[0][k] === 'number' ? 'number' : 'string',
  }));
}

// ============================================================================
// 3. PYTHON SCRIPTS (3 SCRIPTS) + SANDBOX RUNNER
// ============================================================================

export const DEMO_PYTHON_SCRIPTS: any[] = [
  {
    id: 'py_oee_summary',
    name: 'Tesis Ağırlıklı OEE & Net Hız Dengesi',
    description: 'Üretim partileri üzerinden tesis bazlı ağırlıklı OEE, net sağlam üretim oranı ve enerji verimliliğini hesaplar.',
    code: `# Tesis Ağırlıklı OEE & Enerji Yoğunluğu Analizi
batches = sql_data.get('q_batch_production') or []
summary = {}
for b in batches:
    line = b['line_name']
    rec = summary.setdefault(line, {'good': 0, 'plan': 0, 'kwh': 0.0, 'oee_sum': 0.0, 'n': 0})
    rec['good'] += b['good_qty']
    rec['plan'] += b['planned_qty']
    rec['kwh'] += b['energy_kwh']
    rec['oee_sum'] += b['oee_pct']
    rec['n'] += 1

rows = []
for line, r in summary.items():
    rows.append({
        'line_name': line,
        'net_fulfillment_pct': round((r['good'] / max(r['plan'], 1)) * 100, 1),
        'weighted_oee_pct': round(r['oee_sum'] / max(r['n'], 1), 1),
        'kwh_per_unit': round(r['kwh'] / max(r['good'], 1), 2),
    })
out('line_oee_matrix').extend(rows)
`,
    sqlQueryIds: ['q_batch_production'],
    datasetNames: ['line_oee_matrix'],
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    createdAt: '2026-10-12T10:00:00Z',
    updatedAt: '2026-10-25T08:45:00Z',
  },
  {
    id: 'py_thermal_anomaly',
    name: 'CNC & Robot Termal Titreşim Anomali Skoru',
    description: 'Spindle sıcaklığı ve titreşim sensörlerini Z-skor ağırlığıyla birleştirerek kestirimci bakım risk puanı üretir.',
    code: `# Kestirimci Bakım — Termal & Titreşim Anomali Tespiti
machines = sql_data.get('q_machine_telemetry') or []
alerts = []
for m in machines:
    risk = round(min(99.0, m['vibration_mm_s'] * 11.5 + max(0.0, m['spindle_temp_c'] - 45.0) * 0.45), 1)
    alerts.append({
        'machine_code': m['code'],
        'machine_name': m['name'],
        'line_name': m['line_name'],
        'health_score': m['health_score'],
        'anomaly_risk_pct': risk,
        'maintenance_action': 'Acil Rulman & Soğutma Müdahalesi' if risk > 65 else ('Planlı Kalibrasyon' if risk > 35 else 'Normal İzleme'),
    })
out('anomaly_scores').extend(alerts)
`,
    sqlQueryIds: ['q_machine_telemetry'],
    datasetNames: ['anomaly_scores'],
    owner: 'usr_engineer',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    createdAt: '2026-10-16T11:30:00Z',
    updatedAt: '2026-10-25T09:15:00Z',
  },
];

export function executeDemoPython(scriptId = '', code = ''): { datasetName: string; datasetNames: string[]; datasets: Record<string, any> } {
  const isThermal = scriptId === 'py_thermal_anomaly' || code.toLowerCase().includes('vibration') || code.toLowerCase().includes('anomaly');
  if (isThermal) {
    const rows = DEMO_TABLES['machines'].rows.slice(0, 10).map((m) => {
      const vib = Number(m['vibration_mm_s']) || 0;
      const temp = Number(m['spindle_temp_c']) || 40;
      const risk = Math.round(Math.min(98, vib * 11.5 + Math.max(0, Math.min(temp, 120) - 42) * 0.48) * 10) / 10;
      return {
        machine_code: m['code'],
        machine_name: m['name'],
        line_name: m['line_name'],
        health_score: m['health_score'],
        anomaly_risk_pct: risk,
        maintenance_action: risk > 65 ? 'Acil Rulman & Soğutma Müdahalesi' : risk > 35 ? 'Planlı Kalibrasyon' : 'Normal Çalışma',
      };
    }).sort((a, b) => b.anomaly_risk_pct - a.anomaly_risk_pct);
    const cols = buildColumnsMeta(rows);
    return {
      datasetName: 'anomaly_scores',
      datasetNames: ['anomaly_scores'],
      datasets: {
        anomaly_scores: { columns: cols, rows, totalRows: rows.length, rowCount: rows.length, truncated: false },
      },
    };
  }

  const rows = [
    { line_name: 'SMT Dizgi Hattı C1', net_fulfillment_pct: 98.6, weighted_oee_pct: 95.3, kwh_per_unit: 0.36 },
    { line_name: 'CMM Optik Kalite D2', net_fulfillment_pct: 98.1, weighted_oee_pct: 93.1, kwh_per_unit: 0.65 },
    { line_name: 'Şasi Lazer Kaynak A1', net_fulfillment_pct: 96.5, weighted_oee_pct: 91.5, kwh_per_unit: 1.62 },
    { line_name: 'Robotik Gövde Montaj A2', net_fulfillment_pct: 97.4, weighted_oee_pct: 91.4, kwh_per_unit: 1.38 },
    { line_name: 'Batarya Paketleme C2', net_fulfillment_pct: 96.0, weighted_oee_pct: 91.0, kwh_per_unit: 0.89 },
    { line_name: 'Dişli Taşlama B2', net_fulfillment_pct: 95.7, weighted_oee_pct: 88.9, kwh_per_unit: 1.77 },
    { line_name: 'Basınçlı Döküm D1', net_fulfillment_pct: 93.7, weighted_oee_pct: 85.4, kwh_per_unit: 4.48 },
    { line_name: '5-Eksen CNC Blok B1', net_fulfillment_pct: 80.9, weighted_oee_pct: 76.5, kwh_per_unit: 3.41 },
  ];
  const cols = buildColumnsMeta(rows);
  return {
    datasetName: 'line_oee_matrix',
    datasetNames: ['line_oee_matrix'],
    datasets: {
      line_oee_matrix: { columns: cols, rows, totalRows: rows.length, rowCount: rows.length, truncated: false },
    },
  };
}

