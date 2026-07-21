export interface VoltageData {
  timestamp: Date;
  phase_a: number;
  phase_b: number;
  phase_c: number;
  unbalance: number;  // Eksik özellik eklendi
}

export interface VoltageStats {
  min: number;
  max: number;
  avg: number;
  period: string;
}

export interface VoltageResponse {
  data: VoltageData[];
  stats?: VoltageStats;
  status: 'success' | 'error';
  message?: string;
}