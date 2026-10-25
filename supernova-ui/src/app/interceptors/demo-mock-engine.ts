import { BuiltStructure, PathDef, PathNode } from '../models/path-def.model';
import { TemplateDocument } from '../models/template-document.model';
import { DEMO_TABLES, evaluateDemoSql, executeDemoPython } from './demo-mock-data';

// ============================================================================
// 1. FOUR DISTINCT SPACE MAPS (TREE, SEQUENCE, DAG, MULTI_LEVEL)
// ============================================================================

export const DEMO_PATHS: PathDef[] = [
  {
    id: 'p_factory',
    name: 'Apex Kampüs & Robotik Topoloji Haritası',
    description: '4 tesis, 8 üretim hattı ve 16 robot/CNC istasyonunun canlı OEE & sağlık topolojisi.',
    queryId: 'q_factory_tree',
    structure: 'tree',
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    config: {
      id_col: 'node_id',
      parent_col: 'parent_id',
      label_col: 'label',
      type_col: 'node_type',
      health_col: 'health_score',
      status_col: 'status',
      spaceMapConfig: {
        theme: 'factory',
        nodeShape: 'hexagon',
        layout: 'radial',
        color1: '#F59E0B',
        color2: '#10B981',
        color3: '#06B6D4',
        level1Icon: 'fa-industry',
        level2Icon: 'fa-cogs',
        level3Icon: 'fa-robot',
        showOrbits: true,
        showGrid: true,
      },
    },
  },
  {
    id: 'p_assembly_flow',
    name: 'EV Şasi Kaynak & Boyahane Proses Akış Hattı',
    description: 'ST-10 Lazer Kesim → ST-80 EOL Kalite Onay sıralı istasyon akışı ve çevrim süreleri.',
    queryId: 'q_oee_lines',
    structure: 'sequence',
    owner: 'usr_engineer',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    config: {
      id_col: 'line_code',
      label_col: 'line_name',
      health_col: 'oee_pct',
      status_col: 'status',
      spaceMapConfig: {
        theme: 'blueprint',
        nodeShape: 'blueprint',
        layout: 'flow-lr',
        color1: '#38BDF8',
        color2: '#818CF8',
        color3: '#34D399',
        level1Icon: 'fa-industry',
        level2Icon: 'fa-cogs',
        level3Icon: 'fa-clipboard-check',
        showOrbits: false,
        showGrid: true,
      },
    },
  },
  {
    id: 'p_energy_dag',
    name: 'Yüksek Gerilim Trafo, GES & Fider Ağı (DAG)',
    description: 'Ana Trafo TR-A/TR-B ve Çatı GES kaynaklarından 6 üretim fiderine çift beslemeli enerji topolojisi.',
    queryId: 'q_energy_esg',
    structure: 'dag',
    owner: 'usr_engineer',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    config: {
      id_col: 'feeder_code',
      label_col: 'zone_name',
      spaceMapConfig: {
        theme: 'cyber',
        nodeShape: 'cyber',
        layout: 'hierarchy-tb',
        color1: '#10B981',
        color2: '#06B6D4',
        color3: '#F59E0B',
        level1Icon: 'fa-bolt',
        level2Icon: 'fa-plug',
        level3Icon: 'fa-gauge-high',
        showOrbits: false,
        showGrid: true,
      },
    },
  },
  {
    id: 'p_oee_matrix',
    name: 'Şehir → Hat → Vardiya OEE Küme Matrisi',
    description: 'Çok katmanlı bölge, hat ve vardiya üretim partisi sağlık kümeleme görünümü.',
    queryId: 'q_batch_production',
    structure: 'multi_level',
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    config: {
      level1_col: 'shift',
      level2_col: 'line_name',
      level3_col: 'batch_code',
      health_col: 'oee_pct',
      spaceMapConfig: {
        theme: 'crystal',
        nodeShape: 'diamond',
        layout: 'grid',
        color1: '#8B5CF6',
        color2: '#06B6D4',
        color3: '#10B981',
        level1Icon: 'fa-layer-group',
        level2Icon: 'fa-cogs',
        level3Icon: 'fa-boxes-stacked',
        showOrbits: true,
        showGrid: true,
      },
    },
  },
];

export function buildDemoStructure(pathId: string): BuiltStructure {
  if (pathId === 'p_assembly_flow') {
    const steps = [
      { id: 'ST-10', label: 'ST-10 · Fiber Lazer Sac Kesim', health: 96, status: 'online', icon: 'fa-bolt', tact: '38 sn' },
      { id: 'ST-20', label: 'ST-20 · KUKA Şasi Punta Kaynak', health: 94, status: 'online', icon: 'fa-robot', tact: '41 sn' },
      { id: 'ST-30', label: 'ST-30 · 5-Eksen CNC Bağlantı İşleme', health: 68, status: 'warning', icon: 'fa-gear', tact: '54 sn' },
      { id: 'ST-40', label: 'ST-40 · Kataforez & Yüzey Kaplama', health: 91, status: 'online', icon: 'fa-water', tact: '42 sn' },
      { id: 'ST-50', label: 'ST-50 · Robotik Gövde & Batarya Montaj', health: 93, status: 'online', icon: 'fa-cogs', tact: '40 sn' },
      { id: 'ST-60', label: 'ST-60 · 800V EOL & CMM Lazer Kalite', health: 98, status: 'online', icon: 'fa-clipboard-check', tact: '36 sn' },
    ];
    const nodes: PathNode[] = steps.map((s, i) => ({
      id: s.id,
      label: s.label,
      parent: i === 0 ? '' : steps[i - 1].id,
      depth: i,
      path: steps.slice(0, i + 1).map((x) => x.id),
      type: 'Station',
      icon: s.icon,
      children: i < steps.length - 1 ? [steps[i + 1].id] : [],
      healthScore: s.health,
      status: s.status,
      badge: s.tact,
      row: s,
    }));
    return {
      nodes,
      roots: [steps[0].id],
      paths: [steps.map((s) => s.id)],
      stats: { node_count: nodes.length, path_count: 1, max_depth: steps.length - 1, warnings: [] },
    };
  }

  if (pathId === 'p_energy_dag') {
    const nodes: PathNode[] = [
      { id: 'SRC-GRID', label: '154 kV Ana İndirici Trafo (TR-A)', parent: '', depth: 0, path: ['SRC-GRID'], type: 'Source', icon: 'fa-bolt', children: ['BUS-WEST', 'BUS-EAST'], healthScore: 98, status: 'online', badge: '2.4 MW' },
      { id: 'SRC-SOLAR', label: 'Çatı GES Güneş Santrali (2.8 MWp)', parent: '', depth: 0, path: ['SRC-SOLAR'], type: 'Solar', icon: 'fa-leaf', children: ['BUS-WEST', 'BUS-EAST'], healthScore: 99, status: 'online', badge: '-380 kW' },
      { id: 'BUS-WEST', label: 'OG Bara A · Gövde & Elektronik', parent: 'SRC-GRID', parents: ['SRC-GRID', 'SRC-SOLAR'], depth: 1, path: ['SRC-GRID', 'BUS-WEST'], type: 'Busbar', icon: 'fa-plug', children: ['FDR-01', 'FDR-04', 'FDR-05'], healthScore: 96, status: 'online', badge: 'cosφ 0.98' },
      { id: 'BUS-EAST', label: 'OG Bara B · Ağır İmalat & Döküm', parent: 'SRC-GRID', parents: ['SRC-GRID', 'SRC-SOLAR'], depth: 1, path: ['SRC-GRID', 'BUS-EAST'], type: 'Busbar', icon: 'fa-plug', children: ['FDR-02', 'FDR-03', 'FDR-06'], healthScore: 86, status: 'warning', badge: 'cosφ 0.93' },
      ...DEMO_TABLES['energy_telemetry'].rows.slice(0, 6).map((f, idx) => {
        const bus = idx === 0 || idx === 3 || idx === 4 ? 'BUS-WEST' : 'BUS-EAST';
        return {
          id: f['feeder_code'],
          label: `${f['feeder_code']} · ${f['zone_name']}`,
          parent: bus,
          parents: [bus],
          depth: 2,
          path: ['SRC-GRID', bus, f['feeder_code']],
          type: 'Feeder',
          icon: 'fa-gauge-high',
          children: [],
          healthScore: Math.round(f['power_factor'] * 100),
          status: f['power_factor'] < 0.94 ? 'warning' : 'online',
          badge: `${f['active_kwh']} kWh`,
          row: f,
        };
      }),
    ];
    return {
      nodes,
      roots: ['SRC-GRID', 'SRC-SOLAR'],
      paths: nodes.filter((n) => n.depth === 2).map((n) => n.path),
      stats: { node_count: nodes.length, path_count: 6, max_depth: 2, warnings: [] },
    };
  }

  if (pathId === 'p_oee_matrix') {
    const nodes: PathNode[] = [
      { id: 'ROOT-OPS', label: 'Günlük Vardiya OEE Matrisi', parent: '', depth: 0, path: ['ROOT-OPS'], type: 'Root', icon: 'fa-layer-group', children: ['SH-A', 'SH-B'], healthScore: 90, status: 'online' },
      { id: 'SH-A', label: 'Vardiya A (07:00 - 15:00)', parent: 'ROOT-OPS', depth: 1, path: ['ROOT-OPS', 'SH-A'], type: 'Shift', icon: 'fa-sun', children: [], healthScore: 91, status: 'online' },
      { id: 'SH-B', label: 'Vardiya B (15:00 - 23:00)', parent: 'ROOT-OPS', depth: 1, path: ['ROOT-OPS', 'SH-B'], type: 'Shift', icon: 'fa-bolt', children: [], healthScore: 87, status: 'online' },
    ];
    const paths: string[][] = [];
    DEMO_TABLES['production_batches'].rows.forEach((b) => {
      const shId = String(b['shift']).includes('Vardiya A') ? 'SH-A' : 'SH-B';
      const parentNode = nodes.find((n) => n.id === shId)!;
      const nid = b['batch_code'];
      parentNode.children.push(nid);
      const p = ['ROOT-OPS', shId, nid];
      paths.push(p);
      nodes.push({
        id: nid,
        label: `${b['batch_code']} · ${b['line_name']}`,
        parent: shId,
        depth: 2,
        path: p,
        type: 'Batch',
        icon: 'fa-boxes-stacked',
        children: [],
        healthScore: Math.round(b['oee_pct']),
        status: b['oee_pct'] < 80 ? 'warning' : 'online',
        badge: `%${b['oee_pct']} OEE`,
        row: b,
      });
    });
    return {
      nodes,
      roots: ['ROOT-OPS'],
      paths,
      stats: { node_count: nodes.length, path_count: paths.length, max_depth: 2, warnings: [] },
    };
  }

  // Default: p_factory (4 plants -> 8 lines -> 16 machines)
  const nodes: PathNode[] = [];
  const roots: string[] = [];
  const paths: string[][] = [];

  DEMO_TABLES['locations'].rows.forEach((loc) => {
    const locId = `loc_${loc['id']}`;
    roots.push(locId);
    const lines = DEMO_TABLES['production_lines'].rows.filter((pl) => pl['location_id'] === loc['id']);
    nodes.push({
      id: locId,
      label: loc['name'],
      parent: '',
      depth: 0,
      path: [locId],
      type: 'Plant',
      icon: 'fa-industry',
      children: lines.map((l) => `line_${l['id']}`),
      healthScore: Math.round(loc['plant_oee_pct']),
      status: 'online',
      badge: `%${loc['plant_oee_pct']} OEE`,
      row: loc,
    });

    lines.forEach((pl) => {
      const lineId = `line_${pl['id']}`;
      const machs = DEMO_TABLES['machines'].rows.filter((m) => m['line_id'] === pl['id']);
      nodes.push({
        id: lineId,
        label: pl['line_name'],
        parent: locId,
        depth: 1,
        path: [locId, lineId],
        type: 'Line',
        icon: 'fa-cogs',
        children: machs.map((m) => `mach_${m['id']}`),
        healthScore: Math.round(pl['oee_pct']),
        status: pl['status'],
        badge: `${pl['actual_uph']}/${pl['target_uph']} UPH`,
        row: pl,
      });

      machs.forEach((m) => {
        const mId = `mach_${m['id']}`;
        const chain = [locId, lineId, mId];
        paths.push(chain);
        nodes.push({
          id: mId,
          label: m['name'],
          parent: lineId,
          depth: 2,
          path: chain,
          type: m['type'],
          icon: m['type'] === 'Robot' ? 'fa-robot' : m['type'] === 'CNC' ? 'fa-gear' : 'fa-microchip',
          children: [],
          healthScore: m['health_score'],
          status: m['status'],
          badge: `${m['spindle_temp_c']}°C`,
          row: m,
        });
      });
    });
  });

  return {
    nodes,
    roots,
    paths,
    stats: { node_count: nodes.length, path_count: paths.length, max_depth: 2, warnings: [] },
  };
}

// ============================================================================
// 2. REPORT TEMPLATES + LIVE EVALUATOR + REAL XLSX / PDF BINARY BUILDERS
// ============================================================================

function makeExecTemplate(opts: {
  id: string;
  name: string;
  description: string;
  sheetName: string;
  accentHex: string;
  queryId: string;
  kpis: Array<{ label: string; op: 'SUM' | 'AVG' | 'MAX' | 'COUNT'; field: string }>;
  headers: Array<{ col: number; title: string; field: string }>;
  charts: Array<{ id: string; type: 'bar' | 'line' | 'pie'; title: string; xAxis: string; yAxis: string[] }>;
}): { id: string; name: string; description: string; owner: string; allowedRoles: string[]; allowedUsers: string[]; created_at: string; updated_at: string; model: TemplateDocument } {
  const cells: Record<string, any> = {
    '1,1': { row: 1, col: 1, value: opts.name, style: { bold: true, fontSize: 15, bg: '#111827', color: '#F9FAFB' } },
    '1,2': { row: 1, col: 2, binding: { kind: 'builtin', builtin: 'report_datetime' }, style: { bold: true, bg: '#111827', color: '#9CA3AF', align: 'right' } },
    '2,1': { row: 2, col: 1, value: opts.description, style: { italic: true, color: '#6B7280' } },
  };

  opts.kpis.forEach((k, idx) => {
    const col = idx * 2 + 1;
    cells[`4,${col}`] = { row: 4, col, value: k.label, style: { bold: true, bg: '#1F2937', color: '#D1D5DB' } };
    cells[`5,${col}`] = {
      row: 5,
      col,
      binding: { kind: 'summary', queryId: opts.queryId, operation: k.op, field: k.field },
      style: { bold: true, bg: opts.accentHex, color: '#FFFFFF', align: 'right' },
    };
  });

  const fieldMap: Record<number, string> = {};
  opts.headers.forEach((h) => {
    cells[`7,${h.col}`] = {
      row: 7,
      col: h.col,
      value: h.title,
      style: { bold: true, bg: '#1E293B', color: '#F8FAFC', align: 'center' },
    };
    cells[`8,${h.col}`] = {
      row: 8,
      col: h.col,
      binding: { kind: 'query_field', queryId: opts.queryId, field: h.field },
      style: { align: h.col > 3 ? 'right' : 'left' },
    };
    fieldMap[h.col] = h.field;
  });

  const now = '2026-10-25T09:30:00Z';
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    owner: 'usr_utku',
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    created_at: '2026-10-14T08:00:00Z',
    updated_at: now,
    model: {
      id: opts.id,
      name: opts.name,
      description: opts.description,
      owner: 'usr_utku',
      version: 3,
      createdAt: '2026-10-14T08:00:00Z',
      updatedAt: now,
      sheets: [
        {
          id: `${opts.id}_s1`,
          name: opts.sheetName,
          rowCount: 32,
          columnCount: Math.max(opts.headers.length + 1, 9),
          cells,
          bands: [
            {
              id: `${opts.id}_band`,
              queryId: opts.queryId,
              range: { startRow: 8, startCol: 1, endRow: 8, endCol: opts.headers.length },
              fieldMap,
            },
          ],
          charts: opts.charts.map((c, idx) => ({
            id: c.id,
            type: c.type,
            title: c.title,
            queryId: opts.queryId,
            xAxis: c.xAxis,
            yAxis: c.yAxis,
            anchor: { row: 20, col: idx * 5 + 1, widthCols: 5, heightRows: 10 },
          })),
        },
      ],
    },
  };
}

export const DEMO_TEMPLATES = [
  makeExecTemplate({
    id: 'tpl_shift_oee',
    name: 'Günlük Vardiya Üretim & OEE Master Raporu',
    description: 'Vardiya A ve B üretim partileri, toplam sağlam üretim, ortalama OEE ve enerji tüketim dökümü.',
    sheetName: 'Vardiya_OEE_Ciktisi',
    accentHex: '#0F766E',
    queryId: 'q_batch_production',
    kpis: [
      { label: 'TOPLAM SAĞLAM ÜRETİM', op: 'SUM', field: 'good_qty' },
      { label: 'TOPLAM FİRE ADEDİ', op: 'SUM', field: 'scrap_qty' },
      { label: 'ORTALAMA OEE (%)', op: 'AVG', field: 'oee_pct' },
      { label: 'TOPLAM ENERJİ (kWh)', op: 'SUM', field: 'energy_kwh' },
    ],
    headers: [
      { col: 1, title: 'Parti Kodu', field: 'batch_code' },
      { col: 2, title: 'Vardiya', field: 'shift' },
      { col: 3, title: 'Üretim Hattı', field: 'line_name' },
      { col: 4, title: 'Ürün Ailesi', field: 'product_family' },
      { col: 5, title: 'Planlanan', field: 'planned_qty' },
      { col: 6, title: 'Sağlam Adet', field: 'good_qty' },
      { col: 7, title: 'Fire', field: 'scrap_qty' },
      { col: 8, title: 'OEE (%)', field: 'oee_pct' },
      { col: 9, title: 'Enerji (kWh)', field: 'energy_kwh' },
    ],
    charts: [
      { id: 'ch_oee', type: 'bar', title: 'Parti Bazlı OEE Performansı (%)', xAxis: 'batch_code', yAxis: ['oee_pct'] },
      { id: 'ch_good', type: 'line', title: 'Vardiya Sağlam Üretim Adetleri', xAxis: 'line_name', yAxis: ['good_qty'] },
    ],
  }),
  makeExecTemplate({
    id: 'tpl_energy_esg',
    name: 'Tesis Enerji Şebekesi & Karbon Yoğunluk Raporu',
    description: 'Ana fiderlerin aktif kWh tüketimi, pik kW yükü, cosφ güç faktörü ve Çatı GES mahsuplu net CO₂ tablosu.',
    sheetName: 'Enerji_ve_Karbon',
    accentHex: '#1D4ED8',
    queryId: 'q_energy_esg',
    kpis: [
      { label: 'NET AKTİF ENERJİ (kWh)', op: 'SUM', field: 'active_kwh' },
      { label: 'MAKSİMUM PİK YÜK (kW)', op: 'MAX', field: 'peak_kw' },
      { label: 'ORTALAMA GÜÇ FAKTÖRÜ', op: 'AVG', field: 'power_factor' },
      { label: 'NET KARBON (kg CO₂)', op: 'SUM', field: 'co2_kg' },
    ],
    headers: [
      { col: 1, title: 'Fider Kodu', field: 'feeder_code' },
      { col: 2, title: 'Tesis Bölgesi', field: 'zone_name' },
      { col: 3, title: 'Aktif Enerji (kWh)', field: 'active_kwh' },
      { col: 4, title: 'Pik Güç (kW)', field: 'peak_kw' },
      { col: 5, title: 'Güç Faktörü (cosφ)', field: 'power_factor' },
      { col: 6, title: 'Basınçlı Hava (m³)', field: 'compressed_air_m3' },
      { col: 7, title: 'Emisyon (kg CO₂)', field: 'co2_kg' },
    ],
    charts: [
      { id: 'ch_kwh', type: 'bar', title: 'Bölge Bazlı Enerji Tüketimi (kWh)', xAxis: 'zone_name', yAxis: ['active_kwh'] },
      { id: 'ch_co2', type: 'line', title: 'Net Karbon Salımı (kg CO₂)', xAxis: 'feeder_code', yAxis: ['co2_kg'] },
    ],
  }),
  makeExecTemplate({
    id: 'tpl_downtime_audit',
    name: 'Plansız Duruş & Kök Neden Pareto Denetim Raporu',
    description: 'Kritik ekipman arızaları, duruş süreleri (dk), kayıp üretim etkisi ve kök neden analizi.',
    sheetName: 'Durus_Pareto',
    accentHex: '#B45309',
    queryId: 'q_downtime_pareto',
    kpis: [
      { label: 'TOPLAM OLAY SAYISI', op: 'COUNT', field: 'event_code' },
      { label: 'TOPLAM DURUŞ (dk)', op: 'SUM', field: 'duration_min' },
      { label: 'TOPLAM KAYIP ÜRÜN', op: 'SUM', field: 'lost_units' },
      { label: 'EN UZUN DURUŞ (dk)', op: 'MAX', field: 'duration_min' },
    ],
    headers: [
      { col: 1, title: 'Olay Kodu', field: 'event_code' },
      { col: 2, title: 'Başlangıç', field: 'started_at' },
      { col: 3, title: 'Üretim Hattı', field: 'line_name' },
      { col: 4, title: 'İstasyon / Makine', field: 'machine_name' },
      { col: 5, title: 'Kök Neden', field: 'root_cause' },
      { col: 6, title: 'Süre (dk)', field: 'duration_min' },
      { col: 7, title: 'Kayıp Adet', field: 'lost_units' },
      { col: 8, title: 'Öncelik', field: 'severity' },
    ],
    charts: [
      { id: 'ch_dt', type: 'bar', title: 'Makine Bazlı Kayıp Duruş Süresi (dk)', xAxis: 'machine_name', yAxis: ['duration_min'] },
    ],
  }),
  makeExecTemplate({
    id: 'tpl_machine_health',
    name: 'Kestirimci Bakım & Termal Anomali Python Raporu',
    description: 'Python sandbox anomali algoritması ile hesaplanan CNC/Robot risk puanları ve bakım aksiyon planı.',
    sheetName: 'Python_Anomali_Raporu',
    accentHex: '#4338CA',
    queryId: 'py:py_thermal_anomaly:anomaly_scores',
    kpis: [
      { label: 'DENETLENEN İSTASYON', op: 'COUNT', field: 'machine_code' },
      { label: 'MAKSİMUM RİSK (%)', op: 'MAX', field: 'anomaly_risk_pct' },
      { label: 'ORT. SAĞLIK SKORU', op: 'AVG', field: 'health_score' },
    ],
    headers: [
      { col: 1, title: 'Ekipman Kodu', field: 'machine_code' },
      { col: 2, title: 'İstasyon Adı', field: 'machine_name' },
      { col: 3, title: 'Üretim Hattı', field: 'line_name' },
      { col: 4, title: 'Sağlık Skoru', field: 'health_score' },
      { col: 5, title: 'Anomali Riski (%)', field: 'anomaly_risk_pct' },
      { col: 6, title: 'Önerilen Bakım Aksiyonu', field: 'maintenance_action' },
    ],
    charts: [
      { id: 'ch_risk', type: 'bar', title: 'Ekipman Termal & Titreşim Risk Skoru (%)', xAxis: 'machine_code', yAxis: ['anomaly_risk_pct'] },
    ],
  }),
];

function resolveQueryRows(qid: string): { rows: Record<string, any>[]; name: string; kind: 'sql' | 'python' } {
  if (qid.startsWith('py:')) {
    const parts = qid.split(':');
    const res = executeDemoPython(parts[1] || '', '');
    const ds = res.datasets[parts[2] || res.datasetName] || { rows: [] };
    return { rows: ds.rows || [], name: `Python · ${parts[1]}`, kind: 'python' };
  }
  const rows = evaluateDemoSql('', qid);
  return { rows, name: qid, kind: 'sql' };
}

function computeSummary(rows: Record<string, any>[], op: string, field: string): number {
  if (!rows.length) return 0;
  if (op === 'COUNT') return rows.length;
  const nums = rows.map((r) => Number(r[field])).filter((n) => !Number.isNaN(n));
  if (!nums.length) return 0;
  if (op === 'SUM') return Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
  if (op === 'AVG') return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
  if (op === 'MAX') return Math.max(...nums);
  if (op === 'MIN') return Math.min(...nums);
  return nums[0];
}

export function evaluateDemoTemplate(model: TemplateDocument, maxBandRows = 60): any {
  const qIds = new Set<string>();
  for (const s of model.sheets || []) {
    Object.values(s.cells || {}).forEach((c: any) => { if (c?.binding?.queryId) qIds.add(c.binding.queryId); });
    (s.bands || []).forEach((b) => { if (b.queryId) qIds.add(b.queryId); });
    (s.charts || []).forEach((ch) => { if (ch.queryId) qIds.add(ch.queryId); });
  }

  const qMap: Record<string, Record<string, any>[]> = {};
  const queryStats: any[] = [];
  Array.from(qIds).forEach((qid, idx) => {
    const res = resolveQueryRows(qid);
    qMap[qid] = res.rows;
    queryStats.push({
      queryId: qid,
      name: res.name,
      kind: res.kind,
      rowCount: res.rows.length,
      executionMs: 3 + idx * 2,
    });
  });

  const nowIso = new Date().toISOString();
  const nowDisplay = new Date().toLocaleString('tr-TR');
  const sheets = (model.sheets || []).map((sheet) => {
    const colCount = Number(sheet.columnCount || 10);
    const rowCount = Number(sheet.rowCount || 30);
    const bandByStart = new Map<number, any>();
    (sheet.bands || []).forEach((b) => {
      if (b?.range?.startRow) bandByStart.set(Number(b.range.startRow), b);
    });

    const outCells: Record<string, any> = {};
    let nextFinal = 1;
    let r = 1;
    while (r <= rowCount) {
      const band = bandByStart.get(r);
      if (band) {
        const rows = (qMap[band.queryId] || []).slice(0, maxBandRows);
        const items = rows.length ? rows : [{}];
        items.forEach((item, idx) => {
          const targetRow = nextFinal + idx;
          for (let col = 1; col <= colCount; col++) {
            const origCell = (sheet.cells || {})[`${r},${col}`];
            const mappedField = band.fieldMap?.[col] || band.fieldMap?.[String(col)] || origCell?.binding?.field;
            if (mappedField || origCell) {
              const val = mappedField ? (item[mappedField] ?? '') : (origCell?.value ?? '');
              outCells[`${targetRow},${col}`] = {
                row: targetRow,
                col,
                value: val,
                style: origCell?.style,
                isBandRow: true,
                bandQueryId: band.queryId,
              };
            }
          }
        });
        nextFinal += items.length;
        r = Number(band.range.endRow || r) + 1;
      } else {
        for (let col = 1; col <= colCount; col++) {
          const cell = (sheet.cells || {})[`${r},${col}`];
          if (!cell) continue;
          let val: any = cell.value ?? '';
          if (cell.binding) {
            if (cell.binding.kind === 'builtin') {
              val = cell.binding.builtin === 'report_name' ? model.name : nowDisplay;
            } else if (cell.binding.kind === 'summary' && cell.binding.queryId) {
              val = computeSummary(qMap[cell.binding.queryId] || [], cell.binding.operation || 'SUM', cell.binding.field || '');
            } else if (cell.binding.kind === 'query_field' && cell.binding.queryId && cell.binding.field) {
              val = (qMap[cell.binding.queryId]?.[0] || {})[cell.binding.field] ?? '';
            }
          }
          outCells[`${nextFinal},${col}`] = {
            row: nextFinal,
            col,
            value: val,
            style: cell.style,
            bindingKind: cell.binding?.kind,
          };
        }
        nextFinal++;
        r++;
      }
    }

    const evalCharts = (sheet.charts || []).map((ch) => {
      const cRows = (qMap[ch.queryId] || []).slice(0, 12);
      const keys = cRows.length ? Object.keys(cRows[0]) : [];
      const xKey = ch.xAxis && keys.includes(ch.xAxis) ? ch.xAxis : (keys[0] || '');
      const yKeys = (ch.yAxis || []).filter((k) => keys.includes(k));
      const useY = yKeys.length ? yKeys : (keys.length > 1 ? [keys[keys.length - 1]] : []);
      return {
        ...ch,
        labels: cRows.map((row) => String(row[xKey] ?? '')),
        series: useY.map((yk) => ({
          name: yk,
          values: cRows.map((row) => Number(row[yk]) || 0),
        })),
        rowCount: (qMap[ch.queryId] || []).length,
      };
    });

    return {
      id: sheet.id,
      name: sheet.name,
      rowCount: Math.max(nextFinal - 1, 16),
      colCount,
      columnCount: colCount,
      cells: outCells,
      charts: evalCharts,
    };
  });

  return {
    id: model.id,
    name: model.name,
    description: model.description,
    evaluatedAt: nowIso,
    sheets,
    queryStats,
  };
}

// ---- Pure TypeScript Valid OpenXML (.xlsx) Uncompressed ZIP Builder ----
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colRef(col: number): string {
  let n = col;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

export function buildRealXlsxBlob(evaluated: any): Blob {
  const sheet = evaluated?.sheets?.[0] || { name: 'Rapor', cells: {}, rowCount: 10, colCount: 8 };
  let rowsXml = '';
  for (let r = 1; r <= Math.min(sheet.rowCount || 40, 120); r++) {
    let cellsXml = '';
    for (let c = 1; c <= Math.min(sheet.colCount || 10, 16); c++) {
      const cell = sheet.cells?.[`${r},${c}`];
      if (!cell || cell.value === '' || cell.value === undefined || cell.value === null) continue;
      const addr = `${colRef(c)}${r}`;
      if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
        cellsXml += `<c r="${addr}"><v>${cell.value}</v></c>`;
      } else {
        cellsXml += `<c r="${addr}" t="inlineStr"><is><t>${xmlEscape(String(cell.value))}</t></is></c>`;
      }
    }
    if (cellsXml) rowsXml += `<row r="${r}">${cellsXml}</row>`;
  }

  const files: Array<{ name: string; content: string }> = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape((sheet.name || 'Rapor').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
    },
  ];

  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.content);
    const crc = crc32(dataBytes);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);

    localParts.push(lh, dataBytes);
    centralParts.push(ch);
    offset += lh.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, eocd] as BlobPart[], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function buildRealPdfBlob(title: string, lines: string[]): Blob {
  const safeAscii = (s: string) =>
    s
      .replace(/ğ/g, 'g').replace(/Ğ/g, 'G').replace(/ü/g, 'u').replace(/Ü/g, 'U')
      .replace(/ş/g, 's').replace(/Ş/g, 'S').replace(/ı/g, 'i').replace(/İ/g, 'I')
      .replace(/ö/g, 'o').replace(/Ö/g, 'O').replace(/ç/g, 'c').replace(/Ç/g, 'C')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/[()\\]/g, '');

  const streamLines = [
    'BT',
    '/F1 14 Tf',
    '42 790 Td',
    `(${safeAscii(title)}) Tj`,
    '/F1 9 Tf',
    '0 -22 Td',
    ...lines.slice(0, 38).flatMap((ln) => [`(${safeAscii(ln).slice(0, 96)}) Tj`, '0 -16 Td']),
    'ET',
  ].join('\n');

  const objs = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${streamLines.length} >> stream\n${streamLines}\nendstream endobj`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o + '\n';
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

// ============================================================================
// 3. MULTI-DASHBOARDS, ALARMS & SCHEDULES
// ============================================================================

export const DEMO_DASHBOARDS: any[] = [
  {
    id: 'db_main',
    name: 'Üretim & OEE Ana Komuta Panosu',
    description: '4 tesisin canlı OEE performansı, vardiya üretim partileri, ağırlıklı Python analizi ve duruş özeti.',
    owner: 'usr_utku',
    ownerName: 'Baş Mimar',
    isDefault: true,
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    layout: [
      {
        id: 'w_oee_bars', type: 'bar-chart', title: 'Üretim Hatları Canlı OEE (%)', icon: 'fas fa-chart-column',
        w: 2, h: 1, category: 'Production', dataSourceType: 'sql', assignedQueryId: 'q_oee_lines',
        sqlLabelColumn: 'line_name', sqlValueColumn: 'oee_pct',
        config: { visualType: 'Bar Chart', sqlLabelColumn: 'line_name', sqlValueColumn: 'oee_pct' },
      },
      {
        id: 'w_batch_good', type: 'area-chart', title: 'Vardiya Sağlam Üretim Adetleri', icon: 'fas fa-cubes',
        w: 2, h: 1, category: 'Production', dataSourceType: 'sql', assignedQueryId: 'q_batch_production',
        sqlLabelColumn: 'batch_code', sqlValueColumn: 'good_qty',
        config: { visualType: 'Area Chart', sqlLabelColumn: 'batch_code', sqlValueColumn: 'good_qty' },
      },
      {
        id: 'w_py_matrix', type: 'bar-chart', title: 'Python · Birim Ürün Enerji Yoğunluğu (kWh/Adet)', icon: 'fas fa-code',
        w: 2, h: 1, category: 'Analytics', dataSourceType: 'python', assignedPythonId: 'py_oee_summary',
        sqlLabelColumn: 'line_name', sqlValueColumn: 'kwh_per_unit',
        config: { visualType: 'Bar Chart', sqlLabelColumn: 'line_name', sqlValueColumn: 'kwh_per_unit' },
      },
      {
        id: 'w_downtime_tbl', type: 'data-table', title: 'Plansız Duruş & Kök Neden Kayıtları', icon: 'fas fa-triangle-exclamation',
        w: 2, h: 1, category: 'Quality', dataSourceType: 'sql', assignedQueryId: 'q_downtime_pareto',
        sqlLabelColumn: 'machine_name', sqlValueColumn: 'duration_min',
        config: { visualType: 'Data Grid', sqlLabelColumn: 'machine_name', sqlValueColumn: 'duration_min' },
      },
    ],
  },
  {
    id: 'db_energy',
    name: 'Enerji Şebekesi & Karbon İzleme Panosu',
    description: 'Ana trafo fiderleri, pik yük (kW), basınçlı hava ve Çatı GES mahsuplu karbon ayak izi.',
    owner: 'usr_engineer',
    ownerName: 'Otomasyon Mühendisi',
    isDefault: false,
    allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
    allowedUsers: [],
    layout: [
      {
        id: 'w_en_kwh', type: 'bar-chart', title: 'Fider Bazlı Aktif Enerji (kWh)', icon: 'fas fa-bolt',
        w: 2, h: 1, category: 'Energy', dataSourceType: 'sql', assignedQueryId: 'q_energy_esg',
        sqlLabelColumn: 'zone_name', sqlValueColumn: 'active_kwh',
        config: { visualType: 'Bar Chart', sqlLabelColumn: 'zone_name', sqlValueColumn: 'active_kwh' },
      },
      {
        id: 'w_en_co2', type: 'line-chart', title: 'Bölgesel Karbon Emisyonu (kg CO₂)', icon: 'fas fa-leaf',
        w: 2, h: 1, category: 'Energy', dataSourceType: 'sql', assignedQueryId: 'q_energy_esg',
        sqlLabelColumn: 'feeder_code', sqlValueColumn: 'co2_kg',
        config: { visualType: 'Line Chart', sqlLabelColumn: 'feeder_code', sqlValueColumn: 'co2_kg' },
      },
      {
        id: 'w_en_grid', type: 'data-table', title: 'Trafo & Kompresör Telemetri Tablosu', icon: 'fas fa-table',
        w: 4, h: 1, category: 'Energy', dataSourceType: 'sql', assignedQueryId: 'q_energy_esg',
        config: { visualType: 'Data Grid' },
      },
    ],
  },
];

export const DEMO_ALARMS: any[] = [
  { id: 'alm_1', severity: 'critical', status: 'active', source: 'Mazak 5-Eksen İşleme #1 (Bursa B1)', message: 'Spindle rulman sıcaklığı 94.6°C eşiğini aştı (Limit: 85°C) · Titreşim 6.8 mm/s', createdAt: new Date(Date.now() - 18 * 60000).toISOString() },
  { id: 'alm_2', severity: 'high', status: 'active', source: 'Azotlu 12-Bölge Reflow Fırın (Kocaeli C1)', message: 'Bölge-7 termokupl kalibrasyon sapması (+5.5°C)', createdAt: new Date(Date.now() - 47 * 60000).toISOString() },
  { id: 'alm_3', severity: 'medium', status: 'acknowledged', source: 'OG Bara B · Ağır İmalat Fideri', message: 'Reaktif güç faktörü cosφ 0.92 seviyesine geriledi', createdAt: new Date(Date.now() - 115 * 60000).toISOString() },
  { id: 'alm_4', severity: 'low', status: 'resolved', source: 'Trumpf Fiber Lazer Kesim (İzmir A1)', message: 'Koruyucu optik lens temizlik periyodu tamamlandı', createdAt: new Date(Date.now() - 240 * 60000).toISOString() },
];

export const DEMO_SCHEDULES: any[] = [
  { id: 'sch_1', templateId: 'tpl_shift_oee', templateName: 'Günlük Vardiya Üretim & OEE Master Raporu', cron: '0 7,15,23 * * *', label: 'Her vardiya sonu (07:00, 15:00, 23:00)', format: 'xlsx', enabled: true, lastRunAt: '2026-10-25T07:00:02Z' },
  { id: 'sch_2', templateId: 'tpl_energy_esg', templateName: 'Tesis Enerji Şebekesi & Karbon Yoğunluk Raporu', cron: '0 8 * * 1', label: 'Her Pazartesi 08:00', format: 'pdf', enabled: true, lastRunAt: '2026-10-19T08:00:04Z' },
];
