/**
 * NOV4 GOLD — TypeScript tarafı tek renk kaynağı.
 *
 * Bu dosya `src/styles.scss` (CSS değişkenleri) ve `tailwind.config.js`
 * (Tailwind rampaları) ile AYNI değerleri içerir. Grafikler (Chart.js,
 * Canvas 2D) ve dinamik inline renk bağlamaları buradan beslenir; böylece
 * tek bir palet değişikliği tüm uygulamaya yansır.
 *
 * Bir rengi değiştirirken ilgili yerleri senkron tutun:
 *   - styles.scss -> :root / body.dark-theme / body.light-theme
 *   - tailwind.config.js -> neutral / gold / flare / lunar rampaları
 */

/** Marka aksanları (imza renkler). */
export const BRAND = {
  primary: '#F5B301',   // altın — imza renk
  secondary: '#FF7A1A', // solar flare
  tertiary: '#7C8DB5',  // lunar çelik (soğuk kontrast)
  soft: '#FCD34D',      // açık altın (vurgu)
} as const;

/** Semantik durum renkleri. */
export const STATUS = {
  success: '#34D399',
  warning: '#F59E0B',
  danger: '#EF4444',
  error: '#EF4444',
  info: '#7C8DB5',
} as const;

/**
 * Kategorik grafik paleti (10 renk). Chart.js serileri ve Canvas çizimleri
 * için ana palet. HTML/CSS tarafındaki --chart-1..10 değişkenleriyle aynıdır.
 */
export const CHART_PALETTE: readonly string[] = [
  '#F5B301', // altın
  '#FF7A1A', // flare
  '#7C8DB5', // lunar
  '#34D399', // emerald
  '#F472B6', // rose
  '#A78BFA', // violet
  '#2DD4BF', // teal
  '#FCD34D', // açık altın
  '#60A5FA', // sky
  '#FB7185', // coral
];

/** 15 renkli genişletilmiş palet (eski chart-manager 3x5 yapısı için). */
export const CHART_PALETTE_EXT: readonly string[] = [
  ...CHART_PALETTE,
  '#F59E0B', '#8B5CF6', '#06B6D4', '#84CC16', '#EC4899',
];

/** Veri tipi -> renk haritası (widget için; Türkçe anahtarlar korundu). */
export const DATA_TYPE_COLORS: Readonly<Record<string, { border: string; bg: string; text: string }>> = {
  sicaklik: { border: '#FF7A1A', bg: 'rgba(255,122,26,0.14)', text: '#FF7A1A' }, // sıcaklık -> flare
  nem:      { border: '#60A5FA', bg: 'rgba(96,165,250,0.14)', text: '#60A5FA' }, // nem -> sky
  basinc:   { border: '#A78BFA', bg: 'rgba(167,139,250,0.14)', text: '#A78BFA' }, // basınç -> violet
  gerilim:  { border: '#F5B301', bg: 'rgba(245,179,1,0.14)', text: '#F5B301' },   // gerilim -> altın
  akim:     { border: '#2DD4BF', bg: 'rgba(45,212,191,0.14)', text: '#2DD4BF' }, // akım -> teal
  frekans:  { border: '#F472B6', bg: 'rgba(244,114,182,0.14)', text: '#F472B6' }, // frekans -> rose
  guc:      { border: '#34D399', bg: 'rgba(52,211,153,0.14)', text: '#34D399' }, // güç -> emerald
};

/** Bir rgba string üretir (hex değil, rgb bileşenleri bekler). */
export function rgba(rgb: string, alpha: number): string {
  return `rgb(${rgb} / ${alpha})`;
}

/** Paletten döngüsel olarak renk alır. */
export function chartColor(index: number): string {
  return CHART_PALETTE[((index % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length];
}
