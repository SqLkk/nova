import { Component, EventEmitter, Input, OnInit, Output, OnChanges, SimpleChanges, ChangeDetectorRef } from '@angular/core';
import { ApiService, ReportFile } from '../../services/api.service';
import { environment } from '../../../environments/environment';
import { Report } from '../../models/report.model';
import { TranslateService } from '@ngx-translate/core';
import { ConfirmService } from '../../services/confirm.service';

@Component({
  standalone: false,
  selector: 'app-report-viewer-dialog',
  templateUrl: './report-viewer-dialog.component.html',
  styleUrls: ['./report-viewer-dialog.component.scss']
})
export class ReportViewerDialogComponent implements OnInit, OnChanges {
  @Input() visible = false;
  @Input() report: Report | null = null;
  @Input() templateName = '';
  @Output() closed = new EventEmitter<void>();
  @Output() downloadFile = new EventEmitter<ReportFile>();

  reportFiles: ReportFile[] = [];
  isLoading = false;
  error: string | null = null;

  showExcelPreview = false;
  previewLoading = false;
  previewExcelData: any = null;
  activeSheetIdx = 0;
  previewFileName = '';

  constructor(
    private apiService: ApiService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private confirmService: ConfirmService
  ) { }

  ngOnInit(): void {
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible'] && this.visible && this.report) {
      this.loadReportFiles();
    }
  }

  loadReportFiles(): void {
    if (!this.report?.id) return;

    this.isLoading = true;
    this.error = null;
    this.reportFiles = [];

    ////console.log('📁 Rapor dosyaları yükleniyor:', this.report.id);

    this.apiService.getReportFiles(this.report.id).subscribe({
      next: (files: ReportFile[]) => {
        ////console.log('✅ Rapor dosyaları yüklendi:', files);
        if (this.templateName) {
          // Only show files that contain the template name in their filename
          const cleanTmplName = this.templateName.replace(/\s+/g, '_');
          this.reportFiles = files.filter(f => f.name.includes(cleanTmplName) || f.name.includes(this.templateName));
        } else {
          this.reportFiles = files;
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('❌ Rapor dosyaları yüklenirken hata:', err);
        this.error = this.translate.instant('REPORTS.FILES_LOAD_ERROR');
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  // Track function for ngFor performance
  trackByFileName(index: number, file: ReportFile): string {
    return file.name;
  }

  onClose(): void {
    this.visible = false;
    this.closed.emit();
  }

  onDownloadFile(file: ReportFile): void {
    ////console.log('📥 Dosya indiriliyor:', file.name);
    
    if (!this.report?.id) {
      console.error('Rapor ID bulunamadı');
      return;
    }
    this.downloadFile.emit(file);
  }

  onPreviewFile(file: ReportFile): void {
    if (!this.report?.id) {
      console.error('Rapor ID bulunamadı');
      return;
    }

    if (file.type === 'excel') {
      this.showExcelPreview = true;
      this.previewLoading = true;
      this.previewFileName = file.name;
      this.previewExcelData = null;
      this.activeSheetIdx = 0;
      this.cdr.detectChanges();

      this.apiService.previewReportFile(String(this.report.id), file.name).subscribe({
        next: (response: any) => {
          if (response.status === 'success') {
            this.previewExcelData = response.data;
          } else {
            console.error('Excel önizleme hatası:', response.message);
            alert(this.translate.instant('REPORTS.PREVIEW_FAILED', { message: response.message }));
            this.showExcelPreview = false;
          }
          this.previewLoading = false;
          this.cdr.detectChanges();
        },
        error: (err: any) => {
          console.error('Excel önizleme hatası:', err);
          alert(this.translate.instant('REPORTS.PREVIEW_ERROR'));
          this.showExcelPreview = false;
          this.previewLoading = false;
          this.cdr.detectChanges();
        }
      });
      return;
    }

    const previewUrl = `${environment.apiUrl || 'http://localhost:5000/api'}/preview/${file.name}?report_id=${this.report.id}`;
    
    try {
      const newWindow = window.open(previewUrl, '_blank');
      if (!newWindow) {
        console.error('Popup engellenmiş olabilir');
        this.onDownloadFile(file);
      }
    } catch (error) {
      console.error('Dosya önizleme hatası:', error);
      this.onDownloadFile(file);
    }
  }

  async onDeleteFile(file: ReportFile): Promise<void> {
    if (!this.report?.id) return;
    if (!await this.confirmService.confirm(this.translate.instant('REPORTS.DELETE_FILE_CONFIRM', { name: file.name }))) return;

    this.apiService.deleteReportFile(String(this.report.id), file.name).subscribe({
      next: () => {
        this.reportFiles = this.reportFiles.filter(f => f.name !== file.name);
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Dosya silinirken hata:', err);
        alert(this.translate.instant('REPORTS.DELETE_FILE_ERROR'));
        this.cdr.detectChanges();
      }
    });
  }

  async onDeleteAllFiles(): Promise<void> {
    if (!this.report?.id) return;
    if (!await this.confirmService.confirm(this.translate.instant('REPORTS.DELETE_ALL_FILES_CONFIRM'))) return;

    const reportId = String(this.report.id);
    const files = [...this.reportFiles];
    let completed = 0;

    for (const file of files) {
      this.apiService.deleteReportFile(reportId, file.name).subscribe({
        next: () => {
          completed++;
          this.reportFiles = this.reportFiles.filter(f => f.name !== file.name);
          this.cdr.detectChanges();
        },
        error: (err: any) => {
          completed++;
          console.error('Dosya silinirken hata:', err, file.name);
          this.cdr.detectChanges();
        }
      });
    }
  }

  getFileIcon(type: string): string {
    switch (type) {
      case 'excel':
        return 'fas fa-file-excel';
      case 'pdf':
        return 'fas fa-file-pdf';
      case 'csv':
        return 'fas fa-file-csv';
      case 'json':
        return 'fas fa-file-code';
      default:
        return 'fas fa-file-alt';
    }
  }

  getFileIconColor(type: string): string {
    switch (type) {
      case 'excel':
        return 'text-green-400';
      case 'pdf':
        return 'text-red-400';
      case 'csv':
        return 'text-blue-400';
      case 'json':
        return 'text-purple-400';
      default:
        return 'text-slate-400';
    }
  }

  getFileTypeText(type: string): string {
    switch (type) {
      case 'excel':
        return this.translate.instant('REPORTS.FILE_TYPE_EXCEL');
      case 'pdf':
        return this.translate.instant('REPORTS.FILE_TYPE_PDF');
      case 'csv':
        return this.translate.instant('REPORTS.FILE_TYPE_CSV');
      case 'json':
        return this.translate.instant('REPORTS.FILE_TYPE_JSON');
      default:
        return this.translate.instant('REPORTS.FILE_TYPE_GENERIC');
    }
  }

  getPreviewTooltip(type: string): string {
    switch (type) {
      case 'pdf':
        return this.translate.instant('REPORTS.PREVIEW_OPEN_PDF');
      case 'excel':
        return this.translate.instant('REPORTS.PREVIEW');
      case 'csv':
        return this.translate.instant('REPORTS.PREVIEW_VIEW_CSV');
      case 'json':
        return this.translate.instant('REPORTS.PREVIEW_VIEW_JSON');
      default:
        return this.translate.instant('REPORTS.PREVIEW_VIEW_FILE');
    }
  }

  formatFileSize(size: string): string {
    // Size formatting helper
    const sizeInBytes = parseInt(size);
    if (isNaN(sizeInBytes)) return size;

    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let fileSize = sizeInBytes;

    while (fileSize >= 1024 && unitIndex < units.length - 1) {
      fileSize /= 1024;
      unitIndex++;
    }

    return `${fileSize.toFixed(1)} ${units[unitIndex]}`;
  }

  formatDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('tr-TR', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateString;
    }
  }

  getDisplayName(fileName: string): string {
    if (!fileName) return '';
    if (this.report?.id) {
      const prefix = this.report.id + '_';
      if (fileName.startsWith(prefix)) {
        return fileName.substring(prefix.length);
      }
      const prefixHyphen = this.report.id + '-';
      if (fileName.startsWith(prefixHyphen)) {
        return fileName.substring(prefixHyphen.length);
      }
    }
    const rptMatch = fileName.match(/^rpt-[a-f0-9]{12}_(.*)$/);
    if (rptMatch) {
      return rptMatch[1];
    }
    return fileName;
  }
}
