import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { AdminService } from '../../services/admin.service';
import { Report } from '../../models/report.model';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { timeout, catchError } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { ConfirmService } from '../../services/confirm.service';

@Component({
  standalone: false,
  selector: 'app-reports',
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.scss']
})
export class ReportsComponent implements OnInit, OnDestroy {
  reports: Report[] = [];
  filteredReports: Report[] = [];
  isCreatorOpen = false;
  editingReport: Report | null = null; // Edit mode için seçilen rapor
  isLoading = true;

  error: string | null = null;

  // Report execution state
  runningReports = new Set<string>();
  reportOutput: { [key: string]: any } = {};
  showOutput: { [key: string]: boolean } = {};

  // Search and Filter
  searchTerm = '';
  currentFilter = 'all';
  isFilterOpen = false;

  // Report Customizer
  showCustomizer = false;
  selectedReportId: string | null = null;
  isLightMode = false;

  get isThemeLight(): boolean {
    return localStorage.getItem('theme') === 'light';
  }

  // Report viewer dialog
  showReportViewer = false;
  selectedReport: Report | null = null;

  presetPathsFromNetworkMap: string[] = [];
  networkMapReportConfig: any = null;

  // Success notification
  showSuccessNotification = false;
  successMessage = '';
  private notificationTimeout: any;

  // Combined Report
  isGeneratingCombined = false;
  combinedReportResult: any = null;

  // Delete confirmation modal
  showDeleteModal = false;
  reportToDelete: Report | null = null;

  // Template management state
  showTemplatesManager = false;
  templates: any[] = [];
  loadingTemplates = false;
  showTemplateBuilderFromReports = false;
  selectedTemplateToEdit: any = null;
  usersList: any[] = [];
  selectedTemplateForSharing: any = null;
  sharingTargetType: 'template' | 'report' = 'template';
  showSharingModal = false;
  sharingSearchTerm = '';
  currentUserId = '';
  currentUserRole = 'user';

  // Templates & Files manager state
  templatesManagerTab: 'templates' | 'files' = 'templates';
  generatedFiles: any[] = [];
  loadingGeneratedFiles = false;
  selectedTemplateId = '';
  showReportSelectorModal = false;
  reportSelectorAction: 'run' | 'view' = 'run';
  selectedTemplateForSelector: any = null;
  selectedTemplateNameForViewer = '';

  // Dedicated Report Scheduler Modal State
  showSchedulerModal = false;
  selectedReportForSchedule: Report | null = null;
  systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Create New Template wizard state
  showNewTemplateDialog = false;
  newTemplateName = '';
  newTemplateDesc = '';
  selectedTemplateToCloneId = 'default';
  clearTemplateDataOnSnapshot = false;
  newTemplateError = '';

  private subscriptions = new Subscription();

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    private adminService: AdminService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private confirmService: ConfirmService
  ) { }

  ngOnInit(): void {
    const user = this.authService.getCurrentUser();
    if (user) {
      this.currentUserId = user.id;
      this.currentUserRole = user.role;
    }

    const presetRaw = sessionStorage.getItem('networkMapReportPaths');
    if (presetRaw) {
      try {
        const parsed = JSON.parse(presetRaw);
        if (Array.isArray(parsed)) {
          this.presetPathsFromNetworkMap = parsed;
        }
      } catch (error) {
        console.warn('Network map preset parse error:', error);
      }
    }

    const configRaw = sessionStorage.getItem('networkMapReportConfig');
    if (configRaw) {
      try {
        this.networkMapReportConfig = JSON.parse(configRaw);
      } catch (error) {
        console.warn('Network map config parse error:', error);
      }
      sessionStorage.removeItem('networkMapReportConfig');
    }

    if (sessionStorage.getItem('networkMapOpenReportCreator') || this.presetPathsFromNetworkMap.length > 0) {
      this.isCreatorOpen = true;
      sessionStorage.removeItem('networkMapOpenReportCreator');
    }

    if (this.presetPathsFromNetworkMap.length > 0) {
      sessionStorage.removeItem('networkMapReportPaths');
    }

    this.loadReports();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  loadReports(): void {
    this.isLoading = true;
    this.error = null;

    const sub = this.apiService.getReports()
      .pipe(
        timeout(15000)
      )
      .subscribe({
        next: (data) => {
          this.reports = data;
          this.filteredReports = [...data];
          this.applyFiltersAndSearch();
          this.isLoading = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Raporlar yüklenirken hata oluştu:', err);
          this.error = err.name === 'TimeoutError'
            ? this.translate.instant('REPORTS.SERVER_NOT_RESPONDING')
            : this.translate.instant('REPORTS.REPORTS_LOAD_ERROR');
          this.isLoading = false;
          this.cdr.detectChanges();
        }
      });

    this.subscriptions.add(sub);
  }

  generateCombinedReport(): void {
    this.isGeneratingCombined = true;
    this.combinedReportResult = null;

    const sub = this.apiService.generateCombinedReport()
      .pipe(timeout(120000))
      .subscribe({
        next: (result: any) => {
          this.isGeneratingCombined = false;
          if (result.success) {
            this.combinedReportResult = result;
            this.showSuccess(this.translate.instant('REPORTS.COMBINED_REPORT_SUCCESS'));
            this.apiService.downloadCombinedReport(result.file_name);
          } else {
            this.showSuccess(result.message || 'Combined report failed');
          }
        },
        error: (err: any) => {
          this.isGeneratingCombined = false;
          console.error('Combined report error:', err);
          this.showSuccess(this.translate.instant('REPORTS.COMBINED_REPORT_ERROR'));
        }
      });
    this.subscriptions.add(sub);
  }

  openReportCreator(): void {
    this.editingReport = null; // Yeni rapor oluşturma için edit mode'u temizle
    this.isCreatorOpen = true;
  }

  closeReportCreator(): void {
    this.isCreatorOpen = false;
    this.editingReport = null;
    this.isLightMode = false;
  }

  handleReportCreated(report: Report): void {
    // Yeni oluşturulan raporu listeye ekle
    this.reports = [report, ...this.reports];
    this.applyFiltersAndSearch();
    this.closeReportCreator();

    // Başarı mesajı göster
    this.showSuccess(this.translate.instant('REPORTS.REPORT_CREATED_SUCCESS'));
  }

  showSuccess(message: string): void {
    this.successMessage = message;
    this.showSuccessNotification = true;

    // 5 saniye sonra otomatik kapat
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    this.notificationTimeout = setTimeout(() => {
      this.hideSuccessNotification();
    }, 5000);
  }

  hideSuccessNotification(): void {
    this.showSuccessNotification = false;
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
  }

  handleReportUpdated(report: Report): void {
    // Güncellenen raporu listede bul ve güncelle
    const index = this.reports.findIndex(r => r.id === report.id);
    if (index !== -1) {
      // Config değiştiği için rapor tekrar çalıştırılmalı
      report.status = 'ready';
      this.reports[index] = report;
      this.applyFiltersAndSearch();
    }
    this.closeReportCreator();
  }

  // Search and Filter Methods
  onSearchChange(): void {
    this.applyFiltersAndSearch();
  }

  toggleFilterDropdown(): void {
    this.isFilterOpen = !this.isFilterOpen;
  }

  setFilter(filter: string): void {
    this.currentFilter = filter;
    this.isFilterOpen = false;
    this.applyFiltersAndSearch();
  }

  private applyFiltersAndSearch(): void {
    let filtered = [...this.reports];

    // Apply search
    if (this.searchTerm.trim()) {
      const term = this.searchTerm.toLowerCase();
      filtered = filtered.filter(report =>
        report.name?.toLowerCase().includes(term) ||
        report.description?.toLowerCase().includes(term) ||
        report.fileType?.toLowerCase().includes(term)
      );
    }

    // Apply filter
    switch (this.currentFilter) {
      case 'pdf':
        filtered = filtered.filter(report => report.fileType === 'pdf');
        break;
      case 'excel':
        filtered = filtered.filter(report => report.fileType === 'excel');
        break;
      case 'recent':
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filtered = filtered.filter(report => {
          const reportDate = new Date(report.createdAt || '');
          return reportDate >= thirtyDaysAgo;
        });
        break;
      default:
        // 'all' - no additional filtering
        break;
    }

    this.filteredReports = filtered;
  }

  // Stats Methods
  getReportsThisMonth(): number {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    return this.reports.filter(report => {
      const reportDate = new Date(report.createdAt || '');
      return reportDate.getMonth() === thisMonth && reportDate.getFullYear() === thisYear;
    }).length;
  }

  getPendingReports(): number {
    return this.reports.filter(report => report.status === 'pending' || report.status === 'processing').length;
  }

  downloadReport(report: Report): void {
    if (!report.id) {
      console.error('Rapor ID\'si tanımlanmamış');
      return;
    }

    this.apiService.downloadReport(report.id, report.fileType || 'pdf')
      .subscribe({
        next: (blob) => {
          // Dosyayı indirme işlemi
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${report.name}-${report.createdAt}.${report.fileType || 'pdf'}`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          a.remove();
        },
        error: (err) => {
          console.error('Rapor indirilirken hata oluştu:', err);
        }
      });
  }

  deleteReport(report: Report): void {
    this.reportToDelete = report;
    this.showDeleteModal = true;
  }

  async confirmDeleteReport(): Promise<void> {
    const report = this.reportToDelete;
    if (!report || !report.id) {
      this.showDeleteModal = false;
      this.reportToDelete = null;
      return;
    }

    if (await this.confirmService.confirm(`Are you sure you want to delete the report "${report.name}"?`)) {
        const sub = this.apiService.deleteReport(report.id)
          .subscribe({
            next: () => {
              this.reports = this.reports.filter(r => r.id !== report.id);
              this.applyFiltersAndSearch();
              this.showDeleteModal = false;
              this.reportToDelete = null;
            },
            error: (err) => {
              console.error('Rapor silinirken hata oluştu:', err);
              this.showDeleteModal = false;
              this.reportToDelete = null;
            }
          });

        this.subscriptions.add(sub);
    } else {
        this.cancelDeleteReport();
    }
  }

  cancelDeleteReport(): void {
    this.showDeleteModal = false;
    this.reportToDelete = null;
  }

  viewReport(report: Report, templateName: string = ''): void {
    this.selectedTemplateNameForViewer = templateName;
    // Yeni rapor görüntüleyici dialog'unu aç
    ////console.log('👁️ Rapor görüntüleme açılıyor:', report);
    this.selectedReport = report;
    this.showReportViewer = true;
  }

  editReport(report: Report): void {
    // Rapor düzenleme işlemi - edit mode'da creator'ı aç
    ////console.log('Editing report:', report);
    this.editingReport = report;
    this.isCreatorOpen = true;
  }

  startReport(report: Report): void {
    if (!report.id) {
      console.error('Rapor ID\'si tanımlanmamış');
      return;
    }

    // Raporu çalışıyor olarak işaretle - ID'yi string'e çevir
    const reportId = String(report.id);
    this.runningReports.add(reportId);

    // Step 1: Queue the report (returns immediately)
    const sub = this.apiService.startReport(reportId)
      .subscribe({
        next: (result) => {
          // Report is queued — now poll for completion
          this.loadReports(); // Refresh to show "queued" status
          this.cdr.detectChanges();

          const pollSub = this.apiService.pollReportCompletion(reportId)
            .subscribe({
              next: () => {
                this.ngZone.run(() => {
                  this.runningReports.delete(reportId);
                  this.loadReports();
                  this.showChartConfigDialog(report);
                  this.cdr.detectChanges();
                });
              },
              error: (err) => {
                this.ngZone.run(() => {
                  console.error('❌ Rapor çalıştırılırken hata oluştu:', err);
                  this.runningReports.delete(reportId);
                  this.loadReports();
                  alert(this.translate.instant('REPORTS.REPORT_RUN_ERROR', { message: err.message || '' }));
                  this.cdr.detectChanges();
                });
              }
            });
          this.subscriptions.add(pollSub);
        },
        error: (err) => {
          this.ngZone.run(() => {
            console.error('❌ Rapor kuyruğa eklenirken hata oluştu:', err);
            this.runningReports.delete(reportId);
            alert(this.translate.instant('REPORTS.REPORT_RUN_ERROR', { message: err.error?.message || err.message || '' }));
            this.cdr.detectChanges();
          });
        }
      });

    this.subscriptions.add(sub);
  }

  showChartConfigDialog(report: Report): void {
    // Customization ekranını aç
    this.selectedReportId = String(report.id);
    this.showCustomizer = true;
  }

  loadReportOutput(reportId: string): void {
    const sub = this.apiService.getReportOutput(reportId)
      .subscribe({
        next: (output) => {
          ////console.log('📊 Rapor output\'u yüklendi:', output);
          this.reportOutput[reportId] = output;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('❌ Rapor output\'u yüklenirken hata:', err);
          this.cdr.detectChanges();
        }
      });

    this.subscriptions.add(sub);
  }

  toggleOutput(reportId: string | number): void {
    const stringId = String(reportId);
    this.showOutput[stringId] = !this.showOutput[stringId];

    // Eğer output gösteriliyorsa ve henüz yüklenmemişse, yükle
    if (this.showOutput[stringId] && !this.reportOutput[stringId]) {
      this.loadReportOutput(stringId);
    }
    this.cdr.detectChanges();
  }

  isReportRunning(reportId: string | number): boolean {
    return this.runningReports.has(String(reportId));
  }

  hasOutput(reportId: string | number): boolean {
    return !!this.reportOutput[String(reportId)];
  }

  isOutputVisible(reportId: string | number): boolean {
    return !!this.showOutput[String(reportId)];
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

  getStatusText(status: string): string {
    switch (status) {
      case 'completed':
        return this.translate.instant('REPORTS.STATUS_COMPLETED_LABEL');
      case 'processing':
        return this.translate.instant('REPORTS.STATUS_PROCESSING_LABEL');
      case 'failed':
        return this.translate.instant('REPORTS.STATUS_FAILED_LABEL');
      case 'pending':
      default:
        return this.translate.instant('REPORTS.STATUS_PENDING_LABEL');
    }
  }

  // Report customization methods
  customizeReport(report: Report): void {
    // Open report-customizer modal (colors, charts, formulas, templates, generate)
    this.selectedReportId = String(report.id);
    this.showCustomizer = true;
  }

  onCustomizerClosed(): void {
    ////console.log('🔒 Rapor özelleştirme kapatıldı');
    this.showCustomizer = false;
    this.selectedReportId = null;
    this.selectedTemplateId = '';
  }

  onReportViewerClosed(): void {
    ////console.log('🔒 Rapor görüntüleyici kapatıldı');
    this.showReportViewer = false;
    this.selectedReport = null;
    this.selectedTemplateNameForViewer = '';
  }

  // ── Dedicated Scheduler Modal Methods ──
  openReportScheduler(report: Report): void {
    this.selectedReportForSchedule = report;
    this.showSchedulerModal = true;
    this.cdr.detectChanges();
  }

  closeReportScheduler(): void {
    this.showSchedulerModal = false;
    this.selectedReportForSchedule = null;
    this.cdr.detectChanges();
  }

  onSchedulerSaveSuccess(): void {
    this.showSuccess('Report schedule updated successfully!');
    this.closeReportScheduler();
    this.loadReports();
  }

  onReportFileDownload(file: any): void {
    ////console.log('📥 Rapor dosyası indiriliyor:', file);

    // Use the url from file object, or fallback to download endpoint
    const downloadUrl = file.url
      ? `${environment.apiUrl}${file.url}`
      : `${environment.apiUrl}/download/${file.name}`;

    try {
      // Programmatik download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = file.name;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      ////console.log('✅ Dosya indirme başlatıldı:', file.name);
    } catch (error) {
      console.error('❌ Dosya indirme hatası:', error);

      // Fallback: Yeni sekmede aç
      window.open(downloadUrl, '_blank');
    }
  }

  onReportGenerated(generatedReport: any): void {
    console.log('✅ Özelleştirilmiş rapor oluşturuldu:', generatedReport);
    this.showCustomizer = false;
    this.selectedReportId = null;

    // Show success notification with report details
    const dataCount = generatedReport.dataCount || 0;
    const columnsCount = generatedReport.selectedColumnsCount || 0;
    const fileName = generatedReport.result?.output_file || 'Rapor';

    this.showSuccess(
      this.translate.instant('REPORTS.REPORT_GENERATED_SUCCESS', {
        columns: columnsCount,
        records: dataCount.toLocaleString(),
        file: fileName
      })
    );

    // Rapor listesini yenile
    this.loadReports();
  }

  // ── Template Management Methods ──────────────────────────────

  canCreateTemplate(): boolean {
    return this.authService.hasPageAccess('reports/create-template') || this.authService.hasPageAccess('reports');
  }

  canEditReport(): boolean {
    return this.authService.hasPageAccess('reports/edit') || this.authService.hasPageAccess('reports');
  }

  canViewGeneratedReports(): boolean {
    return this.authService.hasPageAccess('generated-reports') || this.authService.hasPageAccess('reports');
  }

  canViewScheduledReports(): boolean {
    return this.authService.hasPageAccess('scheduled-reports') || this.authService.hasPageAccess('reports');
  }

  openNewTemplateDialog(): void {
    if (!this.canCreateTemplate()) {
      alert('Unauthorized! You do not have permission to create templates.');
      return;
    }
    this.newTemplateName = '';
    this.newTemplateDesc = '';
    this.selectedTemplateToCloneId = 'default';
    this.clearTemplateDataOnSnapshot = false;
    this.newTemplateError = '';
    this.showNewTemplateDialog = true;
    this.cdr.detectChanges();
  }

  createTemplate(): void {
    if (!this.newTemplateName || !this.newTemplateName.trim()) {
      this.newTemplateError = 'Template name is required!';
      return;
    }

    this.newTemplateError = '';
    let cloneData: any = null;

    if (this.selectedTemplateToCloneId === 'default') {
      // Set to empty object so excel-template-builder auto-populates its gorgeous multi-sheet default template structure
      cloneData = {};
    } else {
      // Clone from selected template
      const sourceTmpl = this.templates.find(t => t.id === this.selectedTemplateToCloneId);
      if (sourceTmpl && sourceTmpl.template_data) {
        // Deep copy
        cloneData = JSON.parse(JSON.stringify(sourceTmpl.template_data));
        // Reset properties to represent the new name
        cloneData.name = this.newTemplateName;
        if (cloneData.id) delete cloneData.id;
      }
    }

    let finalDesc = this.newTemplateDesc || '';
    if (this.selectedTemplateToCloneId !== 'default') {
      const sourceTmpl = this.templates.find(t => t.id === this.selectedTemplateToCloneId);
      if (sourceTmpl && sourceTmpl.description && !finalDesc) {
        finalDesc = sourceTmpl.description;
      }
    }

    if (cloneData) {
      cloneData.clearTemplateDataOnSnapshot = this.clearTemplateDataOnSnapshot;
    }

    // Save to database
    this.apiService.saveUserTemplate({
      user_id: this.currentUserId,
      name: this.newTemplateName,
      description: finalDesc,
      template_data: cloneData || {},
      template_type: 'visual'
    }).subscribe({
      next: (res: any) => {
        this.showNewTemplateDialog = false;
        this.showSuccess(`Template "${this.newTemplateName}" created successfully!`);
        this.loadTemplates();

        // Open the template builder directly on the newly created template!
        const newTmplObj = {
          id: res.data.id,
          name: this.newTemplateName,
          description: finalDesc,
          template_data: cloneData || {},
          user_id: this.currentUserId
        };
        this.editTemplate(newTmplObj);
      },
      error: (err) => {
        this.newTemplateError = err.error?.message || 'Failed to save new template to server.';
      }
    });
  }

  openTemplatesManager(): void {
    this.showTemplatesManager = true;
    this.loadReports();
    this.loadTemplates();
    if (this.currentUserRole === 'admin' || this.currentUserRole === 'superuser') {
      this.loadUsersList();
    }
  }

  loadTemplates(): void {
    this.loadingTemplates = true;
    this.apiService.listUserTemplates(this.currentUserId).subscribe({
      next: (res) => {
        this.templates = res?.data || [];
        this.loadingTemplates = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load templates:', err);
        this.loadingTemplates = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadUsersList(): void {
    this.adminService.getUsers().subscribe({
      next: (res) => {
        this.usersList = res?.users || [];
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load users list:', err);
      }
    });
  }

  getTemplateOwnerUsername(userId: string): string {
    if (userId === this.currentUserId) {
      const currentUser = this.authService.getCurrentUser();
      return currentUser ? currentUser.username : userId;
    }
    const user = this.usersList.find(u => u.id === userId);
    return user ? user.username : userId;
  }

  editTemplate(template: any): void {
    this.selectedTemplateToEdit = template.template_data;
    if (this.selectedTemplateToEdit) {
      this.selectedTemplateToEdit.id = template.id;
      this.selectedTemplateToEdit.name = template.name;
      this.selectedTemplateToEdit.description = template.description;
    }
    this.showTemplatesManager = false;
    this.showTemplateBuilderFromReports = true;
    this.cdr.detectChanges();
  }

  closeTemplateBuilderFromReports(): void {
    this.showTemplateBuilderFromReports = false;
    this.selectedTemplateToEdit = null;
    this.openTemplatesManager();
    this.cdr.detectChanges();
  }

  onTemplateSavedFromReports(event: any): void {
    const templateId = this.selectedTemplateToEdit?.id;
    const name = event.name || this.selectedTemplateToEdit?.name || 'My Template';

    const originalTemplate = this.templates.find(t => t.id === templateId);

    let targetTemplateId = templateId;
    let targetUserId = this.currentUserId;
    let isShared = originalTemplate ? !!originalTemplate.is_shared : false;
    let sharedWith = originalTemplate ? originalTemplate.shared_with : '[]';
    let isSavingAsCopy = false;

    // Visibility / Duplication Rule:
    // If the template belongs to another user, and the current user is NOT an admin/superuser,
    // they cannot modify the original. Instead, they save a COPY of it for themselves!
    if (originalTemplate && originalTemplate.user_id !== this.currentUserId) {
      const isAdminOrSuper = this.currentUserRole === 'admin' || this.currentUserRole === 'superuser';
      if (!isAdminOrSuper) {
        targetTemplateId = undefined; // Force create as a brand-new template
        isShared = false;            // Start as private
        sharedWith = '[]';
        isSavingAsCopy = true;
      }
    }

    let sharedWithList: string[] = [];
    if (sharedWith) {
      try {
        sharedWithList = typeof sharedWith === 'string' ? JSON.parse(sharedWith) : sharedWith;
      } catch (e) {
        sharedWithList = [];
      }
    }

    this.apiService.saveUserTemplate({
      user_id: targetUserId,
      name: name,
      description: event.description || originalTemplate?.description || '',
      template_data: event,
      template_type: 'visual',
      id: targetTemplateId,
      is_shared: isShared,
      shared_with: sharedWithList
    }).subscribe({
      next: () => {
        if (isSavingAsCopy) {
          this.showSuccess(`Template saved as a copy for yourself: "${name}"`);
        } else {
          this.showSuccess(this.translate.instant('TEMPLATE_SAVED_SUCCESS', { name: name }));
        }
        this.closeTemplateBuilderFromReports();
      },
      error: (err) => {
        console.error('Failed to save template:', err);
        const errMsg = err.error?.message || 'Failed to save template.';
        alert(errMsg);
      }
    });
  }

  async deleteTemplate(template: any): Promise<void> {
    if (await this.confirmService.confirm(`Are you sure you want to delete the template "${template.name}"?`)) {
      this.apiService.deleteUserTemplate(template.id, this.currentUserId).subscribe({
        next: () => {
          this.showSuccess('Template deleted successfully.');
          this.loadTemplates();
        },
        error: (err) => {
          console.error('Failed to delete template:', err);
        }
      });
    }
  }

  openSharingModal(item: any, type: 'template' | 'report' = 'template'): void {
    this.sharingTargetType = type;
    this.selectedTemplateForSharing = item;
    this.showSharingModal = true;
    if (this.usersList.length === 0 && (this.currentUserRole === 'admin' || this.currentUserRole === 'superuser')) {
      this.loadUsersList();
    }
    this.cdr.detectChanges();
  }

  closeSharingModal(): void {
    this.selectedTemplateForSharing = null;
    this.showSharingModal = false;
    this.cdr.detectChanges();
  }

  canManageVisibility(): boolean {
    return this.authService.hasPageAccess('template-visibility');
  }

  isUserSharedWith(userId: string): boolean {
    if (!this.selectedTemplateForSharing) return false;
    const sharedWith = this.selectedTemplateForSharing.shared_with;
    if (!sharedWith) return false;
    try {
      const list = typeof sharedWith === 'string' ? JSON.parse(sharedWith) : sharedWith;
      return Array.isArray(list) && list.includes(userId);
    } catch (e) {
      return false;
    }
  }

  toggleUserSharing(userId: string): void {
    if (!this.selectedTemplateForSharing) return;
    const sharedWith = this.selectedTemplateForSharing.shared_with;
    let list: string[] = [];
    try {
      list = typeof sharedWith === 'string' ? JSON.parse(sharedWith) : (Array.isArray(sharedWith) ? sharedWith : []);
    } catch (e) {
      list = [];
    }

    if (list.includes(userId)) {
      list = list.filter(id => id !== userId);
    } else {
      list.push(userId);
    }

    this.selectedTemplateForSharing.shared_with = JSON.stringify(list);
  }

  toggleGlobalSharing(): void {
    if (!this.selectedTemplateForSharing) return;
    this.selectedTemplateForSharing.is_shared = this.selectedTemplateForSharing.is_shared === 1 ? 0 : 1;
  }

  saveSharingSettings(): void {
    if (!this.selectedTemplateForSharing) return;
    const t = this.selectedTemplateForSharing;
    let sharedWithList: string[] = [];
    try {
      sharedWithList = typeof t.shared_with === 'string' ? JSON.parse(t.shared_with) : (Array.isArray(t.shared_with) ? t.shared_with : []);
    } catch (e) {
      sharedWithList = [];
    }

    if (this.sharingTargetType === 'report') {
      this.apiService.updateReportSharing(t.id, t.is_shared === 1, sharedWithList).subscribe({
        next: () => {
          this.showSuccess('Report sharing settings updated.');
          this.closeSharingModal();
          this.loadReports();
        },
        error: (err) => {
          console.error('Failed to update report sharing settings:', err);
        }
      });
    } else {
      this.apiService.saveUserTemplate({
        user_id: t.user_id,
        name: t.name,
        description: t.description || '',
        template_data: t.template_data,
        template_type: t.template_type || 'visual',
        id: t.id,
        is_shared: t.is_shared === 1,
        shared_with: sharedWithList
      }).subscribe({
        next: () => {
          this.showSuccess('Template sharing settings updated.');
          this.closeSharingModal();
          this.loadTemplates();
        },
        error: (err) => {
          console.error('Failed to update template sharing settings:', err);
        }
      });
    }
  }

  getFilteredUsersForSharing(): any[] {
    if (!this.sharingSearchTerm.trim()) {
      return this.usersList;
    }
    const q = this.sharingSearchTerm.toLowerCase();
    return this.usersList.filter(u =>
      u.username.toLowerCase().includes(q) ||
      (u.display_name && u.display_name.toLowerCase().includes(q)) ||
      (u.email && u.email.toLowerCase().includes(q))
    );
  }

  findBestMatchingReport(templateName: string): any {
    if (!this.reports || this.reports.length === 0) return null;

    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tName = clean(templateName);

    // 1. Exact or partial clean name matches
    let bestMatch = this.reports.find(r => clean(r.name) === tName);
    if (bestMatch) return bestMatch;

    bestMatch = this.reports.find(r => tName.includes(clean(r.name)) || clean(r.name).includes(tName));
    if (bestMatch) return bestMatch;

    // 2. Token overlap matching
    const tTokens = templateName.toLowerCase().split(/[^a-z0-9]+/);
    let maxOverlap = 0;
    let overlapMatch = null;

    for (const r of this.reports) {
      const rTokens = r.name.toLowerCase().split(/[^a-z0-9]+/);
      const overlap = rTokens.filter(tok => tok && tTokens.includes(tok)).length;
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        overlapMatch = r;
      }
    }

    if (overlapMatch && maxOverlap > 0) return overlapMatch;

    // 3. Default fallback: first report in the list
    return this.reports[0];
  }

  runTemplate(template: any): void {
    const desc = template.description || '';
    const match = desc.match(/Report:\s*([a-zA-Z0-9_-]+)/i);
    let reportId = match ? match[1] : '';

    if (!reportId) {
      const bestReport = this.findBestMatchingReport(template.name);
      if (bestReport) {
        reportId = bestReport.id;
      }
    }

    if (!reportId) {
      alert('No base report found in the system!');
      return;
    }

    // Eğer temel rapor sistemde mevcut değilse, dinamik olarak yeni bir temel rapor oluştur!
    if (reportId && !this.reports.find(r => String(r.id) === String(reportId))) {
      const today = new Date();
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);

      const pad = (n: number) => String(n).padStart(2, '0');
      const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      const newReport: any = {
        id: reportId,
        name: template.name,
        description: `Base report generated automatically for template: ${template.name}`,
        type: 'analog_aggregate',
        dataSourceType: 'historical',
        startDate: formatDate(lastMonth),
        endDate: formatDate(today),
        startTime: '00:00',
        endTime: '23:59',
        cycleValue: 30,
        cycleUnit: 'M',
        selectedPaths: [],
        enabledSources: { sys: true, app: false, live: false }
      };

      this.apiService.createReport(newReport).subscribe({
        next: (created) => {
          console.log('✅ Base report created dynamically for template:', created);
          // Rapor listesine ekle (zaten mevcut değilse)
          if (!this.reports.find(r => String(r.id) === String(created.id))) {
            this.reports.push(created);
            this.filteredReports = [...this.reports];
          }
          this.filteredReports = [...this.reports];

          this.selectedTemplateId = template.id;
          this.selectedReportId = reportId;
          this.showTemplatesManager = false;
          this.showCustomizer = true;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('❌ Failed to create dynamic base report:', err);
          alert('Failed to initialize base report configuration for this template!');
        }
      });
      return;
    }

    this.selectedTemplateId = template.id;
    this.selectedReportId = reportId;
    this.showTemplatesManager = false;
    this.showCustomizer = true;
    this.cdr.detectChanges();
  }

  viewTemplateFiles(template: any): void {
    const desc = template.description || '';
    const match = desc.match(/Report:\s*([a-zA-Z0-9_-]+)/i);
    let reportId = match ? match[1] : '';

    if (!reportId) {
      const bestReport = this.findBestMatchingReport(template.name);
      if (bestReport) {
        reportId = bestReport.id;
      }
    }

    if (!reportId) {
      alert('No base report found in the system!');
      return;
    }

    let report: any = this.reports.find(r => String(r.id) === reportId);
    if (!report) {
      report = {
        id: reportId,
        name: template.name,
      };
    }

    this.selectedTemplateNameForViewer = template.name;
    this.viewReport(report, template.name);
  }

  loadGeneratedFiles(): void {
    this.loadingGeneratedFiles = true;
    this.apiService.getGeneratedReports().subscribe({
      next: (res) => {
        this.generatedFiles = res || [];
        this.loadingGeneratedFiles = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load generated files:', err);
        this.loadingGeneratedFiles = false;
        this.cdr.detectChanges();
      }
    });
  }

  downloadGeneratedFile(file: any): void {
    const downloadUrl = file.downloadUrl
      ? `${environment.apiUrl}${file.downloadUrl}`
      : `${environment.apiUrl}/download/${file.filename}`;

    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = file.filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async deleteGeneratedFile(file: any): Promise<void> {
    if (!await this.confirmService.confirm(`Are you sure you want to delete the generated file "${file.filename}"?`)) {
      return;
    }
    this.apiService.deleteGeneratedReports([file.filename]).subscribe({
      next: () => {
        this.showSuccess('Generated file deleted successfully.');
        this.loadGeneratedFiles();
      },
      error: (err) => {
        console.error('Failed to delete file:', err);
        alert('Failed to delete file.');
      }
    });
  }

  formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  getFileIcon(type: string): string {
    switch (type) {
      case 'excel': return 'fas fa-file-excel text-green-600';
      case 'pdf': return 'fas fa-file-pdf text-red-600';
      case 'csv': return 'fas fa-file-csv text-blue-600';
      case 'json': return 'fas fa-file-code text-yellow-600';
      case 'html': return 'fas fa-file-code text-orange-600';
      default: return 'fas fa-file text-gray-500';
    }
  }

  expandedFolders: { [key: string]: boolean } = {};

  toggleFolder(folderName: string): void {
    this.expandedFolders[folderName] = !this.expandedFolders[folderName];
  }

  isFolderExpanded(folderName: string): boolean {
    return !!this.expandedFolders[folderName];
  }

  getGroupedGeneratedFiles(): { folderName: string, files: any[] }[] {
    const groups: { [key: string]: any[] } = {};
    for (const file of this.generatedFiles) {
      const folder = file.reportName || 'Uncategorized';
      if (!groups[folder]) {
        groups[folder] = [];
      }
      groups[folder].push(file);
    }
    return Object.keys(groups).map(folderName => ({
      folderName,
      files: groups[folderName]
    }));
  }
}
