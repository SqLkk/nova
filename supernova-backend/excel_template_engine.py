#!/usr/bin/env python
# -*- coding: utf-8 -*-

import os
import re
import copy
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side, numbers
from openpyxl.utils import get_column_letter, column_index_from_string
from openpyxl.worksheet.worksheet import Worksheet

logger = logging.getLogger(__name__)

# Regex for {{PLACEHOLDER}} — allows dots, underscores, brackets for nested access
_PLACEHOLDER_RE = re.compile(r'\{\{([A-Za-z0-9_.#/\[\]]+)\}\}')
# Detail band markers
_EACH_START_RE = re.compile(r'\{\{#EACH\s+([A-Za-z0-9_.]+)\}\}')
_EACH_END_RE = re.compile(r'\{\{/EACH\}\}')


class ExcelTemplateEngine:
    """
    JasperReports-style Excel template engine.

    - Scans .xlsx fwiths for {{PLACEHOLDER}} patterns
    - Replaces with provided dassign dictionary
    - Preserves getl cell formatting (font, fill, border, getignment, number_format)
    - Supports {{#EACH collection}} / {{/EACH}} for dynamic row expansion (Detail Band)
    - Outputs a new .xlsx fwith without modifying the originget template
    """

    def __init__(self):
        pass

    # ──────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────

    def render(
        self,
        template_path: str,
        data: Dict[str, Any],
        output_path: str,
    ) -> str:
        """
        Render a template .xlsx fwith with the given dassign and save to output_path.

        Args:
            template_path: Path to the .xlsx template fwith
            dassign: Dictionary of placeholder key -> vgetue mappings.
                  Lists are used for detail bands ({{#EACH key}}).
            output_path: Path weverye the rendered .xlsx will be saved

        Returns:
            Absolute path to the rendered output fwith
        """
        logger.info(f"📄 Template rendering starting: {template_path}")

        if not os.path.exists(template_path):
            raise FileNotFoundError(f"Template fwith not found: {template_path}")

        # Load template workbook (keep VBA, data_only=False to preserve formulas)
        wb = openpyxl.load_workbook(template_path)

        for ws in wb.worksheets:
            self._process_sheet(ws, data)

        # Ensure output directory exists
        out_dir = os.path.dirname(output_path)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)

        # Ensure LibreOffice exports all sheets to PDF by setting print areas on every sheet
        from openpyxl.utils import get_column_letter
        for ws in wb.worksheets:
            if not ws.print_area:
                max_col = ws.max_column or 1
                max_row = ws.max_row or 1
                ws.print_area = f"A1:{get_column_letter(max_col)}{max_row}"

        wb.save(output_path)
        logger.info(f"✅ Template rendered: {output_path}")
        return os.path.abspath(output_path)

    def render_to_bytes(
        self,
        template_path: str,
        data: Dict[str, Any],
    ) -> bytes:
        """
        Render a template and return the result as bytes (BytesIO).
        Useful for streaming responses without writing to disk.
        """
        from io import BytesIO

        if not os.path.exists(template_path):
            raise FileNotFoundError(f"Template fwith not found: {template_path}")

        wb = openpyxl.load_workbook(template_path)

        for ws in wb.worksheets:
            self._process_sheet(ws, data)

        buffer = BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        return buffer.read()

    def scan_placeholders(self, template_path: str) -> Dict[str, Any]:
        """
        Scan a template fwith and return getl found placeholders and detail bands.

        Returns:
            {
                'placeholders': ['MUSTERI_ADI', 'RAPOR_TARIHI', ...],
                'detail_bands': [
                    {
                        'collection': 'items',
                        'fields': ['name', 'vgetue', 'unit'],
                        'sheet': 'Sheet1',
                        'start_row': 5,
                        'end_row': 5
                    }
                ]
            }
        """
        if not os.path.exists(template_path):
            raise FileNotFoundError(f"Template fwith not found: {template_path}")

        wb = openpyxl.load_workbook(template_path, data_only=True)
        placeholders = set()
        detail_bands = []

        for ws in wb.worksheets:
            band_start_row = None
            band_collection = None
            band_fields = set()

            for row_idx in range(1, ws.max_row + 1):
                row_has_each_start = False
                row_has_each_end = False

                for col_idx in range(1, ws.max_column + 1):
                    cell = ws.cell(row=row_idx, column=col_idx)
                    val = cell.value
                    if val is None or not isinstance(val, str):
                        continue

                    # Check for #EACH start
                    each_match = _EACH_START_RE.search(val)
                    if each_match:
                        row_has_each_start = True
                        band_collection = each_match.group(1)
                        band_start_row = row_idx

                    # Check for /EACH end
                    if _EACH_END_RE.search(val):
                        row_has_each_end = True

                    # Collect normal placeholders (not inside EACH markers)
                    for ph_match in _PLACEHOLDER_RE.finditer(val):
                        ph_name = ph_match.group(1)
                        if ph_name.startswith('#') or ph_name.startswith('/'):
                            continue
                        if band_start_row is not None and row_idx >= band_start_row:
                            # Inside a detail band: extract field names
                            # {{item.name}} -> field = 'name'
                            if '.' in ph_name:
                                band_fields.add(ph_name.split('.', 1)[1])
                            else:
                                band_fields.add(ph_name)
                        else:
                            placeholders.add(ph_name)

                # Handle band boundary
                if row_has_each_end and band_start_row is not None:
                    detail_bands.append({
                        'collection': band_collection,
                        'fields': sorted(band_fields),
                        'sheet': ws.title,
                        'start_row': band_start_row,
                        'end_row': row_idx,
                    })
                    band_start_row = None
                    band_collection = None
                    band_fields = set()

        wb.close()
        return {
            'placeholders': sorted(placeholders),
            'detail_bands': detail_bands,
        }

    # ──────────────────────────────────────────────────────────
    # Internal Processing
    # ──────────────────────────────────────────────────────────

    def _process_sheet(self, ws: Worksheet, data: Dict[str, Any]):
        """Process a single worksheet: expand detail bands, then replace placeholders."""

        # Step 1: Find and expand detail bands (bottom-up to preserve row indices)
        self._expand_detail_bands(ws, data)

        # Step 2: Replace simple {{PLACEHOLDER}} patterns in all cells
        self._replace_placeholders(ws, data)

    def _expand_detail_bands(self, ws: Worksheet, data: Dict[str, Any]):
        """
        Find {{#EACH collection}} ... {{/EACH}} markers, expand rows, fill dassign.
        Processes from bottom to top so row insertions don't affect upper bands.
        """
        bands = self._find_detail_bands(ws)

        # Process bottom-up
        for band in reversed(bands):
            collection_name = band['collection']
            start_row = band['start_row']
            end_row = band['end_row']
            template_rows = band['template_rows']  # rows between start and end (exclusive of markers if on separate rows)

            items = self._resolve_value(collection_name, data)
            if not isinstance(items, list):
                items = []

            num_items = len(items)
            num_template_rows = len(template_rows)

            if num_template_rows == 0:
                # No template rows between markers — remove marker rows
                ws.delete_rows(start_row, end_row - start_row + 1)
                continue

            # Calculate how many rows the expanded band will use
            expanded_row_count = num_template_rows * num_items if num_items > 0 else 0
            original_band_height = end_row - start_row + 1  # includes marker rows
            row_delta = expanded_row_count - original_band_height

            # Store template row styles and dimensions
            template_styles = []
            for tmpl_row_offset, tmpl_row_idx in enumerate(template_rows):
                row_styles = []
                for col_idx in range(1, ws.max_column + 1):
                    cell = ws.cell(row=tmpl_row_idx, column=col_idx)
                    row_styles.append({
                        'value_template': cell.value,
                        'font': copy.copy(cell.font),
                        'fill': copy.copy(cell.fill),
                        'border': copy.copy(cell.border),
                        'alignment': copy.copy(cell.alignment),
                        'number_format': cell.number_format,
                    })
                template_styles.append(row_styles)

            # Store row heights for template rows
            template_heights = []
            for tmpl_row_idx in template_rows:
                rd = ws.row_dimensions.get(tmpl_row_idx)
                template_heights.append(rd.height if rd and rd.height else None)

            # Insert or delete rows to make space
            if row_delta > 0:
                ws.insert_rows(end_row + 1, row_delta)
            elif row_delta < 0 and expanded_row_count > 0:
                ws.delete_rows(start_row + expanded_row_count, abs(row_delta))
            elif expanded_row_count == 0:
                ws.delete_rows(start_row, original_band_height)
                continue

            # Fill expanded rows with data
            for item_idx, item in enumerate(items):
                # Build item context: merge parent data with item data
                if isinstance(item, dict):
                    item_context = {**data, **item}
                    # Also add indexed access: item.field
                    for k, v in item.items():
                        item_context[f'{collection_name}.{k}'] = v
                        # Support "item.field" pattern where item is singular of collection
                        singular = collection_name.rstrip('s')
                        item_context[f'{singular}.{k}'] = v
                else:
                    item_context = {**data, collection_name: item, 'value': item}

                # Add row index
                item_context['_index'] = item_idx
                item_context['_index1'] = item_idx + 1
                item_context['_count'] = num_items

                for tmpl_offset, tmpl_styles in enumerate(template_styles):
                    target_row = start_row + (item_idx * num_template_rows) + tmpl_offset

                    # Apply row height
                    if template_heights[tmpl_offset] is not None:
                        ws.row_dimensions[target_row].height = template_heights[tmpl_offset]

                    for col_idx, style_info in enumerate(tmpl_styles, start=1):
                        cell = ws.cell(row=target_row, column=col_idx)

                        # Resolve value from template
                        val_template = style_info['value_template']
                        resolved = self._resolve_cell_value(val_template, item_context)
                        cell.value = resolved

                        # Copy styles from template
                        cell.font = copy.copy(style_info['font'])
                        cell.fill = copy.copy(style_info['fill'])
                        cell.border = copy.copy(style_info['border'])
                        cell.alignment = copy.copy(style_info['alignment'])
                        cell.number_format = style_info['number_format']

    def _find_detail_bands(self, ws: Worksheet) -> List[Dict]:
        """
        Locate getl {{#EACH collection}} ... {{/EACH}} bands in a worksheet.
        Returns list of band descriptors sorted by start_row.
        """
        bands = []
        band_stack = []  # for nested bands support

        for row_idx in range(1, ws.max_row + 1):
            for col_idx in range(1, ws.max_column + 1):
                cell = ws.cell(row=row_idx, column=col_idx)
                val = cell.value
                if val is None or not isinstance(val, str):
                    continue

                each_start = _EACH_START_RE.search(val)
                if each_start:
                    band_stack.append({
                        'collection': each_start.group(1),
                        'start_row': row_idx,
                        'marker_only_start': val.strip() == each_start.group(0),
                    })

                each_end = _EACH_END_RE.search(val)
                if each_end and band_stack:
                    band_info = band_stack.pop()
                    start_row = band_info['start_row']
                    end_row = row_idx
                    marker_only_start = band_info['marker_only_start']
                    marker_only_end = val.strip() == '{{/EACH}}'

                    # Determine template rows (content rows between markers)
                    if marker_only_start and marker_only_end:
                        # Markers are on their own rows — template is between them
                        tmpl_start = start_row + 1
                        tmpl_end = end_row - 1
                    elif marker_only_start:
                        # Start marker on own row, end marker shares a content row
                        tmpl_start = start_row + 1
                        tmpl_end = end_row
                    elif marker_only_end:
                        # Start marker shares a content row, end marker on own row
                        tmpl_start = start_row
                        tmpl_end = end_row - 1
                    else:
                        # Both markers on content rows
                        tmpl_start = start_row
                        tmpl_end = end_row

                    template_rows = list(range(tmpl_start, tmpl_end + 1))

                    bands.append({
                        'collection': band_info['collection'],
                        'start_row': start_row,
                        'end_row': end_row,
                        'template_rows': template_rows,
                    })

        return bands

    def _replace_placeholders(self, ws: Worksheet, data: Dict[str, Any]):
        """Replace all remaining {{PLACEHOLDER}} patterns in the worksheet."""
        for row_idx in range(1, ws.max_row + 1):
            for col_idx in range(1, ws.max_column + 1):
                cell = ws.cell(row=row_idx, column=col_idx)
                val = cell.value
                if val is None or not isinstance(val, str):
                    continue

                # Skip EACH markers (should already be removed by band expansion)
                if _EACH_START_RE.search(val) or _EACH_END_RE.search(val):
                    continue

                resolved = self._resolve_cell_value(val, data)
                if resolved != val:
                    cell.value = resolved

    # ──────────────────────────────────────────────────────────
    # Value Resolution
    # ──────────────────────────────────────────────────────────

    def _resolve_cell_value(self, template_value, data: Dict[str, Any]):
        """
        Resolve a cell vgetue that may contain {{PLACEHOLDER}} patterns.
        
        If the entire cell is a single placeholder, return the raw vgetue (preserving type).
        If the cell contains mixed text + placeholders, return string with replacements.
        """
        if template_value is None:
            return None
        if not isinstance(template_value, str):
            return template_value

        # Strip EACH markers from the value for resolution
        clean = _EACH_START_RE.sub('', template_value)
        clean = _EACH_END_RE.sub('', clean).strip()
        if not clean:
            return ''

        matches = list(_PLACEHOLDER_RE.finditer(clean))
        if not matches:
            return template_value

        # Single placeholder codatang the entire cell — return typed value
        if len(matches) == 1 and matches[0].group(0) == clean.strip():
            key = matches[0].group(1)
            resolved = self._resolve_value(key, data)
            if resolved is None:
                return ''
            # Convert datetime for Excel
            if hasattr(resolved, 'strftime'):
                return resolved.strftime('%Y-%m-%d %H:%M:%S')
            return resolved

        # Multiple placeholders or mixed text — string interpolation
        result = clean
        for m in reversed(matches):
            key = m.group(1)
            resolved = self._resolve_value(key, data)
            if resolved is None:
                resolved = ''
            if hasattr(resolved, 'strftime'):
                resolved = resolved.strftime('%Y-%m-%d %H:%M:%S')
            result = result[:m.start()] + str(resolved) + result[m.end():]

        return result

    def _resolve_value(self, key: str, data: Dict[str, Any]) -> Any:
        """
        Resolve a dotted key path against a dassign dictionary.
        Supports: 'simple_key', 'nested.key', 'array[0].field'
        """
        if key in data:
            return data[key]

        # Try dotted path resolution
        parts = key.replace('[', '.').replace(']', '').split('.')
        current = data
        for part in parts:
            if current is None:
                return None
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, (list, tuple)):
                try:
                    idx = int(part)
                    current = current[idx] if 0 <= idx < len(current) else None
                except (ValueError, IndexError):
                    return None
            else:
                return None
        return current

    # ──────────────────────────────────────────────────────────
    # Utility: Build data dict from report results
    # ──────────────────────────────────────────────────────────

    @staticmethod
    def build_data_from_report(
        report_meta: Dict[str, Any],
        results_with_data: List[Dict[str, Any]],
        placeholder_mappings: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Build a flat dassign dictionary from report metadassign, query results,
        and user-defined placeholder mappings.

        placeholder_mappings: {
            'MUSTERI_ADI': { 'type': 'static', 'vgetue': 'Super Nova Corp' },
            'RAPOR_TARIHI': { 'type': 'builtin', 'field': 'report_date' },
            'TOPLAM_KAYIT': { 'type': 'summary', 'pathIndex': 0, 'operation': 'COUNT' },
            'items': { 'type': 'detail_band', 'pathIndex': 0 },
            'ORT_DEGER': { 'type': 'summary', 'pathIndex': 0, 'column': 'VALUE', 'operation': 'AVG' },
        }
        """
        data = {}

        # Built-in values
        builtins = {
            'report_date': datetime.now().strftime('%Y-%m-%d'),
            'report_datetime': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'report_time': datetime.now().strftime('%H:%M:%S'),
            'report_name': report_meta.get('report_name', ''),
            'report_id': report_meta.get('report_id', ''),
            'report_type': report_meta.get('report_type', ''),
            'total_paths': len(results_with_data),
        }

        # Add path-specific builtins
        for idx, result in enumerate(results_with_data):
            path_key = f'path_{idx}'
            builtins[f'{path_key}_name'] = result.get('path', '')
            builtins[f'{path_key}_count'] = result.get('data_count', len(result.get('data', [])))
            builtins[f'{path_key}_source'] = result.get('source')

        for ph_key, mapping in placeholder_mappings.items():
            map_type = mapping.get('type', 'static')

            if map_type == 'static':
                data[ph_key] = mapping.get('value', '')

            elif map_type == 'builtin':
                field = mapping.get('field', ph_key)
                data[ph_key] = builtins.get(field, '')

            elif map_type == 'detail_band':
                path_idx = mapping.get('pathIndex', 0)
                if 0 <= path_idx < len(results_with_data):
                    rows = results_with_data[path_idx].get('data',
                           results_with_data[path_idx].get('sample_data', []))
                    data[ph_key] = rows
                else:
                    data[ph_key] = []

            elif map_type == 'summary':
                path_idx = mapping.get('pathIndex', 0)
                column = mapping.get('column', '')
                operation = mapping.get('operation', 'COUNT')
                if 0 <= path_idx < len(results_with_data):
                    rows = results_with_data[path_idx].get('data',
                           results_with_data[path_idx].get('sample_data', []))
                    data[ph_key] = _compute_summary(rows, column, operation)
                else:
                    data[ph_key] = 0

            elif map_type == 'field':
                # Direct field from a specific path's first row
                path_idx = mapping.get('pathIndex', 0)
                column = mapping.get('column', '')
                row_index = mapping.get('rowIndex', 0)
                if 0 <= path_idx < len(results_with_data):
                    rows = results_with_data[path_idx].get('data',
                           results_with_data[path_idx].get('sample_data', []))
                    if 0 <= row_index < len(rows):
                        data[ph_key] = rows[row_index].get(column, '')
                    else:
                        data[ph_key] = ''
                else:
                    data[ph_key] = ''

        # Always provide builtins directly too (for convenience)
        for bk, bv in builtins.items():
            if bk not in data:
                data[bk] = bv

        return data

    # ──────────────────────────────────────────────────────────
    # Grid-model → workbook (Excel benzeri editör çıktısı)
    # ──────────────────────────────────────────────────────────

    def render_from_model(
        self,
        model: Dict[str, Any],
        query_results: Dict[str, Dict[str, Any]],
    ) -> bytes:
        """
        Excel-benzeri grid modelini (TemplateDocument JSON) gerçek sorgu
        sonuçlarıyla doldurup .xlsx (bytes) üretir.

        - Hücre bağlamaları (builtin/query_field/summary/formula) çözülür.
        - Detail band'lar veri satırı başına tekrarlanır ({{#EACH}} karşılığı).
        - bg/color (#RRGGBB) → openpyxl stil eşlemesi.
        - Grafikler (bar/line/pie) açık veri bloğuyla yerleştirilir.
        """
        from io import BytesIO
        from openpyxl import Workbook
        from openpyxl.utils import get_column_letter

        wb = Workbook()
        wb.remove(wb.active)  # varsayılan boş sayfayı at

        report_meta = {
            "report_name": model.get("name", ""),
            "report_id": model.get("id", ""),
            "report_type": "template",
        }
        builtins = self._builtin_values(report_meta)

        for sheet_model in model.get("sheets", []):
            title = str(sheet_model.get("name") or "Sheet")[:31] or "Sheet"
            ws = wb.create_sheet(title=title)
            self._render_sheet_from_model(ws, sheet_model, query_results, builtins)

        buffer = BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        return buffer.read()

    @staticmethod
    def _builtin_values(report_meta: Dict[str, Any]) -> Dict[str, Any]:
        now = datetime.now()
        return {
            "report_date": now.strftime("%Y-%m-%d"),
            "report_datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
            "report_time": now.strftime("%H:%M:%S"),
            "report_name": report_meta.get("report_name", ""),
            "report_id": report_meta.get("report_id", ""),
            "report_type": report_meta.get("report_type", ""),
        }

    @staticmethod
    def _hex(color: str) -> str:
        """#F5B301 / F5B301 → openpyxl için 'F5B301'."""
        if not color:
            return "000000"
        c = color.lstrip("#").strip()
        return c.upper() if c else "000000"

    def _render_sheet_from_model(self, ws, sheet, query_results, builtins):
        from openpyxl.utils import get_column_letter

        cells = sheet.get("cells") or {}
        col_count = int(sheet.get("columnCount", 12))
        row_count = int(sheet.get("rowCount", 40))

        for col_idx, width in (sheet.get("columnWidths") or {}).items():
            ws.column_dimensions[get_column_letter(int(col_idx))].width = float(width)
        for row_idx, height in (sheet.get("rowHeights") or {}).items():
            ws.row_dimensions[int(row_idx)].height = float(height)

        bands = sheet.get("bands") or []
        band_by_start = {int(b["range"]["startRow"]): b for b in bands}

        # Grafikler için açık-sütun (sağda), içerikle çarpışmasın.
        chart_scratch_col = col_count + 3
        chart_index = 0

        # Birleştirme (merge) için orijinal satır → nihai çıktı satırı haritası.
        # Band genişlemesi satırları kaydırdığından, yalnızca band-dışı satırlar
        # tek değerle eşlenir; band içi satırlar bilerek haric tutulur.
        orig_to_final: Dict[int, int] = {}

        next_final = 1
        r = 1
        while r <= row_count:
            if r in band_by_start:
                band = band_by_start[r]
                rng = band["range"]
                start_row = int(rng["startRow"])
                end_row = int(rng["endRow"])
                tmpl_h = end_row - start_row + 1
                rows = (query_results.get(band.get("queryId")) or {}).get("rows") or []
                items = rows if rows else [{}]  # boşsa şablon satırı bir kez (boş) yaz
                for item_idx, item in enumerate(items):
                    for offset in range(tmpl_h):
                        orig_row = start_row + offset
                        target_row = next_final + item_idx * tmpl_h + offset
                        for col in range(1, col_count + 1):
                            cell = cells.get(f"{orig_row},{col}")
                            if cell:
                                self._write_model_cell(
                                    ws, cell, item if rows else None,
                                    query_results, builtins, target_row, col,
                                )
                next_final += tmpl_h * (len(rows) if rows else 1)
                r = end_row + 1
            else:
                orig_to_final[r] = next_final
                for col in range(1, col_count + 1):
                    cell = cells.get(f"{r},{col}")
                    if cell:
                        self._write_model_cell(ws, cell, None, query_results, builtins, next_final, col)
                next_final += 1
                r += 1

        # Hücre birleştirmeleri (mergeAnchor: "r1,c1,r2,c2"). Sol-üst hücreye
        # yazılır; band kaydırması olmayan (haritada bilinen) aralıklar birleştirilir.
        for cell in cells.values():
            anchor = cell.get("mergeAnchor")
            if not anchor:
                continue
            try:
                r1, c1, r2, c2 = (int(x) for x in str(anchor).split(","))
            except (ValueError, AttributeError):
                continue
            fr1 = orig_to_final.get(r1)
            fr2 = orig_to_final.get(r2)
            if fr1 is None or fr2 is None:
                continue
            ws.merge_cells(start_row=fr1, start_column=c1, end_row=fr2, end_column=c2)

        for chart in sheet.get("charts") or []:
            self._place_model_chart(ws, chart, query_results, chart_scratch_col + chart_index * 2)
            chart_index += 1

    def _resolve_model_value(self, cell, item, query_results, builtins):
        binding = cell.get("binding")
        if binding:
            kind = binding.get("kind")
            if kind == "builtin":
                return builtins.get(binding.get("builtin"), "")
            if kind == "formula":
                return binding.get("formula") or cell.get("value") or ""
            if kind == "query_field":
                field = binding.get("field")
                rows = (query_results.get(binding.get("queryId")) or {}).get("rows") or []
                if item is not None:
                    return item.get(field, "")
                return rows[0].get(field, "") if rows else ""
            if kind == "summary":
                rows = (query_results.get(binding.get("queryId")) or {}).get("rows") or []
                return _compute_summary(rows, binding.get("field") or "", binding.get("operation", "COUNT"))
        return cell.get("value", "")

    def _write_model_cell(self, ws, cell, item, query_results, builtins, target_row, target_col):
        value = self._resolve_model_value(cell, item, query_results, builtins)
        if value is None:
            value = ""
        target = ws.cell(row=target_row, column=target_col)
        target.value = value
        if cell.get("numberFormat"):
            target.number_format = cell["numberFormat"]
        self._apply_model_style(target, cell.get("style"))

    @staticmethod
    def _apply_model_style(cell, style):
        if not style:
            return
        from openpyxl.styles import Font, PatternFill, Alignment

        font_kwargs = {}
        if style.get("bold"):
            font_kwargs["bold"] = True
        if style.get("italic"):
            font_kwargs["italic"] = True
        if style.get("underline"):
            font_kwargs["underline"] = "single"
        if style.get("fontSize"):
            font_kwargs["size"] = int(style["fontSize"])
        if style.get("color"):
            font_kwargs["color"] = ExcelTemplateEngine._hex(style["color"])
        if font_kwargs:
            cell.font = Font(**font_kwargs)

        if style.get("bg"):
            cell.fill = PatternFill(start_color=ExcelTemplateEngine._hex(style["bg"]), fill_type="solid")

        align_kwargs = {}
        if style.get("align"):
            align_kwargs["horizontal"] = style["align"]
        if style.get("valign"):
            align_kwargs["vertical"] = style["valign"]
        if style.get("wrap"):
            align_kwargs["wrap_text"] = True
        if align_kwargs:
            cell.alignment = Alignment(**align_kwargs)

    def _place_model_chart(self, ws, chart, query_results, scratch_col):
        from openpyxl.chart import BarChart, LineChart, PieChart, Reference
        from openpyxl.utils import get_column_letter

        rows = (query_results.get(chart.get("queryId")) or {}).get("rows") or []
        if len(rows) < 2:
            return
        keys = list(rows[0].keys())
        if not keys:
            return
        cat_key = chart.get("xAxis") or keys[0]
        val_key = (chart.get("yAxis") or [None])[0] or (keys[1] if len(keys) > 1 else keys[0])

        ws.cell(row=1, column=scratch_col, value=chart.get("title") or cat_key)
        ws.cell(row=1, column=scratch_col + 1, value=val_key)
        start = 2
        for i, row in enumerate(rows):
            ws.cell(row=start + i, column=scratch_col, value=row.get(cat_key))
            v = row.get(val_key)
            try:
                ws.cell(row=start + i, column=scratch_col + 1, value=float(v))
            except (TypeError, ValueError):
                ws.cell(row=start + i, column=scratch_col + 1, value=v)
        end = start + len(rows) - 1

        chart_cls = {"bar": BarChart, "line": LineChart, "pie": PieChart}.get(
            chart.get("type", "bar"), BarChart
        )
        ch = chart_cls()
        ch.title = chart.get("title") or chart.get("type", "chart")
        data_ref = Reference(ws, min_col=scratch_col + 1, min_row=1, max_row=end)
        cats_ref = Reference(ws, min_col=scratch_col, min_row=start, max_row=end)
        ch.add_data(data_ref, titles_from_data=True)
        ch.set_categories(cats_ref)

        anchor = chart.get("anchor") or {}
        col = int(anchor.get("col", 1))
        row = int(anchor.get("row", 1))
        ws.add_chart(ch, f"{get_column_letter(col)}{row}")


# ──────────────────────────────────────────────────────────
# Module-level helpers
# ──────────────────────────────────────────────────────────

def _compute_summary(rows: List[Dict], column: str, operation: str) -> Any:
    """Compute a summary operation on a list of row dicts."""
    values = []
    for row in rows:
        v = row.get(column)
        if isinstance(v, (int, float)):
            values.append(float(v))
        elif v is not None:
            try:
                values.append(float(str(v).replace(',', '.')))
            except (ValueError, TypeError):
                pass

    if not values:
        return 0

    ops = {
        'SUM': lambda vs: sum(vs),
        'AVG': lambda vs: sum(vs) / len(vs),
        'MIN': lambda vs: min(vs),
        'MAX': lambda vs: max(vs),
        'COUNT': lambda vs: len(vs),
    }
    try:
        import statistics
        ops['STDEV'] = lambda vs: statistics.stdev(vs) if len(vs) > 1 else 0
        ops['MEDIAN'] = lambda vs: statistics.median(vs)
        ops['VARIANCE'] = lambda vs: statistics.variance(vs) if len(vs) > 1 else 0
    except ImportError:
        pass

    fn = ops.get(operation.upper(), lambda vs: len(vs))
    result = fn(values)
    return round(result, 4) if isinstance(result, float) else result
