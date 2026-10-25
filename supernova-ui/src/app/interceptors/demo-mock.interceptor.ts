import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { PERMISSION_CATALOG } from '../services/permission-catalog';
import {
  MOCK_USERS,
  MockUser,
  DEMO_TABLES,
  DEMO_QUERIES,
  DEMO_PYTHON_SCRIPTS,
  evaluateDemoSql,
  buildColumnsMeta,
  executeDemoPython,
} from './demo-mock-data';
import {
  DEMO_PATHS,
  buildDemoStructure,
  DEMO_TEMPLATES,
  evaluateDemoTemplate,
  buildRealXlsxBlob,
  buildRealPdfBlob,
  DEMO_DASHBOARDS,
  DEMO_ALARMS,
  DEMO_SCHEDULES,
} from './demo-mock-engine';

@Injectable()
export class DemoMockInterceptor implements HttpInterceptor {
  private getCurrentUser(): MockUser {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('current_user') || localStorage.getItem('currentUser');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed?.username) {
            const found = MOCK_USERS.find((u) => u.username === parsed.username || u.id === parsed.id);
            if (found) return found;
          }
        } catch {
          // ignore invalid cache
        }
      }
    }
    return MOCK_USERS[0];
  }

  private isDemoActive(): boolean {
    if ((environment as any).demoMode === true) return true;
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname || '';
    const path = window.location.pathname || '';
    return (
      path.startsWith('/demo') ||
      host.includes('github.io') ||
      host.includes('vercel.app') ||
      host.includes('netlify.app') ||
      host.includes('pages.dev') ||
      window.location.protocol === 'file:'
    );
  }

  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const url = request.url;

    // Never intercept static assets, i18n files, or non-API calls
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

    if (!this.isDemoActive()) {
      return next.handle(request);
    }

    let path = url;
    if (path.includes('/api/')) {
      path = '/api/' + path.split('/api/')[1];
    }
    const cleanUrl = path.split('?')[0].replace(/\/+$/, '');
    const queryString = path.includes('?') ? path.split('?')[1] : '';
    const searchParams = new URLSearchParams(queryString);
    const method = request.method.toUpperCase();
    const body = (request.body || {}) as any;

    const ok = (data: any, extra: Record<string, any> = {}, ms = 40) =>
      of(new HttpResponse({ status: 200, body: { success: true, data, ...extra } })).pipe(delay(ms));

    // ========================================================================
    // 0. LOCKED AI COPILOT ENDPOINTS (/api/ai/*) — VISIBLE SHOWCASE, NOT USABLE
    // ========================================================================
    if (cleanUrl === '/api/ai/status') {
      return of(
        new HttpResponse({
          status: 200,
          body: {
            available: false,
            demo_locked: true,
            reason: 'demo_locked',
            optional: true,
            model: 'Qwen3.5-9B · SuperNova v2.4 LoRA (On-Premise Air-Gapped)',
            memory_enabled: true,
            session_count: 2,
            memory_count: 3,
          },
        })
      );
    }

    if (cleanUrl === '/api/ai/history' && method === 'GET') {
      return ok({
        sessions: [
          { id: 'demo_chat_1', title: 'Vardiya OEE & Fire Master Raporu Kurulumu', lastPage: 'template-builder', messageCount: 4, createdAt: '2026-10-24T14:20:00Z', updatedAt: '2026-10-24T14:25:00Z' },
          { id: 'demo_chat_2', title: 'Bursa CNC Termal Anomali SQL Analizi', lastPage: 'query-creator', messageCount: 2, createdAt: '2026-10-23T09:10:00Z', updatedAt: '2026-10-23T09:12:00Z' },
        ],
        memories: [
          { id: 1, key: 'pref_oee', category: 'preference', label: 'Varsayılan hedef OEE eşiği: %85.0', hitCount: 6, updatedAt: '2026-10-25T08:00:00Z' },
          { id: 2, key: 'tbl_batches', category: 'table', label: 'Ana üretim tablosu: production_batches', hitCount: 9, updatedAt: '2026-10-25T08:00:00Z' },
          { id: 3, key: 'tpl_exec', category: 'report', label: 'Kurumsal rapor formatı: Koyu başlık + SUM/AVG özet kartları', hitCount: 4, updatedAt: '2026-10-25T08:00:00Z' },
        ],
      });
    }

    if (cleanUrl.startsWith('/api/ai/')) {
      return of(
        new HttpResponse({
          status: 403,
          body: {
            success: false,
            error: 'Yerel AI Copilot genel web demosunda kullanıma kapalıdır. Yalnızca tesis içi (air-gapped) kurulumlarda aktiftir.',
          },
        })
      );
    }

    // ========================================================================
    // 1. AUTH, USERS & PERMISSIONS
    // ========================================================================
    if (cleanUrl === '/api/auth/login' && method === 'POST') {
      const uname = String(body?.username || '').toLowerCase().trim();
      const targetUser =
        MOCK_USERS.find((u) => u.username === uname) ||
        (uname.includes('admin') ? MOCK_USERS[1] : uname.includes('eng') ? MOCK_USERS[2] : uname.includes('oper') ? MOCK_USERS[3] : uname.includes('view') ? MOCK_USERS[4] : MOCK_USERS[0]);
      return of(
        new HttpResponse({
          status: 200,
          body: {
            success: true,
            token: `nov4_demo_token_${targetUser.id}`,
            user: targetUser,
          },
        })
      ).pipe(delay(120));
    }

    if (cleanUrl === '/api/auth/logout' || cleanUrl === '/api/auth/refresh') {
      return ok({ refreshed: true });
    }

    if (cleanUrl === '/api/profile' || cleanUrl === '/api/auth/me') {
      return ok(this.getCurrentUser());
    }

    const userProfMatch = cleanUrl.match(/^\/api\/users\/([^/]+)\/profile$/);
    if (userProfMatch) {
      const u = MOCK_USERS.find((x) => x.id === userProfMatch[1] || x.username === userProfMatch[1]) || this.getCurrentUser();
      return of(new HttpResponse({ status: 200, body: { success: true, user: u, data: u } }));
    }

    const userPermMatch = cleanUrl.match(/^\/api\/users\/([^/]+)\/permissions$/);
    if (userPermMatch) {
      const u = MOCK_USERS.find((x) => x.id === userPermMatch[1] || x.username === userPermMatch[1]) || this.getCurrentUser();
      return of(new HttpResponse({ status: 200, body: { success: true, permissions: u.permissions, allowedPages: u.allowedPages, data: u.permissions } }));
    }

    if (cleanUrl === '/api/permissions') {
      return ok(PERMISSION_CATALOG);
    }

    if (cleanUrl === '/api/roles' && method === 'GET') {
      return ok([
        { id: 'role_superuser', key: 'superuser', name: 'Süper Kullanıcı', description: 'Sistem geneli tam mimari yetki', level: 100, isSystem: true, isActive: true, color: '#F59E0B', memberCount: 1, permissions: ['*'], canManage: true },
        { id: 'role_admin', key: 'admin', name: 'Sistem Yöneticisi', description: 'Kullanıcı, rol ve veri kaynağı yönetimi', level: 80, isSystem: true, isActive: true, color: '#3B82F6', memberCount: 1, permissions: ['*'], canManage: true },
        { id: 'role_engineer', key: 'engineer', name: 'Otomasyon & Veri Mühendisi', description: 'Space Map, SQL, Python ve Şablon geliştirme', level: 60, isSystem: false, isActive: true, color: '#10B981', memberCount: 1, permissions: MOCK_USERS[2].permissions, canManage: true },
        { id: 'role_operator', key: 'operator', name: 'Vardiya Hat Operatörü', description: 'Canlı pano, harita izleme ve rapor indirme', level: 40, isSystem: false, isActive: true, color: '#06B6D4', memberCount: 1, permissions: MOCK_USERS[3].permissions, canManage: false },
        { id: 'role_viewer', key: 'viewer', name: 'Yönetim İzleyici', description: 'Salt okunur rapor ve pano görüntüleme', level: 20, isSystem: false, isActive: true, color: '#94A3B8', memberCount: 1, permissions: MOCK_USERS[4].permissions, canManage: false },
      ]);
    }

    if (cleanUrl === '/api/users' || (cleanUrl === '/api/admin/users' && method === 'GET')) {
      return ok(
        MOCK_USERS.map((u) => ({
          ...u,
          roleId: `role_${u.role}`,
          roleKey: u.role,
          roleName: u.displayName,
          roleColor: u.level >= 80 ? '#F59E0B' : u.level >= 60 ? '#10B981' : '#38BDF8',
          isActive: true,
          canManage: u.level < 100,
          createdAt: '2026-02-10T09:00:00Z',
          updatedAt: '2026-10-25T08:30:00Z',
        }))
      );
    }

    if (cleanUrl.startsWith('/api/admin/users/')) {
      const uid = cleanUrl.split('/')[4];
      const u = MOCK_USERS.find((x) => x.id === uid || x.username === uid) || MOCK_USERS[0];
      return ok({ ...u, roleId: `role_${u.role}`, roleKey: u.role, isActive: true, canManage: true, overrides: [], ownedCounts: { templates: 4, paths: 4, queries: 6, scripts: 2, dashboards: 2 } });
    }

    if (cleanUrl.startsWith('/api/admin/sharing/')) {
      return ok(DEMO_TEMPLATES.map((t) => ({ id: t.id, name: t.name, owner: t.owner, ownerName: 'Baş Mimar', allowedRoles: t.allowedRoles, allowedUsers: t.allowedUsers })));
    }

    // ========================================================================
    // 2. DATASOURCES & TABLES
    // ========================================================================
    if (cleanUrl === '/api/datasources' && method === 'GET') {
      return ok([
        { id: 'ds_factory', name: 'Apex Üretim & Robotik Veritabanı (PostgreSQL)', db_type: 'postgres', dbType: 'postgres', host: 'pg-prod-01.plant.local', is_active: 1, isActive: true },
        { id: 'ds_energy', name: 'Tesis Enerji & Trafo Telemetri (TimescaleDB)', db_type: 'postgres', dbType: 'postgres', host: 'ts-energy-02.plant.local', is_active: 1, isActive: true },
      ]);
    }

    if (cleanUrl === '/api/datasources/test') {
      return ok({ ok: true }, { message: 'Veritabanı bağlantısı doğrulandı (1.4 ms)' }, 150);
    }

    if (cleanUrl.match(/^\/api\/datasources\/[^/]+\/tables$/)) {
      return ok(Object.keys(DEMO_TABLES));
    }

    const schemaMatch = cleanUrl.match(/^\/api\/datasources\/[^/]+\/tables\/([^/]+)\/schema$/);
    if (schemaMatch) {
      const tbl = DEMO_TABLES[schemaMatch[1]] || DEMO_TABLES['machines'];
      return ok({ columns: tbl.columns, rowCount: tbl.rows.length });
    }

    const tableRowsMatch = cleanUrl.match(/^\/api\/datasources\/[^/]+\/tables\/([^/]+)$/);
    if (tableRowsMatch) {
      const tbl = DEMO_TABLES[tableRowsMatch[1]] || DEMO_TABLES['machines'];
      return ok({ columns: tbl.columns, rows: tbl.rows, rowCount: tbl.rows.length });
    }

    if (cleanUrl.match(/^\/api\/datasources\/[^/]+\/functions$/)) {
      return ok([
        { name: 'fn_calc_shift_oee', schema: 'analytics', kind: 'FUNCTION', signature: 'fn_calc_shift_oee(p_line_id INT, p_shift TEXT)' },
        { name: 'sp_refresh_energy_rollup', schema: 'telemetry', kind: 'PROCEDURE', signature: 'sp_refresh_energy_rollup(p_day DATE)' },
      ]);
    }

    if (cleanUrl.match(/^\/api\/datasources\/[^/]+\/search-columns$/)) {
      const term = (searchParams.get('q') || '').toLowerCase();
      const hits: any[] = [];
      Object.entries(DEMO_TABLES).forEach(([tName, tbl]) => {
        tbl.columns.forEach((c) => {
          if (!term || c.name.toLowerCase().includes(term) || tName.includes(term)) {
            hits.push({ table: tName, column: c.name, dataType: c.dataType });
          }
        });
      });
      return ok(hits);
    }

    // ========================================================================
    // 3. SPACE MAP & PATH DEFINER (/api/paths/*)
    // ========================================================================
    if (cleanUrl === '/api/paths' && method === 'GET') {
      return ok(DEMO_PATHS);
    }

    if (cleanUrl === '/api/paths' && method === 'POST') {
      const created: any = {
        id: `p_${Date.now()}`,
        name: body?.name || 'Yeni Üretim Haritası',
        description: body?.description || '',
        queryId: body?.queryId || 'q_factory_tree',
        structure: body?.structure || 'tree',
        config: body?.config || DEMO_PATHS[0].config,
        owner: this.getCurrentUser().id,
        allowedRoles: ['admin', 'engineer', 'operator', 'viewer'],
        allowedUsers: [],
      };
      DEMO_PATHS.unshift(created);
      return ok(created);
    }

    if (cleanUrl === '/api/paths/preview' && method === 'POST') {
      const qid = body?.queryId || 'q_factory_tree';
      const struct = body?.structure || 'tree';
      const mappedId = struct === 'sequence' ? 'p_assembly_flow' : struct === 'dag' ? 'p_energy_dag' : struct === 'multi_level' ? 'p_oee_matrix' : 'p_factory';
      const rows = evaluateDemoSql('', qid);
      return ok({
        columns: rows.length ? Object.keys(rows[0]) : ['node_id', 'parent_id', 'label', 'health_score'],
        structure: buildDemoStructure(mappedId),
      });
    }

    const pathBuildMatch = cleanUrl.match(/^\/api\/paths\/([^/]+)\/build$/);
    if (pathBuildMatch) {
      return ok(buildDemoStructure(pathBuildMatch[1]), {}, 80);
    }

    const pathSearchMatch = cleanUrl.match(/^\/api\/paths\/([^/]+)\/search$/);
    if (pathSearchMatch) {
      const term = String(body?.term || '').toLowerCase();
      const built = buildDemoStructure(pathSearchMatch[1]);
      const hits = built.nodes
        .filter((n) => !term || n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term))
        .map((n) => ({ id: n.id, label: n.label, type: n.type, depth: n.depth, path: n.path, breadcrumb: [n.label] }));
      return ok({ hits, stats: built.stats });
    }

    const pathItemMatch = cleanUrl.match(/^\/api\/paths\/([^/]+)$/);
    if (pathItemMatch) {
      const pid = pathItemMatch[1];
      const idx = DEMO_PATHS.findIndex((p) => p.id === pid);
      if (method === 'PUT' && idx >= 0) {
        DEMO_PATHS[idx] = {
          ...DEMO_PATHS[idx],
          ...(body?.name ? { name: body.name } : {}),
          ...(body?.description !== undefined ? { description: body.description } : {}),
          ...(body?.structure ? { structure: body.structure } : {}),
          ...(body?.queryId ? { queryId: body.queryId } : {}),
          config: { ...DEMO_PATHS[idx].config, ...(body?.config || {}) },
        };
        return ok(DEMO_PATHS[idx]);
      }
      if (method === 'DELETE' && idx >= 0) {
        DEMO_PATHS.splice(idx, 1);
        return ok(true);
      }
      return ok(DEMO_PATHS[idx >= 0 ? idx : 0]);
    }

    // ========================================================================
    // 4. SAVED SQL QUERIES (/api/queries/*)
    // ========================================================================
    if (cleanUrl === '/api/queries' && method === 'GET') {
      return ok(DEMO_QUERIES);
    }

    if (cleanUrl === '/api/queries' && method === 'POST') {
      const created = {
        id: `q_${Date.now()}`,
        name: body?.name || 'Yeni SQL Sorgusu',
        description: body?.description || '',
        dataSourceId: body?.dataSourceId || 'ds_factory',
        sql: body?.sql || 'SELECT * FROM production_lines',
        owner: this.getCurrentUser().id,
        allowedRoles: ['admin', 'engineer', 'operator'],
        allowedUsers: [],
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      DEMO_QUERIES.unshift(created);
      return ok(created);
    }

    if (cleanUrl === '/api/queries/preview' && method === 'POST') {
      const rows = evaluateDemoSql(body?.sql || '');
      const columns = buildColumnsMeta(rows);
      return ok({ columns, rows, totalRows: rows.length, rowCount: rows.length, truncated: false, executionMs: 4 }, {}, 90);
    }

    const qColsMatch = cleanUrl.match(/^\/api\/queries\/([^/]+)\/columns$/);
    if (qColsMatch) {
      const q = DEMO_QUERIES.find((x) => x.id === qColsMatch[1]);
      const rows = evaluateDemoSql(q?.sql || '', qColsMatch[1]);
      return ok(rows.length ? Object.keys(rows[0]) : []);
    }

    const qPrevMatch = cleanUrl.match(/^\/api\/queries\/([^/]+)\/preview$/);
    if (qPrevMatch) {
      const qid = qPrevMatch[1];
      const q = DEMO_QUERIES.find((x) => x.id === qid);
      const rows = evaluateDemoSql(q?.sql || '', qid);
      const columns = buildColumnsMeta(rows);
      return ok({
        name: q?.name || qid,
        description: q?.description || '',
        columns,
        rows,
        totalRows: rows.length,
        rowCount: rows.length,
        truncated: false,
        executionMs: 4,
      });
    }

    const qItemMatch = cleanUrl.match(/^\/api\/queries\/([^/]+)$/);
    if (qItemMatch) {
      const qid = qItemMatch[1];
      const idx = DEMO_QUERIES.findIndex((x) => x.id === qid);
      if (method === 'PUT' && idx >= 0) {
        DEMO_QUERIES[idx] = { ...DEMO_QUERIES[idx], ...body, updatedAt: new Date().toISOString() };
        return ok(DEMO_QUERIES[idx]);
      }
      if (method === 'DELETE' && idx >= 0) {
        DEMO_QUERIES.splice(idx, 1);
        return ok(true);
      }
      return ok(DEMO_QUERIES[idx >= 0 ? idx : 0]);
    }

    // ========================================================================
    // 5. PYTHON WORKSPACE (/api/python/*)
    // ========================================================================
    if (cleanUrl === '/api/python/scripts' && method === 'GET') {
      return ok(DEMO_PYTHON_SCRIPTS);
    }

    if (cleanUrl === '/api/python/scripts' && method === 'POST') {
      const created = {
        id: `py_${Date.now()}`,
        name: body?.name || 'Yeni Python Analizi',
        description: body?.description || '',
        code: body?.code || '',
        sqlQueryIds: body?.sqlQueryIds || ['q_batch_production'],
        datasetNames: ['line_oee_matrix'],
        owner: this.getCurrentUser().id,
        allowedRoles: ['admin', 'engineer'],
        allowedUsers: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      DEMO_PYTHON_SCRIPTS.unshift(created);
      return ok(created);
    }

    if (cleanUrl === '/api/python/run' && method === 'POST') {
      const res = executeDemoPython('', body?.code || '');
      return ok(res.datasets, {}, 140);
    }

    const pyColsMatch = cleanUrl.match(/^\/api\/python\/scripts\/([^/]+)\/columns$/);
    if (pyColsMatch) {
      const res = executeDemoPython(pyColsMatch[1], '');
      const ds = res.datasets[res.datasetName];
      const colNames = (ds?.columns || []).map((c: any) => c.name || c);
      return of(new HttpResponse({ status: 200, body: { success: true, data: colNames, datasets: res.datasetNames } }));
    }

    const pyRunMatch = cleanUrl.match(/^\/api\/python\/scripts\/([^/]+)\/run$/);
    if (pyRunMatch) {
      const sid = pyRunMatch[1];
      const sc = DEMO_PYTHON_SCRIPTS.find((x) => x.id === sid);
      const res = executeDemoPython(sid, sc?.code || '');
      const chosenName = body?.dataset && res.datasets[body.dataset] ? body.dataset : res.datasetName;
      const chosen = res.datasets[chosenName];
      return ok({
        id: sid,
        name: sc?.name || sid,
        description: sc?.description || '',
        datasetName: chosenName,
        datasetNames: res.datasetNames,
        columns: chosen.columns,
        rows: chosen.rows,
        totalRows: chosen.rows.length,
        datasets: res.datasets,
        executionMs: 11,
      });
    }

    const pyItemMatch = cleanUrl.match(/^\/api\/python\/scripts\/([^/]+)$/);
    if (pyItemMatch) {
      const idx = DEMO_PYTHON_SCRIPTS.findIndex((x) => x.id === pyItemMatch[1]);
      if (method === 'PUT' && idx >= 0) {
        DEMO_PYTHON_SCRIPTS[idx] = { ...DEMO_PYTHON_SCRIPTS[idx], ...body };
        return ok(DEMO_PYTHON_SCRIPTS[idx]);
      }
      if (method === 'DELETE' && idx >= 0) {
        DEMO_PYTHON_SCRIPTS.splice(idx, 1);
        return ok(true);
      }
      return ok(DEMO_PYTHON_SCRIPTS[idx >= 0 ? idx : 0]);
    }

    // ========================================================================
    // 6. TEMPLATES & LIVE REPORT OUTPUTS (/api/templates/*)
    // ========================================================================
    if (cleanUrl === '/api/templates' && method === 'GET') {
      return ok(DEMO_TEMPLATES.map(({ model, ...summary }) => summary));
    }

    if (cleanUrl === '/api/templates' && method === 'POST') {
      const id = `tpl_${Date.now()}`;
      const now = new Date().toISOString();
      const model = body?.model || DEMO_TEMPLATES[0].model;
      model.id = id;
      model.name = body?.name || model.name || 'Yeni Rapor Şablonu';
      const rec = {
        id,
        name: model.name,
        description: body?.description || model.description || '',
        owner: this.getCurrentUser().id,
        allowedRoles: ['admin', 'engineer', 'operator'],
        allowedUsers: [],
        created_at: now,
        updated_at: now,
        model,
      };
      DEMO_TEMPLATES.unshift(rec);
      return ok({ id, name: rec.name });
    }

    if (cleanUrl === '/api/templates/evaluate' && method === 'POST') {
      const model = body?.model || DEMO_TEMPLATES.find((t) => t.id === body?.templateId)?.model || DEMO_TEMPLATES[0].model;
      return ok(evaluateDemoTemplate(model, body?.maxBandRows || 60), {}, 90);
    }

    const tplEvalMatch = cleanUrl.match(/^\/api\/templates\/([^/]+)\/evaluate$/);
    if (tplEvalMatch) {
      const found = DEMO_TEMPLATES.find((t) => t.id === tplEvalMatch[1]) || DEMO_TEMPLATES[0];
      return ok(evaluateDemoTemplate(found.model, body?.maxBandRows || 60), {}, 90);
    }

    const tplRenderMatch = cleanUrl.match(/^\/api\/templates\/([^/]+)\/render$/);
    if (tplRenderMatch) {
      const found = DEMO_TEMPLATES.find((t) => t.id === tplRenderMatch[1]) || DEMO_TEMPLATES[0];
      const evaluated = evaluateDemoTemplate(found.model, 80);
      const fmt = (searchParams.get('format') || 'xlsx').toLowerCase();
      if (fmt === 'pdf') {
        const sheet = evaluated.sheets[0];
        const lines: string[] = [`Tarih: ${evaluated.evaluatedAt}`, '------------------------------------------------------------'];
        for (let r = 1; r <= Math.min(sheet.rowCount, 30); r++) {
          const rowVals: string[] = [];
          for (let c = 1; c <= Math.min(sheet.colCount, 8); c++) {
            const v = sheet.cells[`${r},${c}`]?.value;
            if (v !== undefined && v !== '') rowVals.push(String(v));
          }
          if (rowVals.length) lines.push(rowVals.join(' | '));
        }
        return of(new HttpResponse({ status: 200, body: buildRealPdfBlob(found.name, lines) })).pipe(delay(150));
      }
      return of(new HttpResponse({ status: 200, body: buildRealXlsxBlob(evaluated) })).pipe(delay(150));
    }

    const tplShareMatch = cleanUrl.match(/^\/api\/templates\/([^/]+)\/sharing$/);
    if (tplShareMatch) {
      const found = DEMO_TEMPLATES.find((t) => t.id === tplShareMatch[1]);
      if (found) {
        found.allowedRoles = body?.allowedRoles || [];
        found.allowedUsers = body?.allowedUsers || [];
      }
      return ok(true);
    }

    const tplItemMatch = cleanUrl.match(/^\/api\/templates\/([^/]+)$/);
    if (tplItemMatch) {
      const tid = tplItemMatch[1];
      const idx = DEMO_TEMPLATES.findIndex((t) => t.id === tid);
      if (method === 'PUT' && idx >= 0) {
        if (body?.model) DEMO_TEMPLATES[idx].model = body.model;
        if (body?.name) DEMO_TEMPLATES[idx].name = body.name;
        if (body?.description !== undefined) DEMO_TEMPLATES[idx].description = body.description;
        DEMO_TEMPLATES[idx].updated_at = new Date().toISOString();
        return ok({ id: tid });
      }
      if (method === 'DELETE' && idx >= 0) {
        DEMO_TEMPLATES.splice(idx, 1);
        return ok(true);
      }
      return ok(DEMO_TEMPLATES[idx >= 0 ? idx : 0]);
    }

    // ========================================================================
    // 7. DASHBOARDS (/api/dashboards/*)
    // ========================================================================
    if (cleanUrl === '/api/dashboards' && method === 'GET') {
      return ok(
        DEMO_DASHBOARDS.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          owner: d.owner,
          ownerName: d.ownerName,
          isDefault: d.isDefault,
          allowedRoles: d.allowedRoles,
          allowedUsers: d.allowedUsers,
          widgetCount: d.layout.length,
        }))
      );
    }

    if (cleanUrl === '/api/dashboards/me' && method === 'GET') {
      return ok(DEMO_DASHBOARDS[0]);
    }

    if (cleanUrl === '/api/dashboards' && method === 'POST') {
      const created = {
        id: `db_${Date.now()}`,
        name: body?.name || 'Yeni Pano',
        description: body?.description || '',
        owner: this.getCurrentUser().id,
        ownerName: this.getCurrentUser().displayName,
        isDefault: !!body?.isDefault,
        allowedRoles: ['admin', 'engineer', 'operator'],
        allowedUsers: [],
        layout: body?.layout || [],
      };
      DEMO_DASHBOARDS.push(created);
      return ok({ id: created.id, name: created.name });
    }

    const dbPdfMatch = cleanUrl.match(/^\/api\/dashboards\/([^/]+)\/export-pdf$/);
    if (dbPdfMatch) {
      const d = DEMO_DASHBOARDS.find((x) => x.id === dbPdfMatch[1]) || DEMO_DASHBOARDS[0];
      const lines = d.layout.map((w: any, i: number) => `${i + 1}. ${w.title} [${w.dataSourceType || 'sql'}]`);
      return of(new HttpResponse({ status: 200, body: buildRealPdfBlob(d.name, lines) })).pipe(delay(120));
    }

    const dbDupMatch = cleanUrl.match(/^\/api\/dashboards\/([^/]+)\/duplicate$/);
    if (dbDupMatch) {
      const src = DEMO_DASHBOARDS.find((x) => x.id === dbDupMatch[1]) || DEMO_DASHBOARDS[0];
      const copy = { ...JSON.parse(JSON.stringify(src)), id: `db_${Date.now()}`, name: `${src.name} (Kopya)`, isDefault: false };
      DEMO_DASHBOARDS.push(copy);
      return ok({ id: copy.id, name: copy.name });
    }

    const dbItemMatch = cleanUrl.match(/^\/api\/dashboards\/([^/]+)$/);
    if (dbItemMatch) {
      const did = dbItemMatch[1];
      const idx = DEMO_DASHBOARDS.findIndex((x) => x.id === did);
      if (method === 'PUT' && idx >= 0) {
        if (Array.isArray(body?.layout)) DEMO_DASHBOARDS[idx].layout = body.layout;
        if (body?.name) DEMO_DASHBOARDS[idx].name = body.name;
        if (body?.description !== undefined) DEMO_DASHBOARDS[idx].description = body.description;
        return ok({ id: did });
      }
      if (method === 'DELETE' && idx >= 0 && DEMO_DASHBOARDS.length > 1) {
        DEMO_DASHBOARDS.splice(idx, 1);
        return ok({ deleted: true });
      }
      return ok(DEMO_DASHBOARDS[idx >= 0 ? idx : 0]);
    }

    // ========================================================================
    // 8. ALARMS & SCHEDULES
    // ========================================================================
    if (cleanUrl === '/api/alarms' && method === 'GET') {
      return ok(DEMO_ALARMS);
    }

    const almAck = cleanUrl.match(/^\/api\/alarms\/([^/]+)\/(acknowledge|resolve)$/);
    if (almAck) {
      const found = DEMO_ALARMS.find((a) => a.id === almAck[1]);
      if (found) found.status = almAck[2] === 'resolve' ? 'resolved' : 'acknowledged';
      return ok(found || true);
    }

    if (cleanUrl === '/api/schedules' && method === 'GET') {
      return ok(DEMO_SCHEDULES);
    }

    if (cleanUrl === '/api/schedules' && method === 'POST') {
      const s = { id: `sch_${Date.now()}`, ...body, enabled: true };
      DEMO_SCHEDULES.unshift(s);
      return ok(s);
    }

    return ok([]);
  }
}
