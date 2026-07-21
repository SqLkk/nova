import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  status: 'active' | 'suspended';
  lastLogin: string;
}

export interface DataSourceConfig {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  is_active: number;
}

@Component({
  selector: 'app-admin',
  templateUrl: './admin.component.html',
  styleUrls: ['./admin.component.scss'],
  standalone: false
})
export class AdminComponent implements OnInit {
  activeTab: 'users' | 'datasources' | 'settings' = 'users';

  users: User[] = [
    { id: '1', name: 'System Admin', email: 'admin@supernova.com', role: 'admin', status: 'active', lastLogin: 'Just now' },
    { id: '2', name: 'Data Analyst', email: 'analyst@supernova.com', role: 'editor', status: 'active', lastLogin: '2 hours ago' },
    { id: '3', name: 'Executive Viewer', email: 'exec@supernova.com', role: 'viewer', status: 'active', lastLogin: '1 day ago' },
  ];

  dataSources: DataSourceConfig[] = [];
  
  // Modal state
  showResourceModal = false;
  isTesting = false;
  isSaving = false;
  testResult: { success: boolean, message: string } | null = null;
  showPassword = false;
  
  newResource = {
    name: '',
    db_type: 'sqlite',
    host: '',
    port: 0,
    username: '',
    password: '',
    database_name: ''
  };

  dbTypes = [
    { id: 'sqlite', name: 'SQLite (Local)' },
    { id: 'oracle', name: 'Oracle' },
    { id: 'postgres', name: 'PostgreSQL' },
    { id: 'mysql', name: 'MySQL' }
  ];

  constructor(private http: HttpClient) { }

  ngOnInit(): void {
    this.loadDataSources();
  }

  setTab(tab: 'users' | 'datasources' | 'settings'): void {
    this.activeTab = tab;
  }

  deleteUser(id: string): void {
    this.users = this.users.filter(u => u.id !== id);
  }

  loadDataSources(): void {
    this.http.get<any>(`${environment.apiUrl}/datasources`).subscribe(res => {
      if (res && res.success) {
        this.dataSources = res.data;
      }
    });
  }

  openResourceModal(): void {
    this.showResourceModal = true;
    this.testResult = null;
    this.newResource = {
      name: '',
      db_type: 'sqlite',
      host: '',
      port: 0,
      username: '',
      password: '',
      database_name: ''
    };
  }

  closeResourceModal(): void {
    this.showResourceModal = false;
  }

  testConnection(): void {
    this.isTesting = true;
    this.testResult = null;
    this.http.post<any>(`${environment.apiUrl}/datasources/test`, this.newResource).subscribe({
      next: (res) => {
        this.isTesting = false;
        this.testResult = { success: true, message: 'Connection successful!' };
      },
      error: (err) => {
        this.isTesting = false;
        this.testResult = { success: false, message: err.error?.error || 'Connection failed.' };
      }
    });
  }

  saveResource(): void {
    if (!this.newResource.name || !this.newResource.db_type) return;
    
    this.isSaving = true;
    this.testResult = null;
    
    // First test the connection
    this.http.post<any>(`${environment.apiUrl}/datasources/test`, this.newResource).subscribe({
      next: (testRes) => {
        // If test is successful, save the data source
        this.http.post<any>(`${environment.apiUrl}/datasources`, this.newResource).subscribe({
          next: (res) => {
            this.isSaving = false;
            this.closeResourceModal();
            this.loadDataSources();
          },
          error: (err) => {
            this.isSaving = false;
            const msg = err.error?.error || err.message || 'Unknown error';
            this.testResult = { success: false, message: 'Tested OK, but failed to save: ' + msg };
          }
        });
      },
      error: (err) => {
        this.isSaving = false;
        const msg = err.error?.error || err.message || 'Unknown error';
        this.testResult = { success: false, message: 'Connection Failed: ' + msg };
      }
    });
  }
}
