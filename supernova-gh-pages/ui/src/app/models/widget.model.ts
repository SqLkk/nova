export interface Widget {
  id: string;
  title: string;
  type: 'gauge' | 'chart' | 'value' | 'table' | 'alarm';
  dataSource: string;
  position?: {
    x: number;
    y: number;
    cols: number;
    rows: number;
  };
  settings?: {
    refreshInterval?: number;
    chartType?: string;
    color?: string;
    thresholds?: {
      warning?: number;
      danger?: number;
    };
    unit?: string;
    decimals?: number;
    showTrend?: boolean;
    timeRange?: string;
  };
  lastUpdated?: Date | string;
  data?: any;
}