/**
 * Path Definer modeli — düz sorgu satırlarını hiyerarşik yapılara çeviren
 * kayıtlı tanımlar (PathDef). Backend path_engine.py ile birebir eşleşir.
 */

export type PathStructure = 'tree' | 'binary_tree' | 'sequence' | 'grouped';

/** Kolon eşlemesi + ayarlar (yapı tipine göre farklı alanlar kullanılır). */
export interface PathConfig {
  /** tree/binary_tree/sequence: düğüm kimliği kolonu. */
  id_col?: string;
  /** tree/binary_tree: üst düğüm kolonu. */
  parent_col?: string;
  /** hepsi: etiket (görünen ad) kolonu. */
  label_col?: string;
  /** tree/binary_tree: opsiyonel tip/renk kolonu. */
  type_col?: string;
  /** tree/binary_tree: "kök" anlamına gelen parent değeri (boş = null/empty). */
  root_value?: string;
  /** sequence: bağlı liste bir sonraki kolonu. */
  next_col?: string;
  /** sequence/grouped: sıralama kolonu. */
  order_col?: string;
  /** grouped: gruplama kolonu. */
  group_col?: string;
  /** Hedef veri / eşleşme kolonu (örn. pointid) */
  target_col?: string;
}

/** Yapıdaki tek düğüm. */
export interface PathNode {
  id: string;
  label: string;
  parent: string;
  depth: number;
  /** Kök → bu düğüm id zinciri. */
  path: string[];
  type: string;
  children: string[];
  /** Orijinal sorgu satırı (arama/önizleme için). */
  row?: Record<string, unknown>;
}

export interface BuiltStructure {
  nodes: PathNode[];
  roots: string[];
  /** Kök → yaprak id zincirleri. */
  paths: string[][];
  stats: {
    node_count: number;
    path_count: number;
    max_depth: number;
    warnings: string[];
  };
}

/** Kayıtlı path tanımı. */
export interface PathDef {
  id: string;
  name: string;
  description?: string;
  queryId: string;
  structure: PathStructure;
  config: PathConfig;
  owner?: string;
  allowedRoles?: string[];
  allowedUsers?: string[];
  /** Son /build ile cache'lenen yapı. */
  materialized?: BuiltStructure | null;
  materializedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Arama eşleşmesi. */
export interface SearchHit {
  id: string;
  label: string;
  type: string;
  depth: number;
  path: string[];
  /** Okunabilir kök → düğüm etiket yolu. */
  breadcrumb: string[];
}

/** /preview yanıtı. */
export interface PreviewResult {
  columns: string[];
  structure: BuiltStructure;
}

/** /search yanıtı. */
export interface SearchResult {
  hits: SearchHit[];
  stats: BuiltStructure['stats'];
}

/** UI'da yapı tipi seçenekleri. */
export interface StructureOption {
  value: PathStructure;
  label: string;
  icon: string;
  hint: string;
}
