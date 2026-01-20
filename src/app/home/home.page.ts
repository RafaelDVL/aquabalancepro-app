import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonChip,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { DeviceStatus, DoserService } from '../services/doser.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    CommonModule,
    IonButton,
    IonCard,
    IonCardContent,
    IonChip,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
})
export class HomePage {
  status?: DeviceStatus;
  deviceName = 'AquaBalancePro';
  isLoading = false;
  toastMessage = '';
  toastOpen = false;

  constructor(private readonly doser: DoserService, private readonly router: Router) {}

  ionViewWillEnter(): void {
    void this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    this.isLoading = true;
    try {
      this.status = await firstValueFrom(this.doser.getStatus());
    } catch (error) {
      this.toastMessage =
        error instanceof Error ? error.message : 'Falha ao consultar o dispositivo.';
      this.toastOpen = true;
    } finally {
      this.isLoading = false;
    }
  }

  async openConfig(): Promise<void> {
    try {
      await firstValueFrom(this.doser.setTime(new Date()));
      await this.router.navigateByUrl('/configuracao');
    } catch (error) {
      this.toastMessage =
        error instanceof Error ? error.message : 'Falha ao sincronizar o horario.';
      this.toastOpen = true;
    }
  }

  openConfigPreview(): void {
    void this.router.navigateByUrl('/configuracao');
  }
}
