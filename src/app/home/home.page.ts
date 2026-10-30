import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonContent,
  IonIcon,
  IonSpinner,
  IonToast,
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
// Importação dos ícones usados na Home
import {
  settingsSharp,
  receiptOutline,
  wifi,
  timeOutline,
  refresh,
  statsChart,
  beakerOutline,
  flaskOutline,
  cubeOutline,
  alertCircleOutline,
  checkmarkCircle,
  chevronForward,
} from 'ionicons/icons';

import { firstValueFrom, interval, Subscription } from 'rxjs';
import { BombConfig, DeviceStatus, DoserService, LogEntry } from '../services/doser.service';
import { MissedDose, findMissedDoses } from '../services/dose-check';
import { daysBetween } from '../services/dosing-advisor';
import { evaluateRules, parseDeviceTime } from '../services/dosing-rules';
import { DosingData, normalizeDosingData, openSession } from '../services/dosing.models';
import { DoseNotificationsService } from '../services/dose-notifications.service';
import { TodaySummary, buildTodaySummary, formatCountdown } from '../services/today-summary';

type AlertAction = 'ajuste' | 'configurar' | 'sincronizar';

interface HomeAlert {
  id: string;
  mensagem: string;
  acao?: AlertAction;
  acaoLabel?: string;
  detalhes?: string[];
}

const ACTION_LABELS: Record<AlertAction, string> = {
  ajuste: 'Abrir Ajuste',
  configurar: 'Configurar',
  sincronizar: 'Sincronizar',
};

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    IonIcon,
    IonSpinner,
    IonToast,
  ],
})
export class HomePage {
  status?: DeviceStatus;
  deviceName = 'AquaBalancePro';
  readonly apSsid = 'AquaBalancePro';
  readonly apPassword = '12345678';
  isLoading = false;
  canConfigure = false;
  toastMessage = '';
  toastOpen = false;
  isConnectedToDevice = false; // Indica se o app consegue alcançar o dispositivo
  testDue = false;
  today: TodaySummary | null = null;
  alerts: HomeAlert[] = [];
  private bombs: BombConfig[] = [];
  private logs: LogEntry[] = [];
  private missedDoses: MissedDose[] = [];
  private storedColors: Record<string, string> = {};
  private readonly defaultColors: Record<number, string> = {
    1: '#2DD4BF',
    2: '#F472B6',
    3: '#A855F7',
    4: '#3B82F6',
    5: '#F59E0B',
  };
  private readonly lastCheckKey = 'abp-ultima-conferencia';
  private dosingChecked = false;
  // Polling para manter Wi-Fi e hora atualizados
  private pollingSub?: Subscription;
  private pollingBusy = false;
  readonly statusPollMs = 15000; // 15s: bom equilíbrio entre responsividade e consumo

  constructor(
    private readonly doser: DoserService,
    private readonly router: Router,
    private readonly notifications: DoseNotificationsService,
  ) {
    // Registra os ícones para que apareçam no HTML
    addIcons({
      timeOutline,
      wifi,
      refresh,
      settingsSharp,
      statsChart,
      receiptOutline,
      beakerOutline,
      flaskOutline,
      cubeOutline,
      alertCircleOutline,
      checkmarkCircle,
      chevronForward,
    });
  }

  ionViewWillEnter(): void {
    this.dosingChecked = false;
    this.storedColors = this.getStoredColors();
    void this.refreshStatus();
    this.startPolling();
  }

  ionViewWillLeave(): void {
    this.stopPolling();
  }

  /** Diferença em minutos entre o relógio do ESP32 e o do celular (null sem /status). */
  get clockDriftMin(): number | null {
    const device = parseDeviceTime(this.status?.time);
    if (!device) return null;
    return Math.round((device.getTime() - Date.now()) / 60000);
  }

  get clockLabel(): string {
    const drift = this.clockDriftMin;
    if (drift === null) return '--:--';
    if (Math.abs(drift) <= 2) return 'Relógio sincronizado';
    return `Relógio ${Math.abs(drift)} min ${drift < 0 ? 'atrasado' : 'adiantado'}`;
  }

  get deviceClock(): string {
    return this.status?.time?.split(' ')[1] ?? '--:--';
  }

  countdown(minutes: number): string {
    return formatCountdown(minutes);
  }

  pumpColor(id: number): string {
    return this.storedColors[String(id)] ?? this.defaultColors[id] ?? '#0F969C';
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
      this.dosingChecked = false;
      void this.checkDosing();
    } catch {
      this.isConnectedToDevice = false;
    } finally {
      this.isLoading = false;
    }
  }

  async runAlert(alert: HomeAlert): Promise<void> {
    if (alert.acao === 'ajuste') {
      this.openAjuste();
    } else if (alert.acao === 'configurar') {
      await this.openConfig();
    } else if (alert.acao === 'sincronizar') {
      try {
        await firstValueFrom(this.doser.setTime(new Date()));
        this.toastMessage = 'Relógio do ESP32 sincronizado.';
        this.toastOpen = true;
        await this.refreshStatus();
      } catch (error) {
        this.toastMessage = error instanceof Error ? error.message : 'Falha ao sincronizar o horario.';
        this.toastOpen = true;
      }
    }
  }

  dismissAlert(alert: HomeAlert): void {
    this.alerts = this.alerts.filter((item) => item.id !== alert.id);
    if (alert.id === 'doses-perdidas') this.missedDoses = [];
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
      if (this.dosingChecked) {
        this.today = buildTodaySummary(this.bombs, this.logs, new Date());
      } else {
        void this.checkDosing();
      }
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

  openAnalytics() {
    this.router.navigate(['/analytics']);
  }

  openCalibracao(): void {
    void this.router.navigateByUrl('/calibracao');
  }

  openAjuste(): void {
    void this.router.navigateByUrl('/ajuste');
  }

  openProdutos(): void {
    void this.router.navigateByUrl('/produtos');
  }

  // Resumo do dia, avisos, conferência do log e reagendamento das notificações
  private async checkDosing(): Promise<void> {
    if (this.dosingChecked) return;
    this.dosingChecked = true;
    try {
      const [bombs, logs] = await Promise.all([
        firstValueFrom(this.doser.getConfig()),
        firstValueFrom(this.doser.getLogs()),
      ]);
      this.bombs = bombs;
      this.logs = logs;
      const now = new Date();
      this.today = buildTodaySummary(bombs, logs, now);

      let data: DosingData;
      let hasDosing = true;
      try {
        data = await firstValueFrom(this.doser.getDosingData(bombs.map((bomb) => bomb.id)));
      } catch {
        // Firmware sem /dosing: regras que só dependem da agenda continuam valendo
        data = normalizeDosingData({}, bombs.map((bomb) => bomb.id));
        hasDosing = false;
      }

      const session = openSession(data);
      this.testDue = !!session && daysBetween(new Date(session.inicio), now) >= session.diasPlanejados;
      if (hasDosing) void this.notifications.sync(bombs, data);

      let since: Date | null = null;
      try {
        const stored = localStorage.getItem(this.lastCheckKey);
        since = stored ? new Date(stored) : null;
        localStorage.setItem(this.lastCheckKey, now.toISOString());
      } catch {
        // sem storage: confere os últimos 7 dias
      }
      this.missedDoses = [...this.missedDoses, ...findMissedDoses(bombs, logs, since, now)];
      this.alerts = this.buildAlerts(bombs, data, now);
    } catch {
      this.dosingChecked = false;
    }
  }

  private buildAlerts(bombs: BombConfig[], data: DosingData, now: Date): HomeAlert[] {
    const actionFor = (id: string): AlertAction | undefined => {
      if (id === 'relogio') return 'sincronizar';
      if (id.startsWith('estoque-')) return 'configurar';
      if (id === 'teste-vencido' || id.startsWith('espaco-') || id.startsWith('dose-concentrada-')) return 'ajuste';
      return undefined;
    };

    const alerts: HomeAlert[] = evaluateRules({
      bombs,
      data,
      now,
      deviceTime: parseDeviceTime(this.status?.time),
    })
      .filter((suggestion) => suggestion.nivel === 'aviso')
      .map((suggestion) => {
        const acao = actionFor(suggestion.id);
        return { id: suggestion.id, mensagem: suggestion.mensagem, acao, acaoLabel: acao ? ACTION_LABELS[acao] : undefined };
      });

    if (this.missedDoses.length) {
      const pad = (value: number) => String(value).padStart(2, '0');
      const when = (date: Date) =>
        `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      alerts.push({
        id: 'doses-perdidas',
        mensagem: `${this.missedDoses.length} dose(s) programada(s) sem registro no log (ESP32 desligado, relógio errado ou fila cheia).`,
        detalhes: this.missedDoses
          .slice(0, 3)
          .map((dose) => `${dose.nome} · ${when(dose.quando)} · ${dose.dosagem.toLocaleString('pt-BR')} ml`),
      });
    }
    return alerts;
  }

  private getStoredColors(): Record<string, string> {
    try {
      const parsed = JSON.parse(localStorage.getItem('abp-bomb-colors') ?? '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}
