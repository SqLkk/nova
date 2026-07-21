import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

export interface NetworkNode { id: string; [key: string]: any; }
export interface NetworkMapData { nodes: any[]; links: any[]; totalCount?: number; }
export interface ElementNode { id: string; [key: string]: any; }

@Injectable({
  providedIn: 'root'
})
export class NetworkMapService {
  constructor() {}

  getMapData(): Observable<any> {
    return of({ nodes: [], edges: [] });
  }

  getNetworkMap(): Observable<any> {
    return of({ nodes: [], links: [] });
  }

  getNetworkUpdates(): Observable<any> {
    return of({ nodes: [], links: [] });
  }

  clearCache(): void {}
}
