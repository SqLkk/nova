import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, ChangeDetectorRef, OnInit, OnDestroy } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { Subscription } from 'rxjs';

@Component({
  standalone: false,
  selector: 'app-report-scheduler',
  templateUrl: './report-scheduler.component.html',
  styleUrls: ['./report-scheduler.component.scss']
})
export class ReportSchedulerComponent implements OnInit, OnChanges, OnDestroy {
  @Input() isVisible = false;
  @Input() report: any = null;

  @Output() close = new EventEmitter<void>();
  @Output() saveSuccess = new EventEmitter<void>();

  // Scheduler Form State
  schedulerEnabled = false;
  schedulerType = 'daily';
  schedulerTime = '08:00';
  schedulerDays: string[] = ['MON', 'WED'];
  schedulerDayOfMonth = 1;
  schedulerIntervalValue = 5;
  schedulerIntervalUnit = 'hours';
  schedulerOnceDateTime = '';
  systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  schedulerTimezone = this.systemTimezone;

  isLoading = false;

  scheduleTypes = [
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'interval', label: 'Interval' },
    { value: 'once', label: 'Once' }
  ];

  weekDays = [
    { value: 'MON', label: 'M' },
    { value: 'TUE', label: 'T' },
    { value: 'WED', label: 'W' },
    { value: 'THU', label: 'T' },
    { value: 'FRI', label: 'F' },
    { value: 'SAT', label: 'S' },
    { value: 'SUN', label: 'S' }
  ];

  intervalUnits = [
    { value: 'minutes', label: 'Minutes' },
    { value: 'hours', label: 'Hours' },
    { value: 'days', label: 'Days' }
  ];

  private subscriptions = new Subscription();
  private currentUserId = '';

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    private confirmService: ConfirmService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    const user = this.authService.getCurrentUser();
    if (user) {
      this.currentUserId = user.id;
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['isVisible'] || changes['report']) && this.isVisible && this.report) {
      this.loadExistingSchedule();
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  loadExistingSchedule(): void {
    if (!this.report?.id) return;

    this.isLoading = true;
    // Reset to default states before loading
    this.schedulerEnabled = false;
    this.schedulerType = 'daily';
    this.schedulerTime = '08:00';
    this.schedulerDays = [];
    this.schedulerDayOfMonth = 1;
    this.schedulerIntervalValue = 5;
    this.schedulerIntervalUnit = 'hours';
    this.schedulerOnceDateTime = '';
    this.schedulerTimezone = this.systemTimezone;

    const sub = this.apiService.getReportSchedule(String(this.report.id)).subscribe({
      next: (res) => {
        if (res && res.data) {
          const s = res.data;
          this.schedulerEnabled = s.enabled ?? true;
          this.schedulerType = s.scheduleType || s.schedule_type || 'daily';
          this.schedulerTime = s.scheduleTime || s.schedule_time || '08:00';
          this.schedulerDays = s.scheduleDays || s.schedule_days || [];
          this.schedulerDayOfMonth = s.scheduleDayOfMonth || s.day_of_month || 1;
          this.schedulerIntervalValue = s.intervalValue || s.interval_value || 5;
          this.schedulerIntervalUnit = s.intervalUnit || s.interval_unit || 'hours';
          this.schedulerOnceDateTime = s.onceDateTime || s.once_datetime || '';
          this.schedulerTimezone = s.timezone || this.systemTimezone;
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        // Safe fallback if not found
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
    this.subscriptions.add(sub);
  }

  closeReportScheduler(): void {
    this.close.emit();
  }

  toggleWeekDay(dayValue: string): void {
    const idx = this.schedulerDays.indexOf(dayValue);
    if (idx > -1) {
      this.schedulerDays.splice(idx, 1);
    } else {
      this.schedulerDays.push(dayValue);
    }
    this.cdr.detectChanges();
  }

  saveReportSchedule(): void {
    if (!this.report?.id) return;

    const reportId = String(this.report.id);
    const payload = {
      userId: this.currentUserId,
      enabled: this.schedulerEnabled,
      scheduleType: this.schedulerType,
      schedule_type: this.schedulerType, // both cases for DB versatility!
      scheduleTime: this.schedulerTime,
      schedule_time: this.schedulerTime,
      scheduleDays: this.schedulerDays,
      schedule_days: this.schedulerDays,
      scheduleDayOfMonth: this.schedulerDayOfMonth,
      day_of_month: this.schedulerDayOfMonth,
      intervalValue: this.schedulerIntervalValue,
      interval_value: this.schedulerIntervalValue,
      intervalUnit: this.schedulerIntervalUnit,
      interval_unit: this.schedulerIntervalUnit,
      onceDateTime: this.schedulerOnceDateTime,
      once_datetime: this.schedulerOnceDateTime,
      timezone: this.schedulerTimezone,
      reportConfig: {}
    };

    const sub = this.apiService.saveReportSchedule(reportId, payload).subscribe({
      next: () => {
        this.saveSuccess.emit();
      },
      error: (err: any) => {
        console.error('Failed to save schedule:', err);
        this.confirmService.alert('Failed to update schedule config.');
      }
    });
    this.subscriptions.add(sub);
  }
}
