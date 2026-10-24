/**
 * Path Definer modeli — düz sorgu satırlarını hiyerarşik yapılara çeviren
 * kayıtlı tanımlar (PathDef). Backend path_engine.py ile birebir eşleşir.
 */

export type PathStructure = 'tree' | 'binary_tree' | 'sequence' | 'grouped' | 'dag' | 'multi_level';

/** Kolon eşlemesi + ayarlar (yapı tipine göre farklı alanlar kullanılır). */
export interface PathConfig {
  /** tree/binary_tree/sequence/dag: düğüm kimliği kolonu. */
  id_col?: string;
  /** tree/binary_tree/dag: üst düğüm kolonu (dag için virgülle ayrılmış birden çok ebeveyn). */
  parent_col?: string;
  /** dag: çoklu ebeveyn kolonu alternatifi */
  parents_col?: string;
  /** hepsi: etiket (görünen ad) kolonu. */
  label_col?: string;
  /** tree/binary_tree/dag: opsiyonel tip/renk kolonu. */
  type_col?: string;
  /** tree/binary_tree: "kök" anlamına gelen parent değeri (boş = null/empty). */
  root_value?: string;
  /** sequence: bağlı liste bir sonraki kolonu. */
  next_col?: string;
  /** sequence/grouped: sıralama kolonu. */
  order_col?: string;
  /** grouped: gruplama kolonu. */
  group_col?: string;
  /** multi_level / grouped: alt grup veya çoklu seviye kolonları */
  subgroup_col?: string;
  level1_col?: string;
  level2_col?: string;
  level3_col?: string;
  level_cols?: string[];
  root_label?: string;
  /** Hedef veri / eşleşme kolonu (örn. pointid) */
  target_col?: string;
  /** Canlı sağlık puanı kolonu (örn. health_score, oee_percent) */
  health_col?: string;
  /** Canlı durum kolonu (örn. status, state) */
  status_col?: string;
  /** Rozet kolonu */
  badge_col?: string;
  /** Renk kolonu */
  color_col?: string;
  /** İkon kolonu */
  icon_col?: string;
  /** Space Map görsel/tema/ikon/layout ayarları */
  spaceMapConfig?: {
    theme?: 'cosmic' | 'factory' | 'cyber' | 'blueprint' | 'crystal';
    nodeShape?: 'auto' | 'planet' | 'hexagon' | 'cyber' | 'blueprint' | 'diamond' | 'circle';
    layout?: 'radial' | 'hierarchy-tb' | 'flow-lr' | 'grid' | 'spiral';
    color1?: string;
    color2?: string;
    color3?: string;
    level1Icon?: string;
    level2Icon?: string;
    level3Icon?: string;
    level4Icon?: string;
    autoTypeIcons?: boolean;
    showOrbits?: boolean;
    showGrid?: boolean;
  };
}

/** Yapıdaki tek düğüm. */
export interface PathNode {
  id: string;
  label: string;
  parent: string;
  parents?: string[];
  depth: number;
  /** Kök → bu düğüm id zinciri. */
  path: string[];
  type: string;
  icon?: string;
  children: string[];
  /** Canlı sağlık ve durum rozetleri */
  healthScore?: number;
  status?: string;
  statusColor?: string;
  badge?: string;
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
