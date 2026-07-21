import { Component, EventEmitter, HostListener, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Report } from '../../../models/report.model';
import { AuthService } from '../../../services/auth.service';

@Component({
  standalone: false,
  selector: 'app-report-list',
  templateUrl: './report-list.component.html',
  styleUrls: ['./report-list.component.scss']
})
export class ReportListComponent implements OnInit, OnChanges {
  @Input() reports: Report[] = [];
  @Input() isLoading: boolean = false;
  @Input() error: string | null = null;
  @Input() runningReports: Set<string> = new Set();
  @Input() reportOutput: { [key: string]: any } = {};
  @Input() showOutput: { [key: string]: boolean } = {};
  @Input() compactMode: boolean = false;
  
  @Output() reportView = new EventEmitter<Report>();
  @Output() reportDownload = new EventEmitter<Report>();
  @Output() reportDelete = new EventEmitter<Report>();
  @Output() reportEdit = new EventEmitter<Report>();
  @Output() reportSchedule = new EventEmitter<Report>();
  @Output() reportUpdated = new EventEmitter<Report>();
  @Output() startReport = new EventEmitter<Report>();
  @Output() toggleOutput = new EventEmitter<string>();
  @Output() refresh = new EventEmitter<void>();
  @Output() customizeReport = new EventEmitter<Report>();
  @Output() reportShare = new EventEmitter<Report>();

  constructor(
    private translate: TranslateService,
    private authService: AuthService
  ) { }

  openMenuId: string | number | null = null;

  toggleActionMenu(reportId: string | number): void {
    this.openMenuId = this.openMenuId === reportId ? null : reportId;
  }

  closeActionMenu(): void {
    this.openMenuId = null;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.relative')) {
      this.openMenuId = null;
    }
  }

  ngOnInit(): void {
  }

  ngOnChanges(changes: SimpleChanges): void {
  }

  // Track function for ngFor performance
  trackByReportId(index: number, report: Report): any {
    return report.id || index;
  }

  // File type styling methods
  getFileTypeClasses(fileType: string | undefined): string {
    switch (fileType?.toLowerCase()) {
      case 'pdf':
        return 'bg-gradient-to-r from-red-500 to-red-600';
      case 'excel':
      case 'xlsx':
        return 'bg-gradient-to-r from-green-500 to-green-600';
      case 'csv':
        return 'bg-gradient-to-r from-blue-500 to-blue-600';
      default:
        return 'bg-gradient-to-r from-slate-500 to-slate-600';
    }
  }

  getFileTypeIcon(fileType: string | undefined): string {
    switch (fileType?.toLowerCase()) {
      case 'pdf':
        return 'fas fa-file-pdf';
      case 'excel':
      case 'xlsx':
        return 'fas fa-file-excel';
      case 'csv':
        return 'fas fa-file-csv';
      default:
        return 'fas fa-file-alt';
    }
  }

  // Status styling methods
  getStatusClasses(status: string): string {
    switch (status) {
      case 'ready':
      case 'completed':
        return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      case 'generating':
      case 'processing':
      case 'running':
        return 'bg-blue-500/20 text-blue-400 border border-blue-500/30';
      case 'queued':
      case 'pending':
        return 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
      case 'scheduled':
        return 'bg-amber-500/20 text-amber-400 border border-amber-500/30';
      case 'error':
      case 'failed':
        return 'bg-red-500/20 text-red-400 border border-red-500/30';
      default:
        return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    }
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'ready':
      case 'completed':
        return 'fas fa-check-circle';
      case 'generating':
      case 'processing':
      case 'running':
        return 'fas fa-spinner fa-spin';
      case 'queued':
      case 'pending':
        return 'fas fa-hourglass-half';
      case 'scheduled':
        return 'fas fa-clock';
      case 'error':
      case 'failed':
        return 'fas fa-exclamation-circle';
      default:
        return 'fas fa-check-circle';
    }
  }

  getStatusText(status: string): string {
    switch (status) {
      case 'ready':
        return this.translate.instant('HARDCODED.READY');
      case 'completed':
        return this.translate.instant('HARDCODED.COMPLETED');
      case 'generating':
        return this.translate.instant('HARDCODED.GENERATING');
      case 'processing':
        return this.translate.instant('HARDCODED.PROCESSING');
      case 'pending':
        return this.translate.instant('HARDCODED.PENDING');
      case 'scheduled':
        return this.translate.instant('HARDCODED.SCHEDULED');
      case 'error':
        return this.translate.instant('HARDCODED.ERROR');
      case 'failed':
        return this.translate.instant('HARDCODED.FAILED');
      default:
        return this.translate.instant('HARDCODED.READY');
    }
  }

  // Report type text
  getReportTypeText(reportType: string): string {
    switch (reportType) {
      case 'voltage':
        return this.translate.instant('HARDCODED.VOLTAGE');
      case 'frequency':
        return this.translate.instant('HARDCODED.FREQUENCY');
      case 'power_quality':
        return this.translate.instant('HARDCODED.POWER_QUALITY');
      case 'energy':
        return this.translate.instant('HARDCODED.ENERGY');
      case 'alarm':
        return this.translate.instant('HARDCODED.ALARM');
      case 'custom':
        return this.translate.instant('HARDCODED.CUSTOM');
      default:
        return this.translate.instant('HARDCODED.GENERAL');
    }
  }

  // Date formatting
  formatDate(dateString: string | Date): string {
    if (!dateString) return '';
    const date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    const lang = this.translate.currentLang || 'tr';
    const localeMap: Record<string, string> = { tr: 'tr-TR', en: 'en-US', de: 'de-DE' };
    return date.toLocaleDateString(localeMap[lang] || 'tr-TR');
  }

  formatTime(dateString: string | Date): string {
    if (!dateString) return '';
    const date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  // Date range formatting with time
  formatDateRange(report: Report): string {
    if (!report.startDate || !report.endDate) return this.translate.instant('REPORTS.NO_DATE_RANGE');
    
    const startDate = this.formatDate(report.startDate);
    const endDate = this.formatDate(report.endDate);
    const startTime = report.startTime || '00:00';
    const endTime = report.endTime || '23:59';
    
    if (startDate === endDate) {
      return `${startDate} (${startTime} - ${endTime})`;
    } else {
      return `${startDate} ${startTime} - ${endDate} ${endTime}`;
    }
  }

  // Date range with line break for table display
  formatDateRangeHtml(report: Report): string {
    if (!report.startDate || !report.endDate) return this.translate.instant('REPORTS.NO_DATE_RANGE');
    
    const startDate = this.formatDate(report.startDate);
    const endDate = this.formatDate(report.endDate);
    const startTime = report.startTime || '00:00';
    const endTime = report.endTime || '23:59';
    
    if (startDate === endDate) {
      return `${startDate}<br><span class="text-slate-500">${startTime} – ${endTime}</span>`;
    } else {
      return `${startDate} ${startTime}<br><span class="text-slate-500">→ ${endDate} ${endTime}</span>`;
    }
  }

  // Time only formatting
  formatTimeOnly(timeString: string): string {
    if (!timeString) return '';
    return timeString.substring(0, 5); // HH:mm formatına çevir
  }

  // Processing progress simulation
  getProcessingProgress(report: Report): number {
    // Simulated progress based on creation time
    const created = new Date(report.createdAt || '').getTime();
    const now = Date.now();
    const elapsed = now - created;
    const progress = Math.min(90, (elapsed / 60000) * 30); // 30% per minute, max 90%
    return Math.round(progress);
  }

  // Event handlers
  onViewReport(report: Report): void {
    this.reportView.emit(report);
  }

  onDownloadReport(report: Report): void {
    this.reportDownload.emit(report);
  }

  onEditReport(report: Report): void {
    this.reportEdit.emit(report);
  }

  onScheduleReport(report: Report): void {
    this.reportSchedule.emit(report);
  }

  onDeleteReport(report: Report): void {
    this.reportDelete.emit(report);
  }

  onStartReport(report: Report): void {
    this.startReport.emit(report);
  }

  onToggleOutput(reportId: string | number): void {
    this.toggleOutput.emit(String(reportId));
  }

  onCustomizeReport(report: Report): void {
    this.customizeReport.emit(report);
  }

  // Report state methods
  isReportRunning(reportId: string | number): boolean {
    return this.runningReports.has(String(reportId));
  }

  hasOutput(reportId: string | number): boolean {
    return !!this.reportOutput[String(reportId)];
  }

  isOutputVisible(reportId: string | number): boolean {
    return !!this.showOutput[String(reportId)];
  }

  getReportOutput(reportId: string | number): any {
    return this.reportOutput[String(reportId)] || null;
  }

  getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'processing':
        return 'bg-yellow-100 text-yellow-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'pending':
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }

  onShareReport(report: Report): void {
    this.reportShare.emit(report);
  }

  canManageVisibility(): boolean {
    return this.authService.hasPageAccess('template-visibility');
  }

  canGenerateReport(): boolean {
    return this.authService.hasPageAccess('reports/generate') || this.authService.hasPageAccess('reports');
  }

  canScheduleReport(): boolean {
    return this.authService.hasPageAccess('reports/schedule') || this.authService.hasPageAccess('reports');
  }

  canEditReport(): boolean {
    return this.authService.hasPageAccess('reports/edit') || this.authService.hasPageAccess('reports');
  }

  canDeleteReport(): boolean {
    return this.authService.hasPageAccess('reports/delete') || this.authService.hasPageAccess('reports');
  }
}
