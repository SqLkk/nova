import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface ConfirmState {
  show: boolean;
  message: string;
  isAlert?: boolean;
  resolve?: (value: boolean) => void;
}

@Injectable({
  providedIn: 'root'
})
export class ConfirmService {
  private confirmState = new Subject<ConfirmState>();
  confirmState$ = this.confirmState.asObservable();

  confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.confirmState.next({
        show: true,
        message,
        isAlert: false,
        resolve
      });
    });
  }

  alert(message: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.confirmState.next({
        show: true,
        message,
        isAlert: true,
        resolve: () => resolve()
      });
    });
  }

  respond(result: boolean, resolve?: (value: boolean) => void) {
    if (resolve) {
      resolve(result);
    }
    this.confirmState.next({
      show: false,
      message: ''
    });
  }
}
