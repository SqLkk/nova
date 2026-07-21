/**
 * Nov4 Şablon Dokümanı (Template Document) — Excel benzeri grid modeli.
 *
 * Bu, görsel editörün (purpose-built grid) tek doğrusudur ve backend
 * `excel_template_engine.py` render motoruyla BİREBİR eşleşir:
 *   - Hücre `binding`         → {{PLACEHOLDER}}
 *   - `DetailBand` (aralık)   → {{#EACH collection}} ... {{/EACH}}  (dinamik satır)
 *   - `summary` binding       → engine'in summary mapping'i (SUM/AVG/...)
 *   - `ChartPlacement`        → çalışma sayfasına yerleştirilmiş grafik
 *
 * Hücre adresleri 1-indekslidir (satır, sütun) — openpyxl ile uyumlu.
 */

export interface TemplateDocument {
  id: string;
  name: string;
  description?: string;
  sheets: TemplateSheet[];
  owner?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateSheet {
  id: string;
  name: string;
  /** Grid boyutu (kullanıcı genişletebilir). */
  columnCount: number;
  rowCount: number;
  /** "r,c" anahtarlı hücre haritası (yalnızca dolu hücreler tutulur). */
  cells: Record<string, TemplateCell>;
  columnWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
  /** Query'ye bağlı tekrarlı aralıklar (detail band). */
  bands?: DetailBand[];
  /** Sayfaya yerleştirilmiş grafikler. */
  charts?: ChartPlacement[];
}

export interface TemplateCell {
  row: number;
  col: number;
  /** Ham içerik: düz metin, "{{...}}" yer tutucusu veya "=..." formülü. */
  value?: string;
  /** Ayrıştırılmış bağlama (binding) — editör için metadata. */
  binding?: CellBinding;
  style?: CellStyle;
  numberFormat?: string;
  /** Birleştirme çapasıysa: "r1,c1,r2,c2" (sol-üst hücre). */
  mergeAnchor?: string;
}

export type BindingKind = 'text' | 'query_field' | 'summary' | 'builtin' | 'formula';

export interface CellBinding {
  kind: BindingKind;
  /** query_field / summary için: başvurulan saved query id. */
  queryId?: string;
  /** query_field için: sorgu sütun adı. */
  field?: string;
  /** summary için: toplam işlemi. */
  operation?: SummaryOperation;
  /** builtin için: report_date | report_name | report_datetime | ... */
  builtin?: string;
  /** formula için: bağlanmış formül tanımı (ileride formula-manager ile). */
  formula?: string;
}

export type SummaryOperation =
  | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT'
  | 'STDEV' | 'MEDIAN' | 'VARIANCE' | 'FIRST' | 'LAST';

/** Tekrarlı satır aralığı — bir query'nin her satırı için kopyalanır. */
export interface DetailBand {
  id: string;
  /** Bu bandı besleyen saved query. */
  queryId: string;
  /** Şablondaki tekrar eden satır aralığı (1-indeksli). */
  range: CellRange;
  /** Sütun → sorgu alanı eşlemesi (col index -> field name). */
  fieldMap: Record<number, string>;
}

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface ChartPlacement {
  id: string;
  type: 'line' | 'bar' | 'pie' | 'area';
  anchor: ChartAnchor;
  /** Grafiği besleyen saved query. */
  queryId: string;
  xAxis?: string;
  yAxis?: string[];
  title?: string;
}

export interface ChartAnchor {
  row: number;
  col: number;
  /** Hücre cinsinden kapladığı alan. */
  widthCols: number;
  heightRows: number;
}

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  /** Tailwind/token rengi değil — openpyxl HEX rengi (#RRGGBB). */
  bg?: string;
  color?: string;
  fontSize?: number;
  wrap?: boolean;
}

/** Yeni boş bir hücre anahtarı üretir ("r,c"). */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Yeni boş bir doküman üretir. */
export function createEmptyDocument(name = 'Untitled Template'): TemplateDocument {
  const now = new Date().toISOString();
  return {
    id: '',
    name,
    description: '',
    sheets: [createEmptySheet('Sheet1')],
    owner: '',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function createEmptySheet(name: string, rows = 40, cols = 12): TemplateSheet {
  return {
    id: `s_${Math.random().toString(36).slice(2, 9)}`,
    name,
    rowCount: rows,
    columnCount: cols,
    cells: {},
    columnWidths: {},
    rowHeights: {},
    bands: [],
    charts: [],
  };
}
