import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonAccordion,
  IonAccordionGroup,
  IonBackButton,
  IonButton,
  IonButtons,
  IonChip,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonNote,
  IonRange,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToast,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService, ScheduleConfig } from '../services/doser.service';

interface ScheduleForm extends ScheduleConfig {
  timeValue: string;
}

interface BombForm extends BombConfig {
  activeScheduleIndex: number;
  schedules: ScheduleForm[];
}

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

@Component({
  selector: 'app-configuracao',
  templateUrl: './configuracao.page.html',
  styleUrls: ['./configuracao.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonAccordion,
    IonAccordionGroup,
    IonBackButton,
    IonButton,
    IonButtons,
    IonChip,
    IonContent,
    IonHeader,
    IonInput,
    IonItem,
    IonLabel,
    IonNote,
    IonRange,
    IonSegment,
    IonSegmentButton,
    IonTitle,
    IonToast,
    IonToggle,
    IonToolbar,
  ],
})
export class ConfiguracaoPage {
  bombs: BombForm[] = [];
  days = DAYS;
  loading = false;
  saving = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;

  constructor(private readonly doser: DoserService, private readonly router: Router) {}

  async ionViewWillEnter(): Promise<void> {
    await this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const bombs = await firstValueFrom(this.doser.getConfig());
      this.bombs = bombs.map((bomb) => this.toFormBomb(bomb));
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar configuracoes.';
      this.bombs = this.createFallbackBombs();
    } finally {
      this.loading = false;
    }
  }

  toggleDay(schedule: ScheduleForm, index: number): void {
    schedule.diasSemana[index] = !schedule.diasSemana[index];
  }

  activeCount(bomb: BombForm): number {
    return bomb.schedules.filter((schedule) => schedule.status).length;
  }

  isBombOn(bomb: BombForm): boolean {
    return this.activeCount(bomb) > 0;
  }

  async saveConfig(): Promise<void> {
    if (!this.bombs.length) {
      return;
    }

    this.errorMessage = this.findDuplicateTimes();
    if (this.errorMessage) {
      return;
    }

    this.saving = true;
    try {
      const payload = this.bombs.map((bomb) => this.toConfigPayload(bomb));
      await firstValueFrom(this.doser.saveConfig(payload));
      this.toastMessage = 'Configuracoes salvas com sucesso.';
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar configuracoes.';
    } finally {
      this.saving = false;
    }
  }

  goToCalibracao(): void {
    this.router.navigateByUrl('/calibracao');
  }

  private findDuplicateTimes(): string {
    for (const bomb of this.bombs) {
      const seen = new Set<string>();
      const activeSchedules = bomb.schedules.filter((schedule) => schedule.status);
      for (const schedule of activeSchedules) {
        const key = schedule.timeValue || '00:00';
        if (seen.has(key)) {
          return `Horario duplicado na ${bomb.name || `Bomba ${bomb.id}`}.`;
        }
        seen.add(key);
      }
    }
    return '';
  }

  private toConfigPayload(bomb: BombForm): BombConfig {
    const { activeScheduleIndex, ...rest } = bomb;
    const schedules = bomb.schedules.map((schedule) => {
      const [hour, minute] = schedule.timeValue.split(':').map((value) => Number(value));
      const { timeValue, ...scheduleRest } = schedule;
      return {
        ...scheduleRest,
        hour: Number.isFinite(hour) ? hour : 0,
        minute: Number.isFinite(minute) ? minute : 0,
        dosagem: Number(schedule.dosagem),
        status: Boolean(schedule.status),
        diasSemana: Array.from({ length: 7 }, (_, day) => Boolean(schedule.diasSemana?.[day])),
      };
    });

    return {
      ...rest,
      name: bomb.name?.trim() || `Bomba ${bomb.id}`,
      schedules,
    };
  }

  private formatTime(hour: number, minute: number): string {
    const safeHour = Number.isFinite(hour) ? hour : 0;
    const safeMinute = Number.isFinite(minute) ? minute : 0;
    return `${String(safeHour).padStart(2, '0')}:${String(safeMinute).padStart(2, '0')}`;
  }

  private toFormBomb(bomb: BombConfig): BombForm {
    return {
      ...bomb,
      activeScheduleIndex: 0,
      schedules: bomb.schedules.map((schedule) => ({
        ...schedule,
        timeValue: this.formatTime(schedule.hour, schedule.minute),
      })),
    };
  }

  private createFallbackBombs(): BombForm[] {
    return [1, 2, 3].map((id) =>
      this.toFormBomb({
        id,
        name: `Bomba ${id}`,
        calibrCoef: 1,
        quantidadeEstoque: 0,
        schedules: Array.from({ length: 3 }, (_, index) => ({
          id: index + 1,
          hour: 0,
          minute: 0,
          dosagem: 0.5,
          status: false,
          diasSemana: Array.from({ length: 7 }, () => false),
        })),
      }),
    );
  }
}
