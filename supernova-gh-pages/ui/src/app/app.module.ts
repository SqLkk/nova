import { NgModule, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { RouterModule } from '@angular/router';
import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { WidgetComponent } from './components/widget/widget.component';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormsModule } from '@angular/forms';
import { LoginComponent } from './login/login.component';
import { NgChartsModule } from 'ng2-charts';
import { RealtimeChartComponent } from './components/realtime-chart/realtime-chart.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { ReportsComponent } from './pages/reports/reports.component';
import { ReportListComponent } from './pages/reports/report-list/report-list.component';
import { ReportCreatorComponent } from './pages/reports/report-creator/report-creator.component';
import { HttpClientModule, HttpClient, HTTP_INTERCEPTORS } from '@angular/common/http';
import { NavigationComponent } from './components/navigation/navigation.component';
import { PathSelectorDialogComponent } from './dialogs/path-selector-dialog/path-selector-dialog.component';
import { ReportViewerDialogComponent } from './dialogs/report-viewer-dialog/report-viewer-dialog.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { NetworkMapOptimizedComponent } from './pages/network-map/network-map.component';
import { ReportCustomizerComponent } from './components/report-customizer/report-customizer.component';
import { ChartManagerComponent } from './components/chart-manager/chart-manager.component';
import { FormulaManagerComponent } from './components/formula-manager/formula-manager.component';
import { ExcelTemplateBuilderComponent } from './components/excel-template-builder/excel-template-builder.component';
import { AlarmsComponent } from './pages/alarms/alarms.component';
import { TableExplorerComponent } from './pages/table-explorer/table-explorer.component';
import { PathDefinerComponent } from './components/path-definer/path-definer.component';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { QueryViewerDialogComponent } from './dialogs/query-viewer-dialog/query-viewer-dialog.component';
import { ReportSchedulerComponent } from './components/report-scheduler/report-scheduler.component';
import { ProfileComponent } from './pages/profile/profile.component';
import { SettingsComponent } from './pages/settings/settings.component';
import { AdminComponent } from './pages/admin/admin.component';
import { TemplateBuilderComponent } from './pages/template-builder/template-builder.component';
import { QueryCreatorComponent } from './pages/query-creator/query-creator.component';
import { PythonWorkspaceComponent } from './pages/python-workspace/python-workspace.component';

// Import ngx-translate
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';

// Import services for injection
import { AuthService } from './services/auth.service';
import { AuthInterceptor } from './services/auth.interceptor';
import { DemoMockInterceptor } from './interceptors/demo-mock.interceptor';
import { AuthGuard, LoginGuard } from './guards/auth.guard';
import { AlarmsService } from './services/alarms.service';
import { TableExplorerService } from './services/table-explorer.service';

// Translation loader factory
export function HttpLoaderFactory(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@NgModule({
  declarations: [
    AppComponent,
    ConfirmDialogComponent,
    WidgetComponent,
    LoginComponent,
    RealtimeChartComponent,
    DashboardComponent,
    ReportsComponent,
    ReportListComponent,
    ReportCreatorComponent,
    NavigationComponent,
    PathSelectorDialogComponent,
    ReportViewerDialogComponent,
    NetworkMapOptimizedComponent,
    ReportCustomizerComponent,
    ChartManagerComponent,
    FormulaManagerComponent,
    ExcelTemplateBuilderComponent,
    AlarmsComponent,
    TableExplorerComponent,
    QueryViewerDialogComponent,
    ReportSchedulerComponent,
    ProfileComponent,
    SettingsComponent,
    AdminComponent,
    TemplateBuilderComponent,
    QueryCreatorComponent,
    PythonWorkspaceComponent,
    PathDefinerComponent
  ],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    CommonModule,
    RouterModule,
    AppRoutingModule,
    ReactiveFormsModule,
    FormsModule, // Formlar için gerekli modül
    NgChartsModule,
    DragDropModule,
    HttpClientModule,
    TranslateModule.forRoot({
      defaultLanguage: 'en',
      loader: {
        provide: TranslateLoader,
        useFactory: HttpLoaderFactory,
        deps: [HttpClient]
      }
    })
  ],
  providers: [
    AuthService,
    AuthGuard,
    LoginGuard,
    AlarmsService,
    // Add Demo mock interceptor first so it catches API calls
    { provide: HTTP_INTERCEPTORS, useClass: DemoMockInterceptor, multi: true },
    // Her giden HTTP isteğine Bearer token ekleyen interceptor.
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true }
  ],
  bootstrap: [AppComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA] // Özel elementler için şema eklendi
})
export class AppModule { }
