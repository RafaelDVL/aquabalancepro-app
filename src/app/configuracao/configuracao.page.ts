import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { power, cloudUploadOutline, colorPaletteOutline, chevronDown, chevronUp, sparklesOutline, warningOutline } from 'ionicons/icons';
import {
  AlertController,
  IonAccordion,
  IonAccordionGroup,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonIcon,
  IonToggle,
  IonTitle,
  IonToast,
  IonToolbar } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService, ScheduleConfig } from '../services/doser.service';
import { DoseNotificationsService } from '../services/dose-notifications.service';
import { autoSchedule } from '../services/auto-schedule';
import { dailyDose } from '../services/dosing-advisor';
import { Suggestion, evaluateRules } from '../services/dosing-rules';
import {
  DosingData,
  IDENTITIES,
  IDENTITY_GROUPS,
  PumpIdentity,
  nameMatchesIdentity,
  normalizeDosingData,
} from '../services/dosing.models';
import { CatalogProduct, catalogLabel, findCatalogProduct, productsFor } from '../services/product-catalog';

const SCHEDULE_RULES = ['espaco-', 'dose-concentrada-', 'teto-diario-', 'kh-noite-'];


interface ScheduleForm extends ScheduleConfig {
  timeValue: string;
}

interface BombForm extends BombConfig {
  editingIndex: number | null;
  identidade: PumpIdentity;
  catalogoId: string | null;
  schedules: ScheduleForm[];
  color: string;
  colorBg: string;
}

type DayPreset = 'todos' | 'semana' | 'fimDeSemana';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const WEEKDAYS = [false, true, true, true, true, true, false];

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
    IonToggle,
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
  /** Documento do Ajuste de Dosagem; null com firmware antigo (sem /dosing). */
  dosingData: DosingData | null = null;
  readonly identityGroups = IDENTITY_GROUPS;
  readonly doseMin = 0.5;
  readonly doseMax = 15;
  readonly doseStep = 0.5;
  readonly dosagePresets = [0.5, 1, 3, 5, 10, 15];
  readonly dayPresets: { value: DayPreset; label: string }[] = [
    { value: 'todos', label: 'Todos' },
    { value: 'semana', label: 'Seg–Sex' },
    { value: 'fimDeSemana', label: 'Fim de semana' },
  ];
  private savedSnapshot = '';
  private suggestionsCache = { key: '', value: [] as Suggestion[] };
  private readonly colorStorageKey = 'abp-bomb-colors';
  private readonly refillStorageKey = 'abp-refill-ml';
  private readonly defaultColors: Record<number, string> = {
    1: '#2DD4BF',
    2: '#F472B6',
    3: '#A855F7',
    4: '#3B82F6',
    5: '#F59E0B',
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

  constructor(
    private readonly doser: DoserService,
    private readonly router: Router,
    private readonly notifications: DoseNotificationsService,
    private readonly alerts: AlertController,
  ) {
    addIcons({ power, cloudUploadOutline, colorPaletteOutline, chevronDown, chevronUp, sparklesOutline, warningOutline });
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
      // Tipo de produto (KH, Cálcio…) fica no /dosing; com firmware antigo o seletor só não aparece
      this.dosingData = await firstValueFrom(this.doser.getDosingData(bombs.map((bomb) => bomb.id))).catch(() => null);
      this.bombs = bombs.map((bomb) => this.toFormBomb(bomb, storedColors));
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar configuracoes.';
      const storedColors = this.getStoredColors();
      this.dosingData = null;
      this.bombs = this.createFallbackBombs(storedColors);
    } finally {
      this.savedSnapshot = this.snapshot();
      this.loading = false;
    }
  }

  get isDirty(): boolean {
    return !this.loading && this.snapshot() !== this.savedSnapshot;
  }

  /** Chamado pelo guard da rota antes de sair da tela. */
  async canLeave(): Promise<boolean> {
    if (!this.isDirty) return true;
    const alert = await this.alerts.create({
      header: 'Sair sem salvar?',
      message: 'As alterações nesta tela serão perdidas.',
      buttons: [
        { text: 'Continuar editando', role: 'cancel' },
        { text: 'Sair', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role === 'confirm') {
      this.savedSnapshot = this.snapshot();
      return true;
    }
    return false;
  }

  toggleDay(schedule: ScheduleForm, index: number): void {
    schedule.diasSemana[index] = !schedule.diasSemana[index];
  }

  setDays(schedule: ScheduleForm, preset: DayPreset): void {
    schedule.diasSemana = DAYS.map((_, day) =>
      preset === 'todos' ? true : preset === 'semana' ? WEEKDAYS[day] : !WEEKDAYS[day],
    );
  }

  setScheduleStatus(schedule: ScheduleForm, checked: boolean): void {
    schedule.status = Boolean(checked);
  }

  toggleEditing(bomb: BombForm, index: number): void {
    bomb.editingIndex = bomb.editingIndex === index ? null : index;
  }

  activeCount(bomb: BombForm): number {
    return bomb.schedules.filter((schedule) => schedule.status).length;
  }

  isBombOn(bomb: BombForm): boolean {
    return this.activeCount(bomb) > 0;
  }

  dailyDoseOf(bomb: BombForm): number {
    return dailyDose(this.toConfigPayload(bomb));
  }

  summary(bomb: BombForm): string {
    if (!this.isBombOn(bomb)) return 'Sem horários ativos';
    const next = this.nextDose(bomb);
    return `${this.formatMl(this.dailyDoseOf(bomb))} ml/dia${next ? ` · próxima ${next}` : ''}`;
  }

  /** Sugestões da agenda em edição (KH perto do Ca, dose concentrada…), recalculadas a cada alteração. */
  get suggestions(): Suggestion[] {
    const key = this.snapshot();
    if (key !== this.suggestionsCache.key) {
      const bombs = this.bombs.map((bomb) => this.toConfigPayload(bomb));
      this.suggestionsCache = {
        key,
        value: evaluateRules({ bombs, data: this.rulesData(), now: new Date() }).filter((suggestion) =>
          SCHEDULE_RULES.some((prefix) => suggestion.id.startsWith(prefix)),
        ),
      };
    }
    return this.suggestionsCache.value;
  }

  scheduleWarnings(bomb: BombForm, index: number): Suggestion[] {
    return this.suggestions.filter((suggestion) =>
      suggestion.horarios?.some((ref) => ref.pumpId === bomb.id && ref.scheduleIndex === index),
    );
  }

  hasWarnings(bomb: BombForm): boolean {
    return this.suggestions.some((suggestion) => suggestion.horarios?.some((ref) => ref.pumpId === bomb.id));
  }

  identityLabel(bomb: BombForm): string {
    return IDENTITIES[bomb.identidade].short;
  }

  catalogOptions(bomb: BombForm): CatalogProduct[] {
    return productsFor(bomb.identidade);
  }

  catalogLabel(product: CatalogProduct): string {
    return catalogLabel(product);
  }

  onIdentityChange(bomb: BombForm): void {
    if (findCatalogProduct(bomb.catalogoId)?.identidade !== bomb.identidade) bomb.catalogoId = null;
  }

  showIdentityBadge(bomb: BombForm): boolean {
    return bomb.identidade !== 'Nenhuma' && !nameMatchesIdentity(bomb.name || '', bomb.identidade);
  }

  /** Aplica a correção sugerida no formulário; só vai para o ESP32 ao tocar em Salvar. */
  applyFix(suggestion: Suggestion): void {
    const fix = suggestion.correcao;
    if (fix?.tipo !== 'mover-horario') return;
    const schedule = this.bombs.find((bomb) => bomb.id === fix.pumpId)?.schedules[fix.scheduleIndex];
    if (schedule) schedule.timeValue = this.formatTime(fix.hour, fix.minute);
  }

  async suggestTimes(): Promise<void> {
    const bombs = this.bombs.map((bomb) => this.toConfigPayload(bomb));
    const changes = autoSchedule(bombs, this.rulesData());
    if (!changes.length) {
      this.toastMessage = 'Os horários já estão bem distribuídos.';
      this.toastOpen = true;
      return;
    }

    const lines = changes.map((change) => {
      const times = change.antes.map((antes, i) => (antes === change.depois[i] ? `${antes} (mantém)` : `${antes} → ${change.depois[i]}`));
      return `${change.title}\n${times.join('\n')}`;
    });
    const alert = await this.alerts.create({
      header: 'Horário automático',
      cssClass: 'alert-pre',
      message: `${lines.join('\n\n')}\n\nEspalha as doses no dia e afasta os produtos que não combinam (ex.: KH e Cálcio). Doses e dias não mudam.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Aplicar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role !== 'confirm') return;

    for (const change of changes) {
      const bomb = this.bombs.find((item) => item.id === change.pumpId);
      for (const time of change.horarios) {
        const schedule = bomb?.schedules[time.scheduleIndex];
        if (schedule) schedule.timeValue = this.formatTime(time.hour, time.minute);
      }
    }
    this.toastMessage = 'Horários aplicados. Revise e toque em Salvar.';
    this.toastOpen = true;
  }

  /** Volume em pt-BR com 1 a 2 casas (ex.: 2,0 · 0,43). */
  formatMl(value: number): string {
    return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  daysLabel(schedule: ScheduleForm): string {
    const active = schedule.diasSemana.map((on, day) => (on ? day : -1)).filter((day) => day >= 0);
    if (active.length === 7) return 'Todos os dias';
    if (!active.length) return 'Nenhum dia';
    if (schedule.diasSemana.every((on, day) => on === WEEKDAYS[day])) return 'Seg–Sex';
    if (schedule.diasSemana.every((on, day) => on === !WEEKDAYS[day])) return 'Fim de semana';
    return active.map((day) => DAYS[day]).join(', ');
  }

  isPreset(schedule: ScheduleForm, preset: DayPreset): boolean {
    return schedule.diasSemana.every((on, day) =>
      preset === 'todos' ? on : preset === 'semana' ? on === WEEKDAYS[day] : on === !WEEKDAYS[day],
    );
  }

  stockDays(bomb: BombForm): number | null {
    const perDay = this.dailyDoseOf(bomb);
    if (perDay <= 0 || bomb.quantidadeEstoque <= 0) return null;
    return Math.floor(bomb.quantidadeEstoque / perDay);
  }

  normalizeStock(bomb: BombForm): void {
    const value = Number(bomb.quantidadeEstoque);
    bomb.quantidadeEstoque = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  async refill(bomb: BombForm): Promise<void> {
    const sizes = this.getRefillSizes();
    const alert = await this.alerts.create({
      header: 'Reabasteci',
      message: `Volume do frasco novo de ${bomb.name || `Bomba ${bomb.id}`} (ml).`,
      inputs: [{ name: 'ml', type: 'number', min: 1, value: sizes[String(bomb.id)] ?? 1000 }],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Definir estoque', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss();
    const ml = Math.round(Number(data?.values?.ml));
    if (role !== 'confirm' || !Number.isFinite(ml) || ml <= 0) return;

    bomb.quantidadeEstoque = ml;
    try {
      localStorage.setItem(this.refillStorageKey, JSON.stringify({ ...sizes, [String(bomb.id)]: ml }));
    } catch {
      // Ignora falhas de storage
    }
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
      if (this.dosingData && this.profilesChanged()) {
        const data = this.rulesData();
        await firstValueFrom(this.doser.saveDosingData(data));
        this.dosingData = data;
      }
      this.savedSnapshot = this.snapshot();
      this.toastMessage = 'Configuracoes salvas com sucesso.';
      this.toastOpen = true;
      if (this.dosingData) void this.notifications.sync(payload, this.dosingData);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar configuracoes.';
    } finally {
      this.saving = false;
    }
  }

  private nextDose(bomb: BombForm): string | null {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    for (let offset = 0; offset < 8; offset++) {
      const day = (now.getDay() + offset) % 7;
      const times = bomb.schedules
        .filter((schedule) => schedule.status && schedule.diasSemana[day])
        .map((schedule) => schedule.timeValue || '00:00')
        .filter((time) => {
          const [hour, minute] = time.split(':').map(Number);
          return offset > 0 || hour * 60 + minute > nowMinutes;
        })
        .sort();
      if (times.length) {
        return offset === 0 ? times[0] : offset === 1 ? `amanhã ${times[0]}` : `${DAYS[day]} ${times[0]}`;
      }
    }
    return null;
  }

  private snapshot(): string {
    return JSON.stringify(
      this.bombs.map((bomb) => ({ ...this.toConfigPayload(bomb), identidade: bomb.identidade, catalogoId: bomb.catalogoId })),
    );
  }

  /** Perfil do aquário com o tipo e o produto escolhidos nesta tela (sem /dosing, usa os padrões). */
  private rulesData(): DosingData {
    const base = this.dosingData ?? normalizeDosingData({}, this.bombs.map((bomb) => bomb.id));
    return {
      ...base,
      pumps: base.pumps.map((pump) => {
        const bomb = this.bombs.find((item) => item.id === pump.pumpId);
        if (!bomb) return pump;
        // Produto novo do catálogo traz nome e potência; "Outro" mantém o que já estava cadastrado
        const product = bomb.catalogoId !== pump.catalogoId ? findCatalogProduct(bomb.catalogoId) : undefined;
        return {
          ...pump,
          identidade: bomb.identidade,
          catalogoId: bomb.catalogoId,
          ...(product
            ? { produto: catalogLabel(product), potencia: product.potencia ?? pump.potencia, gramasPorLitro: null }
            : {}),
        };
      }),
    };
  }

  private profilesChanged(): boolean {
    return this.bombs.some((bomb) => {
      const pump = this.dosingData?.pumps.find((item) => item.pumpId === bomb.id);
      return (pump?.identidade ?? 'Nenhuma') !== bomb.identidade || (pump?.catalogoId ?? null) !== bomb.catalogoId;
    });
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
    const { editingIndex, identidade, color, colorBg, ...rest } = bomb;
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
      quantidadeEstoque: Number(bomb.quantidadeEstoque) || 0,
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
      editingIndex: null,
      identidade: this.dosingData?.pumps.find((pump) => pump.pumpId === bomb.id)?.identidade ?? 'Nenhuma',
      catalogoId: this.dosingData?.pumps.find((pump) => pump.pumpId === bomb.id)?.catalogoId ?? null,
      color,
      colorBg: this.colorWithAlpha(color, 0.12),
      schedules: bomb.schedules.map((schedule) => ({
        ...schedule,
        timeValue: this.formatTime(schedule.hour, schedule.minute),
      })),
    };
  }

  private createFallbackBombs(storedColors: Record<string, string>): BombForm[] {
    return [1, 2, 3, 4, 5].map((id) =>
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

  private getRefillSizes(): Record<string, number> {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.refillStorageKey) ?? '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
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
