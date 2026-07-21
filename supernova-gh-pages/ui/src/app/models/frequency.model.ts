export interface FrequencyData {
  timestamp: Date;
  value: number;
  min: number;  // Eksik özellik eklendi
  max: number;  // Eksik özellik eklendi
}

export interface FrequencyStats {
  min: number;
  max: number;
  avg: number;
  period: string;
}

export interface FrequencyResponse {
  data: FrequencyData[];
  stats?: FrequencyStats;
  status: 'success' | 'error';
  message?: string;
}