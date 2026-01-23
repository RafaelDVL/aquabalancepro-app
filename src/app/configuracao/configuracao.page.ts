import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { power, cloudUploadOutline, beakerOutline  } from 'ionicons/icons';
import {
  IonAccordion,
  IonAccordionGroup,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonIcon,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToast,
  IonToolbar } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService, ScheduleConfig } from '../services/doser.service';


interface ScheduleForm extends ScheduleConfig {
  timeValue: string;
}

interface BombForm extends BombConfig {
  activeScheduleIndex: number;
  schedules: ScheduleForm[];
  color: string;
  colorBg: string;
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
    IonButtons,
    IonContent,
    IonHeader,
    IonInput,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonTitle,
    IonToast,
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
  openColorPickerId: number | null = null;
  readonly doseMin = 0.5;
  readonly doseMax = 15;
  readonly doseStep = 0.5;
  readonly dosagePresets = [0.5, 1, 3, 5, 10, 15];
  private readonly colorStorageKey = 'abp-bomb-colors';
  private readonly defaultColors: Record<number, string> = {
    1: '#2DD4BF',
    2: '#F472B6',
    3: '#A855F7',
  };
  readonly colorOptions = [
    '#2DD4BF',
    '#06B6D4',
    '#22D3EE',
    '#14B8A6',
    '#F472B6',
    '#FB923C',
    '#F59E0B',
    '#A855F7',
    '#3B82F6',
    '#6366F1',
    '#fc5be6',
    '#ff0000',
  ];

  constructor(private readonly doser: DoserService, private readonly router: Router) {
    addIcons({ power, cloudUploadOutline, beakerOutline });
  }

  async ionViewWillEnter(): Promise<void> {
    await this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const bombs = await firstValueFrom(this.doser.getConfig());
      const storedColors = this.getStoredColors();
      this.bombs = bombs.map((bomb) => this.toFormBomb(bomb, storedColors));
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar configuracoes.';
      const storedColors = this.getStoredColors();
      this.bombs = this.createFallbackBombs(storedColors);
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

  selectBombColor(bomb: BombForm, color: string): void {
    this.updateBombColor(bomb, color);
    this.persistColors();
    this.openColorPickerId = null;
  }

  toggleColorPicker(bombId: number): void {
    this.openColorPickerId = this.openColorPickerId === bombId ? null : bombId;
  }

  adjustDose(schedule: ScheduleForm, delta: number): void {
    const current = Number(schedule.dosagem);
    const next = (Number.isFinite(current) ? current : this.doseMin) + delta;
    schedule.dosagem = this.normalizeDose(next);
  }

  setDosePreset(schedule: ScheduleForm, value: number): void {
    schedule.dosagem = this.normalizeDose(value);
  }

  normalizeScheduleDose(schedule: ScheduleForm): void {
    const value = Number(schedule.dosagem);
    schedule.dosagem = this.normalizeDose(value);
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
    const { activeScheduleIndex, color, colorBg, ...rest } = bomb;
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

  private toFormBomb(bomb: BombConfig, storedColors: Record<string, string>): BombForm {
    const color = storedColors[String(bomb.id)] ?? this.defaultColors[bomb.id] ?? '#0F969C';
    return {
      ...bomb,
      activeScheduleIndex: 0,
      color,
      colorBg: this.colorWithAlpha(color, 0.12),
      schedules: bomb.schedules.map((schedule) => ({
        ...schedule,
        timeValue: this.formatTime(schedule.hour, schedule.minute),
      })),
    };
  }

  private createFallbackBombs(storedColors: Record<string, string>): BombForm[] {
    return [1, 2, 3].map((id) =>
      this.toFormBomb(
        {
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
        },
        storedColors,
      ),
    );
  }

  private updateBombColor(bomb: BombForm, color: string): void {
    bomb.color = color;
    bomb.colorBg = this.colorWithAlpha(color, 0.12);
  }

  private normalizeDose(value: number): number {
    const safe = Number.isFinite(value) ? value : this.doseMin;
    const clamped = Math.min(this.doseMax, Math.max(this.doseMin, safe));
    const rounded = Math.round(clamped / this.doseStep) * this.doseStep;
    return Number(rounded.toFixed(2));
  }

  private persistColors(): void {
    const payload: Record<string, string> = {};
    for (const bomb of this.bombs) {
      if (bomb.color) {
        payload[String(bomb.id)] = bomb.color;
      }
    }
    try {
      localStorage.setItem(this.colorStorageKey, JSON.stringify(payload));
    } catch {
      // Ignora falhas de storage
    }
  }

  private getStoredColors(): Record<string, string> {
    try {
      const raw = localStorage.getItem(this.colorStorageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch {
      return {};
    }
  }

  private colorWithAlpha(color: string, alpha: number): string {
    const rgb = this.hexToRgb(color);
    if (!rgb) return `rgba(15, 150, 156, ${alpha})`;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  private hexToRgb(color: string): { r: number; g: number; b: number } | null {
    const cleaned = color.replace('#', '').trim();
    if (cleaned.length === 3) {
      const r = parseInt(cleaned[0] + cleaned[0], 16);
      const g = parseInt(cleaned[1] + cleaned[1], 16);
      const b = parseInt(cleaned[2] + cleaned[2], 16);
      return { r, g, b };
    }
    if (cleaned.length === 6) {
      const r = parseInt(cleaned.slice(0, 2), 16);
      const g = parseInt(cleaned.slice(2, 4), 16);
      const b = parseInt(cleaned.slice(4, 6), 16);
      return { r, g, b };
    }
    return null;
  }
}
