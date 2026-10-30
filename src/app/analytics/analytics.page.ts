import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ViewWillEnter,
  ViewWillLeave,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chevronBack, chevronForward } from 'ionicons/icons';
import { Chart, ChartConfiguration, Plugin, registerables } from 'chart.js';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService } from '../services/doser.service';
import { expectedDoses } from '../services/dose-check';
import { DosingData, IDENTITIES, MEASURED_PARAMS, MeasuredParam } from '../services/dosing.models';
import {
  DailySeries,
  ParsedLog,
  PumpPeriodStats,
  StockForecast,
  addDays,
  coverageStart,
  dailySeries,
  dayKey,
  dayLabel,
  paramSeries,
  parseLogs,
  periodStats,
  startOfDay,
  stockForecast,
} from '../services/log-analytics';
import { loadStoredColors, pumpColor, withAlpha } from '../services/pump-colors';

// Desabilitar animações para melhor performance
Chart.defaults.animation = false as any;
Chart.register(...registerables);

type Period = 'dia' | '7' | '30';
type TimelineState = 'executada' | 'manual' | 'pendente' | 'perdida';

interface TimelinePoint {
  x: number;
  y: number;
  dosagem: number;
  estado: TimelineState;
  hora: string;
  programado?: string;
}

const MATCH_TOLERANCE_MIN = 30;
const MISSED_COLOR = '#FBBF24';

function fmt(value: number, decimals = 1): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Linha da hora atual e rótulo de dose acima de cada ponto (só no gráfico da timeline)
const timelineOverlayPlugin: Plugin = {
  id: 'timelineOverlay',
  afterDatasetsDraw(chart: any, _args: unknown, options: { showNow?: boolean }) {
    const ctx = chart.ctx;
    const { x: xScale, y: yScale } = chart.scales;

    if (options?.showNow) {
      const now = new Date();
      const x = xScale.getPixelForValue(now.getHours() + now.getMinutes() / 60);
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(x, yScale.getPixelForValue(yScale.max));
      ctx.lineTo(x, yScale.getPixelForValue(yScale.min));
      ctx.stroke();
      ctx.restore();
    }

    chart.data.datasets.forEach((dataset: any, datasetIndex: number) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden) return;
      meta.data.forEach((element: any, index: number) => {
        const point = dataset.data[index] as TimelinePoint;
        if (!point?.dosagem) return;
        ctx.save();
        ctx.fillStyle = point.estado === 'perdida' ? MISSED_COLOR : 'rgba(255, 255, 255, 0.7)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${fmt(point.dosagem)} ml`, element.x, element.y - 12);
        ctx.restore();
      });
    });
  },
};

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.page.html',
  styleUrls: ['./analytics.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class AnalyticsPage implements ViewWillEnter, ViewWillLeave {
  @ViewChild('timelineCanvas') timelineCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('barsCanvas') barsCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('paramCanvas') paramCanvas?: ElementRef<HTMLCanvasElement>;

  readonly params = MEASURED_PARAMS;
  readonly info = IDENTITIES;
  loading = false;
  errorMessage = '';
  period: Period = 'dia';
  param: MeasuredParam = 'KH';
  selectedDay = startOfDay(new Date());

  stats: PumpPeriodStats[] = [];
  forecasts: StockForecast[] = [];
  coverageNote = '';
  dosing: DosingData | null = null;
  dosingError = '';

  private bombs: BombConfig[] = [];
  private logs: ParsedLog[] = [];
  private colors: Record<string, string> = {};
  private charts: Chart[] = [];

  constructor(
    private readonly doser: DoserService,
    private readonly router: Router,
  ) {
    addIcons({ chevronBack, chevronForward });
  }

  async ionViewWillEnter(): Promise<void> {
    this.colors = loadStoredColors();
    this.selectedDay = startOfDay(new Date());
    await this.loadData();
  }

  ionViewWillLeave(): void {
    this.destroyCharts();
  }

  async loadData(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const [logs, bombs] = await Promise.all([
        firstValueFrom(this.doser.getLogs()),
        firstValueFrom(this.doser.getConfig()),
      ]);
      this.logs = parseLogs(logs);
      this.bombs = bombs;
      try {
        this.dosing = await firstValueFrom(this.doser.getDosingData(bombs.map((bomb) => bomb.id)));
        this.dosingError = '';
      } catch (error) {
        this.dosing = null;
        this.dosingError = error instanceof Error ? error.message : 'Dados do Ajuste de Dosagem indisponíveis.';
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar dados.';
    } finally {
      this.loading = false;
    }
    this.refresh();
  }

  // --- Estado da tela -------------------------------------------------------

  get isToday(): boolean {
    return dayKey(this.selectedDay) === dayKey(new Date());
  }

  get dayTitle(): string {
    return dayLabel(this.selectedDay, new Date());
  }

  get canGoBack(): boolean {
    const oldest = this.logs[this.logs.length - 1]?.quando;
    return !!oldest && startOfDay(oldest) < this.selectedDay;
  }

  get totals(): { ml: number; manualMl: number; percentual: number | null } {
    const programadas = this.stats.reduce((sum, item) => sum + item.programadas, 0);
    const executadas = this.stats.reduce((sum, item) => sum + item.executadas, 0);
    return {
      ml: this.stats.reduce((sum, item) => sum + item.totalMl, 0),
      manualMl: this.stats.reduce((sum, item) => sum + item.manualMl, 0),
      percentual: programadas ? Math.round((executadas / programadas) * 100) : null,
    };
  }

  get hasParamData(): boolean {
    return !!this.dosing && paramSeries(this.dosing.sessoes, this.param).length > 0;
  }

  color(pumpId: number): string {
    return pumpColor(pumpId, this.colors);
  }

  fmt(value: number, decimals = 1): string {
    return fmt(value, decimals);
  }

  forecastOf(pumpId: number): StockForecast | undefined {
    return this.forecasts.find((item) => item.pumpId === pumpId);
  }

  forecastLabel(pumpId: number): string {
    const forecast = this.forecastOf(pumpId);
    if (!forecast || forecast.acabaEm === null) return forecast && forecast.estoque <= 0 ? 'estoque não informado' : '—';
    const date = forecast.acabaEm;
    return `acaba ~${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} (${forecast.dias} d)`;
  }

  percentClass(value: number | null): string {
    if (value === null) return 'text-white/40';
    if (value >= 95) return 'text-green-400';
    if (value >= 80) return 'text-amber-300';
    return 'text-red-400';
  }

  setPeriod(period: Period): void {
    this.period = period;
    if (period === 'dia') this.selectedDay = startOfDay(new Date());
    this.refresh();
  }

  setParam(param: MeasuredParam): void {
    this.param = param;
    this.refresh();
  }

  shiftDay(delta: number): void {
    const next = addDays(this.selectedDay, delta);
    if (next > startOfDay(new Date())) return;
    this.selectedDay = next;
    this.refresh();
  }

  openAjuste(): void {
    void this.router.navigateByUrl('/ajuste');
  }

  // --- Cálculo + gráficos ---------------------------------------------------

  private refresh(): void {
    const now = new Date();
    let from: Date;
    let to: Date;
    if (this.period === 'dia') {
      from = this.selectedDay;
      to = this.isToday ? now : addDays(this.selectedDay, 1);
    } else {
      const days = Number(this.period);
      from = coverageStart(this.logs, startOfDay(addDays(now, -(days - 1))));
      to = now;
      const requested = startOfDay(addDays(now, -(days - 1)));
      this.coverageNote = from > requested ? `Logs disponíveis desde ${dayLabel(from, now).toLowerCase()}.` : '';
    }
    if (this.period === 'dia') this.coverageNote = '';

    this.stats = periodStats(this.bombs, this.logs, from, to).filter(
      (item) => item.programadas > 0 || item.totalMl > 0,
    );
    this.forecasts = stockForecast(this.bombs, this.logs, now);
    setTimeout(() => this.renderCharts(), 0);
  }

  private renderCharts(): void {
    this.destroyCharts();
    if (this.period === 'dia') this.renderTimeline();
    else this.renderBars();
    this.renderParam();
  }

  private destroyCharts(): void {
    this.charts.forEach((chart) => chart.destroy());
    this.charts = [];
  }

  private timelineData(): { pumps: BombConfig[]; points: Map<number, TimelinePoint[]> } {
    const day = this.selectedDay;
    const end = addDays(day, 1);
    const now = new Date();
    const dayLogs = this.logs.filter((log) => log.quando >= day && log.quando < end);
    const used = new Set<ParsedLog>();
    const points = new Map<number, TimelinePoint[]>();
    const push = (pumpId: number, point: TimelinePoint) => points.set(pumpId, [...(points.get(pumpId) ?? []), point]);

    for (const dose of expectedDoses(this.bombs, day, new Date(end.getTime() - 1))) {
      const match = dayLogs.find(
        (log) =>
          !used.has(log) &&
          log.kind === 'programado' &&
          Number(log.bombaId) === dose.pumpId &&
          Math.abs(log.quando.getTime() - dose.quando.getTime()) <= MATCH_TOLERANCE_MIN * 60000,
      );
      if (match) {
        used.add(match);
        push(dose.pumpId, {
          x: match.quando.getHours() + match.quando.getMinutes() / 60,
          y: 0,
          dosagem: match.dosagem,
          estado: 'executada',
          hora: hhmm(match.quando),
          programado: hhmm(dose.quando),
        });
      } else {
        const perdida = dose.quando.getTime() + 5 * 60000 < now.getTime();
        push(dose.pumpId, {
          x: dose.quando.getHours() + dose.quando.getMinutes() / 60,
          y: 0,
          dosagem: dose.dosagem,
          estado: perdida ? 'perdida' : 'pendente',
          hora: hhmm(dose.quando),
        });
      }
    }

    for (const log of dayLogs) {
      if (used.has(log)) continue;
      push(Number(log.bombaId), {
        x: log.quando.getHours() + log.quando.getMinutes() / 60,
        y: 0,
        dosagem: log.dosagem,
        estado: log.kind === 'programado' ? 'executada' : 'manual',
        hora: hhmm(log.quando),
      });
    }

    const pumps = this.bombs.filter((bomb) => points.has(bomb.id));
    pumps.forEach((bomb, index) => points.get(bomb.id)!.forEach((point) => (point.y = pumps.length - index)));
    return { pumps, points };
  }

  private renderTimeline(): void {
    const canvas = this.timelineCanvas?.nativeElement;
    if (!canvas) return;
    const { pumps, points } = this.timelineData();
    const names = new Map(pumps.map((bomb, index) => [pumps.length - index, bomb.name || `Bomba ${bomb.id}`]));

    const datasets = pumps.map((bomb) => {
      const color = this.color(bomb.id);
      const data = points.get(bomb.id)!;
      return {
        label: bomb.name || `Bomba ${bomb.id}`,
        data,
        pointRadius: 8,
        pointHoverRadius: 10,
        pointBorderWidth: 2,
        pointStyle: data.map((point) =>
          point.estado === 'executada' ? 'rectRot' : point.estado === 'manual' ? 'triangle' : 'circle',
        ),
        backgroundColor: data.map((point) =>
          point.estado === 'perdida' ? 'transparent' : point.estado === 'pendente' ? withAlpha(color, 0.35) : color,
        ),
        borderColor: data.map((point) => (point.estado === 'perdida' ? MISSED_COLOR : color)),
      };
    });

    const config: ChartConfiguration = {
      type: 'scatter',
      data: { datasets: datasets as any },
      plugins: [timelineOverlayPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          timelineOverlay: { showNow: this.isToday },
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context: any) => {
                const point = context.raw as TimelinePoint;
                const dose = `${fmt(point.dosagem)} ml`;
                switch (point.estado) {
                  case 'executada':
                    return point.programado && point.programado !== point.hora
                      ? `Programado ${point.programado} · executado ${point.hora} (${dose})`
                      : `Executado ${point.hora} (${dose})`;
                  case 'manual':
                    return `Dose manual ${point.hora} (${dose})`;
                  case 'perdida':
                    return `Sem registro ${point.hora} (${dose})`;
                  default:
                    return `Programado ${point.hora} (${dose})`;
                }
              },
            },
          },
        } as any,
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 24,
            ticks: { stepSize: 4, color: '#94a3b8', callback: (value: any) => `${value}h` },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          },
          y: {
            type: 'linear',
            min: 0.4,
            max: pumps.length + 0.6,
            ticks: {
              stepSize: 1,
              color: '#cbd5e1',
              font: { size: 11 },
              callback: (value: any) => names.get(Number(value)) ?? '',
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          },
        },
      },
    };
    this.charts.push(new Chart(canvas, config));
  }

  private renderBars(): void {
    const canvas = this.barsCanvas?.nativeElement;
    if (!canvas) return;
    const series: DailySeries = dailySeries(this.bombs, this.logs, Number(this.period), new Date());
    const config: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: series.labels,
        datasets: series.series.map((item) => ({
          label: item.nome,
          data: item.values,
          backgroundColor: this.color(item.pumpId),
          borderRadius: 3,
          maxBarThickness: 22,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#e2e8f0', boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (context: any) => `${context.dataset.label}: ${fmt(context.raw, 2)} ml` } },
        },
        scales: {
          x: { stacked: true, ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { color: '#94a3b8', callback: (value: any) => `${value} ml` },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          },
        },
      },
    };
    this.charts.push(new Chart(canvas, config));
  }

  private renderParam(): void {
    const canvas = this.paramCanvas?.nativeElement;
    if (!canvas || !this.dosing) return;
    const points = paramSeries(this.dosing.sessoes, this.param);
    if (!points.length) return;

    const target = this.dosing.tank.alvos[this.param];
    const minX = points[0].x;
    const maxX = points[points.length - 1].x;
    const pad = Math.max((maxX - minX) * 0.05, 12 * 60 * 60 * 1000);
    const unit = IDENTITIES[this.param].unit;
    const dateLabel = (value: number) => {
      const date = new Date(value);
      return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    };

    const config: ChartConfiguration = {
      type: 'line',
      data: {
        datasets: [
          {
            label: IDENTITIES[this.param].label,
            data: points.map((point) => ({ x: point.x, y: point.y })),
            borderColor: '#22d3ee',
            backgroundColor: '#22d3ee',
            tension: 0.25,
            pointRadius: points.map((point) => (point.ajuste ? 7 : 4)),
            pointStyle: points.map((point) => (point.ajuste ? 'rectRot' : 'circle')),
            pointBackgroundColor: points.map((point) => (point.ajuste ? '#F59E0B' : '#22d3ee')),
          },
          {
            label: 'Alvo',
            data: [
              { x: minX - pad, y: target },
              { x: maxX + pad, y: target },
            ],
            borderColor: 'rgba(74, 222, 128, 0.7)',
            borderDash: [6, 6],
            borderWidth: 1.5,
            pointRadius: 0,
          },
        ] as any,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items: any[]) => dateLabel(items[0].parsed.x),
              label: (context: any) => {
                if (context.datasetIndex === 1) return `Alvo: ${fmt(target, 2)} ${unit}`;
                const point = points[context.dataIndex];
                return `${fmt(point.y, 2)} ${unit}${point.ajuste ? ' · doses ajustadas' : ''}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: minX - pad,
            max: maxX + pad,
            ticks: { color: '#94a3b8', maxTicksLimit: 6, callback: (value: any) => dateLabel(Number(value)) },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          },
          y: {
            ticks: { color: '#94a3b8', callback: (value: any) => `${fmt(Number(value), 2)}` },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          },
        },
      },
    };
    this.charts.push(new Chart(canvas, config));
  }
}
