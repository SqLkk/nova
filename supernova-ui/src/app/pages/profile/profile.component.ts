import { Component, OnInit } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { UserProfileService } from '../../services/user-profile.service';
import { TranslateService } from '@ngx-translate/core';

@Component({
  standalone: false,
  selector: 'app-profile',
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss']
})
export class ProfileComponent implements OnInit {
  user: any = null;
  isEditing = false;
  editedUser: any = {};
  recentActivity: any[] = [];
  stats: any = null;
  loading = true;

  constructor(
    private authService: AuthService,
    private userProfileService: UserProfileService,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.user = this.authService.getCurrentUser();
    this.editedUser = { ...this.user };
    
    if (this.user) {
      this.loadUserStats();
      this.loadRecentActivity();
    }
  }

  loadUserStats(): void {
    this.userProfileService.getUserStats(this.user.id).subscribe({
      next: (stats) => {
        this.stats = stats;
        this.loading = false;
      },
      error: (err) => {
        console.error('Failed to load user stats:', err);
        this.stats = null;
        this.loading = false;
      }
    });
  }

  loadRecentActivity(): void {
    this.userProfileService.getRecentActivity(this.user.id).subscribe({
      next: (activity) => {
        this.recentActivity = activity;
      },
      error: (err) => {
        console.error('Failed to load recent activity:', err);
        this.recentActivity = [];
      }
    });
  }

  toggleEdit(): void {
    if (this.isEditing) {
      // Save changes
      this.authService.updateUserProfile(this.editedUser).subscribe({
        next: (response) => {
          if (response.success) {
            this.user = this.authService.getCurrentUser();
            this.isEditing = false;
          }
        },
        error: (err) => {
          console.error('Failed to update profile:', err);
        }
      });
    } else {
      // Start editing
      this.editedUser = { ...this.user };
      this.isEditing = !this.isEditing;
    }
  }

  cancelEdit(): void {
    this.editedUser = { ...this.user };
    this.isEditing = false;
  }

  getRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} ${this.translate.instant('COMMON.DAYS_AGO')}`;
    }
    if (hours > 0) {
      return `${hours} ${this.translate.instant('COMMON.HOURS_AGO')}`;
    }
    return this.translate.instant('COMMON.JUST_NOW');
  }
}
