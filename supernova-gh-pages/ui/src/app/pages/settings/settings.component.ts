import { Component, OnInit } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { ApiService } from '../../services/api.service';

@Component({
  standalone: false,
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss']
})
export class SettingsComponent implements OnInit {
  activeTab: 'general' | 'notifications' | 'security' | 'appearance' = 'general';
  user: any = null;

  // General Settings
  generalSettings = {
    language: 'en',
    timezone: 'Europe/Istanbul',
    dateFormat: 'DD/MM/YYYY',
    timeFormat: '24h'
  };

  // Notification Settings
  notificationSettings = {
    emailNotifications: false,
    pushNotifications: false,
    alarmNotifications: false,
    reportNotifications: false,
    weeklyDigest: false
  };

  // Security Settings
  securitySettings = {
    twoFactorAuth: false,
    sessionTimeout: 30,
    passwordExpiry: 90,
    loginNotifications: false
  };

  // Appearance Settings
  appearanceSettings = {
    theme: 'dark',
    compactMode: false,
    animationsEnabled: true,
    sidebarCollapsed: false
  };

  languages = [
    { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' }
  ];

  timezones = [
    'Europe/Istanbul',
    'Europe/London',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Tokyo'
  ];

  constructor(
    private translate: TranslateService,
    private authService: AuthService,
    private confirmService: ConfirmService,
    private apiService: ApiService
  ) {}

  ngOnInit(): void {
    this.user = this.authService.getCurrentUser();
    this.loadSettings();
  }

  detectSystemTimezone(): void {
    try {
      const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (systemTimezone) {
        this.generalSettings.timezone = systemTimezone;
        if (!this.timezones.includes(systemTimezone)) {
          this.timezones.push(systemTimezone);
        }
      }
    } catch (e) {
      console.error('Failed to detect system timezone:', e);
    }
  }

  loadSettings(): void {
    const activeLang = localStorage.getItem('selectedLanguage') || 'en';
    const activeTheme = localStorage.getItem('theme') || 'dark';

    this.generalSettings.language = activeLang;
    this.appearanceSettings.theme = activeTheme;

    // Load from user preferences first if available
    if (this.user?.preferences) {
      this.generalSettings.language = this.user.preferences.language || activeLang;
      this.generalSettings.timezone = this.user.preferences.timezone || '';
      this.generalSettings.dateFormat = this.user.preferences.dateFormat || 'DD/MM/YYYY';
      this.appearanceSettings.theme = this.user.preferences.theme || activeTheme;
    }

    // Load additional settings from localStorage
    const savedSettings = localStorage.getItem('userSettings');
    if (savedSettings) {
      try {
        const settings = JSON.parse(savedSettings);
        if (settings.general) {
          this.generalSettings = { ...this.generalSettings, ...settings.general };
        }
        if (settings.notifications) {
          this.notificationSettings = { ...this.notificationSettings, ...settings.notifications };
        }
        if (settings.security) {
          this.securitySettings = { ...this.securitySettings, ...settings.security };
        }
        if (settings.appearance) {
          this.appearanceSettings = { ...this.appearanceSettings, ...settings.appearance };
        }
      } catch (error) {
        console.error('Failed to parse saved settings:', error);
      }
    }

    // Auto-detect timezone if not explicitly loaded, or if it is Europe/Istanbul (since user is in Bratislava!)
    if (!this.generalSettings.timezone || this.generalSettings.timezone === 'Europe/Istanbul') {
      this.detectSystemTimezone();
    }
  }

  saveSettings(): void {
    console.log('Saving settings with theme:', this.appearanceSettings.theme);
    
    const settings = {
      general: this.generalSettings,
      notifications: this.notificationSettings,
      security: this.securitySettings,
      appearance: this.appearanceSettings
    };
    
    // Save to localStorage
    localStorage.setItem('userSettings', JSON.stringify(settings));
    
    // Update user preferences via AuthService
    if (this.user) {
      console.log('Updating user preferences...');
      this.authService.updateUserPreferences({
        language: this.generalSettings.language as 'tr' | 'en',
        timezone: this.generalSettings.timezone,
        dateFormat: this.generalSettings.dateFormat,
        theme: this.appearanceSettings.theme as 'light' | 'dark',
        dashboardRefreshInterval: this.user.preferences?.dashboardRefreshInterval || 30
      }).subscribe({
        next: (response) => {
          console.log('Preferences updated:', response);
          // Apply language change
          this.translate.use(this.generalSettings.language);
          localStorage.setItem('selectedLanguage', this.generalSettings.language);
          
          // Apply theme change immediately
          this.applyTheme(this.appearanceSettings.theme as 'light' | 'dark');
        },
        error: (err) => {
          console.error('Failed to update preferences:', err);
          // Temayı yine de uygula
          this.applyTheme(this.appearanceSettings.theme as 'light' | 'dark');
        }
      });
    } else {
      console.log('No user found, applying theme directly');
      // If no user, just apply language and theme
      this.translate.use(this.generalSettings.language);
      localStorage.setItem('selectedLanguage', this.generalSettings.language);
      this.applyTheme(this.appearanceSettings.theme as 'light' | 'dark');
    }
  }
  
  private applyTheme(theme: 'light' | 'dark'): void {
    console.log('Applying theme:', theme);
    const body = document.body;
    const html = document.documentElement;
    
    if (theme === 'light') {
      body.classList.remove('dark-theme');
      html.classList.remove('dark');
      body.classList.add('light-theme');
      console.log('Light theme class added to body');
    } else {
      body.classList.remove('light-theme');
      body.classList.add('dark-theme');
      html.classList.add('dark');
      console.log('Dark theme class added to body and html');
    }
    
    console.log('Body classes:', body.className);
    console.log('HTML classes:', html.className);
  }


  resetSettings(): void {
    this.translate.get('SETTINGS.RESET_CONFIRM').subscribe(async (text: string) => {
      if (await this.confirmService.confirm(text)) {
        localStorage.removeItem('userSettings');
        this.ngOnInit();
      }
    });
  }

  switchTab(tab: 'general' | 'notifications' | 'security' | 'appearance'): void {
    this.activeTab = tab;
  }
  
  changeTheme(theme: 'light' | 'dark'): void {
    console.log('Theme button clicked:', theme);
    this.appearanceSettings.theme = theme;
    this.applyTheme(theme);
  }
}
