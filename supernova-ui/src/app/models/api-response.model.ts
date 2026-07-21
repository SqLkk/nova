export interface ApiResponse<T> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
  timestamp?: Date | string;
  errors?: { [field: string]: string };
  pagination?: {
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
  };
}

export interface WebSocketMessage<T> {
  type: 'data' | 'notification' | 'error' | 'status' | 'control';
  payload: T;
  timestamp: Date | string;
  topic?: string;
}