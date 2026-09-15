export interface Widget {
  id: string;
  title: string;
  type: 'gauge' | 'chart' | 'value' | 'table' | 'alarm' | 'timeline' | 'status-board' | 'live-stream' | 'map-view' | 'path-view' | string;
  dataSource?: string;
  dataSourceType?: 'realtime' | 'historical' | 'app' | 'sql' | 'python' | 'path';
  assignedQueryId?: string;
  assignedPythonId?: string;
  assignedPathId?: string;
  sqlValueColumn?: string;
  sqlLabelColumn?: string;
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