export interface Alarm {
  id?: number;
  timestamp: Date | string;
  type: 'voltage' | 'frequency' | 'power_quality' | 'system' | string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  source?: string;
  acknowledged?: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date | string;
  resolved?: boolean;
  resolvedAt?: Date | string;
  value?: number;
  threshold?: number;
  // LIDI mapped fields
  listNumber?: number;
  listName?: string;
  description?: string;
  status?: string;
  location?: {
    b1?: string;
    b2?: string;
    b3?: string;
    element?: string;
    info?: string;
  };
  tag?: string;
  operator?: string;
  meClass?: number;
  priority?: number;
  statusText?: string;
}

export interface Message {
  id: number;
  timestamp: Date | string;
  type?: string;
  message: string;
  text?: string;
  title?: string;
  source?: string;
  site?: string;
  path?: string;
  priority?: number;
  status?: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED' | 'UNKNOWN';
  severity?: 'LOW' | 'MEDIUM' | 'HIGH';
  acknowledged?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: Date | string;
  location?: {
    b1?: string;
    b2?: string;
    b3?: string;
    element?: string;
    info?: string;
  };
  details?: {
    operator?: string;
    console?: string;
    value?: string;
    unit?: string;
    msgClass?: number;
    indicator?: string;
  };
}