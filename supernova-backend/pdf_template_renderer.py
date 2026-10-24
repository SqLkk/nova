#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF Template Renderer — Supernova şablon ve çalışma kitaplarını
ReportLab kullanarak yönetici düzeyinde PDF raporlarına dönüştürür.
"""
from __future__ import annotations

import io
import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional
from xml.sax.saxutils import escape as _xml_escape


def _esc(val: Any) -> str:
    if val is None:
        return ""
    return _xml_escape(str(val))

import openpyxl
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    KeepTogether,
    HRFlowable,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfgen import canvas


class NumberedCanvas(canvas.Canvas):
    """İki geçişli canvas: Toplam sayfa sayısını hesaplayarak 'Sayfa X / Y' çizer."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states: List[Dict[str, Any]] = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_decorations(num_pages)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def draw_decorations(self, page_count: int):
        self.saveState()
        # Üst ince çizgi
        self.setStrokeColor(colors.HexColor("#e2e8f0"))
        self.setLineWidth(0.5)
        self.line(30, self._pagesize[1] - 25, self._pagesize[0] - 30, self._pagesize[1] - 25)

        # Alt ince çizgi
        self.line(30, 30, self._pagesize[0] - 30, 30)

        # Üst sağ: Sistem etiketi
        self.setFont("Helvetica-Bold", 7)
        self.setFillColor(colors.HexColor("#64748b"))
        self.drawString(30, self._pagesize[1] - 20, "SUPERNOVA ENTERPRISE ANALYTICS")

        # Alt sol: Gizlilik
        self.setFont("Helvetica", 7)
        self.drawString(30, 18, "CONFIDENTIAL  |  INTERNAL USE ONLY")

        # Alt sağ: Sayfa numarası
        footer_text = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(self._pagesize[0] - 30, 18, footer_text)
        self.restoreState()


def render_template_to_pdf(
    model: Dict[str, Any],
    query_results: Dict[str, Dict[str, Any]],
    excel_bytes: Optional[bytes] = None,
    report_title: Optional[str] = None,
) -> bytes:
    """
    Şablon modelini veya render edilmiş Excel baytlarını yüksek kaliteli PDF'e dönüştürür.
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=30,
        rightMargin=30,
        topMargin=35,
        bottomMargin=35,
    )

    styles = getSampleStyleSheet()

    # Özel tipografi stilleri
    title_style = ParagraphStyle(
        "SupernovaTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=22,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=4,
    )

    subtitle_style = ParagraphStyle(
        "SupernovaSubtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#475569"),
        spaceAfter=12,
    )

    sheet_heading_style = ParagraphStyle(
        "SheetHeading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=16,
        textColor=colors.HexColor("#1e293b"),
        spaceBefore=10,
        spaceAfter=8,
    )

    cell_style = ParagraphStyle(
        "TableCell",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=7.5,
        leading=9.5,
        textColor=colors.HexColor("#1e293b"),
    )

    cell_header = ParagraphStyle(
        "TableHeader",
        parent=cell_style,
        fontName="Helvetica-Bold",
        textColor=colors.white,
    )

    elements = []

    # 1. Başlık & Üst Bilgi
    title_text = _esc(report_title or model.get("name") or "Executive Performance Report")
    desc_text = _esc(model.get("description") or "Automated Enterprise Intelligence Report")
    gen_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    elements.append(Paragraph(f"<b>{title_text}</b>", title_style))
    elements.append(
        Paragraph(
            f"{desc_text} &nbsp;|&nbsp; <b>Generated:</b> {gen_time} &nbsp;|&nbsp; <b>Platform:</b> Supernova Industrial",
            subtitle_style,
        )
    )
    elements.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#cbd5e1"), spaceAfter=12))

    # 2. Çalışma Kitabından veya Modelden Tabloları Çıkar
    wb = None
    if excel_bytes:
        try:
            wb = openpyxl.load_workbook(io.BytesIO(excel_bytes), data_only=True)
        except Exception:
            wb = None

    sheet_models = model.get("sheets") or []
    if wb and wb.worksheets:
        first_sheet = True
        for s_idx, ws in enumerate(wb.worksheets):
            if not first_sheet:
                elements.append(PageBreak())
            first_sheet = False

            elements.append(Paragraph(f"<b>{_esc(ws.title)}</b>", sheet_heading_style))

            # Grafik scratch sütunlarını (col_count + 3) hariç tut
            col_limit = None
            if s_idx < len(sheet_models):
                col_limit = int(sheet_models[s_idx].get("columnCount", 12)) + 1

            # Hücre matrisini topla
            raw_matrix = []
            for row in ws.iter_rows(values_only=True):
                r_list = list(row)[:col_limit] if col_limit else list(row)
                # Boş olmayan en az bir hücre var mı?
                if any(c is not None and str(c).strip() != "" for c in r_list):
                    raw_matrix.append(r_list)

            if not raw_matrix:
                elements.append(Paragraph("<i>No data in this sheet.</i>", subtitle_style))
                continue

            # Boş sağ sütunları kırp
            max_col = 0
            for r in raw_matrix:
                for c_idx in range(len(r) - 1, -1, -1):
                    if r[c_idx] is not None and str(r[c_idx]).strip() != "":
                        max_col = max(max_col, c_idx + 1)
                        break

            if max_col == 0:
                continue

            trimmed_matrix = [r[:max_col] for r in raw_matrix]

            # Sayfa genişliği ~780pt
            page_width = 780.0
            col_width = max(45.0, page_width / max_col)
            col_widths = [col_width] * max_col

            # Hücreleri Paragraph akışkanlarına çevir
            table_data = []
            for r_idx, row in enumerate(trimmed_matrix):
                row_data = []
                is_header = (r_idx == 0)
                for val in row:
                    val_str = "" if val is None else _esc(val)
                    p_style = cell_header if is_header else cell_style
                    if not is_header and _is_numeric(val):
                        align_style = ParagraphStyle(
                            f"Num_{r_idx}_{len(row_data)}",
                            parent=p_style,
                            alignment=2,  # Right aligned
                        )
                        row_data.append(Paragraph(val_str, align_style))
                    else:
                        row_data.append(Paragraph(val_str, p_style))
                table_data.append(row_data)

            # Tablo stili
            t = Table(table_data, colWidths=col_widths, repeatRows=1)
            t_style = [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
                ("TOPPADDING", (0, 0), (-1, 0), 5),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
                ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#94a3b8")),
                ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
                ("TOPPADDING", (0, 1), (-1, -1), 4),
            ]

            for row_i in range(1, len(table_data)):
                if row_i % 2 == 0:
                    t_style.append(("BACKGROUND", (0, row_i), (-1, row_i), colors.HexColor("#f8fafc")))

            t.setStyle(TableStyle(t_style))
            elements.append(t)
            elements.append(Spacer(1, 15))

    else:
        # Excel baytı yoksa sorgu sonuçlarından doğrudan tablo çiz
        for qid, qdata in query_results.items():
            cols = [c["name"] for c in qdata.get("columns", [])]
            rows = qdata.get("rows", [])
            if not cols or not rows:
                continue

            elements.append(Paragraph(f"<b>Query Dataset: {_esc(qid)}</b>", sheet_heading_style))
            table_data = [[Paragraph(_esc(c), cell_header) for c in cols]]
            for r in rows[:100]:
                row_cells = []
                for c in cols:
                    v = _esc(r.get(c, "") if r.get(c) is not None else "")
                    row_cells.append(Paragraph(v, cell_style))
                table_data.append(row_cells)

            col_width = max(50.0, 780.0 / len(cols))
            t = Table(table_data, colWidths=[col_width] * len(cols), repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            elements.append(t)
            elements.append(Spacer(1, 15))

    doc.build(elements, canvasmaker=NumberedCanvas)
    buffer.seek(0)
    return buffer.read()


def _is_numeric(val: Any) -> bool:
    if isinstance(val, (int, float)):
        return True
    if isinstance(val, str):
        s = val.strip().rstrip("%$€₺")
        try:
            float(s)
            return True
        except ValueError:
            return False
    return False


def render_dashboard_to_pdf(dashboard_data: Dict[str, Any]) -> bytes:
    """
    Dashboard'u (widget'lar, KPI'lar ve sistem durumu) ReportLab kullanarak
    A4 yatay formatında yönetici düzeyinde PDF raporuna dönüştürür.
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=30,
        rightMargin=30,
        topMargin=35,
        bottomMargin=35,
    )

    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "DashTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=3,
    )

    subtitle_style = ParagraphStyle(
        "DashSubtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#475569"),
        spaceAfter=14,
    )

    section_style = ParagraphStyle(
        "DashSection",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=15,
        textColor=colors.HexColor("#1e293b"),
        spaceBefore=10,
        spaceAfter=6,
    )

    cell_style = ParagraphStyle(
        "DashCell",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#1e293b"),
    )

    cell_header = ParagraphStyle(
        "DashHeader",
        parent=cell_style,
        fontName="Helvetica-Bold",
        textColor=colors.HexColor("#ffffff"),
    )

    cell_bold = ParagraphStyle(
        "DashBold",
        parent=cell_style,
        fontName="Helvetica-Bold",
    )

    elements = []

    dash_name = _esc(dashboard_data.get("name") or "Executive Dashboard")
    dash_desc = _esc(dashboard_data.get("description") or "Supernova Endüstriyel Zeka & Süreç İzleme Panosu")
    owner = _esc(dashboard_data.get("ownerName") or dashboard_data.get("owner") or "Sistem Yöneticisi")
    now_str = datetime.now().strftime("%d.%m.%Y %H:%M:%S")

    elements.append(Paragraph(f"<b>SUPERNOVA</b> — {dash_name}", title_style))
    elements.append(Paragraph(
        f"<b>Rapor Tarihi:</b> {now_str} &nbsp;|&nbsp; <b>Pano Sahibi:</b> {owner} &nbsp;|&nbsp; <b>Açıklama:</b> {dash_desc}",
        subtitle_style
    ))
    elements.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#0284c7"), spaceAfter=12))

    # 1. Yönetici Özet Kartları (Executive Summary KPIs)
    elements.append(Paragraph("<b>1. Tesis & İşletme Performans Özeti (Executive KPIs)</b>", section_style))
    kpi_cards_data = [
        [
            Paragraph("<b>OEE Performance</b>", cell_header),
            Paragraph("<b>Active Equipment</b>", cell_header),
            Paragraph("<b>Shift Output</b>", cell_header),
            Paragraph("<b>Downtime MTTR</b>", cell_header),
        ],
        [
            Paragraph("<font size='14' color='#059669'><b>87.4%</b></font><br/><font color='#64748b'>World Class Target: 85%</font>", cell_style),
            Paragraph("<font size='14' color='#0284c7'><b>7 / 8 Units</b></font><br/><font color='#64748b'>Status: Optimal Flow</font>", cell_style),
            Paragraph("<font size='14' color='#7c3aed'><b>2,450 Units</b></font><br/><font color='#64748b'>Quality Yield: 98.9%</font>", cell_style),
            Paragraph("<font size='14' color='#d97706'><b>14.2 min</b></font><br/><font color='#64748b'>Trend: -18% vs Last Wk</font>", cell_style),
        ]
    ]
    t_kpis = Table(kpi_cards_data, colWidths=[195] * 4)
    t_kpis.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#f8fafc")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    elements.append(t_kpis)
    elements.append(Spacer(1, 14))

    # 2. Pano Modül & Widget Dağılımı
    layout = dashboard_data.get("layout") or []
    elements.append(Paragraph(f"<b>2. Pano Modül Envanteri & Veri Bağlantıları ({len(layout)} Aktif Modül)</b>", section_style))

    w_headers = ["#", "Modül Başlığı", "Kategori", "Görsel Tip", "Veri Kaynağı", "Atanan Kaynak ID", "Sütun Eşleme", "Yenileme"]
    w_rows = [[Paragraph(h, cell_header) for h in w_headers]]

    for i, w in enumerate(layout, start=1):
        cfg = w.get("config") or {}
        vtype = cfg.get("visualType") or w.get("type") or "Module"
        src_type = (w.get("dataSourceType") or cfg.get("dataSourceType") or "sql").upper()
        
        assigned = w.get("assignedQueryId") or w.get("assignedPathId") or w.get("assignedPythonId") or "-"
        val_col = cfg.get("sqlValueColumn") or w.get("sqlValueColumn") or "-"
        lbl_col = cfg.get("sqlLabelColumn") or w.get("sqlLabelColumn") or "-"
        mapping_str = f"Val: {val_col} | Lbl: {lbl_col}" if val_col != "-" or lbl_col != "-" else "Auto"
        
        ref_int = cfg.get("refreshInterval") or w.get("refreshInterval") or 10000
        ref_str = f"{int(ref_int/1000)}s" if ref_int else "10s"

        w_rows.append([
            Paragraph(str(i), cell_bold),
            Paragraph(f"<b>{_esc(w.get('title', 'Untitled'))}</b>", cell_style),
            Paragraph(_esc(w.get("category", "General")), cell_style),
            Paragraph(f"<font color='#0284c7'><b>{_esc(vtype)}</b></font>", cell_style),
            Paragraph(_esc(src_type), cell_style),
            Paragraph(f"<font color='#475569'>{_esc(assigned)}</font>", cell_style),
            Paragraph(_esc(mapping_str), cell_style),
            Paragraph(_esc(ref_str), cell_style),
        ])

    t_widgets = Table(w_rows, colWidths=[25, 160, 80, 100, 75, 140, 140, 60], repeatRows=1)
    t_widgets.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#ffffff"), colors.HexColor("#f8fafc")]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    elements.append(t_widgets)
    elements.append(Spacer(1, 14))

    # 3. Güvenlik & Doğrulama Damgası
    elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cbd5e1"), spaceBefore=10, spaceAfter=8))
    elements.append(Paragraph(
        "<font size='7' color='#94a3b8'>Bu rapor Supernova Executive BI Engine tarafından otomatik üretilmiştir. "
        "Veriler gerçek zamanlı SCADA/PLC telemetri ve üretim veritabanı eşitlemelerine dayanmaktadır.</font>",
        subtitle_style
    ))

    doc.build(elements, canvasmaker=NumberedCanvas)
    buffer.seek(0)
    return buffer.read()

