import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { TranslateService } from '@ngx-translate/core';

@Component({
  standalone: false,
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent implements OnInit {
  
  loginForm: FormGroup;
  loading = false;
  errorMessage = '';
  returnUrl = '';
  selectedLanguage = 'tr';
  currentYear = new Date().getFullYear();

  // Demo credentials gösterimi için
  demoCredentials = [
    { username: 'admin', password: 'Nova_Admin#9841', role: 'HARDCODED.ROLE_ADMIN', desc: 'Yönetici (ACL & Roller)', color: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' },
    { username: 'engineer', password: 'Nova_Engineer#5544', role: 'HARDCODED.ROLE_ENGINEER', desc: 'Mühendis (Space Map & Araçlar)', color: 'border-cyan-500/40 text-cyan-400 bg-cyan-500/10' },
    { username: 'operator', password: 'Nova_Operator#1520', role: 'HARDCODED.ROLE_OPERATOR', desc: 'Düz User (İzleme & Alarmlar)', color: 'border-amber-500/40 text-amber-400 bg-amber-500/10' },
    { username: 'utku', password: 'utku123', role: 'HARDCODED.ROLE_SUPERUSER', desc: 'Geliştirici (Full Yetki)', color: 'border-brand/40 text-brand bg-brand/10' },
    { username: 'viewer', password: 'Nova_Viewer#7611', role: 'HARDCODED.ROLE_VIEWER', desc: 'İzleyici (Salt Okunur)', color: 'border-slate-500/40 text-slate-400 bg-slate-500/10' }
  ];

  constructor(
    private formBuilder: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    public translate: TranslateService
  ) {
    // Dil ayarını localStorage'dan al veya varsayılan olarak tr kullan
    this.selectedLanguage = localStorage.getItem('selectedLanguage') || 'tr';
    translate.setDefaultLang('tr');
    translate.use(this.selectedLanguage);
    this.loginForm = this.formBuilder.group({
      username: ['', [Validators.required, Validators.minLength(3)]],
      password: ['', [Validators.required, Validators.minLength(3)]],
      rememberMe: [false]
    });
  }

  /**
   * Dil değiştirme işlemi
   */
  changeLanguage(lang: string): void {
    this.selectedLanguage = lang;
    this.translate.use(lang);
    localStorage.setItem('selectedLanguage', lang);
  }

  ngOnInit(): void {
    // Return URL'i al (guard'dan geliyorsa)
    this.returnUrl = this.route.snapshot.queryParams['returnUrl'] || '/dashboard';
  }

  /**
   * Form submit
   */
  onSubmit(): void {
    ////console.log('Form submit started');
    
    if (this.loginForm.invalid) {
      ////console.log('Form is invalid');
      this.markFormGroupTouched();
      return;
    }

    this.loading = true;
    this.errorMessage = '';

    const { username, password } = this.loginForm.value;
    ////console.log('Calling auth service with:', username);

    this.authService.login(username, password).subscribe({
      next: (result) => {
        ////console.log('Login result:', result);
        this.loading = false;
        
        if (result.success) {
          ////console.log('Login başarılı:', result.user);
          this.router.navigateByUrl(this.returnUrl);
        } else {
          this.errorMessage = result.message || this.translate.instant('HARDCODED.LOGIN_ERROR');
        }
      },
      error: (error) => {
        ////console.log('Login error:', error);
        this.loading = false;
        this.errorMessage = this.translate.instant('HARDCODED.GENERIC_ERROR');
        console.error('Login error:', error);
      }
    });
  }

  /**
   * Demo credential seçimi
   */
  selectDemoCredential(credential: any): void {
    this.loginForm.patchValue({
      username: credential.username,
      password: credential.password
    });
  }

  /**
   * Demo credential ile anında giriş yap
   */
  loginAs(credential: any): void {
    this.selectDemoCredential(credential);
    setTimeout(() => this.onSubmit(), 50);
  }

  /**
   * Form field'larını touched yap
   */
  private markFormGroupTouched(): void {
    Object.keys(this.loginForm.controls).forEach(key => {
      this.loginForm.get(key)?.markAsTouched();
    });
  }

  /**
   * Field error kontrolü
   */
  hasError(fieldName: string, errorType?: string): boolean {
    const field = this.loginForm.get(fieldName);
    if (!field) return false;

    if (errorType) {
      return field.hasError(errorType) && field.touched;
    }
    return field.invalid && field.touched;
  }

  /**
   * Error mesajı al
   */
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
