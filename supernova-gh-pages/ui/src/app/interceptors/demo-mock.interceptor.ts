import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { PERMISSION_CATALOG } from '../services/permission-catalog';

// ============================================================================
// Nov4 In-Memory Demo Mock Database & Interceptor
// Fully offline, air-gapped simulation for GitHub Pages & Web Demos.
// Supports Role-Based Access (Admin, Engineer, Operator/User, Superuser, Viewer),
// Space Map with multi-theme and figure switching, Admin Panel, Alarms, etc.
// ============================================================================

interface MockUser {
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

// 5 Distinct Role Personas
const MOCK_USERS: MockUser[] = [
  {
    id: 'usr_admin',
    username: 'admin',
    displayName: 'Sistem Yöneticisi (Admin)',
    email: 'admin@supernovacorp.com',
    role: 'admin',
    level: 80,
    permissions: ['*'],
    allowedPages: [
      'admin', 'dashboard', 'reports', 'network-map', 'alarms',
      'table-explorer', 'template-builder', 'query-creator', 'python-workspace',
      'settings', 'profile'
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 15 }
  },
  {
    id: 'usr_engineer',
    username: 'engineer',
    displayName: 'Hat & Otomasyon Mühendisi',
    email: 'engineer@supernovacorp.com',
    role: 'engineer',
    level: 60,
    permissions: [
      'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
      'page:table-explorer', 'page:template-builder', 'page:query-creator',
      'page:python-workspace', 'page:settings', 'page:profile',
      'share:templates', 'share:paths', 'share:queries', 'share:scripts', 'share:dashboards',
      'datasource:view'
    ],
    allowedPages: [
      'dashboard', 'reports', 'network-map', 'alarms',
      'table-explorer', 'template-builder', 'query-creator', 'python-workspace',
      'settings', 'profile'
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 20 }
  },
  {
    id: 'usr_operator',
    username: 'operator',
    displayName: 'Üretim Hat Operatörü (User)',
    email: 'operator@supernovacorp.com',
    role: 'operator',
    level: 40,
    permissions: [
      'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
      'page:profile', 'page:settings'
    ],
    allowedPages: [
      'dashboard', 'reports', 'network-map', 'alarms', 'profile', 'settings'
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 30 }
  },
  {
    id: 'usr_user',
    username: 'user',
    displayName: 'Standart Kullanıcı (Düz User)',
    email: 'user@supernovacorp.com',
    role: 'operator',
    level: 40,
    permissions: [
      'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms',
      'page:profile', 'page:settings'
    ],
    allowedPages: [
      'dashboard', 'reports', 'network-map', 'alarms', 'profile', 'settings'
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 30 }
  },
  {
    id: 'usr_utku',
    username: 'utku',
    displayName: 'Utku Karaca (Sistem Mimarı / Superuser)',
    email: 'utku@supernovacorp.com',
    role: 'superuser',
    level: 100,
    permissions: ['*'],
    allowedPages: [
      'admin', 'dashboard', 'reports', 'network-map', 'alarms',
      'table-explorer', 'template-builder', 'query-creator', 'python-workspace',
      'settings', 'profile'
    ],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 10 }
  },
  {
    id: 'usr_viewer',
    username: 'viewer',
    displayName: 'Misafir Gözlemci (Salt Okunur)',
    email: 'viewer@supernovacorp.com',
    role: 'viewer',
    level: 20,
    permissions: [
      'page:dashboard', 'page:reports', 'page:network-map', 'page:alarms', 'page:profile'
    ],
    allowedPages: ['dashboard', 'reports', 'network-map', 'alarms', 'profile'],
    avatar: 'assets/default-avatar.png',
    preferences: { theme: 'dark', language: 'tr', dashboardRefreshInterval: 60 }
  }
];

// In-Memory Database Tables
const locations = [
  { id: 1, name: 'Plant Alpha - Assembly & Robotics', city: 'Bursa', capacity: 1200 },
  { id: 2, name: 'Plant Beta - Primary & Secondary Packaging', city: 'Kocaeli', capacity: 2400 },
  { id: 3, name: 'Plant Gamma - Automated Paint Shop', city: 'Sakarya', capacity: 800 }
];

const production_lines = [
  { id: 1, name: 'Chassis Assembly Line', location_id: 1, speed: '1.2 m/s', oee: 88.4 },
  { id: 2, name: 'Engine Assembly Line', location_id: 1, speed: '0.8 m/s', oee: 74.0 },
  { id: 3, name: 'Electronics & SMT Assembly', location_id: 1, speed: '2.4 m/s', oee: 91.2 },
  { id: 4, name: 'Primary Packaging Line', location_id: 2, speed: '35 box/min', oee: 95.0 },
  { id: 5, name: 'Secondary & Palletizing Line', location_id: 2, speed: '40 pallet/h', oee: 92.1 },
  { id: 6, name: 'Base Coat Spray Line', location_id: 3, speed: '1.5 m/min', oee: 86.7 },
  { id: 7, name: 'Clear Coat & Curing Line', location_id: 3, speed: '1.0 m/min', oee: 89.3 }
];

const machines = [
  { id: 1, name: 'KUKA Robot Arm C1', type: 'Robot', line_id: 1, status: 'online', model: 'KR Quantec', payload: '210kg', cycle_time: '14.2s', temp: '42°C' },
  { id: 2, name: 'KUKA Robot Arm C2', type: 'Robot', line_id: 1, status: 'online', model: 'KR Quantec', payload: '210kg', cycle_time: '14.8s', temp: '44°C' },
  { id: 3, name: 'Conveyor Belt C-Main', type: 'Conveyor', line_id: 1, status: 'warning', model: 'Intralox Mod', motor_rpm: 1420, vibration: '1.8 mm/s' },
  { id: 4, name: 'Siemens S7-1500 PLC C1', type: 'Controller', line_id: 1, status: 'online', model: 'CPU 1518F', firmware: 'v2.9.2', scan_cycle: '2.1ms' },
  { id: 5, name: 'CNC Lathe E1', type: 'CNC', line_id: 2, status: 'alarm', model: 'DMG Mori CTX', spindle_speed: '4200 rpm', temp: '95°C', alert: 'Spindle Overheating' },
  { id: 6, name: 'CNC Lathe E2', type: 'CNC', line_id: 2, status: 'offline', model: 'DMG Mori CTX', spindle_speed: '0 rpm', status_note: 'Planned Maintenance' },
  { id: 7, name: 'Torque Station E1', type: 'Tool', line_id: 2, status: 'online', model: 'Atlas Copco Tensor', target_torque: '120 Nm', accuracy: '±0.5%' },
  { id: 8, name: 'Engine Testing Rig', type: 'Test', line_id: 2, status: 'online', model: 'AVL Dyno 450', pressure_bar: 6.2, dyno_kw: 145 },
  { id: 9, name: 'Siemens S7-1500 PLC E1', type: 'Controller', line_id: 2, status: 'online', model: 'CPU 1517', firmware: 'v2.9.1', scan_cycle: '2.4ms' },
  { id: 10, name: 'Pick and Place M1', type: 'Robot', line_id: 3, status: 'online', model: 'Yamaha YK400', cph: 45000, feeder_slots: 120 },
  { id: 11, name: 'Reflow Oven SMD', type: 'Heater', line_id: 3, status: 'warning', model: 'Ersa Hotflow', zones: 8, peak_temp: '245°C' },
  { id: 12, name: 'AOI Optical Inspection', type: 'Sensor', line_id: 3, status: 'online', model: 'Koh Young Zenith', camera_res: '25MP', false_call_rate: '0.02%' },
  { id: 13, name: 'Box Erector P1', type: 'Packaging', line_id: 4, status: 'online', model: 'Wexxar Bel 250', boxes_per_min: 35, glue_temp: '165°C' },
  { id: 14, name: 'Sealing Machine P1', type: 'Packaging', line_id: 4, status: 'online', model: '3M AccuGlide', seal_pressure: '4.5 bar', temp: '180°C' },
  { id: 15, name: 'Palletizer Robot R1', type: 'Robot', line_id: 5, status: 'online', model: 'Fanuc M-410iC', layers: 5, pallets_per_hour: 40 },
  { id: 16, name: 'Stretch Wrapper W1', type: 'Packaging', line_id: 5, status: 'offline', model: 'Lantech Q-300', tension_kg: 18, film_usage_m: 42 },
  { id: 17, name: 'Paint Robot Spray 1', type: 'Robot', line_id: 6, status: 'alarm', model: 'Dürr EcoRP E043', bell_speed: '35000 rpm', flow_ml: 280 },
  { id: 18, name: 'Paint Robot Spray 2', type: 'Robot', line_id: 6, status: 'online', model: 'Dürr EcoRP E043', bell_speed: '35000 rpm', flow_ml: 290 },
  { id: 19, name: 'Drying Oven 1', type: 'Heater', line_id: 6, status: 'warning', model: 'Eisenmann AirTunnel', temp_c: '140°C', airflow_mps: 4.2 },
  { id: 20, name: 'Clear Coat Sprayer', type: 'Robot', line_id: 7, status: 'online', model: 'Dürr EcoRP E043', atomization_bar: 3.8, flow_ml: 260 },
  { id: 21, name: 'Drying Oven 2', type: 'Heater', line_id: 7, status: 'online', model: 'Eisenmann AirTunnel', temp_c: '155°C', curing_time: '20min' }
];

// Space Map Built Structure for Factory Path
function getFactoryBuiltStructure(): any {
  const nodes: any[] = [];
  const roots: string[] = [];
  const paths: string[][] = [];

  locations.forEach(loc => {
    const locId = `loc_${loc.id}`;
    roots.push(locId);
    nodes.push({
      id: locId,
      label: loc.name,
      depth: 0,
      parent: null,
      row: {
        id: loc.id,
        name: loc.name,
        city: loc.city,
        type: 'Manufacturing Facility',
        daily_capacity: `${loc.capacity} units`,
        operational_status: 'Active (24/7 Shift)'
      }
    });

    const lines = production_lines.filter(pl => pl.location_id === loc.id);
    lines.forEach(line => {
      const lineId = `line_${line.id}`;
      nodes.push({
        id: lineId,
        label: line.name,
        depth: 1,
        parent: locId,
        row: {
          id: line.id,
          name: line.name,
          location: loc.name,
          speed: line.speed,
          estimated_oee: `${line.oee}%`,
          supervisor: 'Eng. K. Demir'
        }
      });

      const machs = machines.filter(m => m.line_id === line.id);
      machs.forEach(m => {
        const machId = `mach_${m.id}`;
        paths.push([locId, lineId, machId]);
        nodes.push({
          id: machId,
          label: m.name,
          depth: 2,
          parent: lineId,
          row: {
            id: m.id,
            name: m.name,
            type: m.type,
            status: m.status.toUpperCase(),
            model: (m as any).model || 'Standard',
            telemetry: (m as any).spindle_speed || (m as any).cycle_time || (m as any).temp || (m as any).temp_c || 'Nominal',
            plc_node: 'Profinet ID 12'
          }
        });
      });
    });
  });

  return {
    nodes,
    roots,
    paths,
    stats: {
      node_count: nodes.length,
      path_count: paths.length,
      max_depth: 2,
      warnings: []
    }
  };
}

// In-Memory Saved Paths with Space Map Configuration
let mockPaths: any[] = [
  {
    id: 'p_factory',
    name: 'Apex Smart Factory - Space Map',
    description: 'Bursa, Kocaeli ve Sakarya tesisleri robotik hiyerarşisi',
    queryId: 'q_factory',
    structure: 'hierarchical',
    config: {
      spaceMapConfig: {
        theme: 'factory',
        nodeShape: 'hexagon',
        layout: 'radial',
        color1: '#F59E0B',
        color2: '#10B981',
        color3: '#06B6D4',
        level1Icon: 'fa-industry',
        level2Icon: 'fa-cogs',
        level3Icon: 'fa-microchip',
        showOrbits: true,
        showGrid: true
      }
    }
  },
  {
    id: 'p_cosmic',
    name: 'Deep Space Constellation Map',
    description: 'Yıldız ve gezegen yörüngelerinde kozmik telemetri haritası',
    queryId: 'q_factory',
    structure: 'hierarchical',
    config: {
      spaceMapConfig: {
        theme: 'cosmic',
        nodeShape: 'planet',
        layout: 'radial',
        color1: '#60A5FA',
        color2: '#22D3EE',
        color3: '#A78BFA',
        level1Icon: 'fa-sun',
        level2Icon: 'fa-globe',
        level3Icon: 'fa-satellite',
        showOrbits: true,
        showGrid: true
      }
    }
  },
  {
    id: 'p_cyber',
    name: 'Grid Cyber Matrix & IT Telemetry',
    description: 'Siber ağ köşebentleri ve sunucu düğümleri',
    queryId: 'q_factory',
    structure: 'hierarchical',
    config: {
      spaceMapConfig: {
        theme: 'cyber',
        nodeShape: 'cyber',
        layout: 'radial',
        color1: '#00FF9D',
        color2: '#00F0FF',
        color3: '#FF007F',
        level1Icon: 'fa-server',
        level2Icon: 'fa-network-wired',
        level3Icon: 'fa-microchip',
        showOrbits: true,
        showGrid: true
      }
    }
  }
];

// In-Memory Alarms
let mockAlarms = [
  {
    id: 'alm_1',
    severity: 'critical',
    source: 'CNC İşleme Merkezi E1',
    message: 'Ana iş mili (spindle) sıcaklığı kritik eşiği aştı: 95.4°C (Limit: 85°C)',
    timestamp: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    status: 'active',
    location: 'Tesis Alpha - Motor Montaj Hattı',
    value: '95.4 °C',
    threshold: '85.0 °C'
  },
  {
    id: 'alm_2',
    severity: 'critical',
    source: 'KUKA Robot KR-210 (Pano 03)',
    message: 'Aks 4 redüktör tork sapması (+%28). Aşırı mekanik sürtünme veya yük algılandı',
    timestamp: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
    status: 'active',
    location: 'Tesis Alpha - Gövde Kaynak İstasyonu',
    value: '128 %',
    threshold: '100 %'
  },
  {
    id: 'alm_3',
    severity: 'critical',
    source: 'Enjeksiyon Pres Makinesi B2',
    message: 'Kalıp hidrolik yağ basıncı 135 bar seviyesine düştü (Gereken minimum: 180 bar)',
    timestamp: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    status: 'active',
    location: 'Tesis Beta - Plastik Enjeksiyon Hattı',
    value: '135 bar',
    threshold: '180 bar'
  },
  {
    id: 'alm_4',
    severity: 'warning',
    source: 'Siemens S7-1500 Master PLC',
    message: 'Profinet I/O istasyon 08 yanıt süresi gecikmesi (45ms). Paket kaybı riski',
    timestamp: new Date(Date.now() - 1000 * 60 * 65).toISOString(),
    status: 'active',
    location: 'Tesis Alpha - Hat Otomasyonu',
    value: '45 ms',
    threshold: '20 ms'
  },
  {
    id: 'alm_5',
    severity: 'warning',
    source: 'SMD Reflow Fırın Tüneli',
    message: 'Bölge 3 ön ısıtma profili sapması: +5.8°C termal dalgalanma',
    timestamp: new Date(Date.now() - 1000 * 60 * 95).toISOString(),
    status: 'acknowledged',
    location: 'Tesis Gamma - Elektronik Kart Montajı',
    value: '245.8 °C',
    threshold: '240.0 °C',
    acknowledgedBy: 'Mühendis (engineer)'
  },
  {
    id: 'alm_6',
    severity: 'warning',
    source: 'Konveyör Bandı C-Main',
    message: 'Bant tahrik motorunda titreşim artışı: 2.1 mm/s (Eşik: 1.5 mm/s)',
    timestamp: new Date(Date.now() - 1000 * 60 * 130).toISOString(),
    status: 'active',
    location: 'Tesis Alpha - Şasi Taşıma Hattı',
    value: '2.1 mm/s',
    threshold: '1.5 mm/s'
  },
  {
    id: 'alm_7',
    severity: 'warning',
    source: 'Soğutma Kulesi Pompası P-02',
    message: 'Giriş-çıkış debi farkı tolerans dışı (Debi kaybı: 14 m³/h)',
    timestamp: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    status: 'active',
    location: 'Tesis Beta - Yardımcı Tesisler',
    value: '42 m³/h',
    threshold: '56 m³/h'
  },
  {
    id: 'alm_8',
    severity: 'warning',
    source: 'Boya Tabancası Püskürtme Ünitesi',
    message: 'Püskürtme nozül hava basıncı kaybı: 4.8 bar (Hedef: 6.0 bar)',
    timestamp: new Date(Date.now() - 1000 * 60 * 220).toISOString(),
    status: 'acknowledged',
    location: 'Tesis Gamma - Son Kat Boya Kabini',
    value: '4.8 bar',
    threshold: '6.0 bar',
    acknowledgedBy: 'Operatör (operator)'
  },
  {
    id: 'alm_9',
    severity: 'info',
    source: 'CNC Torna Ünitesi T-04',
    message: 'Otomatik takım aşınma kompanzasyonu uygulandı (Takım #04, Sapma: 0.012mm)',
    timestamp: new Date(Date.now() - 1000 * 60 * 280).toISOString(),
    status: 'resolved',
    location: 'Tesis Alpha - Hassas Talaşlı İmalat',
    value: '0.012 mm',
    threshold: '0.020 mm',
    resolvedBy: 'Sistem Otomasyonu'
  },
  {
    id: 'alm_10',
    severity: 'info',
    source: 'Enerji Dağıtım Panosu ADP-01',
    message: 'Vardiya reaktif güç kompanzasyonu devrede (Güç Faktörü cos φ = 0.98)',
    timestamp: new Date(Date.now() - 1000 * 60 * 340).toISOString(),
    status: 'resolved',
    location: 'Tesis Alpha - Trafo Merkezi',
    value: '0.98 cos φ',
    threshold: '0.90 cos φ',
    resolvedBy: 'Enerji Yöneticisi'
  },
  {
    id: 'alm_11',
    severity: 'info',
    source: 'Koli Paketleme Robotu R-07',
    message: 'Vardiya hedef parça sayımı tamamlandı: 1.250 adet / 8 saat',
    timestamp: new Date(Date.now() - 1000 * 60 * 410).toISOString(),
    status: 'resolved',
    location: 'Tesis Gamma - Paketleme & Sevkiyat',
    value: '1.250 adet',
    threshold: '1.200 adet',
    resolvedBy: 'Sistem'
  },
  {
    id: 'alm_12',
    severity: 'info',
    source: 'Basınçlı Hava Kompresörü K-02',
    message: 'Otomatik yoğuşma tahliyesi ve hat hava basınç testi başarılı (7.2 bar)',
    timestamp: new Date(Date.now() - 1000 * 60 * 490).toISOString(),
    status: 'resolved',
    location: 'Tesis Beta - Basınçlı Hava Merkezi',
    value: '7.2 bar',
    threshold: '6.5 bar',
    resolvedBy: 'Periyodik Rutin'
  }
];

// In-Memory Dashboard
let mockDashboardLayout = [
  { id: 'w_oee', type: 'oee', title: 'Overall Equipment Effectiveness (OEE)', icon: 'fas fa-tachometer-alt', w: 2, h: 2, category: 'Production', description: 'Overall Equipment Effectiveness (OEE)', config: { visualType: 'Gauge Chart' } },
  { id: 'w_line', type: 'line-status', title: 'Line Status Overview', icon: 'fas fa-industry', w: 2, h: 1, category: 'Production', description: 'Production lines current capacity usage', config: { visualType: 'Donut Chart' } },
  { id: 'w_trend', type: 'line', title: 'Production OEE Trend Analysis', icon: 'fas fa-chart-line', w: 2, h: 2, category: 'Analytics', description: 'Real-time time series trend', config: { visualType: 'Line Chart' } },
  { id: 'w_energy', type: 'energy', title: 'Facility Energy Consumption', icon: 'fas fa-bolt', w: 2, h: 2, category: 'Energy', description: 'Total consumption levels in kW', config: { visualType: 'Bar Chart' } },
  { id: 'w_carbon', type: 'carbon', title: 'Carbon Footprint', icon: 'fas fa-leaf', w: 1, h: 1, category: 'Energy', description: 'CO2 emission indicator', config: { visualType: 'KPI Card' } },
  { id: 'w_sensor', type: 'sensor', title: 'Robot Arm Temperature Feed', icon: 'fas fa-wave-square', w: 2, h: 1, category: 'Realtime', description: 'Robot temperature sensor real-time simulation', config: { visualType: 'Area Chart' } }
];

// Simple mock SQL executor
function evaluateSql(sql: string): any[] {
  const clean = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  
  if (clean.includes('union all') || clean.includes('depth')) {
    const results: any[] = [];
    locations.forEach(l => {
      results.push({ id: `loc_${l.id}`, label: l.name, depth: 0, parent: null });
    });
    production_lines.forEach(pl => {
      results.push({ id: `line_${pl.id}`, label: pl.name, depth: 1, parent: `loc_${pl.location_id}` });
    });
    machines.forEach(m => {
      results.push({ id: `mach_${m.id}`, label: m.name, depth: 2, parent: `line_${m.line_id}` });
    });
    return results;
  }
  
  if (clean.includes('from machines')) {
    if (clean.includes("status = 'alarm'") || clean.includes("status='alarm'")) {
      return machines.filter(m => m.status === 'alarm');
    }
    if (clean.includes("status = 'warning'") || clean.includes("status='warning'")) {
      return machines.filter(m => m.status === 'warning');
    }
    if (clean.includes("status = 'offline'") || clean.includes("status='offline'")) {
      return machines.filter(m => m.status === 'offline');
    }
    if (clean.includes("status = 'online'") || clean.includes("status='online'")) {
      return machines.filter(m => m.status === 'online');
    }
    return machines;
  }
  
  if (clean.includes('from production_lines') || clean.includes('from production_line')) {
    return production_lines;
  }
  
  if (clean.includes('from locations') || clean.includes('from location')) {
    return locations;
  }
  
  return machines;
}

@Injectable()
export class DemoMockInterceptor implements HttpInterceptor {

  private getCurrentUser(): MockUser {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('currentUser');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.username) {
            const found = MOCK_USERS.find(u => u.username === parsed.username);
            if (found) return found;
          }
        } catch (_) {}
      }
    }
    return MOCK_USERS[0]; // Default to admin
  }

  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const url = request.url;

    // 1. NEVER intercept static assets, i18n JSON translations, images, or non-API files
    if (
      url.includes('assets/') ||
      url.endsWith('.json') ||
      url.endsWith('.png') ||
      url.endsWith('.jpg') ||
      url.endsWith('.svg') ||
      (!url.includes('/api/') && !url.startsWith('/api') && !url.includes('api/'))
    ) {
      return next.handle(request);
    }

    // Determine if this request should be handled by the client-side mock
    const isRelativeApi = url.startsWith('/api/') || url === '/api';
    const isMockHost = typeof window !== 'undefined' && (
      window.location.hostname.includes('github.io') ||
      window.location.pathname.includes('/demo') ||
      window.location.port === '5173' ||
      window.location.protocol === 'file:'
    );

    // If live backend on different host (e.g. http://localhost:5001) and not mock host, let it pass
    if (!isRelativeApi && !isMockHost && !url.includes('/api/')) {
      return next.handle(request);
    }

    // Strip host & query params for route matching
    let path = url;
    if (path.includes('/api/')) {
      path = '/api/' + path.split('/api/')[1];
    }
    const cleanUrl = path.split('?')[0];
    const method = request.method.toUpperCase();

    // ========================================================================
    // 1. AUTH & PROFILE
    // ========================================================================

    // POST /api/auth/login
    if (cleanUrl === '/api/auth/login' && method === 'POST') {
      const body = request.body as any;
      const username = (body?.username || '').toLowerCase().trim();

      let targetUser = MOCK_USERS.find(u => u.username === username);
      if (!targetUser) {
        if (username.includes('admin')) targetUser = MOCK_USERS.find(u => u.username === 'admin');
        else if (username.includes('eng')) targetUser = MOCK_USERS.find(u => u.username === 'engineer');
        else if (username.includes('oper') || username.includes('user')) targetUser = MOCK_USERS.find(u => u.username === 'operator');
        else if (username.includes('utku') || username.includes('dev')) targetUser = MOCK_USERS.find(u => u.username === 'utku');
        else targetUser = MOCK_USERS.find(u => u.username === 'viewer');
      }

      if (targetUser) {
        const token = `nov4_demo_token_${targetUser.id}_${Date.now()}`;
        return of(new HttpResponse({
          status: 200,
          body: {
            success: true,
            token: token,
            user: targetUser
          }
        })).pipe(delay(250));
      }

      return of(new HttpResponse({
        status: 401,
        body: { success: false, message: 'Geçersiz kullanıcı adı veya şifre' }
      })).pipe(delay(250));
    }

    // GET /api/profile or GET /api/auth/me
    if (cleanUrl === '/api/profile' || cleanUrl === '/api/auth/me') {
      const user = this.getCurrentUser();
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: user
        }
      }));
    }

    // POST /api/auth/logout
    if (cleanUrl === '/api/auth/logout') {
      return of(new HttpResponse({ status: 200, body: { success: true } }));
    }

    // ========================================================================
    // 2. ADMIN PANEL & ROLES (/api/admin/*, /api/roles, /api/permissions)
    // ========================================================================

    // GET /api/permissions (Permission Catalog)
    if (cleanUrl === '/api/permissions' && method === 'GET') {
      return of(new HttpResponse({
        status: 200,
        body: { success: true, data: PERMISSION_CATALOG }
      }));
    }

    // GET /api/roles
    if (cleanUrl === '/api/roles' && method === 'GET') {
      const roles = [
        {
          id: 'role_superuser',
          key: 'superuser',
          name: 'Süper Kullanıcı',
          description: 'Sistem geneli tam yetki ve mimari erişim',
          level: 100,
          isSystem: true,
          isActive: true,
          color: '#F5B301',
          memberCount: 1,
          permissions: ['*'],
          canManage: true
        },
        {
          id: 'role_admin',
          key: 'admin',
          name: 'Sistem Yöneticisi',
          description: 'Kullanıcı, rol ve veri kaynağı yönetimi',
          level: 80,
          isSystem: true,
          isActive: true,
          color: '#FF7A1A',
          memberCount: 1,
          permissions: ['*'],
          canManage: true
        },
        {
          id: 'role_engineer',
          key: 'engineer',
          name: 'Hat & Otomasyon Mühendisi',
          description: 'Topoloji, Space Map düzenleme, Python ve SQL Workspace',
          level: 60,
          isSystem: false,
          isActive: true,
          color: '#7C8DB5',
          memberCount: 1,
          permissions: MOCK_USERS.find(u => u.username === 'engineer')?.permissions || [],
          canManage: true
        },
        {
          id: 'role_operator',
          key: 'operator',
          name: 'Hat Operatörü (User)',
          description: 'Dashboard ve canlı SCADA izleme, alarm onaylama',
          level: 40,
          isSystem: false,
          isActive: true,
          color: '#34D399',
          memberCount: 2,
          permissions: MOCK_USERS.find(u => u.username === 'operator')?.permissions || [],
          canManage: false
        },
        {
          id: 'role_viewer',
          key: 'viewer',
          name: 'İzleyici (Misafir)',
          description: 'Salt okunur pano ve rapor görüntüleme',
          level: 20,
          isSystem: false,
          isActive: true,
          color: '#A39A89',
          memberCount: 1,
          permissions: MOCK_USERS.find(u => u.username === 'viewer')?.permissions || [],
          canManage: false
        }
      ];
      return of(new HttpResponse({ status: 200, body: { success: true, data: roles } }));
    }

    // PUT /api/roles/:id
    if (cleanUrl.match(/\/api\/roles\/[^/]+$/) && method === 'PUT') {
      return of(new HttpResponse({ status: 200, body: { success: true, message: 'Rol izinleri güncellendi' } }));
    }

    // GET /api/admin/users
    if (cleanUrl === '/api/admin/users' && method === 'GET') {
      const adminUsers = MOCK_USERS.map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        role: u.role,
        roleId: `role_${u.role}`,
        roleKey: u.role,
        roleName: u.displayName,
        level: u.level,
        roleColor: u.level >= 80 ? '#F5B301' : (u.level >= 60 ? '#7C8DB5' : '#34D399'),
        isActive: true,
        canManage: u.level < 100,
        createdAt: '2026-01-15T09:00:00Z',
        updatedAt: '2026-09-14T18:30:00Z'
      }));
      return of(new HttpResponse({ status: 200, body: { success: true, data: adminUsers } }));
    }

    // GET /api/admin/users/:id
    if (cleanUrl.match(/\/api\/admin\/users\/[^/]+$/) && method === 'GET') {
      const match = cleanUrl.match(/\/api\/admin\/users\/([^/]+)$/);
      const userId = match ? match[1] : '';
      const user = MOCK_USERS.find(u => u.id === userId || u.username === userId) || MOCK_USERS[0];

      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: {
            ...user,
            roleId: `role_${user.role}`,
            roleKey: user.role,
            roleName: user.displayName,
            roleColor: user.level >= 80 ? '#F5B301' : '#7C8DB5',
            isActive: true,
            canManage: true,
            overrides: [],
            ownedCounts: { templates: 3, paths: 2, queries: 4, scripts: 2, dashboards: 1 }
          }
        }
      }));
    }

    // PUT /api/admin/users/:id/password
    if (cleanUrl.match(/\/api\/admin\/users\/[^/]+\/password$/) && method === 'PUT') {
      return of(new HttpResponse({ status: 200, body: { success: true, message: 'Şifre başarıyla güncellendi' } }));
    }

    // PUT /api/admin/users/:id/permissions
    if (cleanUrl.match(/\/api\/admin\/users\/[^/]+\/permissions$/) && method === 'PUT') {
      return of(new HttpResponse({ status: 200, body: { success: true, message: 'İzinler başarıyla güncellendi' } }));
    }

    // POST /api/admin/users
    if (cleanUrl === '/api/admin/users' && method === 'POST') {
      const body = request.body as any;
      const newUser: MockUser = {
        id: `usr_${Date.now()}`,
        username: body?.username || 'new_user',
        displayName: body?.displayName || body?.username || 'Yeni Kullanıcı',
        email: body?.email || 'user@supernovacorp.com',
        role: body?.roleKey || 'operator',
        level: body?.roleKey === 'admin' ? 80 : (body?.roleKey === 'engineer' ? 60 : 40),
        permissions: ['page:dashboard', 'page:network-map', 'page:alarms', 'page:reports'],
        allowedPages: ['dashboard', 'network-map', 'alarms', 'reports'],
        avatar: 'assets/default-avatar.png'
      };
      MOCK_USERS.push(newUser);
      return of(new HttpResponse({ status: 200, body: { success: true, data: newUser } }));
    }

    // PUT /api/admin/users/:id
    if (cleanUrl.match(/\/api\/admin\/users\/[^/]+$/) && method === 'PUT') {
      return of(new HttpResponse({ status: 200, body: { success: true, message: 'Kullanıcı güncellendi' } }));
    }

    // DELETE /api/admin/users/:id
    if (cleanUrl.match(/\/api\/admin\/users\/[^/]+$/) && method === 'DELETE') {
      return of(new HttpResponse({ status: 200, body: { success: true, message: 'Kullanıcı silindi' } }));
    }

    // GET /api/admin/sharing/:type
    if (cleanUrl.match(/\/api\/admin\/sharing\/[^/]+$/) && method === 'GET') {
      const items = [
        { id: 'sh_1', name: 'Factory Performance Master Template', owner: 'usr_admin', ownerName: 'Sistem Yöneticisi', allowedRoles: ['admin', 'engineer', 'operator'], allowedUsers: [] },
        { id: 'sh_2', name: 'Apex Smart Factory Space Map', owner: 'usr_engineer', ownerName: 'Hat & Otomasyon Mühendisi', allowedRoles: ['admin', 'engineer', 'operator', 'viewer'], allowedUsers: [] },
        { id: 'sh_3', name: 'Line OEE Estimation Query', owner: 'usr_engineer', ownerName: 'Hat & Otomasyon Mühendisi', allowedRoles: ['admin', 'engineer'], allowedUsers: [] }
      ];
      return of(new HttpResponse({ status: 200, body: { success: true, data: items } }));
    }

    // PUT /api/admin/sharing/:type/:id
    if (cleanUrl.match(/\/api\/admin\/sharing\/[^/]+\/[^/]+$/) && method === 'PUT') {
      return of(new HttpResponse({ status: 200, body: { success: true, message: 'Paylaşım izinleri kaydedildi' } }));
    }

    // GET /api/users (Quick user picker)
    if (cleanUrl === '/api/users' && method === 'GET') {
      return of(new HttpResponse({ status: 200, body: { success: true, data: MOCK_USERS } }));
    }

    // ========================================================================
    // 3. DATASOURCES & TABLES (/api/datasources/*)
    // ========================================================================

    // GET /api/datasources
    if (cleanUrl === '/api/datasources' && method === 'GET') {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: [
            { id: 'ds_factory', name: 'Apex Smart Factory - Robotics & Assembly', db_type: 'sqlite', dbType: 'sqlite', host: 'edge-cluster-01.factory.local', is_active: 1, isActive: true },
            { id: 'ds_energy', name: 'Facility Energy & Carbon Grid', db_type: 'sqlite', dbType: 'sqlite', host: 'energy-node-02.plant.local', is_active: 1, isActive: true }
          ]
        }
      }));
    }

    // POST /api/datasources/test
    if (cleanUrl === '/api/datasources/test' && method === 'POST') {
      return of(new HttpResponse({
        status: 200,
        body: { success: true, message: 'Bağlantı başarılı! (Gecikme süresi: 1.8 ms)' }
      })).pipe(delay(300));
    }

    // GET /api/datasources/:id/tables
    if (cleanUrl.match(/\/api\/datasources\/[^/]+\/tables$/)) {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: ['locations', 'production_lines', 'machines', 'equipment_downtime_events', 'facility_energy_esg']
        }
      }));
    }

    // GET /api/datasources/:id/tables/:table/schema
    if (cleanUrl.match(/\/api\/datasources\/[^/]+\/tables\/[^/]+\/schema$/)) {
      const match = cleanUrl.match(/\/api\/datasources\/[^/]+\/tables\/([^/]+)\/schema$/);
      const tableName = match ? match[1] : '';
      
      let columns: any[] = [];
      let rowCount = 0;
      if (tableName === 'locations') {
        columns = [
          { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'city', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'capacity', dataType: 'INTEGER', isPrimaryKey: false, nullable: false }
        ];
        rowCount = locations.length;
      } else if (tableName === 'production_lines') {
        columns = [
          { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'location_id', dataType: 'INTEGER', isPrimaryKey: false, nullable: true },
          { name: 'speed', dataType: 'TEXT', isPrimaryKey: false, nullable: true },
          { name: 'oee', dataType: 'REAL', isPrimaryKey: false, nullable: true }
        ];
        rowCount = production_lines.length;
      } else {
        columns = [
          { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'type', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'line_id', dataType: 'INTEGER', isPrimaryKey: false, nullable: true },
          { name: 'status', dataType: 'TEXT', isPrimaryKey: false, nullable: true },
          { name: 'model', dataType: 'TEXT', isPrimaryKey: false, nullable: true }
        ];
        rowCount = machines.length;
      }

      return of(new HttpResponse({
        status: 200,
        body: { success: true, data: { columns, rowCount } }
      }));
    }

    // GET /api/datasources/:id/tables/:table (Row Data)
    if (cleanUrl.match(/\/api\/datasources\/[^/]+\/tables\/[^/]+$/)) {
      const match = cleanUrl.match(/\/api\/datasources\/[^/]+\/tables\/([^/]+)$/);
      const tableName = match ? match[1] : '';
      
      let rows: any[] = [];
      if (tableName === 'locations') rows = locations;
      else if (tableName === 'production_lines') rows = production_lines;
      else rows = machines;

      return of(new HttpResponse({
        status: 200,
        body: { success: true, data: { rows, rowCount: rows.length } }
      }));
    }

    // ========================================================================
    // 4. SPACE MAP & PATH DEFINER (/api/paths/*)
    // ========================================================================

    // GET /api/paths
    if (cleanUrl === '/api/paths' && method === 'GET') {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: mockPaths
        }
      }));
    }

    // GET /api/paths/:id
    if (cleanUrl.match(/\/api\/paths\/[^/]+$/) && method === 'GET') {
      const match = cleanUrl.match(/\/api\/paths\/([^/]+)$/);
      const pathId = match ? match[1] : '';
      const found = mockPaths.find(p => p.id === pathId) || mockPaths[0];

      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: found
        }
      }));
    }

    // PUT /api/paths/:id (Save Space Map Theme, Node Shape, Figure, Colors)
    if (cleanUrl.match(/\/api\/paths\/[^/]+$/) && method === 'PUT') {
      const match = cleanUrl.match(/\/api\/paths\/([^/]+)$/);
      const pathId = match ? match[1] : '';
      const body = request.body as any;

      const idx = mockPaths.findIndex(p => p.id === pathId);
      if (idx !== -1) {
        mockPaths[idx] = {
          ...mockPaths[idx],
          name: body?.name || mockPaths[idx].name,
          config: {
            ...mockPaths[idx].config,
            ...(body?.config || {})
          }
        };
        return of(new HttpResponse({
          status: 200,
          body: {
            success: true,
            data: mockPaths[idx],
            message: 'Space Map yapılandırması başarıyla kaydedildi'
          }
        })).pipe(delay(200));
      }

      return of(new HttpResponse({
        status: 200,
        body: { success: true, data: body }
      }));
    }

    // POST /api/paths/:id/build
    if (cleanUrl.match(/\/api\/paths\/[^/]+\/build$/)) {
      const built = getFactoryBuiltStructure();
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: built
        }
      })).pipe(delay(150));
    }

    // POST /api/paths/:id/search
    if (cleanUrl.match(/\/api\/paths\/[^/]+\/search$/)) {
      const body = request.body as any;
      const term = (body?.term || '').toLowerCase();
      const built = getFactoryBuiltStructure();
      const hits = built.nodes
        .filter((n: any) => n.label.toLowerCase().includes(term))
        .map((n: any) => ({
          id: n.id,
          label: n.label,
          type: n.depth === 0 ? 'Plant' : (n.depth === 1 ? 'Line' : 'Machine'),
          depth: n.depth,
          breadcrumb: [n.label]
        }));

      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: { hits }
        }
      }));
    }

    // ========================================================================
    // 5. QUERIES & SQL WORKSPACE (/api/queries/*)
    // ========================================================================

    // GET /api/queries
    if (cleanUrl === '/api/queries' && method === 'GET') {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: [
            {
              id: 'q_factory',
              name: 'Factory Network Map Hierarchy',
              dataSourceId: 'ds_factory',
              data_source_id: 'ds_factory',
              sql: "SELECT 'loc_' || l.id as id, l.name as label, 0 as depth, NULL as parent FROM locations l\nUNION ALL\nSELECT 'line_' || pl.id, pl.name, 1, 'loc_' || pl.location_id FROM production_lines pl\nUNION ALL\nSELECT 'mach_' || m.id, m.name, 2, 'line_' || m.line_id FROM machines m",
              query: "SELECT 'loc_' || l.id as id, l.name as label, 0 as depth, NULL as parent FROM locations l\nUNION ALL\nSELECT 'line_' || pl.id, pl.name, 1, 'loc_' || pl.location_id FROM production_lines pl\nUNION ALL\nSELECT 'mach_' || m.id, m.name, 2, 'line_' || m.line_id FROM machines m"
            },
            {
              id: 'q_cnc_alerts',
              name: 'Active CNC Machine Alerts',
              dataSourceId: 'ds_factory',
              data_source_id: 'ds_factory',
              sql: "SELECT * FROM machines WHERE type = 'CNC' AND status IN ('alarm', 'offline')",
              query: "SELECT * FROM machines WHERE type = 'CNC' AND status IN ('alarm', 'offline')"
            },
            {
              id: 'q_oee_summary',
              name: 'Line OEE Estimation',
              dataSourceId: 'ds_factory',
              data_source_id: 'ds_factory',
              sql: "SELECT line_id, AVG(CASE WHEN status='online' THEN 92.5 WHEN status='warning' THEN 74.0 ELSE 35.0 END) as avg_oee FROM machines GROUP BY line_id",
              query: "SELECT line_id, AVG(CASE WHEN status='online' THEN 92.5 WHEN status='warning' THEN 74.0 ELSE 35.0 END) as avg_oee FROM machines GROUP BY line_id"
            },
            {
              id: 'q_warning_devices',
              name: 'Machine Warnings List',
              dataSourceId: 'ds_factory',
              data_source_id: 'ds_factory',
              sql: "SELECT * FROM machines WHERE status = 'warning'",
              query: "SELECT * FROM machines WHERE status = 'warning'"
            }
          ]
        }
      }));
    }

    // POST /api/queries/preview
    if (cleanUrl.includes('/api/queries/preview')) {
      const body = request.body as any;
      const sql = body?.sql || '';
      const rows = evaluateSql(sql);
      const rawColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
      const columns = rawColumns.map(col => ({ name: col, dataType: 'text', label: col }));

      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: {
            columns: columns,
            rows: rows,
            rowCount: rows.length
          }
        }
      })).pipe(delay(200));
    }

    // ========================================================================
    // 6. PYTHON WORKSPACE (/api/python/*)
    // ========================================================================

    // GET /api/python/scripts
    if (cleanUrl.endsWith('/api/python/scripts')) {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: [
            {
              id: 's_oee',
              name: 'Calculate Factory Line OEE',
              code: "# Calculate Overall Equipment Effectiveness\n# Input data is loaded from the SQL query 'q_factory'\nmachines = sql_data.get('q_factory') or []\n\nlog('Analyzing OEE rates...')\nresults = []\nfor m in machines:\n    # Simulate OEE calculations\n    oee = 85.0\n    if m.get('status') == 'alarm': oee = 45.0\n    elif m.get('status') == 'warning': oee = 72.0\n    results.append({'machine': m.get('name'), 'oee': f\"{oee}%\"})\n\nout('OEE Analysis').append(results)\n",
              sqlQueryIds: ['q_factory']
            },
            {
              id: 's_temp',
              name: 'CNC Temperature Anomaly Detector',
              code: "# Check temperatures of CNC machines\nmachines = sql_data.get('q_factory') or []\n\nlog('Scanning spindle temperatures...')\nfor m in machines:\n    if m.get('type') == 'CNC':\n        temp = 95 if m.get('status') == 'alarm' else 65\n        if temp > 80:\n            log(f\"[ALERT] {m.get('name')} is overheating: {temp}C!\")\n        else:\n            log(f\"[OK] {m.get('name')} temperature: {temp}C\")\n",
              sqlQueryIds: ['q_factory']
            }
          ]
        }
      }));
    }

    // POST /api/python/run
    if (cleanUrl.includes('/api/python/run')) {
      const body = request.body as any;
      const code = body?.code || '';
      
      const logRows = [
        { log: "Initializing Python execution sandbox (Air-gapped)..." },
        { log: "Loaded industrial telemetry context." }
      ];
      let dataRows: any[] = [];
      let columns: string[] = [];
      let outputName = "Analysis Output";

      if (code.includes('OEE') || code.includes('oee') || code.includes('efficiency')) {
        logRows.push(
          { log: "Running OEE threshold verification across all 7 assembly lines..." },
          { log: "Line 1 (Chassis Assembly Line): OEE 88.4% (Optimal)" },
          { log: "Line 2 (Engine Assembly Line): OEE 74.0% [Underperforming - CNC Lathe E1 Alarm]" },
          { log: "Line 3 (Electronics & SMT): OEE 91.2% (Optimal)" }
        );
        dataRows = [
          { LineName: "Chassis Assembly Line", EstimatedOEE: "88.4%", Status: "Optimal", Recommendation: "Normal production pace" },
          { LineName: "Engine Assembly Line", EstimatedOEE: "74.0%", Status: "Underperforming", Recommendation: "Service CNC Spindle E1" },
          { LineName: "Electronics & SMT", EstimatedOEE: "91.2%", Status: "Optimal", Recommendation: "Maintain current throughput" }
        ];
        columns = ["LineName", "EstimatedOEE", "Status", "Recommendation"];
        outputName = "OEE Line Summary";
      } else if (code.includes('temp') || code.includes('CNC') || code.includes('cnc')) {
        logRows.push(
          { log: "Scanning spindle temperature sensors..." },
          { log: "[CRITICAL] CNC Lathe E1 is overheating: 95°C! (Exceeded 85°C limit)" },
          { log: "[OK] CNC Lathe E2: 0°C (Offline / Standby)" },
          { log: "[WARNING] Reflow Oven SMD: 245°C (+6°C fluctuation)" }
        );
        dataRows = [
          { Machine: "CNC Lathe E1", LastTemp: "95°C", State: "CRITICAL", Action: "Coolant flush required" },
          { Machine: "Reflow Oven SMD", LastTemp: "245°C", State: "WARNING", Action: "Inspect thermocouple" },
          { Machine: "KUKA Robot Arm C1", LastTemp: "42°C", State: "NORMAL", Action: "Within operating range" }
        ];
        columns = ["Machine", "LastTemp", "State", "Action"];
        outputName = "Thermal Anomaly Diagnostics";
      } else {
        logRows.push(
          { log: "Executing custom Python logic..." },
          { log: "Process exited with code 0." }
        );
        dataRows = machines.slice(0, 5);
        columns = ["id", "name", "type", "status"];
      }

      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: {
            "Console Log Output": {
              columns: ["log"],
              rows: logRows,
              rowCount: logRows.length
            },
            [outputName]: {
              columns: columns,
              rows: dataRows,
              rowCount: dataRows.length
            }
          }
        }
      })).pipe(delay(400));
    }

    // ========================================================================
    // 7. ALARMS (/api/alarms/*)
    // ========================================================================

    // GET /api/alarms
    if (cleanUrl.includes('/api/alarms') && method === 'GET') {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: mockAlarms
        }
      }));
    }

    // POST /api/alarms/:id/acknowledge
    if (cleanUrl.match(/\/api\/alarms\/[^/]+\/acknowledge$/)) {
      const match = cleanUrl.match(/\/api\/alarms\/([^/]+)\/acknowledge$/);
      const alarmId = match ? match[1] : '';
      const alm = mockAlarms.find(a => a.id === alarmId);
      if (alm) alm.status = 'acknowledged';

      return of(new HttpResponse({
        status: 200,
        body: { success: true, message: 'Alarm onaylandı' }
      }));
    }

    // POST /api/alarms/:id/resolve
    if (cleanUrl.match(/\/api\/alarms\/[^/]+\/resolve$/)) {
      const match = cleanUrl.match(/\/api\/alarms\/([^/]+)\/resolve$/);
      const alarmId = match ? match[1] : '';
      const alm = mockAlarms.find(a => a.id === alarmId);
      if (alm) alm.status = 'resolved';

      return of(new HttpResponse({
        status: 200,
        body: { success: true, message: 'Alarm çözüldü olarak işaretlendi' }
      }));
    }

    // ========================================================================
    // 8. DASHBOARD & WIDGETS (/api/dashboards/*, /api/widgets/*)
    // ========================================================================

    // GET /api/dashboards/me
    if (cleanUrl.includes('/api/dashboards/me') && method === 'GET') {
      return of(new HttpResponse({
        status: 200,
        body: {
          success: true,
          data: {
            id: 'db_demo',
            name: 'Apex Smart Factory Overview Dashboard',
            layout: mockDashboardLayout
          }
        }
      }));
    }

    // POST /api/dashboards/me or PUT /api/dashboards/:id (Save Layout)
    if (cleanUrl.includes('/api/dashboards') && (method === 'POST' || method === 'PUT')) {
      const body = request.body as any;
      if (Array.isArray(body)) {
        mockDashboardLayout = body;
      } else if (body && Array.isArray(body.layout)) {
        mockDashboardLayout = body.layout;
      }
      return of(new HttpResponse({
        status: 200,
        body: { success: true, message: 'Dashboard yerleşimi kaydedildi' }
      }));
    }

    // GET /api/widgets
    if (cleanUrl.includes('/api/widgets')) {
      return of(new HttpResponse({
        status: 200,
        body: { success: true, data: mockDashboardLayout }
      }));
    }

    // ========================================================================
    // 9. REPORTS & TEMPLATES (/api/reports/*, /api/templates/*)
    // ========================================================================

    // GET /api/reports
    if (cleanUrl === '/api/reports' && method === 'GET') {
      const reports = [
        {
          id: 'rep_1',
          name: 'Apex Daily Operations & OEE Briefing',
          type: 'Excel (XLSX)',
          status: 'ready',
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
          recordCount: 840,
          description: '3 tesisin günlük OEE, plansız duruş ve çevrim süreleri dökümü'
        },
        {
          id: 'rep_2',
          name: 'Facility Energy & ESG Emissions Review',
          type: 'PDF Report',
          status: 'ready',
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
          recordCount: 1200,
          description: 'Haftalık kWh enerji tüketim dağılımı ve karbon ayak izi grafikleri'
        },
        {
          id: 'rep_3',
          name: 'CNC Spindle Thermal & Vibration Audit',
          type: 'Excel (XLSX)',
          status: 'ready',
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
          recordCount: 450,
          description: 'CNC Lathe E1 ve E2 sıcaklık anomali telemetri analizi'
        }
      ];
      return of(new HttpResponse({ status: 200, body: { success: true, data: reports } }));
    }

    // POST /api/reports (Create report)
    if (cleanUrl === '/api/reports' && method === 'POST') {
      const body = request.body as any;
      const newRep = {
        id: `rep_${Date.now()}`,
        name: body?.name || 'Yeni Rapor',
        type: body?.format === 'pdf' ? 'PDF Report' : 'Excel (XLSX)',
        status: 'ready',
        createdAt: new Date().toISOString(),
        recordCount: 150,
        description: body?.description || 'Otomatik oluşturulmuş analiz raporu'
      };
      return of(new HttpResponse({ status: 200, body: { success: true, data: newRep } }));
    }

    // POST /api/reports/:id/run
    if (cleanUrl.match(/\/api\/reports\/[^/]+\/run$/)) {
      return of(new HttpResponse({
        status: 200,
        body: { success: true, message: 'Rapor başarıyla çalıştırıldı ve dosya oluşturuldu.' }
      })).pipe(delay(500));
    }

    // GET /api/templates
    if (cleanUrl.includes('/api/templates') && method === 'GET') {
      const templates = [
        { id: 'tpl_1', name: 'Executive Smart Factory Summary', type: 'excel', isDefault: true },
        { id: 'tpl_2', name: 'Line Telemetry Detailed Sheet', type: 'excel', isDefault: false }
      ];
      return of(new HttpResponse({ status: 200, body: { success: true, data: templates } }));
    }

    // Fallback for any other /api/ call
    return of(new HttpResponse({ status: 200, body: { success: true, data: [] } }));
  }
}
