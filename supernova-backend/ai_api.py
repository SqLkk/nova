"""AI blueprint registered by the existing authenticated Flask application."""
from datetime import datetime
import hashlib
import json
import logging
import re
import uuid

from flask import Blueprint, Response, g, jsonify, request, stream_with_context

from ai_memory import LocalMemory
from ai_service import AIService, AIUnavailable, sse
from ai_tools import (
    SHARING_RESOURCE_TYPES,
    VALID_PERMISSION_KEYS,
    dispatch,
    validate_admin_action,
    validate_path,
    validate_python,
    validate_template,
)
from excel_template_engine import _compute_summary
from query_executor import execute_query, get_table_schema, get_tables
import secrets_util

logger = logging.getLogger(__name__)
_REDACTED_COLS = {'password', 'username', 'password_hash', 'password_salt'}

_CPOINT_VALUE_SQL = """SELECT
    p.POINT_ID,
    p.POINT_NAME,
    p.POINT_TYPE,
    COALESCE(pe.PATH_ELEMENT_NAME, 'Genel Hat') AS ASSET_NAME,
    COALESCE(pe.PATH_LEVEL, 'Subsystem') AS PATH_LEVEL,
    COUNT(t.reading_id) AS READING_COUNT,
    ROUND(COALESCE(AVG(t.value), 0.0), 2) AS AVG_VALUE,
    ROUND(COALESCE(MIN(t.value), p.MIN_VAL), 2) AS MIN_VALUE,
    ROUND(COALESCE(MAX(t.value), p.MAX_VAL), 2) AS MAX_VALUE,
    p.MIN_VAL AS SPEC_MIN_VAL,
    p.MAX_VAL AS SPEC_MAX_VAL
FROM C_POINT p
LEFT JOIN C_POINT_PATH_ELEMENT ppe ON p.POINT_ID = ppe.POINT_ID
LEFT JOIN C_PATH_ELEMENT pe ON ppe.PATH_ID = pe.PATH_ID
LEFT JOIN machine_telemetry_timeseries t ON p.POINT_ID = t.sensor_id
GROUP BY p.POINT_ID, p.POINT_NAME, p.POINT_TYPE, pe.PATH_ELEMENT_NAME, pe.PATH_LEVEL, p.MIN_VAL, p.MAX_VAL
ORDER BY p.POINT_ID"""

_CPOINT_VALUE_COLS = [
    {'name': 'POINT_ID', 'type': 'TEXT'},
    {'name': 'POINT_NAME', 'type': 'TEXT'},
    {'name': 'POINT_TYPE', 'type': 'TEXT'},
    {'name': 'ASSET_NAME', 'type': 'TEXT'},
    {'name': 'PATH_LEVEL', 'type': 'TEXT'},
    {'name': 'READING_COUNT', 'type': 'INTEGER'},
    {'name': 'AVG_VALUE', 'type': 'REAL'},
    {'name': 'MIN_VALUE', 'type': 'REAL'},
    {'name': 'MAX_VALUE', 'type': 'REAL'},
    {'name': 'SPEC_MIN_VAL', 'type': 'REAL'},
    {'name': 'SPEC_MAX_VAL', 'type': 'REAL'},
]

# Uygulama Veritabanı Tablo Kataloğu & Semantik Bilgi Grafiği (Eğitim Gerektirmeyen Akıllı Katman)
_DOMAIN_TABLE_CATALOG = {
    'C_POINT': {
        'title': 'C_POINT — Sensör & Ölçüm Noktaları Kataloğu',
        'desc': 'Sensör kimliği (POINT_ID), nokta adı, ölçüm tipi (Temperature, Pressure, Vibration, Flow, Power), birim ve alt/üst spesifikasyon limitleri (MIN_VAL, MAX_VAL).',
        'icon': 'fa-bullseye',
        'rowCount': 12,
        'defaultQueryId': 'q_b0d48d0120',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'sensor_telemetry',
        'columns': ['POINT_ID', 'POINT_NAME', 'POINT_TYPE', 'UNIT', 'MIN_VAL', 'MAX_VAL'],
        'keywords': {'c_point', 'point', 'point_id', 'point_name', 'sensör', 'sensor', 'nokta', 'limit', 'min_val', 'max_val', 'ölçüm', 'value', 'değer', 'sıcaklık', 'basınç', 'titreşim'},
    },
    'C_PATH_ELEMENT': {
        'title': 'C_PATH_ELEMENT — Endüstriyel Varlık & Hat Hiyerarşi Düğümleri',
        'desc': 'PATH_ID, PARENT_PATH_ID, PATH_ELEMENT_NAME ve PATH_LEVEL (Enterprise → Site → Area → Line → Subsystem) hiyerarşi ağacı.',
        'icon': 'fa-sitemap',
        'rowCount': 41,
        'defaultQueryId': 'q_4bd69f38e2',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'sensor_telemetry',
        'columns': ['PATH_ID', 'PARENT_PATH_ID', 'PATH_ELEMENT_NAME', 'PATH_LEVEL'],
        'keywords': {'c_path_element', 'c_path', 'path_id', 'parent_path_id', 'path_element_name', 'path_level', 'varlık', 'hiyerarşi', 'hat', 'düğüm', 'point', 'c_point'},
    },
    'C_POINT_PATH_ELEMENT': {
        'title': 'C_POINT_PATH_ELEMENT — Sensör ↔ Varlık Yolu Eşleşme Köprüsü',
        'desc': 'Sensör noktalarını (POINT_ID) fabrika varlık ağacındaki düğümlere (PATH_ID) bağlayan köprü tablo.',
        'icon': 'fa-link',
        'rowCount': 12,
        'defaultQueryId': 'q_f5390aa942',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'sensor_telemetry',
        'columns': ['PATH_ID', 'POINT_ID'],
        'keywords': {'c_point_path_element', 'point_id', 'path_id', 'eşleşme', 'köprü', 'bağlantı', 'point', 'c_point'},
    },
    'machine_telemetry_timeseries': {
        'title': 'machine_telemetry_timeseries — Canlı Makine & Sensör Telemetri Serisi',
        'desc': '60.000+ satır yüksek frekanslı sensör okumaları (reading_id, timestamp, machine_id, sensor_id, metric_name, value, lsl, usl, alarm_status).',
        'icon': 'fa-wave-square',
        'rowCount': 60000,
        'defaultQueryId': 'q_ind_telemetry_recent',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'sensor_telemetry',
        'columns': ['reading_id', 'timestamp', 'machine_id', 'sensor_id', 'metric_name', 'value', 'unit', 'lsl', 'usl', 'warning_threshold', 'alarm_status'],
        'keywords': {'machine_telemetry_timeseries', 'telemetry', 'telemetri', 'sensör', 'sensor', 'sensor_id', 'reading', 'okuma', 'value', 'değer', 'alarm', 'zaman', 'timeseries', 'point', 'c_point', 'makine'},
    },
    'production_batches': {
        'title': 'production_batches — Üretim Batch Lotları, OEE & Çevrim Performansı',
        'desc': '450 üretim lotu: planlanan/üretilen/sağlam/fire miktarları (planned_qty, produced_qty, good_qty, scrap_qty), OEE bileşenleri (oee_percentage, availability_rate, performance_rate, quality_rate), vardiya ve hat.',
        'icon': 'fa-industry',
        'rowCount': 450,
        'defaultQueryId': 'q_ind_production_oee',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'production_quality',
        'columns': ['batch_id', 'work_order_id', 'product_code', 'product_name', 'product_family', 'line_id', 'shift_name', 'planned_qty', 'produced_qty', 'good_qty', 'scrap_qty', 'scrap_rate_pct', 'cycle_time_actual_sec', 'cycle_time_target_sec', 'availability_rate', 'performance_rate', 'quality_rate', 'oee_percentage', 'batch_status'],
        'keywords': {'production_batches', 'production', 'üretim', 'uretim', 'batch', 'lot', 'oee', 'vardiya', 'shift', 'fire', 'scrap', 'çevrim', 'cycle', 'ürün', 'product', 'prdocut', 'performans', 'kalite'},
    },
    'quality_inspections': {
        'title': 'quality_inspections — Kalite Kontrol Muayene, Sapma & Hata (Defect) Kayıtları',
        'desc': '800 kalite kontrol kaydı: lot (batch_id), istasyon (station_name), mikron sapma (measured_deviation_um), hata kodu (defect_code, defect_description) ve kritiklik (defect_severity).',
        'icon': 'fa-clipboard-check',
        'rowCount': 800,
        'defaultQueryId': 'q_ind_quality_pareto',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'production_quality',
        'columns': ['inspection_id', 'batch_id', 'product_code', 'machine_id', 'timestamp', 'station_name', 'inspection_mode', 'status', 'measured_deviation_um', 'upper_tolerance_um', 'lower_tolerance_um', 'defect_code', 'defect_description', 'defect_severity', 'inspector_name'],
        'keywords': {'quality_inspections', 'quality', 'kalite', 'defect', 'hata', 'muayene', 'inspection', 'tolerans', 'sapma', 'batch', 'fire', 'scrap', 'kontrol', 'pareto'},
    },
    'equipment_downtime_events': {
        'title': 'equipment_downtime_events — Ekipman Arıza, Duruş (Downtime) & Bakım (MTTR)',
        'desc': '180 arıza/duruş kaydı: makine (machine_name), saha (plant_area), duruş süresi (downtime_minutes), arıza modu (failure_mode), kök neden (root_cause) ve onarım maliyeti (repair_cost_usd).',
        'icon': 'fa-screwdriver-wrench',
        'rowCount': 180,
        'defaultQueryId': 'q_ind_downtime_pareto',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'assets_maintenance',
        'columns': ['event_id', 'machine_id', 'machine_name', 'plant_area', 'start_timestamp', 'end_timestamp', 'downtime_minutes', 'category', 'failure_mode', 'root_cause', 'corrective_action', 'technician_id', 'repair_cost_usd', 'impacted_oee_factor', 'estimated_lost_units'],
        'keywords': {'equipment_downtime_events', 'downtime', 'duruş', 'durus', 'arıza', 'ariza', 'bakım', 'bakim', 'maintenance', 'mttr', 'mtbf', 'kök neden', 'root_cause', 'maliyet', 'repair', 'makine', 'ekipman'},
    },
    'facility_energy_esg': {
        'title': 'facility_energy_esg — Tesis Enerji Tüketimi (kWh), Güç Faktörü & CO2 (ESG)',
        'desc': '3.600 enerji & ESG kaydı: bölge (plant_area), aktif/reaktif güç (active_power_kwh, reactive_power_kvarh), pik talep (peak_demand_kw), basınçlı hava ve CO2 emisyonu (co2_emissions_kg).',
        'icon': 'fa-bolt',
        'rowCount': 3600,
        'defaultQueryId': 'q_ind_energy_esg',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'energy_esg',
        'columns': ['log_id', 'timestamp', 'facility_id', 'plant_area', 'active_power_kwh', 'reactive_power_kvarh', 'power_factor', 'peak_demand_kw', 'compressed_air_m3', 'co2_emissions_kg'],
        'keywords': {'facility_energy_esg', 'energy', 'enerji', 'elektrik', 'güç', 'power', 'kwh', 'karbon', 'co2', 'emisyon', 'esg', 'tüketim', 'saha', 'plant_area'},
    },
    'factory_assets_hierarchy': {
        'title': 'factory_assets_hierarchy — ISA-95 Fabrika Varlık Envanteri & Hiyerarşi Ağacı',
        'desc': '41 endüstriyel varlık: asset_id, parent_asset_id, asset_name, asset_level, plant_area, criticality_tier, manufacturer, status ve health_score.',
        'icon': 'fa-network-wired',
        'rowCount': 41,
        'defaultQueryId': 'q_ind_asset_tree',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'assets_maintenance',
        'columns': ['asset_id', 'parent_asset_id', 'asset_name', 'asset_level', 'level_depth', 'plant_area', 'criticality_tier', 'manufacturer', 'model_number', 'status', 'description', 'health_score'],
        'keywords': {'factory_assets_hierarchy', 'asset', 'varlık', 'varlik', 'envanter', 'fabrika', 'factory', 'hiyerarşi', 'tree', 'makine', 'ekipman', 'health_score', 'sağlık', 'isa-95'},
    },
    'manufacturing_process_sequence': {
        'title': 'manufacturing_process_sequence — Üretim Proses Akış Adımları & Rota (DAG/Sequence)',
        'desc': '10 üretim operasyon adımı: step_id, step_order, next_step_id, prerequisite_step_ids, step_name, workstation_name, std_cycle_time_sec ve health_score.',
        'icon': 'fa-diagram-project',
        'rowCount': 10,
        'defaultQueryId': 'q_ind_mfg_sequence',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'production_quality',
        'columns': ['step_id', 'step_order', 'next_step_id', 'step_name', 'assigned_line_id', 'workstation_name', 'std_cycle_time_sec', 'quality_gate_required', 'target_tolerance_um', 'prerequisite_step_ids', 'health_score', 'status'],
        'keywords': {'manufacturing_process_sequence', 'proses', 'process', 'adım', 'step', 'sequence', 'sıra', 'rota', 'routing', 'dag', 'akış', 'istasyon', 'üretim'},
    },
}

_JOIN_RECIPES = [
    {
        'id': 'join_cpoint_telemetry',
        'tables': ['C_POINT', 'C_POINT_PATH_ELEMENT', 'C_PATH_ELEMENT', 'machine_telemetry_timeseries'],
        'title': '🔗 [Çoklu Tablo JOIN] C_POINT + C_PATH_ELEMENT + machine_telemetry_timeseries',
        'desc': 'Sensör katalog limitlerini (C_POINT), bağlı olduğu hat/varlık düğümünü (C_PATH_ELEMENT) ve canlı telemetri ölçüm değerlerini (AVG/MIN/MAX) tek sorguda birleştirir.',
        'badge': '4 TABLO JOIN · Önerilen',
        'queryId': 'q_ind_cpoint_values',
        'dataSourceId': 'ds_apex_factory',
        'domain': 'sensor_telemetry',
        'sql': _CPOINT_VALUE_SQL,
        'columns': ['POINT_ID', 'POINT_NAME', 'POINT_TYPE', 'ASSET_NAME', 'PATH_LEVEL', 'READING_COUNT', 'AVG_VALUE', 'MIN_VALUE', 'MAX_VALUE', 'SPEC_MIN_VAL', 'SPEC_MAX_VAL'],
    },
    {
        'id': 'join_production_quality',
        'tables': ['production_batches', 'quality_inspections'],
        'title': '🔗 [Çoklu Tablo JOIN] production_batches + quality_inspections',
        'desc': 'Üretim lotlarının (batch_id) OEE ve üretim miktarlarını, aynı lotlara ait kalite muayene hataları (defect_code) ve mikron sapmalarıyla birleştirir.',
        'badge': '2 TABLO JOIN · Üretim + Kalite',
        'queryId': None,
        'dataSourceId': 'ds_apex_factory',
        'domain': 'production_quality',
        'sql': """SELECT
    b.batch_id,
    b.product_name,
    b.product_family,
    b.line_id,
    b.shift_name,
    b.produced_qty,
    b.good_qty,
    b.scrap_qty,
    ROUND(b.oee_percentage, 2) AS oee_percentage,
    COUNT(q.inspection_id) AS inspection_count,
    SUM(CASE WHEN q.status = 'FAIL' OR (q.defect_code IS NOT NULL AND q.defect_code != '') THEN 1 ELSE 0 END) AS defect_count,
    ROUND(COALESCE(AVG(q.measured_deviation_um), 0.0), 2) AS avg_deviation_um
FROM production_batches b
LEFT JOIN quality_inspections q ON b.batch_id = q.batch_id
GROUP BY b.batch_id, b.product_name, b.product_family, b.line_id, b.shift_name, b.produced_qty, b.good_qty, b.scrap_qty, b.oee_percentage
ORDER BY defect_count DESC, b.oee_percentage ASC
LIMIT 150""",
        'columns': ['batch_id', 'product_name', 'product_family', 'line_id', 'shift_name', 'produced_qty', 'good_qty', 'scrap_qty', 'oee_percentage', 'inspection_count', 'defect_count', 'avg_deviation_um'],
    },
    {
        'id': 'join_assets_downtime',
        'tables': ['factory_assets_hierarchy', 'equipment_downtime_events'],
        'title': '🔗 [Çoklu Tablo JOIN] factory_assets_hierarchy + equipment_downtime_events',
        'desc': 'Fabrika varlık envanteri (sağlık skoru, kritiklik seviyesi) ile makine arıza/duruş sürelerini (downtime_minutes) ve onarım maliyetlerini birleştirir.',
        'badge': '2 TABLO JOIN · Varlık + Duruş',
        'queryId': None,
        'dataSourceId': 'ds_apex_factory',
        'domain': 'assets_maintenance',
        'sql': """SELECT
    a.asset_id,
    a.asset_name,
    a.asset_level,
    a.plant_area,
    a.criticality_tier,
    ROUND(COALESCE(a.health_score, 85.0), 1) AS health_score,
    COUNT(d.event_id) AS downtime_incidents,
    ROUND(COALESCE(SUM(d.downtime_minutes), 0.0), 1) AS total_downtime_min,
    ROUND(COALESCE(AVG(d.downtime_minutes), 0.0), 1) AS avg_mttr_min,
    ROUND(COALESCE(SUM(d.repair_cost_usd), 0.0), 2) AS total_repair_cost_usd
FROM factory_assets_hierarchy a
LEFT JOIN equipment_downtime_events d ON a.asset_id = d.machine_id
GROUP BY a.asset_id, a.asset_name, a.asset_level, a.plant_area, a.criticality_tier, a.health_score
ORDER BY total_downtime_min DESC, a.health_score ASC""",
        'columns': ['asset_id', 'asset_name', 'asset_level', 'plant_area', 'criticality_tier', 'health_score', 'downtime_incidents', 'total_downtime_min', 'avg_mttr_min', 'total_repair_cost_usd'],
    },
    {
        'id': 'join_energy_assets',
        'tables': ['facility_energy_esg', 'factory_assets_hierarchy'],
        'title': '🔗 [Çoklu Tablo JOIN] facility_energy_esg + factory_assets_hierarchy',
        'desc': 'Tesis bölgelerinin (plant_area) toplam enerji tüketimi (kWh) ve CO2 emisyonunu, o sahadaki aktif ekipman sayısı ve sağlık ortalaması ile birleştirir.',
        'badge': '2 TABLO JOIN · Enerji + Saha',
        'queryId': None,
        'dataSourceId': 'ds_apex_factory',
        'domain': 'energy_esg',
        'sql': """SELECT
    e.plant_area,
    COUNT(DISTINCT a.asset_id) AS asset_count,
    ROUND(COALESCE(AVG(a.health_score), 85.0), 1) AS avg_asset_health,
    ROUND(SUM(e.active_power_kwh), 2) AS total_active_kwh,
    ROUND(AVG(e.power_factor), 3) AS avg_power_factor,
    ROUND(MAX(e.peak_demand_kw), 2) AS max_peak_kw,
    ROUND(SUM(e.co2_emissions_kg), 2) AS total_co2_kg
FROM facility_energy_esg e
LEFT JOIN factory_assets_hierarchy a ON e.plant_area = a.plant_area
GROUP BY e.plant_area
ORDER BY total_active_kwh DESC""",
        'columns': ['plant_area', 'asset_count', 'avg_asset_health', 'total_active_kwh', 'avg_power_factor', 'max_peak_kw', 'total_co2_kg'],
    },
]


def register_ai(app, settings, get_database, can_access, has_permission, query_columns, cache, limiter):
    blueprint = Blueprint('ai', __name__, url_prefix='/api/ai')
    gateway = AIService(settings)
    app.extensions['ai_service'] = gateway
    _seeded_queries = {'done': False}

    def _ensure_domain_queries():
        if _seeded_queries['done']:
            return
        try:
            with get_database()._conn() as conn:
                ds_row = conn.execute(
                    "SELECT id FROM data_sources WHERE id='ds_apex_factory' AND is_active=1"
                ).fetchone()
                if ds_row:
                    existing = conn.execute(
                        "SELECT id FROM queries WHERE id='q_ind_cpoint_values'"
                    ).fetchone()
                    roles_json = json.dumps(['admin', 'superuser', 'engineer', 'operator', 'viewer'])
                    cols_json = json.dumps(_CPOINT_VALUE_COLS, ensure_ascii=False)
                    if not existing:
                        conn.execute(
                            """INSERT INTO queries
                               (id, name, description, data_source_id, sql_text, parameters,
                                columns_meta, owner_id, allowed_roles, allowed_users, is_active)
                               VALUES (?, ?, ?, ?, ?, '[]', ?, 'system', ?, '[]', 1)""",
                            (
                                'q_ind_cpoint_values',
                                '[Smart Factory] C_Point Sensör Değerleri & Varlık Yolu (Value Raporu)',
                                'C_POINT, C_POINT_PATH_ELEMENT, C_PATH_ELEMENT ve machine_telemetry_timeseries tablolarını birleştirerek nokta bazlı ölçüm değerlerini (AVG/MIN/MAX) ve varlık hiyerarşisini getirir.',
                                'ds_apex_factory',
                                _CPOINT_VALUE_SQL,
                                cols_json,
                                roles_json,
                            ),
                        )
            _seeded_queries['done'] = True
        except Exception:
            logger.debug('Could not seed domain queries', exc_info=True)

    def _load_full_source(ds_id):
        if not ds_id:
            return None
        with get_database()._conn() as conn:
            row = conn.execute('SELECT * FROM data_sources WHERE id=? AND is_active=1', (ds_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d['password'] = secrets_util.decrypt_secret(d.get('password') or '')
        except Exception:
            d['password'] = d.get('password') or ''
        return d

    def schema_snapshot():
        _ensure_domain_queries()
        with get_database()._conn() as conn:
            sources = [dict(r) for r in conn.execute(
                'SELECT id, name, db_type, database_name, cached_tables FROM data_sources WHERE is_active=1')]
            rows = [dict(r) for r in conn.execute('SELECT * FROM queries WHERE is_active=1')]
        accessible_rows = [r for r in rows if can_access(r)]
        visible_source_ids = {r['data_source_id'] for r in accessible_rows}
        discovery_allowed = has_permission('datasource:view')
        safe_sources = []
        known_tables = {}
        for source in sources:
            if not discovery_allowed and source['id'] not in visible_source_ids:
                continue
            try:
                tables = cache.get('tables:' + source['id']) or json.loads(source['cached_tables'] or '[]')
            except (TypeError, ValueError):
                tables = []
            if not tables and discovery_allowed and (source.get('db_type') or '').lower() == 'sqlite' and source['id'] != 'ds_app':
                try:
                    tables = get_tables(source)
                    cache.set('tables:' + source['id'], tables)
                except Exception:
                    tables = []
            if not isinstance(tables, list) or not discovery_allowed:
                tables = []
            # Metadata only, never live row data or datasource credentials.
            table_meta = []
            for table in tables[:100]:
                name = table if isinstance(table, str) else table.get('name', '') if isinstance(table, dict) else ''
                if not name:
                    continue
                cached_schema = cache.get(f'schema:{source["id"]}:{name}')
                if not cached_schema and (source.get('db_type') or '').lower() == 'sqlite' and source['id'] != 'ds_app':
                    try:
                        cached_schema = get_table_schema(source, name)
                        cache.set(f'schema:{source["id"]}:{name}', cached_schema)
                    except Exception:
                        cached_schema = {}
                cached_schema = cached_schema or {}
                raw_cols = cached_schema.get('columns', []) if isinstance(cached_schema, dict) else []
                columns = [c.get('name') if isinstance(c, dict) else str(c) for c in raw_cols if c]
                columns = [c for c in columns if c and c.lower() not in _REDACTED_COLS]
                table_meta.append({'name': name, 'columns': columns})
                if columns:
                    known_tables[name.upper()] = columns
            safe_sources.append({'id': source['id'], 'name': source['name'], 'dialect': source['db_type'],
                                 'tables': table_meta, 'metadata_only': True})
        queries = []
        for r in accessible_rows[:100]:
            raw_cols = query_columns(r)
            col_names = [c.get('name') if isinstance(c, dict) else str(c) for c in raw_cols if c]
            if not col_names and r.get('sql_text'):
                m = re.match(r'^\s*SELECT\s+\*\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$', r['sql_text'], re.IGNORECASE)
                if m and m.group(1).upper() in known_tables:
                    col_names = list(known_tables[m.group(1).upper()])
            col_names = [c for c in col_names if c and c.lower() not in _REDACTED_COLS]
            sql_snippet = r.get('sql_text', '') or ''
            if any(red in sql_snippet.lower() for red in _REDACTED_COLS):
                sql_snippet = ''
            desc_snippet = (r.get('description') or '')[:200]
            if any(red in desc_snippet.lower() for red in _REDACTED_COLS):
                desc_snippet = ''
            queries.append({'id': r['id'], 'name': r['name'], 'description': desc_snippet,
                            'dataSourceId': r['data_source_id'], 'sql': sql_snippet, 'columns': col_names})
        return {'sources': safe_sources, 'queries': queries,
                'note': 'All authorized table and query columns are listed above.'}

    def rbac_snapshot():
        caller_role = getattr(g, 'role', 'viewer') or 'viewer'
        caller_level = int(getattr(g, 'level', 20) or 20)
        roles_out = []
        users_out = None
        try:
            with get_database()._conn() as conn:
                if has_permission('role:view') or has_permission('page:admin'):
                    role_rows = [dict(r) for r in conn.execute(
                        'SELECT id, key, name, description, level, is_system FROM roles WHERE is_active=1 ORDER BY level DESC'
                    )]
                    for rr in role_rows:
                        perms = [p['permission_key'] for p in conn.execute(
                            'SELECT permission_key FROM role_permissions WHERE role_id=? ORDER BY permission_key',
                            (rr['id'],),
                        )]
                        roles_out.append({
                            'key': rr['key'],
                            'name': rr['name'],
                            'level': rr['level'],
                            'isSystem': bool(rr['is_system']),
                            'permissions': perms,
                        })
                if has_permission('user:view'):
                    u_rows = [dict(u) for u in conn.execute(
                        'SELECT id, display_name, role, is_active FROM users ORDER BY created_at ASC LIMIT 100'
                    )]
                    users_out = [
                        {
                            'id': u['id'],
                            'displayName': u['display_name'],
                            'roleKey': u['role'],
                            'isActive': bool(u['is_active']),
                        }
                        for u in u_rows
                    ]
        except Exception:
            logger.debug('Could not inspect RBAC snapshot', exc_info=True)
        out = {
            'callerRole': caller_role,
            'callerLevel': caller_level,
            'roles': roles_out,
            'permissionKeys': sorted(VALID_PERMISSION_KEYS),
            'sharingResourceTypes': sorted(SHARING_RESOURCE_TYPES),
        }
        if users_out is not None:
            out['users'] = users_out
        return out

    def _execute_query_live(qid=None, ds_id=None, sql_text=None, query_name=None, create_if_missing=False):
        """Load or create a SavedQuery, run it against the DB, and return live metadata + sample rows."""
        row = None
        if qid:
            with get_database()._conn() as conn:
                r = conn.execute('SELECT * FROM queries WHERE id=? AND is_active=1', (qid,)).fetchone()
                if r:
                    row = dict(r)
        if not row and sql_text and ds_id and create_if_missing:
            clean_sql = sql_text.strip().rstrip(';')
            if re.match(r'^\s*(SELECT|WITH)\b', clean_sql, re.IGNORECASE):
                digest = hashlib.sha1(f"{ds_id}:{clean_sql}".encode('utf-8')).hexdigest()[:10]
                new_qid = f"q_ai_{digest}"
                with get_database()._conn() as conn:
                    existing = conn.execute('SELECT * FROM queries WHERE id=?', (new_qid,)).fetchone()
                    if existing:
                        row = dict(existing)
                    else:
                        qname = (query_name or f"[Copilot] Otomatik Sorgu ({new_qid[-4:]})").strip()
                        roles_json = json.dumps(['admin', 'superuser', 'engineer', 'operator', 'viewer'])
                        owner = getattr(g, 'uid', None) or 'system'
                        conn.execute(
                            """INSERT INTO queries
                               (id, name, description, data_source_id, sql_text, parameters,
                                columns_meta, owner_id, allowed_roles, allowed_users, is_active)
                               VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, '[]', 1)""",
                            (new_qid, qname, 'Copilot tarafından rapor için oluşturuldu.', ds_id, clean_sql, owner, roles_json),
                        )
                        row = dict(conn.execute('SELECT * FROM queries WHERE id=?', (new_qid,)).fetchone())
        if not row or not can_access(row):
            return None

        ds = _load_full_source(row['data_source_id'])
        if not ds:
            return None

        rows = []
        col_objs = []
        try:
            res = execute_query(ds, row['sql_text'], {}, limit=200)
            rows = res.get('rows') or []
            col_objs = res.get('columns') or []
            if col_objs:
                cache.set(f"qcols:{row['id']}", col_objs)
                with get_database()._conn() as conn:
                    conn.execute(
                        "UPDATE queries SET columns_meta=?, updated_at=datetime('now') WHERE id=?",
                        (json.dumps(col_objs, ensure_ascii=False), row['id']),
                    )
        except Exception as exc:
            logger.warning("Live query preview failed for %s: %s", row['id'], exc)
            col_objs = query_columns(row) or []

        cols = [c.get('name') if isinstance(c, dict) else str(c) for c in col_objs if c]
        cols = [c for c in cols if c and c.lower() not in _REDACTED_COLS]
        if not cols and rows:
            cols = [k for k in rows[0].keys() if k.lower() not in _REDACTED_COLS]

        # Classify numeric vs text columns from actual row values or column names
        numeric_cols = []
        text_cols = []
        for c in cols:
            vals = [r.get(c) for r in rows[:25] if r.get(c) is not None]
            is_num = False
            if vals:
                is_num = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals)
            else:
                cl = c.lower()
                is_num = any(k in cl for k in ('val', 'qty', 'count', 'rate', 'pct', 'oee', 'min', 'max', 'avg', 'sum', 'score', 'kwh', 'cost', 'sec', 'um'))
            if is_num:
                numeric_cols.append(c)
            else:
                text_cols.append(c)

        safe_preview = []
        for r in rows[:5]:
            safe_preview.append({c: r.get(c) for c in cols})

        return {
            'queryId': row['id'],
            'queryName': row['name'],
            'dataSourceId': row['data_source_id'],
            'dataSourceName': ds.get('name') or row['data_source_id'],
            'sql': row['sql_text'],
            'columns': cols,
            'numericColumns': numeric_cols,
            'textColumns': text_cols,
            'rowCount': len(rows),
            'previewRows': safe_preview,
            '_allRows': rows,
        }

    def _infer_report_name(user_text, query_meta, chart_title=None):
        low = (user_text or '').lower()
        if 'c_point' in low or 'point' in low:
            if 'batch' in low or 'prdocut' in low or 'product' in low or 'üretim' in low:
                return 'Apex Smart Factory C_Point & Üretim Batch Raporu'
            if 'value' in low or 'değer' in low or 'tablo' in low:
                return 'C_Point Sensör Değerleri ve Varlık Raporu'
            return 'C_Point Nokta ve Telemetri Analiz Raporu'
        if 'batch' in low or 'prdocut' in low or 'product' in low or 'üretim' in low or 'oee' in low:
            return 'Apex Smart Factory Üretim Batch ve OEE Raporu'
        if 'downtime' in low or 'duruş' in low or 'arıza' in low or 'mttr' in low:
            return 'Ekipman Duruş (Downtime) ve Bakım Raporu'
        if 'kalite' in low or 'quality' in low or 'defect' in low or 'hata' in low:
            return 'Kalite Kontrol ve Hata Pareto Raporu'
        if 'enerji' in low or 'energy' in low or 'esg' in low or 'karbon' in low:
            return 'Tesis Enerji Tüketimi ve Karbon (ESG) Raporu'
        if chart_title and len(chart_title.strip()) > 3 and chart_title.lower() != 'copilot önizlemesi':
            t = chart_title.strip()
            return t if 'rapor' in t.lower() else f"{t} Raporu"
        qname = re.sub(r'^\[[^\]]+\]\s*', '', (query_meta or {}).get('queryName') or 'Veri Analiz').strip()
        return qname if 'rapor' in qname.lower() else f"{qname} Raporu"

    def _build_query_proposal_fields(q_info, parsed_json=None, user_text='', preferred_chart=None):
        cols = q_info['columns']
        num_cols = q_info['numericColumns']
        txt_cols = q_info['textColumns']
        all_rows = q_info.get('_allRows') or []
        u_low = (user_text or '').lower()

        # 1. Chart config (explicit prompt -> model JSON -> persistent user memory -> 'bar')
        raw_charts = (parsed_json or {}).get('charts') if isinstance(parsed_json, dict) else None
        raw_chart = raw_charts[0] if isinstance(raw_charts, list) and raw_charts and isinstance(raw_charts[0], dict) else {}
        if any(k in u_low for k in ('çizgi grafik', 'line chart', 'line grafik')):
            chart_type = 'line'
        elif any(k in u_low for k in ('pasta grafik', 'pie chart', 'daire grafik')):
            chart_type = 'pie'
        elif any(k in u_low for k in ('çubuk grafik', 'bar chart', 'sütun grafik')):
            chart_type = 'bar'
        elif raw_chart.get('type') in ('bar', 'line', 'pie'):
            chart_type = raw_chart['type']
        elif preferred_chart in ('bar', 'line', 'pie'):
            chart_type = preferred_chart
        else:
            chart_type = 'bar'
        x_axis = raw_chart.get('xAxis') if raw_chart.get('xAxis') in cols else None
        if not x_axis:
            for pref in ('POINT_NAME', 'product_name', 'machine_name', 'Machine Name', 'Plant Area', 'shift_name', 'Shift Name', 'ASSET_NAME', 'batch_id', 'POINT_ID', 'label', 'name'):
                if pref in cols:
                    x_axis = pref
                    break
            if not x_axis:
                x_axis = txt_cols[0] if txt_cols else (cols[0] if cols else '')

        raw_y = raw_chart.get('yAxis') or []
        if isinstance(raw_y, str):
            raw_y = [raw_y]
        y_axis = [y for y in raw_y if y in cols and y != x_axis]
        if not y_axis:
            preferred_y = [c for c in ('AVG_VALUE', 'MIN_VALUE', 'MAX_VALUE', 'oee_percentage', 'produced_qty', 'good_qty', 'scrap_qty', 'MIN_VAL', 'MAX_VAL', 'value', 'downtime_minutes', 'active_power_kwh') if c in cols and c != x_axis]
            y_axis = preferred_y[:3] if preferred_y else [c for c in num_cols if c != x_axis][:2]
        if not y_axis and cols:
            y_axis = [cols[-1]]

        chart_title = raw_chart.get('title') or _infer_report_name(user_text, q_info)
        chart_cfg = {
            'include': True,
            'type': chart_type,
            'title': chart_title,
            'xAxis': x_axis,
            'yAxis': y_axis[:3],
        }

        # 2. Summary KPI cells
        raw_cells = (parsed_json or {}).get('cells') if isinstance(parsed_json, dict) else None
        summaries = []
        seen_ops = set()
        if isinstance(raw_cells, list):
            for cell in raw_cells:
                b = (cell or {}).get('binding') if isinstance(cell, dict) else None
                if isinstance(b, dict) and b.get('kind') == 'summary':
                    f = b.get('field')
                    op = (b.get('operation') or 'SUM').upper()
                    if f in cols and (f, op) not in seen_ops:
                        seen_ops.add((f, op))
                        summaries.append({
                            'field': f,
                            'operation': op,
                            'checked': True,
                            'value': _compute_summary(all_rows, f, op) if all_rows else 0,
                        })

        # Add default sensible summaries so user can toggle them
        default_candidates = []
        for pref_f, pref_op in [
            ('AVG_VALUE', 'AVG'), ('MIN_VALUE', 'MIN'), ('MAX_VALUE', 'MAX'), ('READING_COUNT', 'SUM'),
            ('MIN_VAL', 'MIN'), ('MAX_VAL', 'MAX'), ('POINT_ID', 'COUNT'),
            ('oee_percentage', 'AVG'), ('produced_qty', 'SUM'), ('good_qty', 'SUM'), ('scrap_qty', 'SUM'), ('batch_id', 'COUNT'),
            ('downtime_minutes', 'SUM'), ('repair_cost_usd', 'SUM'), ('active_power_kwh', 'SUM'), ('value', 'AVG'),
        ]:
            if pref_f in cols:
                default_candidates.append((pref_f, pref_op))
        for nc in num_cols[:3]:
            default_candidates.extend([(nc, 'AVG'), (nc, 'MIN'), (nc, 'MAX'), (nc, 'SUM')])
        if cols:
            default_candidates.append((cols[0], 'COUNT'))

        for f, op in default_candidates:
            if (f, op) not in seen_ops and len(summaries) < 6:
                seen_ops.add((f, op))
                summaries.append({
                    'field': f,
                    'operation': op,
                    'checked': len([s for s in summaries if s['checked']]) < 4,
                    'value': _compute_summary(all_rows, f, op) if all_rows else 0,
                })

        selected_cols = cols[:8]
        return chart_cfg, summaries, selected_cols

    def _prepare_report_proposal(user_text, assistant_text, context, snapshot):
        low_user = (user_text or '').lower()
        wants_report = any(k in low_user for k in (
            'rapor', 'report', 'excel', 'şablon', 'template', 'tablo oluştur', 'value raporu', 'batch raporu', 'özet tablo'
        ))

        # Check if assistant emitted a JSON block with charts/cells or a SQL block
        parsed_json = None
        for m in re.finditer(r'```(?:json)?\s*\n([\s\S]*?)```', assistant_text or ''):
            try:
                obj = json.loads(m.group(1).strip())
                if isinstance(obj, dict) and ('charts' in obj or 'cells' in obj):
                    parsed_json = obj
                    break
            except Exception:
                pass
        if not parsed_json and (assistant_text or '').strip().startswith('{'):
            try:
                obj = json.loads(assistant_text.strip())
                if isinstance(obj, dict) and ('charts' in obj or 'cells' in obj):
                    parsed_json = obj
            except Exception:
                pass

        if not parsed_json and not wants_report:
            return None, None

        # Check if assistant wrote a SQL query block
        sql_match = re.search(r'```sql\s*\n([\s\S]*?)```', assistant_text or '', re.IGNORECASE)
        extracted_sql = sql_match.group(1).strip() if sql_match else None

        # Determine primary queryId
        primary_qid = None
        if isinstance(parsed_json, dict):
            for ch in parsed_json.get('charts') or []:
                if isinstance(ch, dict) and ch.get('queryId'):
                    primary_qid = ch['queryId']
                    break
            if not primary_qid:
                for cl in parsed_json.get('cells') or []:
                    b = (cl or {}).get('binding') if isinstance(cl, dict) else None
                    if isinstance(b, dict) and b.get('queryId'):
                        primary_qid = b['queryId']
                        break

        # Match any accessible saved query ID or exact query name mentioned in the user prompt
        if not primary_qid:
            for sq in snapshot.get('queries') or []:
                sq_id = (sq.get('id') or '').lower()
                sq_name = (sq.get('name') or '').lower()
                if (sq_id and re.search(r'\b' + re.escape(sq_id) + r'\b', low_user)) or (
                    sq_name and len(sq_name) >= 4 and sq_name in low_user
                ):
                    primary_qid = sq['id']
                    break

        # If user asked for C_POINT + value / tables, prioritize the joined C_POINT value query!
        if ('c_point' in low_user or 'point' in low_user) and any(w in low_user for w in ('value', 'değer', 'tablo', 'rapor', 'report')):
            if 'batch' not in low_user and 'prdocut' not in low_user and 'product' not in low_user:
                primary_qid = 'q_ind_cpoint_values'

        # If user asked for production batch report, prioritize q_ind_production_oee
        if any(w in low_user for w in ('batch', 'prdocut', 'product', 'üretim')) and ('rapor' in low_user or 'report' in low_user):
            if not primary_qid or primary_qid == 'q_b0d48d0120':
                primary_qid = 'q_ind_production_oee'

        # If user references previous session/work ("önceki", "aynı", "geçen", "son"), reuse remembered queryId
        mem_info = context.get('user_memory') if isinstance(context.get('user_memory'), dict) else {}
        if not primary_qid and mem_info.get('last_query_id') and any(w in low_user for w in ('önceki', 'aynı', 'geçen', 'son yaptığımız', 'yine')):
            primary_qid = mem_info['last_query_id']

        q_info = None
        if extracted_sql and not primary_qid:
            ds_id = context.get('data_source_id') or 'ds_apex_factory'
            q_info = _execute_query_live(
                ds_id=ds_id,
                sql_text=extracted_sql,
                query_name=_infer_report_name(user_text, {}),
                create_if_missing=True,
            )
        if not q_info and primary_qid:
            q_info = _execute_query_live(qid=primary_qid)
        if not q_info:
            for aq in context.get('active_queries') or []:
                qid = aq.get('id') if isinstance(aq, dict) else aq
                q_info = _execute_query_live(qid=qid)
                if q_info and q_info['columns']:
                    break
        if not q_info or not q_info['columns']:
            return None, None

        chart_cfg, summaries, selected_cols = _build_query_proposal_fields(
            q_info, parsed_json, user_text, preferred_chart=mem_info.get('preferred_chart_type')
        )
        report_name = _infer_report_name(user_text, q_info, chart_cfg.get('title'))

        # Gather candidate queries so user can switch in the interactive dialog
        candidate_ids = [q_info['queryId']]
        if 'c_point' in low_user or 'point' in low_user:
            for cid in ('q_ind_cpoint_values', 'q_b0d48d0120', 'q_ind_telemetry_recent', 'q_ind_production_oee'):
                if cid not in candidate_ids:
                    candidate_ids.append(cid)
        for aq in context.get('active_queries') or []:
            cid = aq.get('id') if isinstance(aq, dict) else aq
            if cid and cid not in candidate_ids:
                candidate_ids.append(cid)

        candidates = []
        for cid in candidate_ids[:4]:
            for sq in snapshot.get('queries') or []:
                if sq['id'] == cid and sq.get('columns'):
                    candidates.append({
                        'id': sq['id'],
                        'name': sq['name'],
                        'columns': sq['columns'],
                    })
                    break

        proposal = {
            'reportName': report_name,
            'queryId': q_info['queryId'],
            'queryName': q_info['queryName'],
            'dataSourceId': q_info['dataSourceId'],
            'dataSourceName': q_info['dataSourceName'],
            'sql': q_info['sql'],
            'rowCount': q_info['rowCount'],
            'columns': q_info['columns'],
            'selectedColumns': selected_cols,
            'previewRows': q_info['previewRows'],
            'includeDetailTable': True,
            'chart': chart_cfg,
            'summaries': summaries,
            'candidateQueries': candidates,
        }

        # Check if assistant_text has human explanation outside the code block
        text_outside = re.sub(r'```[\s\S]*?```', '', assistant_text or '').strip()
        intro_delta = None
        if len(text_outside) < 25:
            checked_sums = [f"{s['operation']}({s['field']}) = {s['value']}" for s in summaries if s.get('checked')]
            sum_str = ', '.join(checked_sums[:4]) if checked_sums else 'Yok'
            intro_delta = (
                f"📊 **{report_name}** için veritabanı sorgusunu çalıştırdım, verileri çektim ve Excel rapor şablonunu hazırladım:\n\n"
                f"• **Veri Kaynağı:** `{q_info['dataSourceName']}`\n"
                f"• **Hazırlanan Sorgu:** `{q_info['queryName']}` (**{q_info['rowCount']} satır** veri doğrulandı)\n"
                f"• **Tablo Kolonları ({len(selected_cols)}):** `{', '.join(selected_cols[:6])}{'...' if len(selected_cols) > 6 else ''}`\n"
                f"• **Özet KPI Değerleri:** {sum_str}\n"
                f"• **Grafik:** `{chart_cfg['title']}` ({chart_cfg['type'].upper()} · X: `{chart_cfg['xAxis']}`, Y: `{', '.join(chart_cfg['yAxis'])}`)\n\n"
                f"Aşağıdaki interaktif panelden **Rapor Adını**, **Veri Sorgusunu**, **Grafik Türünü** veya **Kolonları** düzenleyebilirsiniz. "
                f"**Raporu şimdi oluşturup çalıştırayım mı (Execute)?**"
            )

        return proposal, intro_delta

    def _get_live_table_catalog(snapshot, ds_id='ds_apex_factory'):
        """Merge static industrial table catalog with live schema_snapshot tables so custom user tables are also included."""
        catalog = dict(_DOMAIN_TABLE_CATALOG)
        for src in snapshot.get('sources') or []:
            src_id = src.get('id') or ds_id
            for t in src.get('tables') or []:
                tname = t.get('name')
                if not tname:
                    continue
                cols = [c.get('name') for c in (t.get('columns') or []) if isinstance(c, dict) and c.get('name')]
                if tname in catalog:
                    merged = dict(catalog[tname])
                    if cols:
                        merged['columns'] = cols
                    merged['dataSourceId'] = src_id
                    catalog[tname] = merged
                else:
                    catalog[tname] = {
                        'title': f"{tname} ({src.get('name') or src_id})",
                        'description': f"{src.get('name') or src_id} veritabanındaki `{tname}` tablosu.",
                        'rowCount': 100,
                        'columns': cols,
                        'defaultQueryId': '',
                        'dataSourceId': src_id,
                        'tags': [tname.lower()] + [c.lower() for c in cols[:6]],
                    }
        return catalog

    def _discover_candidate_tables(user_text, snapshot, context=None, exclude_tables=None):
        """Score tables and multi-table JOIN recipes against the user's request and detect ambiguity."""
        low = (user_text or '').lower()
        tokens = set(re.findall(r'[a-z0-9_ğüşıöç]+', low))
        exclude_set = {t.lower() for t in (exclude_tables or [])}
        catalog = _get_live_table_catalog(snapshot, (context or {}).get('data_source_id') or 'ds_apex_factory')

        scored_tables = []
        explicit_mentions = []
        for tname, meta in catalog.items():
            if tname.lower() in exclude_set:
                continue
            score = 0
            if tname.lower() in low:
                score += 12
                explicit_mentions.append(tname)
            for tag in (meta.get('keywords') or meta.get('tags') or []):
                tag_l = tag.lower()
                if tag_l in low:
                    score += 4 if len(tag_l) > 4 else 2
                elif any(tok.startswith(tag_l[:4]) for tok in tokens if len(tok) >= 4 and len(tag_l) >= 4):
                    score += 2
            for col in meta.get('columns') or []:
                col_l = col.lower()
                if col_l in tokens or (len(col_l) > 4 and col_l in low):
                    score += 3
            scored_tables.append((score, tname, meta))

        scored_tables.sort(key=lambda item: (item[0], item[2].get('rowCount', 0)), reverse=True)
        matched = [item for item in scored_tables if item[0] > 0]
        if not matched:
            # Default core industrial tables when query is generic
            matched = scored_tables[:5]

        scored_recipes = []
        for rec in _JOIN_RECIPES:
            r_score = 0
            rec_haystack = f"{rec.get('title', '')} {rec.get('desc', '')} {rec.get('domain', '')} {' '.join(rec.get('columns') or [])}".lower()
            for tok in tokens:
                if len(tok) >= 4 and tok in rec_haystack:
                    r_score += 2
            if sum(1 for tbl in rec['tables'] if tbl.lower() in low) >= 2:
                r_score += 10
            elif any(tbl in [m[1] for m in matched[:3]] for tbl in rec['tables']):
                r_score += 3
            if r_score > 0:
                scored_recipes.append((r_score, rec))
        scored_recipes.sort(key=lambda item: item[0], reverse=True)

        asks_for_table_help = any(k in low for k in (
            'hangi tablo', 'tablo seç', 'tablolar', 'kararsız', 'hangisi', 'join', 'birleştir',
            'tablo öner', 'veritabanı', 'şema', 'schema', 'kaynak seç'
        ))
        high_matches = [m for m in matched if m[0] >= 4]
        is_ambiguous = asks_for_table_help or (len(high_matches) >= 2 and len(explicit_mentions) != 1) or len(matched) >= 2

        return {
            'candidates': [{'score': s, 'name': n, **m} for s, n, m in matched[:5]],
            'joinRecipes': [r for _, r in scored_recipes[:3]] or _JOIN_RECIPES[:2],
            'explicitMentions': explicit_mentions,
            'asksForTableHelp': asks_for_table_help,
            'isAmbiguous': is_ambiguous,
        }

    def _synthesize_sql_for_tables(ds_id, table_names, user_text='', custom_note='', snapshot=None, recipe_id=None):
        """Synthesize a clean, verified read-only SQL query for 1 or more selected tables (with automatic JOINs)."""
        catalog = _get_live_table_catalog(snapshot or {'sources': []}, ds_id)
        if recipe_id:
            for rec in _JOIN_RECIPES:
                if rec['id'] == recipe_id:
                    base_sql = rec['sql']
                    return _apply_custom_sql_modifiers(base_sql, custom_note, user_text), (rec.get('title') or rec.get('label') or rec['id']), rec['tables']

        clean_tables = []
        for t in table_names or []:
            for kt in catalog.keys():
                if kt.lower() == str(t).strip().lower() and kt not in clean_tables:
                    clean_tables.append(kt)
            if str(t).strip() and str(t).strip() not in clean_tables and all(kt.lower() != str(t).strip().lower() for kt in catalog.keys()):
                clean_tables.append(str(t).strip())

        if not clean_tables:
            clean_tables = ['production_batches']

        # Check if exact table pair matches one of our curated JOIN recipes
        tset = {t.lower() for t in clean_tables}
        for rec in _JOIN_RECIPES:
            rset = {rt.lower() for rt in rec['tables']}
            if len(clean_tables) >= 2 and (tset == rset or rset.issubset(tset)):
                sql = _apply_custom_sql_modifiers(rec['sql'], custom_note, user_text)
                return sql, (rec.get('title') or rec.get('label') or rec['id']), clean_tables

        # Special 3-table C_POINT + C_POINT_PATH_ELEMENT + C_PATH_ELEMENT hierarchy join
        if tset.issubset({'c_point', 'c_path_element', 'c_point_path_element', 'machine_telemetry_timeseries'}) and len(clean_tables) >= 2:
            if 'c_path_element' in tset or 'c_point_path_element' in tset:
                sql = (
                    "SELECT p.POINT_ID, p.POINT_NAME, p.POINT_TYPE, p.UNIT, p.MIN_VAL, p.MAX_VAL, "
                    "pe.PATH_ID, pe.PATH_ELEMENT_NAME, pe.PATH_LEVEL, pe.PARENT_PATH_ID "
                    "FROM C_POINT p "
                    "JOIN C_POINT_PATH_ELEMENT ppe ON p.POINT_ID = ppe.POINT_ID "
                    "JOIN C_PATH_ELEMENT pe ON ppe.PATH_ID = pe.PATH_ID "
                    "ORDER BY p.POINT_ID, pe.PATH_ID"
                )
                return _apply_custom_sql_modifiers(sql, custom_note, user_text), "C_POINT + Path Hiyerarşi JOIN Sorgusu", clean_tables

        if len(clean_tables) == 1:
            t0 = clean_tables[0]
            cols = (catalog.get(t0) or {}).get('columns') or ['*']
            col_list = ', '.join(cols[:10]) if cols else '*'
            order_col = cols[0] if cols and cols[0] != '*' else '1'
            sql = f"SELECT {col_list}\nFROM {t0}\nORDER BY {order_col} DESC\nLIMIT 250"
            return _apply_custom_sql_modifiers(sql, custom_note, user_text), f"{t0} Veri Sorgusu", clean_tables

        # Generic multi-table automatic JOIN builder using shared or known foreign keys
        primary = clean_tables[0]
        p_alias = 't1'
        p_cols = (catalog.get(primary) or {}).get('columns') or []
        select_parts = [f"{p_alias}.{c}" for c in p_cols[:6]] if p_cols else [f"{p_alias}.*"]
        join_clauses = []
        used_cols = set(c.lower() for c in p_cols[:6])

        known_fk_pairs = [
            ('batch_id', 'batch_id'),
            ('machine_id', 'machine_id'),
            ('machine_id', 'asset_id'),
            ('asset_id', 'machine_id'),
            ('POINT_ID', 'POINT_ID'),
            ('POINT_ID', 'sensor_id'),
            ('PATH_ID', 'PATH_ID'),
            ('plant_area', 'plant_area'),
            ('product_code', 'product_code'),
            ('line_id', 'line_id'),
            ('line_id', 'asset_id'),
        ]

        for idx, other in enumerate(clean_tables[1:], start=2):
            alias = f"t{idx}"
            o_cols = (catalog.get(other) or {}).get('columns') or []
            for oc in o_cols[:5]:
                if oc.lower() not in used_cols:
                    select_parts.append(f"{alias}.{oc}")
                    used_cols.add(oc.lower())
                else:
                    select_parts.append(f"{alias}.{oc} AS {other.lower()[:6]}_{oc}")

            join_cond = None
            for lk, rk in known_fk_pairs:
                if lk in p_cols and rk in o_cols:
                    if lk == 'POINT_ID' and rk == 'sensor_id':
                        join_cond = f"{alias}.sensor_id LIKE ('%' || {p_alias}.POINT_ID)"
                    else:
                        join_cond = f"{p_alias}.{lk} = {alias}.{rk}"
                    break
            if not join_cond:
                shared = [c for c in p_cols if c in o_cols]
                if shared:
                    join_cond = f"{p_alias}.{shared[0]} = {alias}.{shared[0]}"
                else:
                    join_cond = "1=1"
            join_clauses.append(f"LEFT JOIN {other} {alias} ON {join_cond}")

        sql = (
            f"SELECT {', '.join(select_parts[:12])}\n"
            f"FROM {primary} {p_alias}\n"
            + "\n".join(join_clauses)
            + "\nLIMIT 250"
        )
        label = f"{' + '.join(clean_tables)} Birleşik (JOIN) Sorgusu"
        return _apply_custom_sql_modifiers(sql, custom_note, user_text), label, clean_tables

    def _apply_custom_sql_modifiers(sql_text, custom_note='', user_text=''):
        """Apply optional filter hints or LIMIT adjustments from user's custom note without breaking SQL validity."""
        sql = (sql_text or '').strip().rstrip(';')
        note = (custom_note or '').strip()
        if not note:
            return sql
        low_note = note.lower()
        # If user typed a raw WHERE condition or filter keyword like "Line-A", "OEE > 80", etc.
        extra_filters = []
        for line_code in ('line-a', 'line-b', 'line-c', 'line-d'):
            if line_code in low_note and 'line_id' in sql.lower():
                extra_filters.append(f"line_id = '{line_code.upper()}'")
        m_oee = re.search(r'oee\s*([><=]+)\s*(\d+(?:\.\d+)?)', low_note)
        if m_oee and 'oee_percentage' in sql.lower():
            extra_filters.append(f"oee_percentage {m_oee.group(1)} {m_oee.group(2)}")
        if extra_filters and 'where ' not in sql.lower() and 'group by' not in sql.lower():
            order_idx = sql.upper().find('\nORDER BY')
            limit_idx = sql.upper().find('\nLIMIT')
            split_at = min([i for i in (order_idx, limit_idx, len(sql)) if i != -1])
            sql = sql[:split_at] + "\nWHERE " + " AND ".join(extra_filters) + sql[split_at:]
        return sql

    def _synthesize_python_for_query(q_info, extra_metrics=False):
        """Generate an AST-validated SuperNova Python sandbox script for a given query."""
        qname = q_info.get('queryName') or q_info['queryId']
        cols = q_info['columns']
        num_cols = q_info['numericColumns']
        txt_cols = q_info['textColumns']
        group_col = txt_cols[0] if txt_cols else (cols[0] if cols else 'id')
        metric_col = num_cols[0] if num_cols else (cols[-1] if cols else 'value')
        second_metric = num_cols[1] if len(num_cols) > 1 else metric_col

        if extra_metrics:
            return (
                f"rows = sql_data.get({repr(qname)}, [])\n"
                f"grouped = {{}}\n"
                f"for r in rows:\n"
                f"    key = str(r.get('{group_col}') or 'Bilinmeyen')\n"
                f"    val = float(r.get('{metric_col}', 0) or 0)\n"
                f"    val2 = float(r.get('{second_metric}', 0) or 0)\n"
                f"    if key not in grouped:\n"
                f"        grouped[key] = {{'count': 0, 'sum': 0.0, 'min': val, 'max': val, 'sum2': 0.0}}\n"
                f"    bucket = grouped[key]\n"
                f"    bucket['count'] = bucket['count'] + 1\n"
                f"    bucket['sum'] = bucket['sum'] + val\n"
                f"    bucket['sum2'] = bucket['sum2'] + val2\n"
                f"    if val < bucket['min']:\n"
                f"        bucket['min'] = val\n"
                f"    if val > bucket['max']:\n"
                f"        bucket['max'] = val\n\n"
                f"for key, b in grouped.items():\n"
                f"    cnt = b['count'] or 1\n"
                f"    avg_val = round(b['sum'] / cnt, 2)\n"
                f"    spread = round(b['max'] - b['min'], 2)\n"
                f"    out('analiz_ozeti').append({{\n"
                f"        '{group_col}': key,\n"
                f"        'KAYIT_SAYISI': b['count'],\n"
                f"        'ORT_{metric_col.upper()}': avg_val,\n"
                f"        'MIN_{metric_col.upper()}': round(b['min'], 2),\n"
                f"        'MAX_{metric_col.upper()}': round(b['max'], 2),\n"
                f"        'ARALIK_FARK': spread,\n"
                f"        'TOPLAM_{second_metric.upper()}': round(b['sum2'], 2),\n"
                f"    }})"
            )
        return (
            f"rows = sql_data.get({repr(qname)}, [])\n"
            f"for r in rows:\n"
            f"    val = float(r.get('{metric_col}', 0) or 0)\n"
            f"    out('sonuc').append({{\n"
            f"        '{group_col}': r.get('{group_col}'),\n"
            f"        '{metric_col}': round(val, 2),\n"
            f"        'DURUM': 'NORMAL' if val >= 0 else 'DIKKAT',\n"
            f"    }})"
        )

    def _synthesize_path_for_query(q_info, alt_mode=False):
        """Generate a validated Space Map PathDef JSON for a given query."""
        qid = q_info['queryId']
        cols = q_info['columns']
        txt_cols = q_info['textColumns']
        num_cols = q_info['numericColumns']

        id_col = next((c for c in cols if c.upper() in ('ASSET_ID', 'PATH_ID', 'NODE_ID', 'POINT_ID', 'ID', 'BATCH_ID')), cols[0])
        parent_col = next((c for c in cols if 'PARENT' in c.upper()), None)
        label_col = next((c for c in cols if any(k in c.upper() for k in ('NAME', 'LABEL', 'PRODUCT', 'ELEMENT'))), txt_cols[0] if txt_cols else cols[0])
        status_col = next((c for c in cols if any(k in c.upper() for k in ('STATUS', 'SEVERITY', 'RESULT', 'UNIT', 'SHIFT'))), None)
        val_col = num_cols[0] if num_cols else None

        if parent_col and not alt_mode:
            structure = 'tree'
            inner = {'id_col': id_col, 'parent_col': parent_col, 'label_col': label_col}
        elif len(txt_cols) >= 2 and not alt_mode:
            structure = 'multi_level'
            inner = {
                'id_col': id_col,
                'level1_col': txt_cols[0],
                'level2_col': txt_cols[1],
                'level3_col': txt_cols[2] if len(txt_cols) > 2 else id_col,
                'label_col': label_col,
            }
        else:
            structure = 'grouped'
            grp_col = txt_cols[0] if txt_cols else cols[0]
            inner = {'group_col': grp_col, 'id_col': id_col, 'label_col': label_col}

        if status_col:
            inner['status_col'] = status_col
        if val_col:
            inner['badge_col'] = val_col

        return {
            'name': f"{q_info['queryName'][:40]} Space Map",
            'queryId': qid,
            'structure': structure,
            'config': inner,
            **inner,
        }

    def _build_table_disambiguation_dialog(user_text, discovery, context=None, is_companion=False):
        """Construct an interactive table & JOIN disambiguation dialog with schema metadata."""
        candidates = discovery.get('candidates') or []
        recipes = discovery.get('joinRecipes') or []
        ds_id = (context or {}).get('data_source_id') or 'ds_apex_factory'
        page = (context or {}).get('page') or 'dashboard'

        default_target = 'auto'
        if page in ('template-builder', 'reports'):
            default_target = 'report'
        elif page in ('query-creator', 'table-explorer'):
            default_target = 'sql'
        elif page in ('network-map', 'path-definer'):
            default_target = 'spacemap'
        elif page in ('python-engine', 'python-workspace'):
            default_target = 'python'
        elif any(k in (user_text or '').lower() for k in ('rapor', 'excel', 'template', 'grafik', 'tablo oluştur')):
            default_target = 'report'

        options = []
        # 1. Put the top recommended multi-table JOIN recipe first if relevant
        for idx, rec in enumerate(recipes[:2]):
            rec_title = rec.get('title') or rec.get('label') or rec['id']
            options.append({
                'id': rec['id'],
                'label': rec_title if rec_title.startswith('🔗') else f"🔗 {rec_title}",
                'description': rec.get('desc') or rec.get('description') or '',
                'badge': rec.get('badge') or f"{len(rec['tables'])} TABLO JOIN",
                'icon': 'fa-link',
                'tables': rec['tables'],
                'queryId': rec.get('queryId') or rec.get('defaultQueryId') or '',
                'dataSourceId': rec.get('dataSourceId') or ds_id,
                'columns': (rec.get('columns') or rec.get('tables') or [])[:8],
                'actionType': 'table_join',
                'prompt': f"{' ve '.join(rec['tables'])} tablolarını JOIN yaparak analiz et.",
                'recommended': idx == 0 and not is_companion,
            })

        # 2. Add individual candidate database tables (multi-selectable so user can combine any 2+ tables!)
        for idx, tbl in enumerate(candidates[:5]):
            tname = tbl['name']
            cols = tbl.get('columns') or []
            row_cnt = tbl.get('rowCount') or 0
            tbl_title = tbl.get('title') or tname
            options.append({
                'id': f"tbl_{tname}",
                'label': f"🗄️ {tbl_title}" if tname in tbl_title else f"🗄️ {tname} — {tbl_title}",
                'description': tbl.get('desc') or tbl.get('description') or f"{tname} tablosu",
                'badge': f"{row_cnt:,} satır".replace(',', '.'),
                'icon': tbl.get('icon') or 'fa-table',
                'tables': [tname],
                'queryId': tbl.get('defaultQueryId') or '',
                'dataSourceId': tbl.get('dataSourceId') or ds_id,
                'columns': cols[:8],
                'rowCount': row_cnt,
                'actionType': 'table_select',
                'prompt': f"{tname} tablosunu ({', '.join(cols[:5])}) kullan.",
                'recommended': idx == 0 and not recipes,
            })

        title = (
            '🔄 Tablo Değiştir veya Çoklu Tablo (JOIN) Birleştir'
            if is_companion
            else '🧭 Hangi Tablo veya JOIN Kombinasyonu ile Çalışalım?'
        )
        prompt = (
            'Bu analiz için veritabanında birden fazla uygun tablo tespit ettim. '
            'Tek bir tablo seçebilir, **birden fazla tabloyu işaretleyerek otomatik JOIN** yaptırabilir '
            'veya hazır birleştirilmiş (JOIN) veri setlerinden birini seçebilirsiniz:'
        )
        return {
            'id': f"dlg_tbl_{uuid.uuid4().hex[:8]}",
            'dialogType': 'table_disambiguation',
            'title': title,
            'prompt': prompt,
            'multiSelect': True,
            'targetAction': default_target,
            'dataSourceId': ds_id,
            'options': options,
        }

    def _evaluate_user_selection(messages, context, snapshot):
        """
        Deterministically evaluate user's interactive dialog choice (`context['user_selection']`
        or explicit follow-up message) and populate `_short_circuit_answer`, `_forced_proposal`,
        and `_forced_dialog` on `context`.
        """
        sel = context.get('user_selection')
        user_text = (messages[-1]['content'] if messages else '').strip()
        low_text = user_text.lower()
        ds_id = context.get('data_source_id') or 'ds_apex_factory'
        page = context.get('page') or 'dashboard'

        # Also detect when user clicked or typed one of the standard option prompts without structured `user_selection`
        if not isinstance(sel, dict):
            inferred_ids = []
            if 'bu sql sorgusunu kullanarak grafik ve özet kpi içeren bir excel raporu' in low_text:
                inferred_ids.append('sql_to_report')
            elif 'bu sql sorgusuna parametreli tarih/filtre koşulları ekle' in low_text:
                inferred_ids.append('sql_add_filter')
            elif 'bu sorguyu veritabanındaki ilişkili diğer tablolarla join yaparak' in low_text:
                inferred_ids.append('sql_join_more')
            elif 'q_ind_production_oee sorgusundaki gerçek oee' in low_text:
                inferred_ids.append('use_oee_query')
            elif 'q_ind_cpoint_values sorgusundaki c_point' in low_text:
                inferred_ids.append('use_cpoint_query')
            elif 'mevcut tablo ve sorgulardaki var olan kolonları kullanarak' in low_text:
                inferred_ids.append('use_existing_cols')
            elif 'evet, önerdiğin şekilde veritabanı sorgusunu ve excel rapor' in low_text:
                inferred_ids.append('confirm_yes')
            elif 'önce ilgili tabloları birleştiren salt okunur sql sorgusunu' in low_text:
                inferred_ids.append('write_sql_first')
            elif 'bu verileri analiz eden bir python sandbox scripti yaz' in low_text:
                inferred_ids.append('write_py_first')
            if inferred_ids:
                sel = {'selectedOptionIds': inferred_ids, 'targetAction': 'auto'}

        if not isinstance(sel, dict):
            return False

        opt_ids = [str(x) for x in (sel.get('selectedOptionIds') or []) if x]
        sel_tables = [str(t) for t in (sel.get('selectedTables') or []) if t]
        target_action = (sel.get('targetAction') or 'auto').lower()
        custom_note = (sel.get('customText') or '').strip()
        prev_sql = (sel.get('previousSql') or '').strip()
        prev_qid = (sel.get('previousQueryId') or '').strip()

        # Extract previous SQL from assistant messages if not explicitly passed
        if not prev_sql:
            for m in reversed(messages[:-1]):
                if m.get('role') == 'assistant':
                    m_sql = re.search(r'```sql\s*\n([\s\S]*?)```', m.get('content') or '', re.IGNORECASE)
                    if m_sql:
                        prev_sql = m_sql.group(1).strip()
                        break

        # ── CASE 1: Table / Multi-Table JOIN Selection (`tbl_*` / `join_*` / `selectedTables`) ──
        recipe_id = next((oid for oid in opt_ids if oid.startswith('join_')), None)
        for oid in opt_ids:
            if oid.startswith('tbl_'):
                tname = oid[4:]
                if tname and tname not in sel_tables:
                    sel_tables.append(tname)

        if recipe_id or sel_tables:
            sql_text, query_label, used_tables = _synthesize_sql_for_tables(
                ds_id=ds_id,
                table_names=sel_tables,
                user_text=user_text,
                custom_note=custom_note,
                snapshot=snapshot,
                recipe_id=recipe_id if len(sel_tables) <= 1 else None,
            )
            q_info = _execute_query_live(
                ds_id=ds_id,
                sql_text=sql_text,
                query_name=f"[Copilot] {query_label}",
                create_if_missing=True,
            )
            if not q_info or not q_info.get('columns'):
                # Fallback to a known query if custom join had any issue
                fallback_qid = 'q_ind_cpoint_values' if any('point' in t.lower() for t in used_tables) else 'q_ind_production_oee'
                q_info = _execute_query_live(qid=fallback_qid)

            if q_info and q_info.get('columns'):
                # Decide target action when set to 'auto'
                resolved_action = target_action
                if resolved_action == 'auto':
                    if page in ('network-map', 'path-definer') or any(k in low_text for k in ('space map', 'spacemap', 'topoloji', 'hiyerarşi', 'path')):
                        resolved_action = 'spacemap'
                    elif page in ('python-engine', 'python-workspace') or any(k in low_text for k in ('python', 'script')):
                        resolved_action = 'python'
                    elif page in ('query-creator', 'table-explorer') and not any(k in low_text for k in ('rapor', 'excel', 'template')):
                        resolved_action = 'sql'
                    else:
                        resolved_action = 'report'

                join_badge = (
                    f"**Çoklu Tablo (JOIN):** `{', '.join(used_tables)}`"
                    if len(used_tables) > 1
                    else f"**Seçilen Tablo:** `{used_tables[0]}`"
                )
                note_line = f"\n• **Ek Filtre / Not:** `{custom_note}`" if custom_note else ""

                if resolved_action == 'spacemap':
                    path_cfg = _synthesize_path_for_query(q_info)
                    context['_short_circuit_answer'] = (
                        f"✅ Seçiminizi değerlendirdim ({join_badge}). Veritabanında sorguyu oluşturup doğruladım "
                        f"(**{q_info['rowCount']} satır**) ve **Space Map / Path Definer** yapılandırmasını hazırladım:{note_line}\n\n"
                        f"```json\n{json.dumps(path_cfg, ensure_ascii=False, indent=2)}\n```\n\n"
                        f"Aşağıdaki **Space Map'e Uygula** butonuna tıklayarak topolojiyi anında görselleştirebilir veya aynı veriden Excel raporu üretebilirsiniz."
                    )
                    return True

                if resolved_action == 'python':
                    py_code = _synthesize_python_for_query(q_info, extra_metrics=True)
                    context['_short_circuit_answer'] = (
                        f"✅ Seçiminizi değerlendirdim ({join_badge}). `{q_info['queryName']}` sorgusunu (**{q_info['rowCount']} satır**) "
                        f"bağlayarak **Python Workspace** analiz scriptini hazırladım:{note_line}\n\n"
                        f"```python\n{py_code}\n```"
                    )
                    return True

                if resolved_action == 'sql':
                    cols_preview = ', '.join(q_info['columns'][:8])
                    context['_short_circuit_answer'] = (
                        f"✅ Seçtiğiniz tabloları değerlendirdim ({join_badge}) ve canlı veritabanında doğruladım:\n\n"
                        f"• **Kayıtlı Sorgu:** `{q_info['queryName']}` (`{q_info['queryId']}`)\n"
                        f"• **Dönen Kayıt Sayısı:** **{q_info['rowCount']} satır**\n"
                        f"• **Kolonlar ({len(q_info['columns'])}):** `{cols_preview}`{note_line}\n\n"
                        f"```sql\n{q_info['sql']}\n```"
                    )
                    return True

                # Default / 'report': Build interactive Excel Report Proposal + SQL preview!
                mem_pref = (context.get('user_memory') or {}).get('preferred_chart_type') if isinstance(context.get('user_memory'), dict) else None
                chart_cfg, summaries, selected_cols = _build_query_proposal_fields(
                    q_info, None, query_label + ' ' + user_text, preferred_chart=mem_pref
                )
                report_name = _infer_report_name(query_label + ' ' + user_text, q_info, chart_cfg.get('title'))
                checked_sums = [f"{s['operation']}({s['field']}) = {s['value']}" for s in summaries if s.get('checked')]
                sum_str = ', '.join(checked_sums[:4]) if checked_sums else 'Yok'

                context['_forced_proposal'] = {
                    'reportName': report_name,
                    'queryId': q_info['queryId'],
                    'queryName': q_info['queryName'],
                    'dataSourceId': q_info['dataSourceId'],
                    'dataSourceName': q_info['dataSourceName'],
                    'sql': q_info['sql'],
                    'rowCount': q_info['rowCount'],
                    'columns': q_info['columns'],
                    'selectedColumns': selected_cols,
                    'previewRows': q_info['previewRows'],
                    'includeDetailTable': True,
                    'chart': chart_cfg,
                    'summaries': summaries,
                    'candidateQueries': [
                        {'id': sq['id'], 'name': sq['name'], 'columns': sq['columns']}
                        for sq in (snapshot.get('queries') or [])[:4] if sq.get('columns')
                    ],
                }
                context['_short_circuit_answer'] = (
                    f"✅ Seçtiğiniz tablo yapılandırmasını değerlendirdim ({join_badge}) ve **{report_name}** şablonunu canlı verilerle hazırladım:{note_line}\n\n"
                    f"• **Veri Kaynağı:** `{q_info['dataSourceName']}`\n"
                    f"• **Oluşturulan Sorgu:** `{q_info['queryName']}` (**{q_info['rowCount']} satır** doğrulandı)\n"
                    f"• **Seçili Kolonlar ({len(selected_cols)}):** `{', '.join(selected_cols[:6])}`\n"
                    f"• **Özet KPI Değerleri:** {sum_str}\n\n"
                    f"```sql\n{q_info['sql']}\n```\n\n"
                    f"Aşağıdaki rapor kartından kolonları/grafiği özelleştirip **Raporu Oluştur & Çalıştır (Execute)** butonuna tıklayabilirsiniz."
                )
                return True

        # ── CASE 2: Follow-up & Clarification Option Evaluation ──
        primary_opt = opt_ids[0] if opt_ids else ''

        if primary_opt in ('sql_to_report', 'py_to_report', 'path_report', 'confirm_yes', 'use_existing_cols', 'use_oee_query', 'use_cpoint_query'):
            target_qid = prev_qid
            if primary_opt == 'use_oee_query':
                target_qid = 'q_ind_production_oee'
            elif primary_opt == 'use_cpoint_query':
                target_qid = 'q_ind_cpoint_values'

            q_info = None
            if prev_sql and primary_opt == 'sql_to_report':
                q_info = _execute_query_live(
                    ds_id=ds_id,
                    sql_text=prev_sql,
                    query_name=f"[Copilot] {_infer_report_name(user_text, {})}",
                    create_if_missing=True,
                )
            if not q_info and target_qid:
                q_info = _execute_query_live(qid=target_qid)
            if not q_info:
                for aq in context.get('active_queries') or []:
                    aq_id = aq.get('id') if isinstance(aq, dict) else aq
                    q_info = _execute_query_live(qid=aq_id)
                    if q_info and q_info.get('columns'):
                        break
            if not q_info:
                q_info = _execute_query_live(qid='q_ind_production_oee')

            if q_info and q_info.get('columns'):
                mem_pref = (context.get('user_memory') or {}).get('preferred_chart_type') if isinstance(context.get('user_memory'), dict) else None
                chart_cfg, summaries, selected_cols = _build_query_proposal_fields(
                    q_info, None, user_text, preferred_chart=mem_pref
                )
                report_name = _infer_report_name(user_text, q_info, chart_cfg.get('title'))
                checked_sums = [f"{s['operation']}({s['field']}) = {s['value']}" for s in summaries if s.get('checked')]
                sum_str = ', '.join(checked_sums[:4]) if checked_sums else 'Yok'
                context['_forced_proposal'] = {
                    'reportName': report_name,
                    'queryId': q_info['queryId'],
                    'queryName': q_info['queryName'],
                    'dataSourceId': q_info['dataSourceId'],
                    'dataSourceName': q_info['dataSourceName'],
                    'sql': q_info['sql'],
                    'rowCount': q_info['rowCount'],
                    'columns': q_info['columns'],
                    'selectedColumns': selected_cols,
                    'previewRows': q_info['previewRows'],
                    'includeDetailTable': True,
                    'chart': chart_cfg,
                    'summaries': summaries,
                    'candidateQueries': [
                        {'id': sq['id'], 'name': sq['name'], 'columns': sq['columns']}
                        for sq in (snapshot.get('queries') or [])[:4] if sq.get('columns')
                    ],
                }
                context['_short_circuit_answer'] = (
                    f"📊 Seçiminiz doğrultusunda **`{q_info['queryName']}`** sorgusunu çalıştırdım (**{q_info['rowCount']} satır**) "
                    f"ve **{report_name}** Excel şablonunu hazırladım:\n\n"
                    f"• **Tablo Kolonları ({len(selected_cols)}):** `{', '.join(selected_cols[:6])}`\n"
                    f"• **Özet KPI Değerleri:** {sum_str}\n"
                    f"• **Grafik:** `{chart_cfg['title']}` ({chart_cfg['type'].upper()})\n\n"
                    f"Aşağıdaki interaktif rapor panelinden **Raporu Oluştur & Çalıştır (Execute)** diyerek Excel raporunu hemen açabilirsiniz."
                )
                return True

        if primary_opt == 'sql_add_filter':
            base_sql = prev_sql or "SELECT batch_id, product_name, line_id, shift_name, produced_qty, oee_percentage, start_time\nFROM production_batches\nORDER BY start_time DESC\nLIMIT 200"
            clean_sql = base_sql.strip().rstrip(';')
            # Detect a date/time or status column to filter on
            filter_clause = "1=1"
            for dcol in ('start_time', 'recorded_at', 'inspected_at', 'reading_date'):
                if dcol in clean_sql.lower():
                    filter_clause = f"{dcol} >= COALESCE(:start_date, '2025-01-01') AND {dcol} <= COALESCE(:end_date, '2026-12-31')"
                    break
            if filter_clause == "1=1":
                if 'min_val' in clean_sql.lower():
                    filter_clause = "MIN_VAL >= COALESCE(:min_threshold, 0)"
                elif 'oee_percentage' in clean_sql.lower():
                    filter_clause = "oee_percentage >= COALESCE(:min_oee, 75)"
            if custom_note:
                clean_sql = _apply_custom_sql_modifiers(clean_sql, custom_note, user_text)
            if 'where ' in clean_sql.lower():
                clean_sql = re.sub(r'(?i)\bWHERE\b', f"WHERE ({filter_clause}) AND ", clean_sql, count=1)
            else:
                idx_split = min([i for i in (clean_sql.upper().find('\nGROUP BY'), clean_sql.upper().find('\nORDER BY'), clean_sql.upper().find('\nLIMIT'), len(clean_sql)) if i != -1])
                clean_sql = clean_sql[:idx_split] + f"\nWHERE {filter_clause}" + clean_sql[idx_split:]

            context['_short_circuit_answer'] = (
                f"✅ Seçiminiz üzerine SQL sorgusuna parametreli filtre koşullarını (`{filter_clause}`) ekledim:\n\n"
                f"```sql\n{clean_sql}\n```\n\n"
                f"**SQL Studio'ya Gönder** ile sorguyu editörde açabilir veya aşağıdaki seçeneklerle hemen Excel raporuna dönüştürebilirsiniz."
            )
            return True

        if primary_opt == 'sql_join_more':
            # Inspect which tables are already in prev_sql and offer related tables to JOIN!
            used = [t for t in _DOMAIN_TABLE_CATALOG.keys() if t.lower() in (prev_sql or '').lower()]
            discovery = _discover_candidate_tables(user_text + ' ' + (prev_sql or ''), snapshot, context, exclude_tables=used)
            dlg = _build_table_disambiguation_dialog(user_text, discovery, context, is_companion=False)
            dlg['title'] = '🔗 Mevcut Sorguya Hangi Tabloları JOIN Yapalım?'
            dlg['prompt'] = (
                f"Mevcut sorguda `{', '.join(used) if used else 'temel tablo'}` kullanılıyor. "
                f"Birleştirmek (JOIN) istediğiniz ek tabloları veya hazır JOIN paketini seçin:"
            )
            if used:
                for opt in dlg.get('options') or []:
                    if opt.get('actionType') == 'table_select':
                        opt['tables'] = used + [t for t in (opt.get('tables') or []) if t not in used]
                        opt['badge'] = f"{len(opt['tables'])} TABLO JOIN"
            context['_forced_dialog'] = dlg
            context['_short_circuit_answer'] = (
                f"🔗 Mevcut SQL sorgunuzu (`{', '.join(used) if used else 'aktif sorgu'}`) zenginleştirmek için "
                f"veritabanındaki ilişkili tabloları analiz ettim. Aşağıdaki karttan **birleştirmek istediğiniz tabloyu veya çoklu JOIN seçeneğini** işaretleyin:"
            )
            return True

        if primary_opt in ('sql_to_spacemap', 'path_alt'):
            q_info = None
            if prev_sql:
                q_info = _execute_query_live(ds_id=ds_id, sql_text=prev_sql, query_name="[Copilot] Space Map Sorgusu", create_if_missing=True)
            if not q_info and prev_qid:
                q_info = _execute_query_live(qid=prev_qid)
            if not q_info:
                for aq in context.get('active_queries') or []:
                    q_info = _execute_query_live(qid=aq.get('id') if isinstance(aq, dict) else aq)
                    if q_info and q_info.get('columns'):
                        break
            if not q_info:
                q_info = _execute_query_live(qid='q_ind_asset_tree')
            if q_info and q_info.get('columns'):
                path_cfg = _synthesize_path_for_query(q_info, alt_mode=(primary_opt == 'path_alt'))
                context['_short_circuit_answer'] = (
                    f"🪐 `{q_info['queryName']}` sorgusundaki gerçek kolonları (`{', '.join(q_info['columns'][:6])}`) kullanarak "
                    f"**{path_cfg['structure'].upper()}** tipinde Space Map / Path Definer yapılandırmasını hazırladım:\n\n"
                    f"```json\n{json.dumps(path_cfg, ensure_ascii=False, indent=2)}\n```\n\n"
                    f"**Space Map'e Uygula** butonuna tıklayarak haritayı anında açabilirsiniz."
                )
                return True

        if primary_opt in ('py_add_metrics', 'write_py_first'):
            q_info = _execute_query_live(qid=prev_qid) if prev_qid else None
            if not q_info:
                for aq in context.get('active_queries') or []:
                    q_info = _execute_query_live(qid=aq.get('id') if isinstance(aq, dict) else aq)
                    if q_info and q_info.get('columns'):
                        break
            if not q_info:
                q_info = _execute_query_live(qid='q_ind_production_oee')
            if q_info and q_info.get('columns'):
                py_code = _synthesize_python_for_query(q_info, extra_metrics=True)
                context['_short_circuit_answer'] = (
                    f"🐍 `{q_info['queryName']}` sorgusu için min, max, ortalama ve aralık farkı (spread) metriklerini hesaplayan "
                    f"gelişmiş **Python Workspace** scriptini hazırladım:\n\n"
                    f"```python\n{py_code}\n```"
                )
                return True

        if primary_opt == 'write_sql_first':
            discovery = _discover_candidate_tables(user_text, snapshot, context)
            top_tables = [c['name'] for c in (discovery.get('candidates') or [])[:2]] or ['production_batches']
            sql_text, label, used_tables = _synthesize_sql_for_tables(ds_id, top_tables, user_text, custom_note, snapshot)
            q_info = _execute_query_live(ds_id=ds_id, sql_text=sql_text, query_name=f"[Copilot] {label}", create_if_missing=True)
            row_cnt = q_info['rowCount'] if q_info else 0
            context['_short_circuit_answer'] = (
                f"🔍 `{', '.join(used_tables)}` tablolarını birleştiren salt-okunur SQL sorgusunu hazırladım ve doğruladım (**{row_cnt} satır**):\n\n"
                f"```sql\n{sql_text}\n```"
            )
            return True

        return False

    def _build_interactive_dialog(user_text, assistant_text, context, snapshot):
        """Build an interactive follow-up question / decision dialog or Table Disambiguation wizard."""
        if context.get('_forced_dialog'):
            return context['_forced_dialog']

        text = (assistant_text or '').strip()
        if not text:
            return None
        low = text.lower()
        low_user = (user_text or '').lower()
        has_sql = bool(re.search(r'```sql\b', text, re.IGNORECASE))
        has_py = bool(re.search(r'```(?:python|py)\b', text, re.IGNORECASE))
        has_path = '"structure"' in text and any(s in text for s in ('"tree"', '"dag"', '"sequence"', '"grouped"', '"binary_tree"', '"multi_level"'))
        has_question = '?' in text or any(k in low for k in ('eksik', 'bulunmuyor', 'ister misiniz', 'yapayım mı', 'hangisi', 'seçin', 'kararsız'))

        # Extract SQL if present so follow-up actions know the exact SQL
        sql_match = re.search(r'```sql\s*\n([\s\S]*?)```', text, re.IGNORECASE)
        extracted_sql = sql_match.group(1).strip() if sql_match else ''

        # If user explicitly asks about which tables to use or Copilot is asking a table question, return Table Disambiguation Dialog!
        discovery = _discover_candidate_tables(user_text + ' ' + text, snapshot, context)
        if discovery.get('asksForTableHelp') or (has_question and any(k in low for k in ('tablo', 'table', 'join', 'kaynak', 'şema'))):
            return _build_table_disambiguation_dialog(user_text, discovery, context, is_companion=False)

        if has_sql:
            return {
                'id': f"dlg_sql_{uuid.uuid4().hex[:8]}",
                'dialogType': 'followup',
                'title': 'SQL Sorgusu Hazır — Nasıl Devam Edelim?',
                'prompt': 'Hazırlanan SQL sorgusu ile aşağıdaki işlemlerden hangisini yapmamı istersiniz?',
                'multiSelect': False,
                'options': [
                    {
                        'id': 'sql_to_report',
                        'label': '📊 Bu sorguyla hemen Excel Raporu (Template Builder) hazırla',
                        'description': 'Sorguyu canlı çalıştırır, KPI özetlerini ve grafiğini içeren Excel şablonunu kurar.',
                        'badge': 'TEMPLATE BUILDER',
                        'actionType': 'sql_to_report',
                        'prompt': 'Bu SQL sorgusunu kullanarak grafik ve özet KPI içeren bir Excel raporu oluştur.',
                        'recommended': True,
                    },
                    {
                        'id': 'sql_join_more',
                        'label': '🔗 Başka Tablolarla Birleştir (Tablo Seçici & JOIN Sihirbazı)',
                        'description': 'Veritabanındaki ilişkili tabloları seçerek bu sorguya otomatik LEFT JOIN ekler.',
                        'badge': 'ÇOKLU TABLO JOIN',
                        'actionType': 'sql_join_more',
                        'prompt': 'Bu sorguyu veritabanındaki ilişkili diğer tablolarla JOIN yaparak zenginleştir.',
                    },
                    {
                        'id': 'sql_to_spacemap',
                        'label': '🪐 Bu Sorgudan Space Map Topolojisi (Path Definer) Üret',
                        'description': 'Sorgu kolonlarını analiz ederek çok katmanlı Space Map haritasına dönüştürür.',
                        'badge': 'SPACE MAP',
                        'actionType': 'sql_to_spacemap',
                        'prompt': 'Bu SQL sorgusunu kullanarak Space Map için Path Definer topolojisi oluştur.',
                    },
                    {
                        'id': 'sql_add_filter',
                        'label': '🎛️ Tarih Aralığı ve Dinamik Filtre Parametreleri (:start, :end) Ekle',
                        'description': 'Sorguya parametreli WHERE koşulları ve eşik filtreleri ekler.',
                        'badge': 'FİLTRE',
                        'actionType': 'sql_add_filter',
                        'prompt': 'Bu SQL sorgusuna parametreli tarih/filtre koşulları ekle.',
                    },
                ],
            }
        if has_py:
            return {
                'id': f"dlg_py_{uuid.uuid4().hex[:8]}",
                'dialogType': 'followup',
                'title': 'Python Scripti Hazır — Sonraki Adım',
                'prompt': 'Veri dönüşüm scripti için nasıl devam etmek istersiniz?',
                'multiSelect': False,
                'options': [
                    {
                        'id': 'py_to_report',
                        'label': '📊 Bu verilerle bir Excel Raporu (Template Builder) oluştur',
                        'description': 'Aktif veri kaynağını kullanarak KPI ve grafikli Excel raporu hazırlar.',
                        'badge': 'RAPOR',
                        'prompt': 'Seçili sorguyu kullanarak grafik ve özet KPI hücreleri içeren bir Excel raporu oluştur.',
                        'recommended': True,
                    },
                    {
                        'id': 'py_add_metrics',
                        'label': '📈 Script içine Min / Max / Spread ve Grup Özeti hesapları ekle',
                        'description': 'out() çıktısına grup bazlı min, max, ortalama ve fark analizlerini ekler.',
                        'badge': 'GELİŞMİŞ METRİK',
                        'prompt': 'Scripti geliştirerek min, max ve ağırlıklı oran metriklerini de out() çıktısına ekle.',
                    },
                ],
            }
        if has_path:
            return {
                'id': f"dlg_path_{uuid.uuid4().hex[:8]}",
                'dialogType': 'followup',
                'title': 'Topoloji Yapılandırması Hazır — Sonraki Adım',
                'prompt': 'Path Definer / Space Map hiyerarşisine ek olarak ne yapmak istersiniz?',
                'multiSelect': False,
                'options': [
                    {
                        'id': 'path_report',
                        'label': '📊 Bu hiyerarşi verisiyle bir Excel Özet Raporu da hazırla',
                        'description': 'Space Map verisini Template Builder içinde tablo ve grafik olarak açar.',
                        'badge': 'TEMPLATE BUILDER',
                        'prompt': 'Bu sorgudaki verileri kullanarak Template Builder için grafikli bir Excel raporu oluştur.',
                        'recommended': True,
                    },
                    {
                        'id': 'path_alt',
                        'label': '🔄 Farklı bir topoloji türü (Multi-Level / Tree / Grouped) dene',
                        'description': 'Aynı veri kaynağı için alternatif katman dizilimi oluşturur.',
                        'badge': 'ALTERNATİF YAPI',
                        'prompt': 'Aynı sorgu için alternatif bir Path Definer yapısı öner.',
                    },
                ],
            }

        # When there are multiple candidate tables for the user's topic, proactively present the Table Disambiguation Wizard!
        if discovery.get('isAmbiguous') and len(discovery.get('candidates') or []) >= 2:
            return _build_table_disambiguation_dialog(user_text, discovery, context, is_companion=False)

        if has_question:
            sentences = [s.strip() for s in re.split(r'[\n]+', text) if '?' in s]
            question_prompt = sentences[-1] if sentences else 'Nasıl devam etmemi istersiniz?'
            if any(k in low for k in ('eksik', 'bulunmuyor', 'kolon', 'column', 'oee')):
                return {
                    'id': f"dlg_clarify_{uuid.uuid4().hex[:8]}",
                    'dialogType': 'clarification',
                    'title': 'Eksik Veri / Tablo & Kolon Kararı',
                    'prompt': question_prompt,
                    'multiSelect': False,
                    'options': [
                        {
                            'id': 'use_existing_cols',
                            'label': '✅ Mevcut kolonları kullanarak alternatif bir KPI ve Değer Raporu oluştur',
                            'description': 'Seçili sorgudaki gerçek kolonlarla en uygun Excel özet raporunu kurar.',
                            'badge': 'HIZLI ÇÖZÜM',
                            'prompt': 'Mevcut tablo ve sorgulardaki var olan kolonları kullanarak en uygun Excel özet raporunu ve grafiğini oluştur.',
                            'recommended': True,
                        },
                        {
                            'id': 'use_oee_query',
                            'label': '🏭 Apex Smart Factory Üretim & OEE tablosunu (production_batches) kullan',
                            'description': 'Gerçek OEE, üretilen/sağlam/fire miktarı ve vardiya verilerini içeren tabloya geçer.',
                            'badge': '450 SATIR',
                            'tables': ['production_batches'],
                            'queryId': 'q_ind_production_oee',
                            'prompt': 'q_ind_production_oee sorgusundaki gerçek OEE ve üretim batch kolonlarını kullanarak raporu oluştur.',
                        },
                        {
                            'id': 'use_cpoint_query',
                            'label': '📡 C_Point Sensör Değerleri & Telemetri JOIN sorgusunu kullan',
                            'description': 'C_POINT ve machine_telemetry_timeseries tablolarını birleştiren sensör sorgusuna geçer.',
                            'badge': '2 TABLO JOIN',
                            'tables': ['C_POINT', 'machine_telemetry_timeseries'],
                            'queryId': 'q_ind_cpoint_values',
                            'prompt': 'q_ind_cpoint_values sorgusundaki C_POINT ve telemetri ölçüm değerlerini kullanarak value raporu oluştur.',
                        },
                    ],
                }
            return {
                'id': f"dlg_q_{uuid.uuid4().hex[:8]}",
                'dialogType': 'clarification',
                'title': 'Copilot Sorusu — Seçiminizi Belirtin',
                'prompt': question_prompt,
                'multiSelect': False,
                'options': [
                    {
                        'id': 'confirm_yes',
                        'label': '📊 Evet, önerdiğin şekilde uygula ve Excel raporunu hazırla',
                        'description': 'Önerilen veritabanı sorgusunu çalıştırır ve rapor şablonunu hazırlar.',
                        'badge': 'EXCEL RAPORU',
                        'prompt': 'Evet, önerdiğin şekilde veritabanı sorgusunu ve Excel rapor şablonunu hazırla.',
                        'recommended': True,
                    },
                    {
                        'id': 'write_sql_first',
                        'label': '🔍 Önce veritabanı tablolarını birleştiren SQL sorgusunu yaz',
                        'description': 'İlgili tabloları JOIN yapan salt-okunur SQL sorgusunu üretir.',
                        'badge': 'SQL STUDIO',
                        'prompt': 'Önce ilgili tabloları birleştiren salt okunur SQL sorgusunu oluştur.',
                    },
                    {
                        'id': 'write_py_first',
                        'label': '🐍 Python Workspace için veri analizi scripti hazırla',
                        'description': 'Verileri işleyen güvenli Python sandbox scripti yazar.',
                        'badge': 'PYTHON',
                        'prompt': 'Bu verileri analiz eden bir Python sandbox scripti yaz.',
                    },
                ],
            }
        return None

    @blueprint.get('/status')
    @blueprint.get('/health')
    def status():
        info = dict(gateway.health())
        info['optional'] = True
        info['memory_enabled'] = bool(settings.AI_MEMORY_ENABLED)
        uid = getattr(g, 'uid', None)
        if uid and settings.AI_MEMORY_ENABLED:
            try:
                mem = LocalMemory(get_database())
                info['session_count'] = len(mem.list_sessions(uid, limit=50))
                info['memory_count'] = len(mem.list_memories(uid, limit=40))
            except Exception:
                pass
        return jsonify(info)

    @blueprint.get('/history')
    def list_chat_history():
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        if not settings.AI_MEMORY_ENABLED:
            return jsonify({'success': True, 'data': {'sessions': [], 'memories': []}})
        try:
            mem = LocalMemory(get_database())
            return jsonify({
                'success': True,
                'data': {
                    'sessions': mem.list_sessions(uid, limit=30),
                    'memories': mem.list_memories(uid, limit=25),
                },
            })
        except Exception:
            logger.warning('Could not read optional AI chat history', exc_info=True)
            return jsonify({'success': True, 'data': {'sessions': [], 'memories': []}})

    @blueprint.get('/history/<session_id>')
    def get_chat_session(session_id):
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        if not settings.AI_MEMORY_ENABLED:
            return jsonify({'success': False, 'error': 'Memory disabled.'}), 404
        data = LocalMemory(get_database()).get_session(uid, session_id)
        if not data:
            return jsonify({'success': False, 'error': 'Sohbet kaydı bulunamadı.'}), 404
        return jsonify({'success': True, 'data': data})

    @blueprint.post('/history/<session_id>/meta')
    def sync_chat_session_meta(session_id):
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        if not settings.AI_MEMORY_ENABLED:
            return jsonify({'success': True, 'updated': False})
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({'success': False, 'error': 'Invalid payload.'}), 400
        try:
            mem = LocalMemory(get_database())
            updated = mem.update_last_assistant_meta(uid, session_id, body)
            prop = body.get('reportProposal') if isinstance(body.get('reportProposal'), dict) else None
            if prop and isinstance(prop.get('chart'), dict):
                c_type = prop['chart'].get('type') if prop['chart'].get('include', True) else None
                if c_type in ('bar', 'line', 'pie'):
                    labels = {'bar': 'Çubuk (Bar)', 'line': 'Çizgi (Line)', 'pie': 'Pasta (Pie)'}
                    mem.upsert_memory(
                        uid,
                        'pref:chart_type',
                        'preference',
                        f"Grafik tercihi: {labels[c_type]} Grafik",
                        {'chartType': c_type},
                    )
            return jsonify({'success': True, 'updated': updated})
        except Exception:
            logger.debug('Could not sync session metadata', exc_info=True)
            return jsonify({'success': True, 'updated': False})

    @blueprint.delete('/history/<session_id>')
    def delete_chat_session(session_id):
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        deleted = LocalMemory(get_database()).delete_session(uid, session_id) if settings.AI_MEMORY_ENABLED else False
        return jsonify({'success': True, 'deleted': deleted})

    @blueprint.delete('/history')
    def clear_chat_history():
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        cleared = LocalMemory(get_database()).clear_sessions(uid) if settings.AI_MEMORY_ENABLED else 0
        return jsonify({'success': True, 'cleared': cleared})

    @blueprint.post('/memory')
    def add_user_memory_note():
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        if not settings.AI_MEMORY_ENABLED:
            return jsonify({'success': False, 'error': 'Hafıza devre dışı.'}), 400
        body = request.get_json(silent=True) or {}
        note = (body.get('note') or '').strip() if isinstance(body, dict) else ''
        if not note or len(note) > 240:
            return jsonify({'success': False, 'error': 'Hafıza notu 1-240 karakter olmalıdır.'}), 400
        digest_key = re.sub(r'[^a-z0-9ğüşıöç]+', '_', note.lower())[:48].strip('_') or uuid.uuid4().hex[:8]
        mem = LocalMemory(get_database())
        saved = mem.upsert_memory(uid, f"pref:manual_{digest_key}", 'preference', note, {'note': note})
        # Also detect chart preference if user wrote one in manual note
        low_n = note.lower()
        if any(k in low_n for k in ('çizgi', 'line')):
            mem.upsert_memory(uid, 'pref:chart_type', 'preference', 'Grafik tercihi: Çizgi (Line) Grafik', {'chartType': 'line'})
        elif any(k in low_n for k in ('pasta', 'pie')):
            mem.upsert_memory(uid, 'pref:chart_type', 'preference', 'Grafik tercihi: Pasta (Pie) Grafik', {'chartType': 'pie'})
        elif any(k in low_n for k in ('çubuk', 'sütun', 'bar')):
            mem.upsert_memory(uid, 'pref:chart_type', 'preference', 'Grafik tercihi: Çubuk (Bar) Grafik', {'chartType': 'bar'})
        return jsonify({'success': True, 'data': saved})

    @blueprint.delete('/memory/<int:mem_id>')
    def delete_user_memory_item(mem_id):
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        deleted = LocalMemory(get_database()).delete_memory(uid, mem_id) if settings.AI_MEMORY_ENABLED else False
        return jsonify({'success': True, 'deleted': deleted})

    @blueprint.delete('/memory')
    def clear_user_memories():
        uid = getattr(g, 'uid', None)
        if not uid:
            return jsonify({'success': False, 'error': 'Authentication required.'}), 401
        cleared = LocalMemory(get_database()).clear_memories(uid) if settings.AI_MEMORY_ENABLED else 0
        return jsonify({'success': True, 'cleared': cleared})

    @blueprint.get('/schema')
    def schema():
        return jsonify({'success': True, 'data': schema_snapshot()})

    @blueprint.post('/artifacts/validate')
    def validate_artifact():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({'success': False, 'error': 'Invalid request.'}), 400
        kind, artifact = body.get('kind'), body.get('artifact')
        try:
            if kind == 'python':
                validated = validate_python(artifact)
            elif kind == 'path':
                if not has_permission('page:network-map'):
                    return jsonify({'success': False, 'error': 'Forbidden.'}), 403
                validated = validate_path(artifact, schema_snapshot()['queries'])
            elif kind == 'template':
                if not has_permission('page:template-builder'):
                    return jsonify({'success': False, 'error': 'Forbidden.'}), 403
                validated = validate_template(artifact, schema_snapshot()['queries'])
            elif kind == 'admin':
                if not has_permission('page:admin'):
                    return jsonify({'success': False, 'error': 'Forbidden.'}), 403
                rbac = rbac_snapshot()
                validated = validate_admin_action(
                    artifact, caller_level=rbac.get('callerLevel', 80), known_roles=rbac.get('roles')
                )
            else:
                raise ValueError('Unknown artifact kind.')
            return jsonify({'success': True, 'data': validated})
        except (ValueError, SyntaxError, TypeError, KeyError) as exc:
            return jsonify({'success': False, 'error': str(exc)}), 422

    @blueprint.post('/reports/inspect-query')
    def inspect_report_query():
        """Return live DB preview, columns, chart defaults and KPI summaries when user switches query in Copilot."""
        body = request.get_json(silent=True) or {}
        qid = (body.get('queryId') or '').strip()
        if not qid:
            return jsonify({'success': False, 'error': 'queryId is required.'}), 400
        q_info = _execute_query_live(qid=qid)
        if not q_info:
            return jsonify({'success': False, 'error': 'Query not found or inaccessible.'}), 404
        chart_cfg, summaries, selected_cols = _build_query_proposal_fields(
            q_info, None, body.get('prompt') or q_info['queryName']
        )
        return jsonify({
            'success': True,
            'data': {
                'queryId': q_info['queryId'],
                'queryName': q_info['queryName'],
                'dataSourceId': q_info['dataSourceId'],
                'dataSourceName': q_info['dataSourceName'],
                'sql': q_info['sql'],
                'rowCount': q_info['rowCount'],
                'columns': q_info['columns'],
                'selectedColumns': selected_cols,
                'previewRows': q_info['previewRows'],
                'chart': chart_cfg,
                'summaries': summaries,
            },
        })

    @blueprint.post('/reports/build')
    def build_report_template():
        """Create/save the SQL query and build a complete Excel TemplateDocument in report_templates."""
        if not has_permission('page:template-builder') and not has_permission('page:reports'):
            return jsonify({'success': False, 'error': 'Rapor şablonu oluşturma yetkiniz yok.'}), 403
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return jsonify({'success': False, 'error': 'Invalid request body.'}), 400

        report_name = (body.get('reportName') or 'Copilot Raporu').strip()[:120]
        qid = (body.get('queryId') or '').strip()
        ds_id = (body.get('dataSourceId') or 'ds_apex_factory').strip()
        sql_text = (body.get('sql') or '').strip()

        q_info = _execute_query_live(
            qid=qid or None,
            ds_id=ds_id,
            sql_text=sql_text or None,
            query_name=f"[Copilot] {report_name}",
            create_if_missing=True,
        )
        if not q_info or not q_info['columns']:
            return jsonify({'success': False, 'error': 'Sorgu çalıştırılamadı veya kolon bulunamadı.'}), 422

        qid = q_info['queryId']
        cols = q_info['columns']
        req_cols = body.get('selectedColumns')
        selected_cols = [c for c in (req_cols if isinstance(req_cols, list) else cols[:8]) if c in cols]
        if not selected_cols:
            selected_cols = cols[:8]

        include_detail = bool(body.get('includeDetailTable', True))
        chart_req = body.get('chart') if isinstance(body.get('chart'), dict) else {}
        raw_summaries = body.get('summaries') if isinstance(body.get('summaries'), list) else []
        active_summaries = [
            s for s in raw_summaries
            if isinstance(s, dict) and s.get('checked', True) and s.get('field') in cols
        ]

        # Construct a rich, multi-section TemplateDocument model
        cells = {}
        bands = []
        charts = []
        table_width = max(len(selected_cols), len(active_summaries), 4)

        # Row 1: Title Banner
        cells['1,1'] = {
            'row': 1, 'col': 1,
            'value': report_name,
            'mergeAnchor': f"1,1,1,{table_width}",
            'style': {'bold': True, 'fontSize': 14, 'color': '#FFFFFF', 'bg': '#0F172A', 'align': 'left', 'valign': 'center'},
        }
        # Row 2: Metadata Subtitle (dinamik çalıştırma zamanı ile)
        cells['2,1'] = {
            'row': 2, 'col': 1,
            'value': f"Kaynak: {q_info['dataSourceName']} · Sorgu: {q_info['queryName']} · Canlı Çalıştırma: {{{{report_datetime}}}}",
            'mergeAnchor': f"2,1,2,{table_width}",
            'style': {'italic': True, 'fontSize': 9, 'color': '#CBD5E1', 'bg': '#1E293B', 'align': 'left', 'valign': 'center'},
        }

        current_row = 4
        # Rows 4-5: KPI Summary Cards Row
        if active_summaries:
            for idx, s in enumerate(active_summaries[:8], start=1):
                op = (s.get('operation') or 'SUM').upper()
                field = s.get('field')
                cells[f"{current_row},{idx}"] = {
                    'row': current_row, 'col': idx,
                    'value': f"{op} ({field})",
                    'style': {'bold': True, 'fontSize': 9, 'color': '#334155', 'bg': '#E2E8F0', 'align': 'center', 'valign': 'center'},
                }
                cells[f"{current_row + 1},{idx}"] = {
                    'row': current_row + 1, 'col': idx,
                    'value': f"={{{{{op}({field})}}}}",
                    'numberFormat': '#,##0' if op == 'COUNT' else '#,##0.00',
                    'binding': {'kind': 'summary', 'queryId': qid, 'field': field, 'operation': op},
                    'style': {'bold': True, 'fontSize': 11, 'color': '#0369A1', 'bg': '#F0F9FF', 'align': 'center', 'valign': 'center'},
                }
            current_row += 3

        # Detail Band Data Table (Header Row + Dynamic #EACH Row)
        if include_detail and selected_cols:
            header_row = current_row
            band_row = current_row + 1
            field_map = {}
            for idx, col_name in enumerate(selected_cols, start=1):
                cells[f"{header_row},{idx}"] = {
                    'row': header_row, 'col': idx,
                    'value': col_name,
                    'style': {'bold': True, 'fontSize': 10, 'color': '#FFFFFF', 'bg': '#1E293B', 'align': 'center', 'valign': 'center'},
                }
                is_num = col_name in q_info['numericColumns']
                cells[f"{band_row},{idx}"] = {
                    'row': band_row, 'col': idx,
                    'value': f"{{{{{col_name}}}}}",
                    'numberFormat': '#,##0.00' if is_num else undefined_or_none(None),
                    'binding': {'kind': 'query_field', 'queryId': qid, 'field': col_name},
                    'style': {'fontSize': 10, 'color': '#0F172A', 'align': 'right' if is_num else 'left', 'valign': 'center'},
                }
                if not is_num:
                    cells[f"{band_row},{idx}"].pop('numberFormat', None)
                field_map[str(idx)] = col_name
            bands.append({
                'id': 'bnd_main',
                'queryId': qid,
                'range': {'startRow': band_row, 'startCol': 1, 'endRow': band_row, 'endCol': len(selected_cols)},
                'fieldMap': field_map,
            })
            current_row = band_row + 2

        # Chart Placement (placed to the right of the table so it never collides with expanding rows)
        if chart_req.get('include', True):
            c_type = chart_req.get('type') if chart_req.get('type') in ('bar', 'line', 'pie') else 'bar'
            x_axis = chart_req.get('xAxis') if chart_req.get('xAxis') in cols else cols[0]
            raw_y = chart_req.get('yAxis') or []
            if isinstance(raw_y, str):
                raw_y = [raw_y]
            y_axis = [y for y in raw_y if y in cols] or [cols[-1]]
            chart_col = (len(selected_cols) + 2) if include_detail else 1
            chart_row = 4 if include_detail else current_row
            charts.append({
                'id': f"ch_{uuid.uuid4().hex[:8]}",
                'type': c_type,
                'title': (chart_req.get('title') or report_name)[:80],
                'queryId': qid,
                'xAxis': x_axis,
                'yAxis': y_axis,
                'anchor': {'row': chart_row, 'col': chart_col, 'widthCols': 7, 'heightRows': 14},
            })

        total_cols = max(table_width + 9, 16)
        col_widths = {str(i): 20 for i in range(1, table_width + 1)}
        row_heights = {'1': 30, '2': 20, '4': 20, '5': 26}

        tid = (body.get('templateId') or '').strip() or f"tpl_{uuid.uuid4().hex[:10]}"
        now_iso = datetime.now().isoformat()
        owner = getattr(g, 'uid', None) or 'system'
        roles = ['admin', 'superuser', 'engineer', 'operator', 'viewer']

        # Ensure unique template name if creating a new template
        final_name = report_name
        with get_database()._conn() as conn:
            existing_by_id = conn.execute('SELECT id, name FROM report_templates WHERE id=?', (tid,)).fetchone()
            if not existing_by_id:
                dup = conn.execute('SELECT id FROM report_templates WHERE name=?', (final_name,)).fetchone()
                if dup:
                    final_name = f"{report_name} ({datetime.now().strftime('%H:%M:%S')})"

        model = {
            'id': tid,
            'name': final_name,
            'description': f"Copilot tarafından {q_info['queryName']} sorgusu ile oluşturuldu.",
            'sheets': [{
                'id': 'sh_main',
                'name': 'Rapor',
                'rowCount': max(40, current_row + 15),
                'columnCount': total_cols,
                'columnWidths': col_widths,
                'rowHeights': row_heights,
                'cells': cells,
                'bands': bands,
                'charts': charts,
            }],
            'updatedAt': now_iso,
        }

        with get_database()._conn() as conn:
            if existing_by_id:
                conn.execute(
                    """UPDATE report_templates
                       SET name=?, description=?, model=?, version=version+1, updated_at=datetime('now')
                       WHERE id=?""",
                    (final_name, model['description'], json.dumps(model, ensure_ascii=False), tid),
                )
            else:
                conn.execute(
                    """INSERT INTO report_templates
                       (id, name, description, model, owner_id, allowed_roles, allowed_users, version, is_active)
                       VALUES (?, ?, ?, ?, ?, ?, '[]', 1, 1)""",
                    (tid, final_name, model['description'], json.dumps(model, ensure_ascii=False), owner, json.dumps(roles)),
                )

        if settings.AI_MEMORY_ENABLED and owner and owner != 'system':
            try:
                mem = LocalMemory(get_database())
                c_label = (chart_req.get('type') or 'bar').upper() if chart_req.get('include', True) else 'TABLO'
                mem.upsert_memory(
                    owner,
                    f"report:{qid}",
                    'report',
                    f"Oluşturulan rapor: {final_name} ({c_label})",
                    {'reportName': final_name, 'queryId': qid, 'templateId': tid, 'selectedColumns': selected_cols[:10]},
                )
            except Exception:
                logger.debug('Could not record built report in AI memory', exc_info=True)

        return jsonify({
            'success': True,
            'data': {
                'templateId': tid,
                'name': final_name,
                'queryId': qid,
                'rowCount': q_info['rowCount'],
                'columns': cols,
            },
        })

    @blueprint.post('/chat/stream')
    @blueprint.post('/chat/completions')
    @limiter.limit('20 per minute')
    def chat():
        try:
            messages, context = gateway.validate_request(request.get_json(silent=True))
        except (ValueError, TypeError) as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400
        if not settings.AI_ENABLED:
            return jsonify({'available': False, 'reason': 'disabled'}), 503
        page = context.get('page', 'dashboard')
        permission_page = 'network-map' if page == 'path-definer' else ('query-creator' if page == 'query-viewer' else page)
        if not has_permission('page:' + permission_page):
            return jsonify({'success': False, 'error': 'Page context is not accessible.'}), 403
        snapshot = schema_snapshot()
        if page in ('admin', 'settings', 'profile'):
            context['rbac'] = rbac_snapshot()
        # Client query metadata is replaced with authoritative, ACL-filtered metadata.
        requested = context.get('active_queries') or []
        if not isinstance(requested, list):
            return jsonify({'success': False, 'error': 'Invalid active_queries.'}), 400
        query_ids = [q.get('id') if isinstance(q, dict) else q for q in requested]
        if any(not isinstance(qid, str) for qid in query_ids):
            return jsonify({'success': False, 'error': 'Query IDs must be strings.'}), 400
        ids = set(query_ids)
        selected_queries = [q for q in snapshot['queries'] if q['id'] in ids]
        context['active_queries'] = list(selected_queries)
        uid = getattr(g, 'uid', None) or ''
        chat_session_id = context.pop('chat_session_id', '') if isinstance(context.get('chat_session_id'), str) else ''
        last_msg = messages[-1]['content'].lower()

        # Load persistent cross-session user memory from local SQLite DB so the user never repeats prior context
        mem_ctx = {}
        if settings.AI_MEMORY_ENABLED and uid:
            try:
                mem_ctx = LocalMemory(get_database()).recall_context(uid, messages[-1]['content'], can_access)
                if mem_ctx:
                    context['user_memory'] = {k: v for k, v in mem_ctx.items() if k != 'last_sql'}
                    ledger = dict(context.get('session_ledger') or {}) if isinstance(context.get('session_ledger'), dict) else {}
                    if not ledger.get('lastSql') and mem_ctx.get('last_sql'):
                        ledger['lastSql'] = mem_ctx['last_sql']
                    if not ledger.get('lastQueryId') and mem_ctx.get('last_query_id'):
                        ledger['lastQueryId'] = mem_ctx['last_query_id']
                    if not ledger.get('lastTables') and mem_ctx.get('last_tables'):
                        ledger['lastTables'] = mem_ctx['last_tables']
                    context['session_ledger'] = ledger
            except Exception:
                logger.debug('Could not recall cross-session AI memory', exc_info=True)

        # If user references previous chat/work ("geçen", "önceki", "aynı tablo", "son yaptığımız") without an explicit selection yet
        if not context.get('user_selection') and mem_ctx and any(
            w in last_msg for w in ('önceki', 'geçen', 'aynı tablo', 'aynı sorgu', 'son yaptığımız', 'az önceki', 'yine aynı')
        ):
            ledger = context.get('session_ledger') or {}
            if any(k in last_msg for k in ('join', 'birleştir', 'ekle')) and ledger.get('lastSql'):
                context['user_selection'] = {
                    'selectedOptionIds': ['sql_join_more'],
                    'previousSql': ledger.get('lastSql', ''),
                    'previousQueryId': ledger.get('lastQueryId', ''),
                    'targetAction': 'sql',
                }
            elif mem_ctx.get('last_tables') or mem_ctx.get('last_query_id'):
                inferred_target = (
                    'report' if any(k in last_msg for k in ('rapor', 'excel', 'şablon', 'template')) else
                    'spacemap' if any(k in last_msg for k in ('space map', 'spacemap', 'harita', 'topoloji')) else
                    'python' if 'python' in last_msg else 'sql'
                )
                if mem_ctx.get('last_tables'):
                    context['user_selection'] = {
                        'dialogType': 'table_disambiguation',
                        'selectedTables': list(mem_ctx['last_tables']),
                        'selectedQueryId': mem_ctx.get('last_query_id') or '',
                        'dataSourceId': context.get('data_source_id') or 'ds_apex_factory',
                        'targetAction': inferred_target,
                    }
                elif inferred_target == 'report' and mem_ctx.get('last_query_id'):
                    context['user_selection'] = {
                        'selectedOptionIds': ['confirm_yes'],
                        'previousQueryId': mem_ctx['last_query_id'],
                        'targetAction': 'report',
                    }
        if not settings.AI_MOCK_MODE and 'tool_get_database_schema' not in last_msg:
            raw_tokens = set(re.findall(r'[a-z0-9_ğüşıöç]+', last_msg))
            tokens = set(raw_tokens)
            for tok in list(raw_tokens):
                if tok.startswith('prdocut') or tok.startswith('product') or tok == 'üretim':
                    tokens.update({'production', 'batch', 'oee', 'production_batches'})
                if tok == 'batch':
                    tokens.update({'production', 'oee', 'production_batches', 'batch_id'})
                if 'point' in tok:
                    tokens.update({'c_point', 'point_id', 'point_name', 'cpoint', 'avg_value'})
                if tok in ('value', 'değer', 'deger', 'ölçüm'):
                    tokens.update({'avg_value', 'min_value', 'max_value', 'cpoint', 'values'})
            def _score_query(q):
                haystack = f"{q['id']} {q['name']} {' '.join(q.get('columns') or [])}".lower()
                score = sum(2 if t in q['id'].lower() or t in q['name'].lower() else 1 for t in tokens if t in haystack)
                if 'c_point' in tokens and ('avg_value' in tokens or 'tablo' in last_msg or 'tabloları' in last_msg):
                    if q['id'] == 'q_ind_cpoint_values':
                        score += 10
                return score
            candidates = [q for q in snapshot['queries'] if q.get('columns') and q['id'] not in ids]
            ranked = sorted(candidates, key=_score_query, reverse=True)
            if not ids:
                matched = [q for q in ranked if _score_query(q) > 0]
                context['active_queries'] = (matched or ranked)[:3]
            else:
                extra = [q for q in ranked if _score_query(q) >= 3][:max(0, 3 - len(selected_queries))]
                context['active_queries'] = selected_queries + extra
            if page in ('query-creator', 'table-explorer') or not context['active_queries']:
                active_sources = [
                    {'id': s['id'], 'name': s['name'], 'dialect': s['dialect'], 'tables': s['tables'][:12]}
                    for s in snapshot['sources'] if s.get('tables')
                ]
                if active_sources:
                    context['sources'] = active_sources
        # 1. Evaluate interactive dialog selection if the user responded to a Copilot dialog
        selection_handled = _evaluate_user_selection(messages, context, snapshot)

        # 2. Discover candidate database tables & multi-table JOIN recipes for the user's request
        discovery = _discover_candidate_tables(messages[-1]['content'], snapshot, context)
        high_candidates = [c for c in (discovery.get('candidates') or []) if c.get('score', 0) >= 4]

        if not selection_handled and not settings.AI_MOCK_MODE and page not in ('admin', 'settings', 'profile'):
            # If user asks about tables/schema/JOINs OR if the request spans multiple candidate tables without an explicit single table name
            wants_direct_report = any(k in last_msg for k in ('rapor oluştur', 'excel raporu', 'template oluştur', 'raporu hazırla'))
            if discovery.get('asksForTableHelp') or (
                len(high_candidates) >= 2 and len(discovery.get('explicitMentions') or []) == 0 and not wants_direct_report
            ):
                cand_lines = []
                for c in (discovery.get('candidates') or [])[:4]:
                    cols_str = ', '.join((c.get('columns') or [])[:6])
                    c_desc = c.get('desc') or c.get('description') or ''
                    row_str = f"{c.get('rowCount', 0):,}".replace(',', '.')
                    cand_lines.append(
                        f"• **`{c['name']}`** ({row_str} satır) — {c_desc}\n"
                        f"  _Kolonlar:_ `{cols_str}`"
                    )
                join_lines = []
                for r in (discovery.get('joinRecipes') or [])[:2]:
                    r_title = r.get('title') or r.get('label') or r['id']
                    r_desc = r.get('desc') or r.get('description') or ''
                    join_lines.append(f"• **`{r_title}`** (`{' ⋈ '.join(r['tables'])}`) — {r_desc}")

                context['_forced_dialog'] = _build_table_disambiguation_dialog(
                    messages[-1]['content'], discovery, context, is_companion=False
                )
                context['_short_circuit_answer'] = (
                    f"🧭 İsteğiniz için **`ds_apex_factory`** veritabanında birden fazla uygun tablo ve birleştirme (JOIN) alternatifi tespit ettim:\n\n"
                    f"**Aday Tablolar:**\n" + "\n".join(cand_lines) + "\n\n"
                    + ("**Önerilen Çoklu Tablo (JOIN) Kombinasyonları:**\n" + "\n".join(join_lines) + "\n\n" if join_lines else "")
                    + "Aşağıdaki **Tablo & JOIN Karar Panelinden** tek bir tablo seçebilir, **birden fazla tabloyu işaretleyerek otomatik JOIN** yaptırabilir "
                    + "veya doğrudan üretilecek çıktı türünü (**Excel Raporu / SQL / Space Map / Python**) belirleyebilirsiniz:"
                )

        examples = []
        if settings.AI_MEMORY_ENABLED and not context.get('_short_circuit_answer'):
            try:
                examples = LocalMemory(get_database()).retrieve(messages[-1]['content'], can_access, page)
            except Exception:
                logger.warning('AI memory retrieval unavailable; continuing without examples.')

        def run_tool(name, arguments):
            # Recheck current ACL instead of trusting the initial snapshot on a long stream.
            return dispatch(name, arguments, {**schema_snapshot(), 'rbac': rbac_snapshot()})

        def on_complete(answer_text):
            emitted_proposal = None
            emitted_dialog = None
            full_answer_text = answer_text or ''
            user_prompt = messages[-1]['content'] if messages else ''
            try:
                proposal = context.get('_forced_proposal')
                intro_delta = None
                if not proposal:
                    proposal, intro_delta = _prepare_report_proposal(user_prompt, answer_text, context, snapshot)
                if proposal:
                    emitted_proposal = proposal
                    if intro_delta:
                        full_answer_text = (full_answer_text + '\n\n' + intro_delta).strip()
                        yield sse({'choices': [{'delta': {'content': '\n\n' + intro_delta}}]})
                    yield sse(proposal, 'proposal')
                    # Also attach a companion table switcher/JOIN dialog when multiple tables match and user hasn't already selected from dialog
                    if not selection_handled and len(discovery.get('candidates') or []) >= 2:
                        companion_dlg = _build_table_disambiguation_dialog(user_prompt, discovery, context, is_companion=True)
                        emitted_dialog = companion_dlg
                        yield sse(companion_dlg, 'dialog')
                else:
                    dialog = _build_interactive_dialog(user_prompt, answer_text, context, snapshot)
                    if dialog:
                        emitted_dialog = dialog
                        yield sse(dialog, 'dialog')
            except Exception:
                logger.warning('Post-stream proposal/dialog enrichment failed', exc_info=True)

            # Persist chat turn & learned user preferences into local SQLite DB
            if settings.AI_MEMORY_ENABLED and uid:
                try:
                    mem = LocalMemory(get_database())
                    summary_patch = mem.learn_from_turn(
                        uid,
                        user_prompt,
                        full_answer_text,
                        context=context,
                        proposal=emitted_proposal,
                    )
                    saved_session = mem.save_turn(
                        uid,
                        chat_session_id or None,
                        page,
                        user_prompt,
                        full_answer_text,
                        assistant_meta={
                            'reportProposal': emitted_proposal,
                            'dialog': emitted_dialog,
                        },
                        summary_patch=summary_patch,
                    )
                    if saved_session.get('sessionId'):
                        yield sse(saved_session, 'session')
                except Exception:
                    logger.warning('Could not persist optional AI chat turn', exc_info=True)

        @stream_with_context
        def generate():
            try:
                yield from gateway.stream(messages, context, run_tool, examples, on_complete=on_complete)
            except GeneratorExit:
                raise
            except AIUnavailable as exc:
                yield sse({'reason': exc.reason, 'message': 'Yerel AI yanıtı tamamlanamadı. Tekrar deneyebilirsiniz.'}, 'error')
            except Exception:
                logger.exception('AI stream failed')
                yield sse({'reason': 'offline', 'message': 'Yerel AI bağlantısı kullanılamıyor.'}, 'error')

        return Response(generate(), content_type='text/event-stream; charset=utf-8', headers={
            'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
        })

    app.register_blueprint(blueprint)


def undefined_or_none(val):
    return val


def index_saved_example(settings, database, kind, row):
    if not settings.AI_ENABLED or not settings.AI_MEMORY_ENABLED:
        return
    try:
        LocalMemory(database).index(kind, row)
    except Exception:
        # Optional memory may never make saving a query/script fail.
        logger.warning('AI example indexing unavailable; source saved normally.')
