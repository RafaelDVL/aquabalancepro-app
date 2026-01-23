import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
// Importação dos ícones usados na nova Home moderna
import {
  settingsSharp,
  receiptOutline,
  wifi,
  cloud,
  timeOutline,
  refreshCircle
} from 'ionicons/icons';

import { firstValueFrom, interval, Subscription } from 'rxjs';
import { DeviceStatus, DoserService } from '../services/doser.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  standalone: true, // <--- ADICIONEI ISTO AQUI (Importante!)
  imports: [
    CommonModule,
    IonContent,
    IonIcon,
    IonSpinner,
  ],
})
export class HomePage {
  status?: DeviceStatus;
  deviceName = 'AquaBalancePro';
  isLoading = false;
  canConfigure = false;
  toastMessage = '';
  toastOpen = false;
  isConnectedToDevice = false; // Indica se o app consegue alcançar o ESP32
  // Polling para manter Wi-Fi e hora atualizados
  private pollingSub?: Subscription;
  private pollingBusy = false;
  readonly statusPollMs = 15000; // 15s: bom equilíbrio entre responsividade e consumo

  constructor(private readonly doser: DoserService, private readonly router: Router) {
    // Registra os ícones para que apareçam no HTML
    addIcons({
      settingsSharp,
      receiptOutline,
      wifi,
      cloud,
      timeOutline,
      refreshCircle
    });
  }

  ionViewWillEnter(): void {
    void this.refreshStatus();
    this.startPolling();
  }

  ionViewWillLeave(): void {
    this.stopPolling();
  }

  async refreshStatus(): Promise<void> {
    this.isLoading = true;
    this.canConfigure = false;
    try {
      this.status = await firstValueFrom(this.doser.getStatus());
      if (this.status?.apSsid) {
        this.deviceName = this.status.apSsid;
      }

      this.canConfigure = true;
      this.isConnectedToDevice = true;
    } catch (error) {
      this.toastMessage = error instanceof Error ? error.message : 'Falha ao consultar o dispositivo.';
      this.toastOpen = true;
      this.isConnectedToDevice = false;
    } finally {
      this.isLoading = false;
    }
  }

  // Versão silenciosa usada pelo polling, sem spinner/toast
  private async refreshStatusSilent(): Promise<void> {
    if (this.pollingBusy) return;
    this.pollingBusy = true;
    try {
      const s = await firstValueFrom(this.doser.getStatus());
      this.status = s;
      if (this.status?.apSsid) {
        this.deviceName = this.status.apSsid;
      }
      this.canConfigure = true;
      this.isConnectedToDevice = true;
    } catch {
      // Em erro, marca desconectado para refletir no indicador
      this.isConnectedToDevice = false;
      this.canConfigure = false;
    } finally {
      this.pollingBusy = false;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollingSub = interval(this.statusPollMs).subscribe(() => {
      void this.refreshStatusSilent();
    });
  }

  private stopPolling(): void {
    this.pollingSub?.unsubscribe();
    this.pollingSub = undefined;
  }

  async openConfig(): Promise<void> {
    try {
      await firstValueFrom(this.doser.setTime(new Date()));
    } catch (error) {
      this.toastMessage = error instanceof Error ? error.message : 'Falha ao sincronizar o horario.';
      this.toastOpen = true;
    } finally {
      await this.router.navigateByUrl('/configuracao');
    }
  }

  openLogs(): void {
    void this.router.navigateByUrl('/logs');
  }
}
