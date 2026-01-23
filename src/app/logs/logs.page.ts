import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { flaskOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { DoserService, LogEntry } from '../services/doser.service';

@Component({
  selector: 'app-logs',
  templateUrl: './logs.page.html',
  imports: [IonIcon,
    CommonModule,
    IonBackButton,
    IonButtons,
    IonContent,
    IonFooter,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
})
export class LogsPage {
  logs: LogEntry[] = [];
  loading = false;
  clearing = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;

  // Usa o mesmo esquema da tela de configuração
  private readonly colorStorageKey = 'abp-bomb-colors';
  private readonly defaultColors: Record<number, string> = {
    1: '#2DD4BF',
    2: '#F472B6',
    3: '#A855F7',
  };
  private storedColors: Record<string, string> = {};

  constructor(private readonly doser: DoserService) {
    addIcons({ flaskOutline });
  }

  getPumpColor(id: number | undefined): string {
    const safeId = Number(id) || 1;
    const fromStorage = this.storedColors[String(safeId)];
    return fromStorage ?? this.defaultColors[safeId] ?? '#0F969C';
  }

  getPumpGradient(id: number | undefined): string {
    const base = this.getPumpColor(id);
    const start = this.colorWithAlpha(base, 0.95);
    const end = this.colorWithAlpha(base, 0.35);
    return `linear-gradient(180deg, ${start} 0%, ${end} 100%)`;
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

  ionViewWillEnter(): void {
    this.storedColors = this.getStoredColors();
    void this.loadLogs();
  }

  ionViewWillLeave(): void {
    // Cleanup if needed
  }

  async loadLogs(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const logs = await firstValueFrom(this.doser.getLogs());
      this.logs = this.sortLogs(logs);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar logs.';
    } finally {
      this.loading = false;
    }
  }

  async clearLogs(): Promise<void> {
    if (this.clearing || !this.logs.length) {
      return;
    }
    this.clearing = true;
    this.errorMessage = '';
    try {
      await firstValueFrom(this.doser.clearLogs());
      this.logs = [];
      this.toastMessage = 'Logs apagados.';
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao apagar logs.';
    } finally {
      this.clearing = false;
    }
  }

  isProgramado(log: LogEntry): boolean {
    return (log.origem ?? '').toLowerCase().includes('program');
  }

  private sortLogs(logs: LogEntry[]): LogEntry[] {
    return [...logs].sort((a, b) => this.parseTimestamp(b.timestamp) - this.parseTimestamp(a.timestamp));
  }

  private parseTimestamp(value: string | undefined): number {
    if (!value) return 0;
    const [datePart, timePart] = value.split(' ');
    if (!datePart) return 0;
    const [day, month, year] = datePart.split('/').map((part) => Number(part));
    const [hour, minute, second] = (timePart ?? '').split(':').map((part) => Number(part));

    if (!day || !month || !year) return 0;
    const parsed = new Date(year, month - 1, day, hour || 0, minute || 0, second || 0);
    return parsed.getTime();
  }
}
