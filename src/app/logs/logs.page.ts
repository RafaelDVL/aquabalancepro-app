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
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { DoserService, LogEntry } from '../services/doser.service';

@Component({
  selector: 'app-logs',
  templateUrl: './logs.page.html',
  imports: [
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

  constructor(private readonly doser: DoserService) {}

  ionViewWillEnter(): void {
    void this.loadLogs();
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
