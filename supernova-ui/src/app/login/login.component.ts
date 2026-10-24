import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ThemeService } from '../services/theme.service';
import { TranslateService } from '@ngx-translate/core';

export interface DemoCredentialCard {
  username: string;
  password: string;
  role: string;
  desc: string;
  icon: string;
  tone: 'gold' | 'emerald' | 'cyan' | 'amber' | 'slate';
  featured?: boolean;
}

@Component({
  standalone: false,
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent implements OnInit, OnDestroy {
  loginForm: FormGroup;
  loading = false;
  showPassword = false;
  errorMessage = '';
  returnUrl = '/dashboard';
  selectedLanguage = 'tr';
  activeDemoUser = '';
  isDarkTheme = true;
  currentYear = new Date().getFullYear();

  readonly languages = [
    { code: 'tr', label: 'TR', name: 'Türkçe' },
    { code: 'en', label: 'EN', name: 'English' },
    { code: 'de', label: 'DE', name: 'Deutsch' }
  ];

  readonly showcaseFeatures = [
    { icon: 'fa-sitemap', titleKey: 'LOGIN.FEAT_MAP_TITLE', descKey: 'LOGIN.FEAT_MAP_DESC', accent: 'cyan' },
    { icon: 'fa-file-excel', titleKey: 'LOGIN.FEAT_REPORT_TITLE', descKey: 'LOGIN.FEAT_REPORT_DESC', accent: 'emerald' },
    { icon: 'fa-terminal', titleKey: 'LOGIN.FEAT_STUDIO_TITLE', descKey: 'LOGIN.FEAT_STUDIO_DESC', accent: 'gold' },
    { icon: 'fa-shield-halved', titleKey: 'LOGIN.FEAT_SEC_TITLE', descKey: 'LOGIN.FEAT_SEC_DESC', accent: 'violet' }
  ];

  readonly demoCredentials: DemoCredentialCard[] = [
    {
      username: 'utku',
      password: 'utku123',
      role: 'HARDCODED.ROLE_SUPERUSER',
      desc: 'Tam Yetki · Tüm Modüller, Şablon Motoru & Mimari',
      icon: 'fa-crown',
      tone: 'gold',
      featured: true
    },
    {
      username: 'admin',
      password: 'Nova_Admin#9841',
      role: 'HARDCODED.ROLE_ADMIN',
      desc: 'Yönetici (Kullanıcılar, Roller & ACL)',
      icon: 'fa-user-shield',
      tone: 'emerald'
    },
    {
      username: 'engineer',
      password: 'Nova_Engineer#5544',
      role: 'HARDCODED.ROLE_ENGINEER',
      desc: 'Mühendis (Space Map, SQL & Python)',
      icon: 'fa-microchip',
      tone: 'cyan'
    },
    {
      username: 'operator',
      password: 'Nova_Operator#1520',
      role: 'HARDCODED.ROLE_OPERATOR',
      desc: 'Operatör (Canlı İzleme & Alarmlar)',
      icon: 'fa-gauge-high',
      tone: 'amber'
    },
    {
      username: 'viewer',
      password: 'Nova_Viewer#7611',
      role: 'HARDCODED.ROLE_VIEWER',
      desc: 'İzleyici (Salt Okunur Pano & Rapor)',
      icon: 'fa-eye',
      tone: 'slate'
    }
  ];

  private themeSub?: Subscription;

  constructor(
    private formBuilder: FormBuilder,
    private authService: AuthService,
    private themeService: ThemeService,
    private router: Router,
    private route: ActivatedRoute,
    public translate: TranslateService
  ) {
    this.selectedLanguage = localStorage.getItem('selectedLanguage') || 'tr';
    translate.setDefaultLang('tr');
    translate.use(this.selectedLanguage);
    this.isDarkTheme = this.themeService.current === 'dark';

    this.loginForm = this.formBuilder.group({
      username: ['', [Validators.required, Validators.minLength(3)]],
      password: ['', [Validators.required, Validators.minLength(3)]],
      rememberMe: [false]
    });
  }

  ngOnInit(): void {
    const rawReturn = String(this.route.snapshot.queryParams['returnUrl'] || '/dashboard');
    this.returnUrl = (rawReturn.startsWith('/') && !rawReturn.startsWith('//')) ? rawReturn : '/dashboard';
    this.themeSub = this.themeService.themeChanges$.subscribe(theme => {
      this.isDarkTheme = theme === 'dark';
    });
  }

  ngOnDestroy(): void {
    this.themeSub?.unsubscribe();
  }

  changeLanguage(lang: string): void {
    if (!lang) return;
    this.selectedLanguage = lang;
    this.translate.use(lang);
    try {
      localStorage.setItem('selectedLanguage', lang);
    } catch {
      /* ignore storage errors */
    }
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }

  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  clearError(): void {
    this.errorMessage = '';
  }

  onSubmit(): void {
    if (this.loginForm.invalid) {
      this.markFormGroupTouched();
      return;
    }

    this.loading = true;
    this.errorMessage = '';

    const { username, password } = this.loginForm.value;

    this.authService.login(String(username || '').trim(), String(password || '')).subscribe({
      next: (result) => {
        this.loading = false;
        if (result.success) {
          this.router.navigateByUrl(this.returnUrl);
        } else {
          this.activeDemoUser = '';
          this.errorMessage = result.message || this.translate.instant('HARDCODED.LOGIN_ERROR');
        }
      },
      error: () => {
        this.loading = false;
        this.activeDemoUser = '';
        this.errorMessage = this.translate.instant('HARDCODED.GENERIC_ERROR');
      }
    });
  }

  selectDemoCredential(credential: DemoCredentialCard): void {
    this.activeDemoUser = credential.username;
    this.errorMessage = '';
    this.loginForm.patchValue({
      username: credential.username,
      password: credential.password
    });
  }

  loginAs(credential: DemoCredentialCard): void {
    if (this.loading) return;
    this.selectDemoCredential(credential);
    setTimeout(() => this.onSubmit(), 40);
  }

  private markFormGroupTouched(): void {
    Object.keys(this.loginForm.controls).forEach(key => {
      this.loginForm.get(key)?.markAsTouched();
    });
  }

  hasError(fieldName: string, errorType?: string): boolean {
    const field = this.loginForm.get(fieldName);
    if (!field) return false;
    if (errorType) {
      return field.hasError(errorType) && field.touched;
    }
    return field.invalid && field.touched;
  }

  getErrorMessage(fieldName: string): string {
    const field = this.loginForm.get(fieldName);
    if (!field || !field.errors || !field.touched) return '';

    if (field.errors['required']) {
      return fieldName === 'username'
        ? this.translate.instant('LOGIN.USERNAME_REQUIRED')
        : this.translate.instant('LOGIN.PASSWORD_REQUIRED');
    }
    if (field.errors['minlength']) {
      return `${this.translate.instant('COMMON.MIN_LENGTH')} ${field.errors['minlength'].requiredLength}`;
    }
    return this.translate.instant('COMMON.INVALID_VALUE');
  }
}
