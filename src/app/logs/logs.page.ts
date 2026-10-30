import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import {
  ActionSheetController,
  AlertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
  RefresherCustomEvent,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { ellipsisVertical, alertCircleOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService } from '../services/doser.service';
import { MissedDose, findMissedDoses } from '../services/dose-check';
import { DayGroup, ORIGEM_LABELS, OrigemKind, ParsedLog, groupByDay, parseLogs, toCsv } from '../services/log-analytics';
import { loadStoredColors, pumpColor } from '../services/pump-colors';

type OrigemFilter = 'todas' | OrigemKind;

type DayRow = { tipo: 'log'; quando: Date; log: ParsedLog } | { tipo: 'perdida'; quando: Date; dose: MissedDose };

interface DayView extends DayGroup {
  rows: DayRow[];
}

const DAYS_PER_PAGE = 7;

@Component({
  selector: 'app-logs',
  templateUrl: './logs.page.html',
  imports: [
    CommonModule,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
})
export class LogsPage {
  readonly origemFilters: { value: OrigemFilter; label: string }[] = [
    { value: 'todas', label: 'Todas' },
    { value: 'programado', label: ORIGEM_LABELS.programado },
    { value: 'manual', label: ORIGEM_LABELS.manual },
    { value: 'calibracao', label: ORIGEM_LABELS.calibracao },
  ];
  logs: ParsedLog[] = [];
  bombs: BombConfig[] = [];
  missed: MissedDose[] = [];
  groups: DayView[] = [];
  pumpFilter: number | null = null;
  origemFilter: OrigemFilter = 'todas';
  visibleDays = DAYS_PER_PAGE;
  loading = false;
  clearing = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;
  private colors: Record<string, string> = {};

  constructor(
    private readonly doser: DoserService,
    private readonly actionSheets: ActionSheetController,
    private readonly alerts: AlertController,
  ) {
    addIcons({ ellipsisVertical, alertCircleOutline });
  }

  ionViewWillEnter(): void {
    this.colors = loadStoredColors();
    void this.loadLogs();
  }

  get visibleGroups(): DayView[] {
    return this.groups.slice(0, this.visibleDays);
  }

  get pumpsInLogs(): { id: number; nome: string }[] {
    const ids = new Set(this.logs.map((log) => Number(log.bombaId)));
    return [...ids].sort((a, b) => a - b).map((id) => ({ id, nome: this.pumpName(id, `Bomba ${id}`) }));
  }

  color(id: number | undefined): string {
    return pumpColor(Number(id) || 1, this.colors);
  }

  /** Nome atual da bomba (o log guarda o nome da época da dose). */
  pumpName(id: number, fallback: string): string {
    return this.bombs.find((bomb) => bomb.id === id)?.name || fallback;
  }

  origemLabel(log: ParsedLog): string {
    return ORIGEM_LABELS[log.kind];
  }

  hora(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  ml(value: number): string {
    return `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ml`;
  }

  setPumpFilter(id: number | null): void {
    this.pumpFilter = this.pumpFilter === id ? null : id;
    this.rebuild();
  }

  setOrigemFilter(value: OrigemFilter): void {
    this.origemFilter = value;
    this.rebuild();
  }

  showMore(): void {
    this.visibleDays += DAYS_PER_PAGE;
  }

  async onRefresh(event: RefresherCustomEvent): Promise<void> {
    await this.loadLogs();
    await event.target.complete();
  }

  async loadLogs(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const [logs, bombs] = await Promise.all([
        firstValueFrom(this.doser.getLogs()),
        firstValueFrom(this.doser.getConfig()).catch(() => [] as BombConfig[]),
      ]);
      this.logs = parseLogs(logs);
      this.bombs = bombs;
      this.missed = findMissedDoses(bombs, logs, null, new Date());
      this.visibleDays = DAYS_PER_PAGE;
      this.rebuild();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar logs.';
    } finally {
      this.loading = false;
    }
  }

  async openMenu(): Promise<void> {
    const sheet = await this.actionSheets.create({
      header: 'Logs',
      buttons: [
        { text: 'Atualizar', handler: () => void this.loadLogs() },
        { text: 'Exportar CSV', handler: () => void this.exportCsv() },
        { text: 'Apagar todos os logs', role: 'destructive', handler: () => void this.confirmClear() },
        { text: 'Cancelar', role: 'cancel' },
      ],
    });
    await sheet.present();
  }

  async exportCsv(): Promise<void> {
    if (!this.logs.length) return;
    const csv = toCsv(this.logs, (id, fallback) => this.pumpName(id, fallback));
    const fileName = `aquabalance-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    try {
      if (Capacitor.isNativePlatform()) {
        const file = await Filesystem.writeFile({
          path: fileName,
          data: '﻿' + csv,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({ title: 'Logs do AquaBalance', files: [file.uri] });
      } else {
        const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      this.toastMessage = error instanceof Error ? error.message : 'Falha ao exportar.';
      this.toastOpen = true;
    }
  }

  private async confirmClear(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Apagar todos os logs?',
      message: `Os ${this.logs.length} registros do ESP32 serão apagados. Exporte o CSV antes se quiser guardar o histórico.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Exportar e apagar', role: 'export' },
        { text: 'Apagar', role: 'destructive', cssClass: 'alert-button-danger' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role === 'export') {
      await this.exportCsv();
      await this.clearLogs();
    } else if (role === 'destructive') {
      await this.clearLogs();
    }
  }

  private async clearLogs(): Promise<void> {
    if (this.clearing || !this.logs.length) return;
    this.clearing = true;
    this.errorMessage = '';
    try {
      await firstValueFrom(this.doser.clearLogs());
      this.logs = [];
      this.missed = [];
      this.rebuild();
      this.toastMessage = 'Logs apagados.';
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao apagar logs.';
    } finally {
      this.clearing = false;
    }
  }

  private rebuild(): void {
    const byPump = <T extends { bombaId?: number; pumpId?: number }>(item: T) =>
      this.pumpFilter === null || Number(item.bombaId ?? item.pumpId) === this.pumpFilter;
    const logs = this.logs.filter(
      (log) => byPump(log) && (this.origemFilter === 'todas' || log.kind === this.origemFilter),
    );
    const showMissed = this.origemFilter === 'todas' || this.origemFilter === 'programado';
    const missed = showMissed ? this.missed.filter((dose) => byPump(dose)) : [];
    // Registros e doses não executadas do dia numa só lista, do horário mais recente ao mais antigo
    this.groups = groupByDay(logs, missed, new Date()).map((group) => ({
      ...group,
      rows: [
        ...group.logs.map((log): DayRow => ({ tipo: 'log', quando: log.quando, log })),
        ...group.missed.map((dose): DayRow => ({ tipo: 'perdida', quando: dose.quando, dose })),
      ].sort((a, b) => b.quando.getTime() - a.quando.getTime()),
    }));
  }
}
