export interface Report {
  id?: string;
  name: string;
  description?: string;
  type: 'voltage' | 'frequency' | 'power_quality' | 'energy' | 'custom' | 'analog_aggregate' | 'analog_raw' | 'digital' | 'messages' | 'raw';
  createdAt: Date | string;
  createdBy?: string;
  startDate: Date | string;
  endDate: Date | string;
  startTime?: string; // Başlangıç saati (HH:mm formatında)
  endTime?: string; // Bitiş saati (HH:mm formatında)
  cycleValue?: number; // Analog aggregate raporlar için
  cycleUnit?: string; // Analog aggregate raporlar için ('M', 'H', 'D' gibi)
  selectedPaths?: string[]; // Seçilen path'ler
  parameters?: {[key: string]: any};
  status: 'generating' | 'ready' | 'error' | 'scheduled' | 'pending' | 'processing' | 'completed' | 'failed' | 'queued' | 'running';
  fileUrl?: string;
  fileType?: 'pdf' | 'excel' | 'csv' | 'json';
  fileSize?: string; // Dosya boyutu eklendi
  progress?: number; // İlerleme yüzdesi eklendi
  error?: string;
  is_shared?: number;
  shared_with?: string;
}