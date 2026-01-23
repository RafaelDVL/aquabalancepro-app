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

import { firstValueFrom } from 'rxjs';
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
    } catch (error) {
      this.toastMessage = error instanceof Error ? error.message : 'Falha ao consultar o dispositivo.';
      this.toastOpen = true;
    } finally {
      this.isLoading = false;
    }
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

  openConfigPreview(): void {
    void this.router.navigateByUrl('/configuracao');
  }

  openLogs(): void {
    void this.router.navigateByUrl('/logs');
  }
}
