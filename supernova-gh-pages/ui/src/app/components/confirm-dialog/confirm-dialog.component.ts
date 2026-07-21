import { Component, OnInit, OnDestroy } from '@angular/core';
import { ConfirmService, ConfirmState } from '../../services/confirm.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-confirm-dialog',
  template: `
    <div *ngIf="state.show" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="bg-[rgb(24,20,31)] border border-[rgb(58,52,64)] rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 transform transition-all">
        <h3 class="text-lg font-bold text-white mb-4 flex items-center">
          <i class="fas fa-exclamation-circle text-[rgb(var(--accent-primary))] mr-3 text-xl"></i>
          Confirmation
        </h3>
        <p class="text-[rgb(163,154,137)] text-sm mb-8 leading-relaxed">
          {{ state.message }}
        </p>
        <div class="flex justify-end space-x-3">
          <button *ngIf="!state.isAlert" (click)="onCancel()" class="px-4 py-2 rounded-lg bg-[rgb(31,27,38)] border border-[rgb(58,52,64)] text-[rgb(163,154,137)] hover:text-white hover:bg-[rgb(47,41,52)] transition-colors text-sm font-semibold">
            Cancel
          </button>
          <button (click)="onConfirm()" class="px-4 py-2 rounded-lg bg-[rgb(var(--accent-primary))] text-white hover:brightness-110 shadow-[0_0_15px_rgba(var(--accent-primary-rgb),0.3)] transition-all text-sm font-semibold">
            {{ state.isAlert ? 'OK' : 'Confirm' }}
          </button>
        </div>
      </div>
    </div>
  `,
  standalone: false
})
export class ConfirmDialogComponent implements OnInit, OnDestroy {
  state: ConfirmState = { show: false, message: '' };
  private sub?: Subscription;

  constructor(private confirmService: ConfirmService) {}

  ngOnInit(): void {
    this.sub = this.confirmService.confirmState$.subscribe(state => {
      this.state = state;
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  onConfirm(): void {
    this.confirmService.respond(true, this.state.resolve);
  }

  onCancel(): void {
    this.confirmService.respond(false, this.state.resolve);
  }
}
