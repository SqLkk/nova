import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpResponse } from '@angular/common/http';
import { Observable, of, from } from 'rxjs';
import { delay } from 'rxjs/operators';

// In-memory mock database representing our factory
const locations = [
  { id: 1, name: 'Plant Alpha - Assembly' },
  { id: 2, name: 'Plant Beta - Packaging' },
  { id: 3, name: 'Plant Gamma - Paint Shop' }
];

const production_lines = [
  { id: 1, name: 'Chassis Assembly Line', location_id: 1 },
  { id: 2, name: 'Engine Assembly Line', location_id: 1 },
  { id: 3, name: 'Electronics Assembly', location_id: 1 },
  { id: 4, name: 'Primary Packaging', location_id: 2 },
  { id: 5, name: 'Secondary Packaging', location_id: 2 },
  { id: 6, name: 'Base Coat Line', location_id: 3 },
  { id: 7, name: 'Clear Coat Line', location_id: 3 }
];

const machines = [
  { id: 1, name: 'KUKA Robot Arm C1', type: 'Robot', line_id: 1, status: 'online' },
  { id: 2, name: 'KUKA Robot Arm C2', type: 'Robot', line_id: 1, status: 'online' },
  { id: 3, name: 'Conveyor Belt C-Main', type: 'Conveyor', line_id: 1, status: 'warning' },
  { id: 4, name: 'Siemens S7 PLC C1', type: 'Controller', line_id: 1, status: 'online' },
  { id: 5, name: 'CNC Lathe E1', type: 'CNC', line_id: 2, status: 'alarm' },
  { id: 6, name: 'CNC Lathe E2', type: 'CNC', line_id: 2, status: 'offline' },
  { id: 7, name: 'Torque Station E1', type: 'Tool', line_id: 2, status: 'online' },
  { id: 8, name: 'Engine Testing Rig', type: 'Test', line_id: 2, status: 'online' },
  { id: 9, name: 'Siemens S7 PLC E1', type: 'Controller', line_id: 2, status: 'online' },
  { id: 10, name: 'Pick and Place M1', type: 'Robot', line_id: 3, status: 'online' },
  { id: 11, name: 'Reflow Oven', type: 'Heater', line_id: 3, status: 'warning' },
  { id: 12, name: 'Optical Inspection', type: 'Sensor', line_id: 3, status: 'online' },
  { id: 13, name: 'Box Erector P1', type: 'Packaging', line_id: 4, status: 'online' },
  { id: 14, name: 'Sealing Machine P1', type: 'Packaging', line_id: 4, status: 'online' },
  { id: 15, name: 'Palletizer Robot R1', type: 'Robot', line_id: 5, status: 'online' },
  { id: 16, name: 'Stretch Wrapper', type: 'Packaging', line_id: 5, status: 'offline' },
  { id: 17, name: 'Paint Robot Spray 1', type: 'Robot', line_id: 6, status: 'alarm' },
  { id: 18, name: 'Paint Robot Spray 2', type: 'Robot', line_id: 6, status: 'online' },
  { id: 19, name: 'Drying Oven 1', type: 'Heater', line_id: 6, status: 'warning' },
  { id: 20, name: 'Clear Coat Sprayer', type: 'Robot', line_id: 7, status: 'online' },
  { id: 21, name: 'Drying Oven 2', type: 'Heater', line_id: 7, status: 'online' }
];

// Simple client-side mock SQL executor
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

  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    // Only intercept /api/ requests
    if (!request.url.startsWith('/api/')) {
      return next.handle(request);
    }

    const url = request.url;
    const cleanUrl = url.split('?')[0];

    // Login mock
    if (cleanUrl.includes('/api/auth/login')) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        token: 'gh-pages-demo-token',
        user: { id: 1, username: 'admin', role: 'admin' }
      }})).pipe(delay(500));
    }

    // Profile mock
    if (cleanUrl.includes('/api/profile')) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: { id: 1, username: 'admin', role: 'admin' }
      }}));
    }

    // Datasources mock
    if (cleanUrl.endsWith('/api/datasources')) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: [{ id: 'ds_factory', name: 'Factory Mock DB', type: 'sqlite', host: 'local', is_active: 1, isActive: true }]
      }}));
    }

    // Queries mock list
    if (cleanUrl.endsWith('/api/queries')) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: [
          {
            id: 'q_factory',
            name: 'Factory Network Map Hierarchy',
            dataSourceId: 'ds_factory',
            data_source_id: 'ds_factory',
            sql: "SELECT \n  'loc_' || l.id as id,\n  l.name as label,\n  0 as depth,\n  NULL as parent\nFROM locations l\nUNION ALL\nSELECT \n  'line_' || pl.id as id,\n  pl.name as label,\n  1 as depth,\n  'loc_' || pl.location_id as parent\nFROM production_lines pl\nUNION ALL\nSELECT \n  'mach_' || m.id as id,\n  m.name as label,\n  2 as depth,\n  'line_' || m.line_id as parent\nFROM machines m",
            query: "SELECT \n  'loc_' || l.id as id,\n  l.name as label,\n  0 as depth,\n  NULL as parent\nFROM locations l\nUNION ALL\nSELECT \n  'line_' || pl.id as id,\n  pl.name as label,\n  1 as depth,\n  'loc_' || pl.location_id as parent\nFROM production_lines pl\nUNION ALL\nSELECT \n  'mach_' || m.id as id,\n  m.name as label,\n  2 as depth,\n  'line_' || m.line_id as parent\nFROM machines m"
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
      }}));
    }

    // Table Explorer - Get Table list for DB
    if (cleanUrl.match(/\/api\/datasources\/.+\/tables$/)) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: ['locations', 'production_lines', 'machines']
      }}));
    }

    // Table Explorer - Get Table Schema for Table
    if (cleanUrl.match(/\/api\/datasources\/.+\/tables\/.+\/schema$/)) {
      const match = cleanUrl.match(/\/api\/datasources\/.+\/tables\/(.+)\/schema$/);
      const tableName = match ? match[1] : '';
      
      let columns: any[] = [];
      let rowCount = 0;
      if (tableName === 'locations') {
        columns = [
          { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false }
        ];
        rowCount = locations.length;
      } else if (tableName === 'production_lines') {
        columns = [
          { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'location_id', dataType: 'INTEGER', isPrimaryKey: false, nullable: true }
        ];
        rowCount = production_lines.length;
      } else if (tableName === 'machines') {
        columns = [
          { name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'type', dataType: 'TEXT', isPrimaryKey: false, nullable: false },
          { name: 'line_id', dataType: 'INTEGER', isPrimaryKey: false, nullable: true },
          { name: 'status', dataType: 'TEXT', isPrimaryKey: false, nullable: true }
        ];
        rowCount = machines.length;
      }

      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: { columns, rowCount }
      }}));
    }

    // Table Explorer - Get Table Data
    if (cleanUrl.match(/\/api\/datasources\/.+\/tables\/.+$/)) {
      const match = cleanUrl.match(/\/api\/datasources\/.+\/tables\/(.+)$/);
      const tableName = match ? match[1] : '';
      
      let rows: any[] = [];
      if (tableName === 'locations') rows = locations;
      else if (tableName === 'production_lines') rows = production_lines;
      else if (tableName === 'machines') rows = machines;

      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: { rows, rowCount: rows.length }
      }}));
    }

    // Ad-hoc preview sql execution from Query Creator / Template Builder
    if (cleanUrl.includes('/api/queries/preview')) {
      const body = request.body as any;
      const sql = body?.sql || '';
      const rows = evaluateSql(sql);
      const rawColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
      const columns = rawColumns.map(col => ({ name: col, dataType: 'text', label: col }));

      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: {
          columns: columns,
          rows: rows,
          rowCount: rows.length
        }
      }})).pipe(delay(300));
    }

    // Dashboard loading - GET /api/dashboards/me
    if (cleanUrl.includes('/api/dashboards/me')) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: {
          id: 'db_demo',
          name: 'Factory Overview Dashboard',
          layout: [
            { id: 'w_oee', type: 'oee', title: 'Overall Equipment Effectiveness', icon: 'fas fa-tachometer-alt', w: 2, h: 2, category: 'Production', description: 'Overall Equipment Effectiveness (OEE)', config: { visualType: 'Gauge Chart' } },
            { id: 'w_line', type: 'line-status', title: 'Line Status Overview', icon: 'fas fa-industry', w: 2, h: 1, category: 'Production', description: 'Production lines current capacity usage', config: { visualType: 'Donut Chart' } },
            { id: 'w_trend', type: 'line', title: 'Production OEE Trend Analysis', icon: 'fas fa-chart-line', w: 2, h: 2, category: 'Analytics', description: 'Real-time time series trend', config: { visualType: 'Line Chart' } },
            { id: 'w_energy', type: 'energy', title: 'Energy Consumption Map', icon: 'fas fa-bolt', w: 2, h: 2, category: 'Energy', description: 'Total consumption levels in kW', config: { visualType: 'Bar Chart' } },
            { id: 'w_carbon', type: 'carbon', title: 'Carbon Footprint', icon: 'fas fa-leaf', w: 1, h: 1, category: 'Energy', description: 'CO2 emission indicator', config: { visualType: 'KPI Card' } },
            { id: 'w_sensor', type: 'sensor', title: 'Robot Arm Temperature Feed', icon: 'fas fa-wave-square', w: 2, h: 1, category: 'Realtime', description: 'Robot temperature sensor real-time simulation', config: { visualType: 'Area Chart' } }
          ]
        }
      }}));
    }

    // Paths build mock
    if (cleanUrl.match(/\/api\/paths\/.*\/build/)) {
      // Fetch the generated JSON file asynchronously
      return from(
        fetch('assets/mock-factory.json')
          .then(res => res.json())
          .then(nodes => {
            return new HttpResponse({ status: 200, body: { success: true, data: { nodes } } });
          })
      ).pipe(delay(300));
    }


    // Single Path GET mock
    if (cleanUrl.match(/\/api\/paths\/[^/]+$/)) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: {
          id: 'p_factory',
          name: 'Factory Network Map',
          queryId: 'q_factory',
          config: {
            spaceMapConfig: {
               theme: "factory",
               layout: "grid",
               level1Icon: "fa-industry",
               level2Icon: "fa-cogs",
               level3Icon: "fa-robot",
               color1: "#3b82f6",
               color2: "#10b981",
               color3: "#f59e0b"
            }
          }
        }
      }}));
    }

    // Paths list mock
    if (cleanUrl.endsWith('/api/paths')) {
      return of(new HttpResponse({ status: 200, body: {
        success: true,
        data: [{
          id: 'p_factory',
          name: 'Factory Network Map',
          queryId: 'q_factory',
          config: {
            spaceMapConfig: {
               theme: "factory",
               layout: "grid",
               level1Icon: "fa-industry",
               level2Icon: "fa-cogs",
               level3Icon: "fa-robot",
               color1: "#3b82f6",
               color2: "#10b981",
               color3: "#f59e0b"
            }
          }
        }]
      }}));
    }

    // POST /api/python/run
    if (cleanUrl.includes('/api/python/run')) {
      const body = request.body as any;
      const code = body?.code || '';
      
      const logRows = [
        { log: "Initializing demo Python execution sandbox..." },
        { log: "Linking SQL data references..." }
      ];
      let dataRows: any[] = [];
      let columns: string[] = [];
      let outputName = "Analysis Output";

      if (code.includes('OEE') || code.includes('oee') || code.includes('efficiency')) {
        logRows.push(
          { log: "Running OEE threshold analysis..." },
          { log: "Lines checked: Chassis Line, Engine Line, Electronics Line" },
          { log: "Line 2 (Engine Line) OEE is below 80% threshold!" }
        );
        dataRows = [
          { LineName: "Chassis Assembly Line", EstimatedOEE: "82.5%", Status: "Optimal" },
          { LineName: "Engine Assembly Line", EstimatedOEE: "74.0%", Status: "Underperforming" },
          { LineName: "Electronics Assembly", EstimatedOEE: "83.3%", Status: "Optimal" }
        ];
        columns = ["LineName", "EstimatedOEE", "Status"];
        outputName = "OEE Line Summary";
      } else if (code.includes('temperature') || code.includes('temp') || code.includes('CNC') || code.includes('cnc')) {
        logRows.push(
          { log: "Scanning spindle temperature tags..." },
          { log: "Critical anomaly detected in: CNC Lathe E1!" },
          { log: "Sending automated diagnostic logs..." }
        );
        dataRows = [
          { MachineName: "CNC Lathe E1", LastTemperature: "95°C", State: "CRITICAL" },
          { MachineName: "CNC Lathe E2", LastTemperature: "64°C", State: "Offline" },
          { MachineName: "Reflow Oven", LastTemperature: "245°C", State: "Normal" }
        ];
        columns = ["MachineName", "LastTemperature", "State"];
        outputName = "Thermal Anomaly Log";
      } else {
        logRows.push(
          { log: "Executing user script..." },
          { log: "Process exited with code 0." }
        );
        dataRows = machines.slice(0, 5);
        columns = ["id", "name", "type", "status"];
      }

      return of(new HttpResponse({ status: 200, body: {
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
      }})).pipe(delay(600));
    }

    // GET /api/python/scripts
    if (cleanUrl.endsWith('/api/python/scripts')) {
      return of(new HttpResponse({ status: 200, body: {
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
      }}));
    }

    // Alarms mock
    if (cleanUrl.includes('/api/alarms')) {
      return of(new HttpResponse({ status: 200, body: { success: true, data: [] } }));
    }

    // Widgets mock
    if (cleanUrl.includes('/api/widgets')) {
      return of(new HttpResponse({ status: 200, body: { success: true, data: [] } }));
    }

    // Default fallback mock for any other /api/ call
    return of(new HttpResponse({ status: 200, body: { success: true, data: [] } }));
  }
}
