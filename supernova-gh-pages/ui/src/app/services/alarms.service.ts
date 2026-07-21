import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

export interface Alarm { id: any; [key: string]: any; }
export interface Message { id: string; [key: string]: any; }
export interface LidiEntry { id: string; [key: string]: any; }
export interface LidiSummaryItem { id: string; [key: string]: any; }

@Injectable({
  providedIn: 'root'
})
export class AlarmsService {
  constructor() {}

  getAlarms(): Observable<any[]> {
    return of([
      { id: 'log_1', severity: 'Critical', source: 'CNC Lathe E1', message: 'Spindle motor temperature critical limit exceeded (95°C). Machine enters safe halt.', timestamp: new Date(Date.now() - 5 * 60000).toISOString(), status: 'Active' },
      { id: 'log_2', severity: 'Critical', source: 'Paint Robot Spray 1', message: 'Pressure line drop detected. Paint thickness variation exceeds quality tolerances.', timestamp: new Date(Date.now() - 12 * 60000).toISOString(), status: 'Active' },
      { id: 'log_3', severity: 'Warning', source: 'Reflow Oven', message: 'Zone 3 heater element showing minor thermal deviation (+3.2°C).', timestamp: new Date(Date.now() - 25 * 60000).toISOString(), status: 'Acknowledged' },
      { id: 'log_4', severity: 'Warning', source: 'Conveyor Belt C-Main', message: 'Belt speed deviation detected. Motor current high.', timestamp: new Date(Date.now() - 40 * 60000).toISOString(), status: 'Active' }
    ]);
  }

  getMessages(filters?: any): Observable<any> {
    return of({
      data: [
        { id: 'msg_1', type: 'system', text: 'Spindle motor temperature critical limit exceeded (95°C).' },
        { id: 'msg_2', type: 'quality', text: 'Pressure line drop detected. Paint thickness variation exceeds quality tolerances.' }
      ]
    });
  }

  getMessageCount(filters?: any): Observable<any> {
    return of({ count: 0 });
  }

  getLidiSummary(): Observable<any> {
    return of({});
  }

  getLidiMessages(params?: any): Observable<any> {
    return of({ data: [] });
  }
}
