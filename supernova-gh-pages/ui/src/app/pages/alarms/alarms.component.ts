import { Component, OnInit } from '@angular/core';

export interface SystemLog {
  id: string;
  severity: 'Critical' | 'Warning' | 'Info';
  source: string;
  message: string;
  timestamp: string;
  status: 'Active' | 'Resolved' | 'Acknowledged';
}

@Component({
  standalone: false,
  selector: 'app-alarms',
  templateUrl: './alarms.component.html',
  styleUrls: ['./alarms.component.scss']
})
export class AlarmsComponent implements OnInit {
  logs: SystemLog[] = [
    {
      id: 'log_1',
      severity: 'Critical',
      source: 'CNC Lathe E1',
      message: 'Spindle motor temperature critical limit exceeded (95°C). Machine enters safe halt.',
      timestamp: new Date(Date.now() - 5 * 60000).toISOString(),
      status: 'Active'
    },
    {
      id: 'log_2',
      severity: 'Critical',
      source: 'Paint Robot Spray 1',
      message: 'Pressure line drop detected. Paint thickness variation exceeds quality tolerances.',
      timestamp: new Date(Date.now() - 12 * 60000).toISOString(),
      status: 'Active'
    },
    {
      id: 'log_3',
      severity: 'Warning',
      source: 'Reflow Oven',
      message: 'Zone 3 heater element showing minor thermal deviation (+3.2°C).',
      timestamp: new Date(Date.now() - 25 * 60000).toISOString(),
      status: 'Acknowledged'
    },
    {
      id: 'log_4',
      severity: 'Warning',
      source: 'Conveyor Belt C-Main',
      message: 'Belt speed deviation detected. Motor current high.',
      timestamp: new Date(Date.now() - 40 * 60000).toISOString(),
      status: 'Active'
    },
    {
      id: 'log_5',
      severity: 'Info',
      source: 'Stretch Wrapper',
      message: 'Film roll replacement completed successfully.',
      timestamp: new Date(Date.now() - 60 * 60000).toISOString(),
      status: 'Resolved'
    },
    {
      id: 'log_6',
      severity: 'Info',
      source: 'SQL Sync Service',
      message: 'Database synchronization complete. 21 machines metrics updated.',
      timestamp: new Date(Date.now() - 75 * 60000).toISOString(),
      status: 'Resolved'
    },
    {
      id: 'log_7',
      severity: 'Warning',
      source: 'Drying Oven 1',
      message: 'Pre-heating cycle took longer than expected baseline.',
      timestamp: new Date(Date.now() - 120 * 60000).toISOString(),
      status: 'Acknowledged'
    }
  ];

  filteredLogs: SystemLog[] = [];
  searchTerm = '';
  severityFilter = 'All';

  constructor() {}

  ngOnInit(): void {
    this.applyFilters();
  }

  applyFilters(): void {
    this.filteredLogs = this.logs.filter(log => {
      const matchesSearch = log.source.toLowerCase().includes(this.searchTerm.toLowerCase()) || 
                            log.message.toLowerCase().includes(this.searchTerm.toLowerCase());
      
      const matchesSeverity = this.severityFilter === 'All' || log.severity === this.severityFilter;
      
      return matchesSearch && matchesSeverity;
    });
  }

  acknowledgeLog(log: SystemLog): void {
    log.status = 'Acknowledged';
    this.applyFilters();
  }

  resolveLog(log: SystemLog): void {
    log.status = 'Resolved';
    this.applyFilters();
  }
}
