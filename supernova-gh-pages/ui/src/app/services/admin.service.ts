import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { ApiService } from './api.service';

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  constructor(private apiService: ApiService) {}

  getSystemSettings(): Observable<any> {
    return of({ theme: 'supernova', version: '2.0.0' });
  }

  syncDatasources(): Observable<any> {
    return of({ success: true });
  }

  getUsers(): Observable<any> {
    return of({ users: [] });
  }
}
