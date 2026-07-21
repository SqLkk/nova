/**
 * Veri kaynağı (data source) — güvenli (credentials hariç) istemci modeli.
 * Backend `data_sources` tablosundaki kaynaki temsil eder; şifreler asla
 * istemciye gönderilmez.
 */
export type DataSourceType = 'oracle' | 'sqlserver' | 'postgres' | 'sqlite';

export interface DataSource {
  id: string;
  name: string;
  dbType: DataSourceType;
  host?: string;
  port?: number;
  databaseName?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
