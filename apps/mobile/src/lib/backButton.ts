import { App as CapApp } from '@capacitor/app';

type ModalCloseHandler = () => boolean;

class BackButtonManager {
  private modalStack: ModalCloseHandler[] = [];
  private lastBackPressTime = 0;
  private toastCallback: ((message: string) => void) | null = null;
  private initialized = false;

  init(toastCallback: (message: string) => void) {
    this.toastCallback = toastCallback;
    if (this.initialized) return;
    this.initialized = true;

    // Listen to Android hardware back button via Capacitor App plugin
    try {
      CapApp.addListener('backButton', () => {
        const handled = this.popAndHandle();
        if (handled) {
          // Modal was dismissed; do not exit
          return;
        }

        // At root screen - double tap to exit
        const now = Date.now();
        if (now - this.lastBackPressTime < 2000) {
          CapApp.exitApp();
        } else {
          this.lastBackPressTime = now;
          if (this.toastCallback) {
            this.toastCallback('Press back again to exit');
          }
        }
      });
    } catch (e) {
      console.debug('Capacitor App backButton listener not available in standard browser', e);
    }

    // Desktop keyboard Escape key listener
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.popAndHandle();
        }
      });
    }
  }

  push(handler: ModalCloseHandler): () => void {
    this.modalStack.push(handler);
    return () => {
      this.remove(handler);
    };
  }

  remove(handler: ModalCloseHandler) {
    const idx = this.modalStack.lastIndexOf(handler);
    if (idx !== -1) {
      this.modalStack.splice(idx, 1);
    }
  }

  popAndHandle(): boolean {
    while (this.modalStack.length > 0) {
      const handler = this.modalStack.pop();
      if (handler) {
        const closed = handler();
        if (closed) return true;
      }
    }
    return false;
  }

  hasOpenModals(): boolean {
    return this.modalStack.length > 0;
  }
}

export const backButtonManager = new BackButtonManager();
