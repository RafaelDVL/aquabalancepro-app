import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { flash, powerOutline, timerOutline } from 'ionicons/icons';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToast,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { DoserService, RelayInfo } from '../services/doser.service';

interface RelayView extends RelayInfo {
  busy: boolean;
}

@Component({
  selector: 'app-relays',
  templateUrl: './relays.page.html',
  styleUrls: ['./relays.page.scss'],
  imports: [
    CommonModule,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonTitle,
    IonToast,
    IonToggle,
    IonToolbar,
  ],
})
export class RelaysPage {
  relays: RelayView[] = [];
  loading = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;

  private pollSub?: Subscription;
  private tickSub?: Subscription;
  private pollBusy = false;
  readonly pollMs = 3000;

  constructor(private readonly doser: DoserService, private readonly router: Router) {
    addIcons({ flash, powerOutline, timerOutline });
  }

  ionViewWillEnter(): void {
    void this.loadRelays();
    this.startPolling();
  }

  ionViewWillLeave(): void {
    this.stopPolling();
  }

  async loadRelays(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const relays = await firstValueFrom(this.doser.getRelays());
      this.relays = relays.map((relay) => ({ ...relay, busy: false }));
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar os reles.';
    } finally {
      this.loading = false;
    }
  }

  async toggleRelay(relay: RelayView, state: boolean): Promise<void> {
    if (relay.state === state) return; // ignora reenvio quando o polling atualiza o toggle
    relay.busy = true;
    const previous = relay.state;
    relay.state = state;
    relay.timerRemaining = 0; // manual vence o timer
    try {
      await firstValueFrom(this.doser.setRelay(relay.id, state));
    } catch (error) {
      relay.state = previous; // reverte em caso de erro
      this.toastMessage = error instanceof Error ? error.message : 'Falha ao acionar o rele.';
      this.toastOpen = true;
    } finally {
      relay.busy = false;
    }
  }

  openRules(): void {
    void this.router.navigateByUrl('/rules');
  }

  formatTimer(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollSub = interval(this.pollMs).subscribe(() => void this.refreshSilent());
    this.tickSub = interval(1000).subscribe(() => this.tickTimers());
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = undefined;
    this.tickSub?.unsubscribe();
    this.tickSub = undefined;
  }

  private async refreshSilent(): Promise<void> {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      const relays = await firstValueFrom(this.doser.getRelays());
      this.relays = relays.map((relay) => {
        const existing = this.relays.find((item) => item.id === relay.id);
        // Preserva o estado otimista enquanto uma troca manual está em voo
        if (existing?.busy) {
          return existing;
        }
        return { ...relay, busy: false };
      });
    } catch {
      // mantem o ultimo estado conhecido em caso de erro de rede
    } finally {
      this.pollBusy = false;
    }
  }

  private tickTimers(): void {
    for (const relay of this.relays) {
      if (relay.timerRemaining > 0) {
        relay.timerRemaining -= 1;
      }
    }
  }
}
