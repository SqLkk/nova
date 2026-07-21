export interface PowerQualityData {
  timestamp: Date;
  // Servisin kullandığı alanlar ile uyumlu olacak şekilde güncellendi
  active_power: number;  // Eksik özellik eklendi
  reactive_power: number;  // Eksik özellik eklendi
  apparent_power: number;  // Eksik özellik eklendi
  power_factor: number;
  voltage_thd: number;
  current_thd: number;
}

export interface PowerQualityStats {
  min_power_factor: number;
  max_power_factor: number;
  avg_power_factor: number;
  max_thd: number;
  period: string;
}

export interface PowerQualityResponse {
  data: PowerQualityData[];
  stats?: PowerQualityStats;
  status: 'success' | 'error';
  message?: string;
}