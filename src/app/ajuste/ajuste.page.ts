import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  AlertController,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService } from '../services/doser.service';
import { DoseNotificationsService } from '../services/dose-notifications.service';
import { AdjustmentResult, PumpAdjustment, applyAdjustments, computeAdjustments, dailyDose, daysBetween, fmt, round } from '../services/dosing-advisor';
import { Suggestion, evaluateRules, parseDeviceTime } from '../services/dosing-rules';
import {
  DosingData,
  IDENTITIES,
  MAX_SESSIONS,
  MEASURED_PARAMS,
  MeasuredParam,
  Measurements,
  SESSION_DAY_OPTIONS,
  TestSession,
  openSession,
} from '../services/dosing.models';

type MeasurementForm = Record<MeasuredParam, number | null>;

function emptyMeasurements(): MeasurementForm {
  return { KH: null, Ca: null, Mg: null };
}

function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

@Component({
  selector: 'app-ajuste',
  templateUrl: './ajuste.page.html',
  imports: [CommonModule, FormsModule, IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToast, IonToolbar],
})
export class AjustePage {
  readonly params = MEASURED_PARAMS;
  readonly dayOptions = SESSION_DAY_OPTIONS;
  readonly info = IDENTITIES;
  bombs: BombConfig[] = [];
  data: DosingData | null = null;
  suggestions: Suggestion[] = [];
  session: TestSession | undefined;
  result: AdjustmentResult | null = null;

  medidas: MeasurementForm = emptyMeasurements();
  diasPlanejados = 7;
  dataInicio = toLocalInput(new Date());
  dataFim = toLocalInput(new Date());

  loading = false;
  busy = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;

  constructor(
    private readonly doser: DoserService,
    private readonly notifications: DoseNotificationsService,
    private readonly alerts: AlertController,
    private readonly router: Router,
  ) {}

  async ionViewWillEnter(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    this.result = null;
    try {
      this.bombs = await firstValueFrom(this.doser.getConfig());
      this.data = await firstValueFrom(this.doser.getDosingData(this.bombs.map((bomb) => bomb.id)));
      this.session = openSession(this.data);
      this.medidas = emptyMeasurements();
      this.dataFim = toLocalInput(new Date());
      if (this.session) {
        this.dataInicio = toLocalInput(new Date(this.session.inicio));
        this.diasPlanejados = this.session.diasPlanejados;
      } else {
        this.dataInicio = toLocalInput(new Date());
      }
      await this.refreshSuggestions();
      void this.notifications.sync(this.bombs, this.data);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar os dados.';
    } finally {
      this.loading = false;
    }
  }

  get needsSetup(): boolean {
    return !!this.data && (this.data.tank.volumeLitros <= 0 || !this.data.pumps.some((pump) => IDENTITIES[pump.identidade].measured && pump.potencia));
  }

  get diasDecorridos(): number {
    return this.session ? Math.max(0, daysBetween(new Date(this.dataInicio), new Date(this.dataFim))) : 0;
  }

  get progresso(): number {
    return this.session ? Math.min(100, (this.diasDecorridos / this.session.diasPlanejados) * 100) : 0;
  }

  paramLabel(param: MeasuredParam): string {
    return `${IDENTITIES[param].label} (${IDENTITIES[param].unit})`;
  }

  formatDate(value: string | undefined): string {
    return value ? new Date(value).toLocaleDateString('pt-BR') : '';
  }

  formatNumber(value: number | undefined, decimals = 2): string {
    return value === undefined ? '—' : round(value, decimals).toLocaleString('pt-BR');
  }

  pumpName(pumpId: string | number): string {
    const bomb = this.bombs.find((item) => item.id === Number(pumpId));
    return bomb?.name || `Bomba ${pumpId}`;
  }

  appliedEntries(session: TestSession): { pumpId: string; antes: number; depois: number }[] {
    return Object.keys(session.aplicado ?? {}).map((pumpId) => ({ pumpId, ...session.aplicado![pumpId] }));
  }

  measuredKeys(values: Measurements | undefined): MeasuredParam[] {
    return MEASURED_PARAMS.filter((param) => values?.[param] !== undefined);
  }

  get history(): TestSession[] {
    return [...(this.data?.sessoes ?? [])].filter((session) => session.fim).reverse();
  }

  get selectedCount(): number {
    return this.result?.ajustes.filter((item) => item.selecionada && item.status === 'ajustar').length ?? 0;
  }

  statusLabel(item: PumpAdjustment): string {
    switch (item.status) {
      case 'ajustar':
        return item.origem === 'vinculo' ? 'Sugestão vinculada' : 'Ajustar';
      case 'manter':
        return 'Manter';
      case 'sem-horario':
        return 'Sem horário ativo';
      default:
        return 'Sem dados';
    }
  }

  async startSession(): Promise<void> {
    if (!this.data) return;
    const medidasInicio = this.collectMeasurements();
    if (medidasInicio.KH === undefined && medidasInicio.Ca === undefined) {
      this.errorMessage = 'Informe pelo menos o KH ou o Cálcio.';
      return;
    }
    const inicio = new Date(this.dataInicio);
    const session: TestSession = {
      id: inicio.toISOString(),
      inicio: inicio.toISOString(),
      diasPlanejados: this.diasPlanejados,
      medidasInicio,
      dosesSnapshot: this.snapshot(this.bombs),
    };
    await this.persist({ ...this.data, sessoes: [...this.data.sessoes, session].slice(-MAX_SESSIONS) }, 'Teste iniciado.');
  }

  calculate(): void {
    if (!this.data || !this.session) return;
    this.errorMessage = '';
    const medidasFim = this.collectMeasurements();
    const session = { ...this.session, inicio: new Date(this.dataInicio).toISOString() };
    this.result = computeAdjustments({
      bombs: this.bombs,
      data: this.data,
      session,
      medidasFim,
      fim: new Date(this.dataFim),
    });
  }

  async apply(): Promise<void> {
    if (!this.data || !this.session || !this.result) return;
    const selected = this.result.ajustes.filter((item) => item.selecionada && item.status === 'ajustar');
    const lines = selected.map((item) => `${item.nome}: ${fmt(item.doseAtual)} → ${fmt(item.doseNova)} ml/dia`);
    const confirmed = await this.confirm(
      selected.length ? 'Aplicar novas doses?' : 'Encerrar sem mudar doses?',
      selected.length
        ? `${lines.join('\n')}\n\nAs doses serão gravadas no ESP32 e um novo teste começará agora.`
        : 'O resultado fica no histórico e um novo teste começa agora com as medidas de hoje.',
    );
    if (!confirmed) return;

    this.busy = true;
    try {
      const newBombs = applyAdjustments(this.bombs, this.result.ajustes);
      if (selected.length) {
        await firstValueFrom(this.doser.saveConfig(newBombs));
        this.bombs = newBombs;
      }

      const fim = new Date(this.dataFim);
      const medidasFim = this.collectMeasurements();
      const aplicado = selected.reduce<Record<string, { antes: number; depois: number }>>((acc, item) => {
        acc[String(item.pumpId)] = { antes: item.doseAtual, depois: item.doseNova };
        return acc;
      }, {});
      const closed: TestSession = {
        ...this.session,
        inicio: new Date(this.dataInicio).toISOString(),
        fim: fim.toISOString(),
        medidasFim,
        aplicado,
      };
      const next: TestSession = {
        id: fim.toISOString(),
        inicio: fim.toISOString(),
        diasPlanejados: this.session.diasPlanejados,
        medidasInicio: medidasFim,
        dosesSnapshot: this.snapshot(newBombs),
      };
      const sessoes = [...this.data.sessoes.filter((item) => item.id !== this.session!.id), closed, next].slice(-MAX_SESSIONS);
      await this.persist({ ...this.data, sessoes }, selected.length ? 'Doses aplicadas. Novo teste iniciado.' : 'Resultado salvo. Novo teste iniciado.');
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao aplicar o ajuste.';
    } finally {
      this.busy = false;
    }
  }

  async cancelSession(): Promise<void> {
    if (!this.data || !this.session) return;
    const confirmed = await this.confirm('Descartar o teste aberto?', 'As medidas do início deste teste serão apagadas.');
    if (!confirmed) return;
    const sessoes = this.data.sessoes.filter((item) => item.id !== this.session!.id);
    await this.persist({ ...this.data, sessoes }, 'Teste descartado.');
  }

  async applySuggestion(suggestion: Suggestion): Promise<void> {
    const fix = suggestion.correcao;
    if (!fix) return;
    const confirmed = await this.confirm(suggestion.descricaoCorrecao ?? 'Aplicar correção?', suggestion.mensagem);
    if (!confirmed) return;

    this.busy = true;
    try {
      if (fix.tipo === 'sincronizar-relogio') {
        await firstValueFrom(this.doser.setTime(new Date()));
        this.toastMessage = 'Relógio do ESP32 sincronizado.';
      } else {
        const newBombs = this.bombs.map((bomb) =>
          bomb.id !== fix.pumpId
            ? bomb
            : {
                ...bomb,
                schedules: bomb.schedules.map((schedule, index) =>
                  index === fix.scheduleIndex ? { ...schedule, hour: fix.hour, minute: fix.minute } : schedule,
                ),
              },
        );
        await firstValueFrom(this.doser.saveConfig(newBombs));
        this.bombs = newBombs;
        if (this.data) void this.notifications.sync(newBombs, this.data);
        this.toastMessage = 'Horário atualizado.';
      }
      this.toastOpen = true;
      await this.refreshSuggestions();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao aplicar a correção.';
    } finally {
      this.busy = false;
    }
  }

  openProdutos(): void {
    void this.router.navigateByUrl('/produtos');
  }

  private async refreshSuggestions(): Promise<void> {
    if (!this.data) return;
    let deviceTime: Date | null = null;
    try {
      deviceTime = parseDeviceTime((await firstValueFrom(this.doser.getStatus())).time);
    } catch {
      // sem /status: a regra do relógio é ignorada
    }
    this.suggestions = evaluateRules({ bombs: this.bombs, data: this.data, now: new Date(), deviceTime });
  }

  private async persist(data: DosingData, message: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.doser.saveDosingData(data));
      this.toastMessage = message;
      this.toastOpen = true;
      await this.load();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar.';
    } finally {
      this.busy = false;
    }
  }

  private collectMeasurements(): Measurements {
    return MEASURED_PARAMS.reduce<Measurements>((acc, param) => {
      const value = this.medidas[param];
      if (value !== null && value !== undefined && String(value) !== '' && Number.isFinite(Number(value))) {
        acc[param] = Number(value);
      }
      return acc;
    }, {});
  }

  private snapshot(bombs: BombConfig[]): Record<string, number> {
    return bombs.reduce<Record<string, number>>((acc, bomb) => {
      acc[String(bomb.id)] = round(dailyDose(bomb), 2);
      return acc;
    }, {});
  }

  private async confirm(header: string, message: string): Promise<boolean> {
    const alert = await this.alerts.create({
      header,
      cssClass: 'alert-pre',
      message,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Confirmar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    return role === 'confirm';
  }
}
