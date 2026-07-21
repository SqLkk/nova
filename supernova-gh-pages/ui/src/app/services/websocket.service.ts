import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, EMPTY } from 'rxjs';

/**
 * WebSocket service stub.
 * Backend artık WebSocket (flask-socketio) desteklemiyor.
 * Bu servis, mevcut interface'i koruyarak hiçbir bağlantı kurmaz.
 * Gerçek zamanlı veri akışı HTTP polling ile sağlanır (DataService).
 */

@Injectable({
  providedIn: 'root'
})
export class WebsocketService implements OnDestroy {
  private connectionStatus = new BehaviorSubject<boolean>(false);
  public connectionStatus$ = this.connectionStatus.asObservable();

  constructor() {}

  public connect(_topics: string[] = []): void {
    // No-op: WebSocket desteği kaldırıldı
  }

  public subscribe(_topics: string[]): void {
    // No-op
  }

  public unsubscribe(_topics: string[]): void {
    // No-op
  }

  public send(_data: any): void {
    // No-op
  }

  public disconnect(): void {
    // No-op
  }

  public getTopic<T>(_topic: string): Observable<T> {
    return EMPTY;
  }

  ngOnDestroy(): void {
    // No-op
  }
}
