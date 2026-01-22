import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonAlert,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService } from '../services/doser.service';

@Component({
  selector: 'app-calibracao',
  templateUrl: './calibracao.page.html',
  imports: [
    CommonModule,
    FormsModule,
    IonAlert,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSelect,
    IonSelectOption,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
})
export class CalibracaoPage {
  bombs: BombConfig[] = [];
  selectedBombId = 1;
  readonly calibrationDoseMl = 1;
  quickTestBombId = 1;
  quickTestDose = 1;
  readonly quickDoseOptions = [1, 3, 5, 10, 15];
  showDosePrompt = false;
  pendingCalibration = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;
  readonly alertInputs = [
    { name: 'actualDose', type: 'number', placeholder: 'ml', min: 0, step: 0.1 },
  ];
  readonly alertButtons = [
    {
      text: 'Cancelar',
      role: 'cancel',
      handler: () => {
        this.showDosePrompt = false;
      },
    },
    {
      text: 'Calibrar',
      handler: (data: { actualDose: string }) => this.applyCalibration(data.actualDose),
    },
  ];

  constructor(private readonly doser: DoserService) {}

  async ionViewWillEnter(): Promise<void> {
    await this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    this.errorMessage = '';
    try {
      this.bombs = await firstValueFrom(this.doser.getConfig());
      if (this.bombs.length) {
        this.selectedBombId = this.bombs[0].id;
        this.quickTestBombId = this.bombs[0].id;
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar configuracoes.';
    }
  }

  get selectedBomb(): BombConfig | undefined {
    return this.bombs.find((bomb) => bomb.id === this.selectedBombId);
  }

  async startCalibration(): Promise<void> {
    if (!this.selectedBomb) {
      return;
    }
    this.pendingCalibration = true;
    try {
      await firstValueFrom(
        this.doser.testDose(this.selectedBombId, this.calibrationDoseMl, 'Calibracao'),
      );
      this.showDosePrompt = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao testar a bomba.';
    } finally {
      this.pendingCalibration = false;
    }
  }

  async applyCalibration(actualDose: string | number): Promise<void> {
    const measured = Number(actualDose);
    if (!this.selectedBomb || !Number.isFinite(measured) || measured <= 0) {
      this.showDosePrompt = false;
      return;
    }

    const ratio = this.calibrationDoseMl / measured;
    const updated = {
      ...this.selectedBomb,
      calibrCoef: Number((this.selectedBomb.calibrCoef * ratio).toFixed(3)),
    };

    this.bombs = this.bombs.map((bomb) => (bomb.id === updated.id ? updated : bomb));

    try {
      await firstValueFrom(this.doser.saveConfig(this.bombs));
      this.toastMessage = `Calibrado com ${measured} ml.`;
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar calibracao.';
    } finally {
      this.showDosePrompt = false;
    }
  }

  async runQuickTest(): Promise<void> {
    if (this.quickTestDose <= 0) {
      return;
    }
    try {
      await firstValueFrom(
        this.doser.testDose(this.quickTestBombId, this.quickTestDose, 'Teste rapido'),
      );
      this.toastMessage = 'Teste enviado para a bomba.';
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao enviar teste.';
    }
  }
}
