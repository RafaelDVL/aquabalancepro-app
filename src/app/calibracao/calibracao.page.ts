import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertController,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToast,
  IonToolbar,
  IonButton,
} from '@ionic/angular/standalone';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService } from '../services/doser.service';
import { loadStoredColors, pumpColor } from '../services/pump-colors';
import { addIcons } from 'ionicons';
import { checkmarkCircleOutline, colorWandOutline, powerOutline, stopCircleOutline, timerOutline, waterOutline } from 'ionicons/icons';

/** Mesmo valor do firmware (TEMPO_POR_ML): duração da dose = ml × 700 ms × coeficiente. */
const MS_PER_ML = 700;
/** Folga para a bomba ligar e o pedido chegar ao ESP32. */
const START_MARGIN_MS = 1500;
/** Medido acima disso (fração do pedido) pede confirmação: ar na mangueira ou erro de digitação. */
const SANITY_LIMIT = 0.4;
/** Conferência dentro disso conta como calibrada. */
const VERIFY_TOLERANCE = 0.03;
/** Doses manuais acima disso pedem confirmação. */
const MANUAL_CONFIRM_ML = 10;
/** Acionamento contínuo: sinal ao firmware a cada 1 s (ele desliga com 4 s sem sinal) e teto do firmware. */
const RUN_KEEPALIVE_MS = 1000;
const RUN_MAX_MS = 120000;

type Step = 'setup' | 'running' | 'measure' | 'result' | 'verified';
type Mode = 'calibrar' | 'conferir';

interface CalibrationResult {
  pedido: number;
  medido: number;
  antes: number;
  depois: number;
  salvo: boolean;
}

interface VerifyResult {
  pedido: number;
  medido: number;
  erro: number;
}

@Component({
  selector: 'app-calibracao',
  templateUrl: './calibracao.page.html',
  imports: [
    IonButton,
    IonIcon,
    CommonModule,
    FormsModule,
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
  calibrationDose = 10;
  readonly calibrationOptions = [5, 10, 20];
  step: Step = 'setup';
  mode: Mode = 'calibrar';
  measuredInput = '';
  remainingMs = 0;
  totalMs = 0;
  result: CalibrationResult | null = null;
  verify: VerifyResult | null = null;
  sending = false;
  saving = false;
  quickTestBombId = 1;
  quickTestDose = 1;
  readonly quickDoseOptions = [1, 3, 5, 10, 15];
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;
  runBombId: number | null = null;
  runElapsedMs = 0;
  runBusy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runTimer: ReturnType<typeof setInterval> | null = null;
  private runStartedAt = 0;
  private lastKeepAlive = 0;
  private keepAliveInFlight = false;
  private deadline = 0;
  private colors: Record<string, string> = {};

  constructor(
    private readonly doser: DoserService,
    private readonly alerts: AlertController,
  ) {
    addIcons({ colorWandOutline, waterOutline, timerOutline, checkmarkCircleOutline, powerOutline, stopCircleOutline });
  }

  async ionViewWillEnter(): Promise<void> {
    this.colors = loadStoredColors();
    await this.loadConfig();
    await this.resumeRun();
  }

  color(id: number): string {
    return pumpColor(id, this.colors);
  }

  ionViewWillLeave(): void {
    this.stopTimer();
    if (this.runBombId !== null) void this.stopRun();
  }

  async loadConfig(): Promise<void> {
    this.errorMessage = '';
    try {
      this.bombs = await firstValueFrom(this.doser.getConfig());
      if (this.bombs.length && !this.bombs.some((bomb) => bomb.id === this.selectedBombId)) {
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

  get progress(): number {
    return this.totalMs > 0 ? Math.min(1, 1 - this.remainingMs / this.totalMs) : 0;
  }

  get remainingSeconds(): number {
    return Math.ceil(this.remainingMs / 1000);
  }

  bombName(bomb: BombConfig | undefined): string {
    return bomb?.name || `Bomba ${bomb?.id ?? ''}`;
  }

  /** Vazão estimada pelo coeficiente atual (ml/min). */
  flow(coef: number): number {
    return 60000 / (MS_PER_ML * (coef || 1));
  }

  durationMs(ml: number, coef: number): number {
    return ml * MS_PER_ML * (coef || 1);
  }

  num(value: number, decimals = 1): string {
    return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  }

  coef(value: number): string {
    return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }

  /** Erro relativo em % com sinal (+ dosou a mais). */
  percent(erro: number): string {
    const value = Math.round(erro * 1000) / 10;
    return `${value > 0 ? '+' : ''}${value.toLocaleString('pt-BR')}%`;
  }

  deviationText(pedido: number, medido: number): string {
    if (medido === pedido) return 'A bomba já dosava o volume certo.';
    const value = Math.round((Math.abs(medido - pedido) / pedido) * 1000) / 10;
    return `A bomba dosava ${value.toLocaleString('pt-BR')}% ${medido > pedido ? 'a mais' : 'a menos'} que o pedido.`;
  }

  selectBomb(id: number): void {
    if (this.step === 'setup') this.selectedBombId = id;
  }

  async startCalibration(): Promise<void> {
    await this.dispense('calibrar');
  }

  async startVerify(): Promise<void> {
    await this.dispense('conferir');
  }

  finishWaiting(): void {
    this.stopTimer();
    this.step = 'measure';
  }

  async submitMeasure(): Promise<void> {
    const bomb = this.selectedBomb;
    const measured = Number(String(this.measuredInput).replace(',', '.'));
    if (!bomb || !Number.isFinite(measured) || measured <= 0) {
      this.errorMessage = 'Digite o volume medido em ml.';
      return;
    }
    this.errorMessage = '';

    const deviation = Math.abs(measured - this.calibrationDose) / this.calibrationDose;
    if (deviation > SANITY_LIMIT && !(await this.confirmOutlier(measured))) return;

    if (this.mode === 'conferir') {
      this.verify = { pedido: this.calibrationDose, medido: measured, erro: (measured - this.calibrationDose) / this.calibrationDose };
      this.step = 'verified';
      return;
    }
    this.setResult(bomb, measured);
  }

  /** Conferência fora da tolerância: recalcula a partir dela (o coeficiente salvo é o ponto de partida). */
  recalibrateFromVerify(): void {
    const bomb = this.selectedBomb;
    if (!bomb || !this.verify) return;
    this.setResult(bomb, this.verify.medido);
  }

  get verifyOk(): boolean {
    return !!this.verify && Math.abs(this.verify.erro) <= VERIFY_TOLERANCE;
  }

  async saveCalibration(): Promise<void> {
    const bomb = this.selectedBomb;
    if (!bomb || !this.result || this.saving) return;
    this.saving = true;
    this.errorMessage = '';
    const updated = this.bombs.map((item) => (item.id === bomb.id ? { ...item, calibrCoef: this.result!.depois } : item));
    try {
      await firstValueFrom(this.doser.saveConfig(updated));
      this.bombs = updated;
      this.result = { ...this.result, salvo: true };
      this.toastMessage = 'Calibração salva no ESP32.';
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar calibracao.';
    } finally {
      this.saving = false;
    }
  }

  reset(): void {
    this.stopTimer();
    this.step = 'setup';
    this.mode = 'calibrar';
    this.measuredInput = '';
    this.result = null;
    this.verify = null;
    this.errorMessage = '';
  }

  increaseQuickDose(): void {
    this.quickTestDose = Number((this.quickTestDose + 0.1).toFixed(1));
  }

  decreaseQuickDose(): void {
    if (this.quickTestDose > 0.1) {
      this.quickTestDose = Number((this.quickTestDose - 0.1).toFixed(1));
    }
  }

  quickDuration(): string {
    const bomb = this.bombs.find((item) => item.id === this.quickTestBombId);
    return this.num(this.durationMs(this.quickTestDose, bomb?.calibrCoef ?? 1) / 1000, 0);
  }

  async runQuickTest(): Promise<void> {
    const dose = Number(this.quickTestDose);
    if (!Number.isFinite(dose) || dose <= 0) {
      return;
    }
    const bomb = this.bombs.find((item) => item.id === this.quickTestBombId);
    if (dose > MANUAL_CONFIRM_ML) {
      const alert = await this.alerts.create({
        header: 'Liberar dose grande?',
        message: `${this.num(dose)} ml em ${this.bombName(bomb)} (~${this.quickDuration()} s). Confira se a mangueira está no lugar certo.`,
        buttons: [
          { text: 'Cancelar', role: 'cancel' },
          { text: 'Liberar', role: 'confirm' },
        ],
      });
      await alert.present();
      const { role } = await alert.onDidDismiss();
      if (role !== 'confirm') return;
    }
    try {
      await firstValueFrom(this.doser.testDose(this.quickTestBombId, dose, 'Manual'));
      this.toastMessage = `${this.num(dose)} ml enviados para ${this.bombName(bomb)}.`;
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao enviar dose.';
    }
  }

  get runRemainingMs(): number {
    return Math.max(0, RUN_MAX_MS - this.runElapsedMs);
  }

  /** Volume estimado pelo tempo ligado (mesma conta do firmware). */
  get runMl(): number {
    const bomb = this.bombs.find((item) => item.id === this.runBombId);
    return this.runElapsedMs / (MS_PER_ML * (bomb?.calibrCoef || 1));
  }

  clock(ms: number): string {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  async toggleRun(): Promise<void> {
    if (this.runBombId !== null) {
      await this.stopRun();
      return;
    }
    if (this.runBusy) return;
    this.runBusy = true;
    this.errorMessage = '';
    try {
      await firstValueFrom(this.doser.runPump(this.quickTestBombId, 'ligar'));
      this.beginRun(this.quickTestBombId, 0);
    } catch (error) {
      this.errorMessage =
        error instanceof HttpErrorResponse && error.status === 409
          ? 'Outra dose está em andamento. Aguarde terminar.'
          : error instanceof Error
            ? error.message
            : 'Falha ao ligar a bomba.';
    } finally {
      this.runBusy = false;
    }
  }

  async stopRun(): Promise<void> {
    const bombId = this.runBombId;
    if (bombId === null) return;
    const ml = this.runMl;
    const bomb = this.bombs.find((item) => item.id === bombId);
    this.endRun();
    try {
      await firstValueFrom(this.doser.runPump(bombId, 'desligar'));
      this.toastMessage = `${this.bombName(bomb)} desligada (~${this.num(ml)} ml).`;
      this.toastOpen = true;
    } catch {
      this.errorMessage = 'Sem resposta do ESP32. A bomba desliga sozinha em até 4 s sem sinal do app.';
    }
  }

  /** Volta à tela com a bomba ainda ligada (pelo app em outro aparelho, por exemplo). */
  private async resumeRun(): Promise<void> {
    if (this.runBombId !== null) return;
    try {
      const status = await firstValueFrom(this.doser.getStatus());
      if (status.run) {
        this.quickTestBombId = status.run.bomb;
        this.beginRun(status.run.bomb, status.run.ms);
      }
    } catch {
      // Sem status: a tela segue sem acionamento em andamento
    }
  }

  private beginRun(bombId: number, elapsedMs: number): void {
    this.endRun();
    this.runBombId = bombId;
    this.runStartedAt = Date.now() - elapsedMs;
    this.runElapsedMs = elapsedMs;
    this.lastKeepAlive = Date.now();
    this.runTimer = setInterval(() => this.tickRun(), 200);
  }

  private endRun(): void {
    if (this.runTimer) clearInterval(this.runTimer);
    this.runTimer = null;
    this.runBombId = null;
    this.keepAliveInFlight = false;
  }

  private tickRun(): void {
    this.runElapsedMs = Date.now() - this.runStartedAt;
    if (this.runBombId === null || this.keepAliveInFlight || Date.now() - this.lastKeepAlive < RUN_KEEPALIVE_MS) return;
    const bombId = this.runBombId;
    this.lastKeepAlive = Date.now();
    this.keepAliveInFlight = true;
    this.doser.runPump(bombId, 'manter').subscribe({
      next: () => (this.keepAliveInFlight = false),
      error: (error) => {
        if (this.runBombId !== bombId) return;
        const bomb = this.bombs.find((item) => item.id === bombId);
        const ml = this.runMl;
        this.endRun();
        this.errorMessage =
          error instanceof HttpErrorResponse && error.status === 409
            ? `${this.bombName(bomb)} desligou sozinha (~${this.num(ml)} ml): passou de 2 min ou ficou 4 s sem sinal do app.`
            : 'Conexão com o ESP32 perdida. A bomba desliga sozinha em até 4 s sem sinal do app.';
      },
    });
  }

  private async dispense(mode: Mode): Promise<void> {
    const bomb = this.selectedBomb;
    const dose = Number(this.calibrationDose);
    if (!bomb || this.sending || !Number.isFinite(dose) || dose <= 0) return;
    this.sending = true;
    this.errorMessage = '';
    try {
      await firstValueFrom(this.doser.testDose(bomb.id, dose, 'Calibracao'));
      this.mode = mode;
      this.measuredInput = '';
      this.verify = null;
      if (mode === 'calibrar') this.result = null;
      this.startTimer(this.durationMs(dose, bomb.calibrCoef) + START_MARGIN_MS);
      this.step = 'running';
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao acionar a bomba.';
    } finally {
      this.sending = false;
    }
  }

  private setResult(bomb: BombConfig, measured: number): void {
    // Firmware: duração = ml × 700 × coef. Dosou menos que o pedido → coeficiente sobe na mesma proporção.
    const depois = Number((bomb.calibrCoef * (this.calibrationDose / measured)).toFixed(3));
    this.result = { pedido: this.calibrationDose, medido: measured, antes: bomb.calibrCoef, depois, salvo: false };
    this.mode = 'calibrar';
    this.step = 'result';
  }

  private async confirmOutlier(measured: number): Promise<boolean> {
    const alert = await this.alerts.create({
      header: 'Confira o valor',
      message: `Você mediu ${this.num(measured, 2)} ml para um pedido de ${this.num(this.calibrationDose)} ml. Ar na mangueira ou erro de digitação?`,
      buttons: [
        { text: 'Corrigir', role: 'cancel' },
        { text: 'Usar mesmo assim', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    return role === 'confirm';
  }

  private startTimer(ms: number): void {
    this.stopTimer();
    this.totalMs = ms;
    this.remainingMs = ms;
    this.deadline = Date.now() + ms;
    this.timer = setInterval(() => {
      this.remainingMs = Math.max(0, this.deadline - Date.now());
      if (this.remainingMs <= 0) this.finishWaiting();
    }, 200);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
