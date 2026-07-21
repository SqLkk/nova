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
    return of([]);
  }

  getMessages(filters?: any): Observable<any> {
    return of({ data: [] });
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
