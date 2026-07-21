import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './login/login.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { ReportsComponent } from './pages/reports/reports.component';
import { NetworkMapOptimizedComponent } from './pages/network-map/network-map.component';
import { AlarmsComponent } from './pages/alarms/alarms.component';
import { AuthGuard, LoginGuard } from './guards/auth.guard';
import { TableExplorerComponent } from './pages/table-explorer/table-explorer.component';
import { ProfileComponent } from './pages/profile/profile.component';
import { SettingsComponent } from './pages/settings/settings.component';
import { AdminComponent } from './pages/admin/admin.component';
import { TemplateBuilderComponent } from './pages/template-builder/template-builder.component';
import { QueryCreatorComponent } from './pages/query-creator/query-creator.component';
import { PythonWorkspaceComponent } from './pages/python-workspace/python-workspace.component';

const routes: Routes = [
  // Default redirect to login
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  
  // Login page (only accessible if not logged in)
  { 
    path: 'login', 
    component: LoginComponent,
    canActivate: [LoginGuard]
  },
  
  // Protected routes (require authentication)
  { 
    path: 'dashboard', 
    component: DashboardComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'dashboard' }
  },
  { 
    path: 'reports', 
    component: ReportsComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'reports' }
  },
  { 
    path: 'network-map', 
    component: NetworkMapOptimizedComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'network-map' }
  },
  { 
    path: 'alarms', 
    component: AlarmsComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'alarms' }
  },
  {
    path: 'table-explorer',
    component: TableExplorerComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'table-explorer' }
  },
  { 
    path: 'profile', 
    component: ProfileComponent,
    canActivate: [AuthGuard]
  },
  { 
    path: 'settings', 
    component: SettingsComponent,
    canActivate: [AuthGuard]
  },
  { 
    path: 'admin', 
    component: AdminComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'admin' }
  },

  // Excel benzeri şablon editörü (Template Builder) — rapor kalbi.
  {
    path: 'template-builder',
    component: TemplateBuilderComponent,
    canActivate: [AuthGuard]
  },
  {
    path: 'query-creator',
    component: QueryCreatorComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'query-creator' }
  },
  {
    path: 'python-workspace',
    component: PythonWorkspaceComponent,
    canActivate: [AuthGuard],
    data: { pageKey: 'python-workspace' }
  },

  // Wildcard route - redirect to dashboard if logged in, login if not
  { path: '**', redirectTo: '/dashboard' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { useHash: true })],
  exports: [RouterModule]
})
export class AppRoutingModule {}
