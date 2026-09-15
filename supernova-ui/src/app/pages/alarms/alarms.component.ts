import { Component, OnInit } from '@angular/core';
import { AlarmsService, AlarmItem } from '../../services/alarms.service';
import { AuthService } from '../../services/auth.service';

@Component({
  standalone: false,
  selector: 'app-alarms',
  templateUrl: './alarms.component.html',
  styleUrls: ['./alarms.component.scss']
})
export class AlarmsComponent implements OnInit {
  alarms: AlarmItem[] = [];
  filteredAlarms: AlarmItem[] = [];
  
  // Filters
  searchTerm = '';
  selectedSeverity = 'all'; // all, critical, warning, info
  selectedStatus = 'all'; // all, active, acknowledged, resolved
  selectedLocation = 'all';

  // Counts
  totalCount = 0;
  criticalCount = 0;
  warningCount = 0;
  infoCount = 0;
  activeCount = 0;
  acknowledgedCount = 0;
  resolvedCount = 0;

  currentUserRole = 'Operatör';

  constructor(
    private alarmsService: AlarmsService,
    private authService: AuthService
  ) {}

  ngOnInit(): void {
    this.authService.currentUser$.subscribe(u => {
      if (u?.displayName) {
        this.currentUserRole = u.displayName;
      }
    });
    this.loadAlarms();
  }

  loadAlarms(): void {
    this.alarmsService.getAlarms().subscribe(data => {
      this.alarms = data;
      this.calculateCounts();
      this.applyFilters();
    });
  }

  calculateCounts(): void {
    this.totalCount = this.alarms.length;
    this.criticalCount = this.alarms.filter(a => a.severity === 'critical' && a.status !== 'resolved').length;
    this.warningCount = this.alarms.filter(a => a.severity === 'warning' && a.status !== 'resolved').length;
    this.infoCount = this.alarms.filter(a => a.severity === 'info').length;
    this.activeCount = this.alarms.filter(a => a.status === 'active').length;
    this.acknowledgedCount = this.alarms.filter(a => a.status === 'acknowledged').length;
    this.resolvedCount = this.alarms.filter(a => a.status === 'resolved').length;
  }

  applyFilters(): void {
    this.filteredAlarms = this.alarms.filter(a => {
      const matchesSearch = 
        !this.searchTerm ||
        a.source.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        a.message.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        a.location.toLowerCase().includes(this.searchTerm.toLowerCase());

      const matchesSeverity = 
        this.selectedSeverity === 'all' || a.severity === this.selectedSeverity;

      const matchesStatus = 
        this.selectedStatus === 'all' || a.status === this.selectedStatus;

      const matchesLocation =
        this.selectedLocation === 'all' || a.location.toLowerCase().includes(this.selectedLocation.toLowerCase());

      return matchesSearch && matchesSeverity && matchesStatus && matchesLocation;
    });
  }

  setSeverityFilter(sev: string): void {
    this.selectedSeverity = sev;
    this.applyFilters();
  }

  setStatusFilter(status: string): void {
    this.selectedStatus = status;
    this.applyFilters();
  }

  setLocationFilter(loc: string): void {
    this.selectedLocation = loc;
    this.applyFilters();
  }

  acknowledge(alarm: AlarmItem): void {
    this.alarmsService.acknowledgeAlarm(alarm.id, this.currentUserRole).subscribe(() => {
      alarm.status = 'acknowledged';
      alarm.acknowledgedBy = this.currentUserRole;
      this.calculateCounts();
      this.applyFilters();
    });
  }

  resolve(alarm: AlarmItem): void {
    this.alarmsService.resolveAlarm(alarm.id, this.currentUserRole).subscribe(() => {
      alarm.status = 'resolved';
      alarm.resolvedBy = this.currentUserRole;
      this.calculateCounts();
      this.applyFilters();
    });
  }

  triggerSimulatedAlarm(): void {
    this.alarmsService.triggerRandomAlarm();
    this.loadAlarms();
  }

  getTimeAgo(dateStr: string): string {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const diffMin = Math.floor(diffMs / (1000 * 60));
    if (diffMin < 1) return 'Az önce';
    if (diffMin < 60) return `${diffMin} dk önce`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} sa önce`;
    return `${Math.floor(diffHours / 24)} gün önce`;
  }
}
