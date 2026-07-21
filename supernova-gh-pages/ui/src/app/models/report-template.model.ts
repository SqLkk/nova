export interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  format: 'xlsx' | 'pdf' | 'csv';
  isActive: boolean;
  sections: ReportSection[];
  schedule?: ReportSchedule;
  recipients?: string[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface ReportSection {
  id: string;
  title: string;
  type: 'table' | 'chart' | 'summary' | 'kpi' | 'text';
  order: number;
  dataPaths: DataPathMapping[];
  config: SectionConfig;
}

export interface DataPathMapping {
  id: string;
  label: string;
  dataPath: string;
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'last';
  unit?: string;
  format?: string; // e.g., "0.00", "0,0.00"
  threshold?: {
    warning?: number;
    critical?: number;
  };
}

export interface SectionConfig {
  // Table config
  columns?: string[];
  showTotals?: boolean;
  showAverages?: boolean;
  
  // Chart config
  chartType?: 'line' | 'bar' | 'pie' | 'area' | 'gauge';
  xAxis?: string;
  yAxis?: string[];
  
  // KPI config
  target?: number;
  comparison?: 'previous_period' | 'target' | 'none';
  
  // General
  backgroundColor?: string;
  showHeader?: boolean;
  customStyle?: any;
}

export interface ReportSchedule {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  time: string; // HH:mm format
  dayOfWeek?: number; // 0-6 for weekly
  dayOfMonth?: number; // 1-31 for monthly
  monthOfYear?: number; // 1-12 for yearly
  timezone: string;
  lastRun?: Date;
  nextRun?: Date;
}

export interface GeneratedReport {
  id: string;
  templateId: string;
  templateName: string;
  type: string;
  format: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  generatedAt: Date;
  generatedBy: string;
  fileUrl?: string;
  fileSize?: number;
  error?: string;
  period: {
    startDate: Date;
    endDate: Date;
  };
  metadata?: {
    totalRecords?: number;
    sections?: number;
    charts?: number;
  };
}

export interface ReportGenerationRequest {
  templateId: string;
  period: {
    startDate: Date;
    endDate: Date;
  };
  format?: 'xlsx' | 'pdf' | 'csv';
  recipients?: string[];
  sendEmail?: boolean;
}
