import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { Chart, ChartConfiguration, registerables, Plugin } from 'chart.js';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService, LogEntry } from '../services/doser.service';

// Desabilitar animações para melhor performance
Chart.defaults.animation = false as any;

Chart.register(...registerables);

// Plugin customizado para desenhar overlay no gráfico diário
const dailyChartOverlayPlugin: Plugin = {
  id: 'dailyChartOverlay',
  afterDatasetsDraw(chart: any) {
    const ctx = chart.ctx;

    // Desenhar linha pontilhada da hora atual
    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;

    if (currentHour >= 0 && currentHour <= 24) {
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;

      const x = xScale.getPixelForValue(currentHour);
      const yTop = yScale.getPixelForValue(yScale.max);
      const yBottom = yScale.getPixelForValue(yScale.min);

      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBottom);
      ctx.stroke();
      ctx.restore();
    }

    // Desenhar doses acima dos pontos
    chart.data.datasets.forEach((dataset: any, datasetIndex: number) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta.hidden && meta.data) {
        meta.data.forEach((element: any, index: number) => {
          const point = dataset.data[index];
          if (point && point.dosagem) {
            const x = element.x;
            const y = element.y - 25;

            ctx.save();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(point.dosagem.toFixed(1) + 'ml', x, y);
            ctx.restore();
          }
        });
      }
    });
  },
};

Chart.register(dailyChartOverlayPlugin);

type ChartType = 'daily';

interface DailyDataPoint {
  hour: number;
  minute: number;
  bombId: number;
  dosagem: number;
  origem: string;
  scheduled: boolean;
  isExecuted?: boolean;
}

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.page.html',
  styleUrls: ['./analytics.page.scss'],
  imports: [
    CommonModule,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class AnalyticsPage implements OnInit, AfterViewInit {
  @ViewChild('dailyCanvas', { static: false }) dailyCanvas?: ElementRef<HTMLCanvasElement>;

  loading = false;
  errorMessage = '';

  private dailyChart?: Chart;
  private logs: LogEntry[] = [];
  private bombs: BombConfig[] = [];
  private readonly colorStorageKey = 'abp-bomb-colors';
  private readonly defaultColors: Record<number, string> = {
    1: '#2DD4BF',
    2: '#F472B6',
    3: '#A855F7',
  };
  private storedColors: Record<string, string> = {};

  constructor(private readonly doser: DoserService) {}

  async ngOnInit(): Promise<void> {
    this.storedColors = this.getStoredColors();
    await this.loadData();
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.createCharts();
    }, 100);
  }

  async loadData(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      const [logs, config] = await Promise.all([
        firstValueFrom(this.doser.getLogs()),
        firstValueFrom(this.doser.getConfig()),
      ]);
      this.logs = logs;
      this.bombs = config;
      if (this.dailyChart) {
        this.updateCharts();
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar dados.';
    } finally {
      this.loading = false;
    }
  }

  private createCharts(): void {
    this.createDailyChart();
  }

  private updateCharts(): void {
    this.updateDailyChart();
  }

  private createDailyChart(): void {
    if (!this.dailyCanvas?.nativeElement) return;

    const ctx = this.dailyCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const data = this.getDailyData();

    // Agrupar dados por bomba (sem separar programado/executado)
    const datasets: any[] = [];
    const bombIds = [...new Set(data.map(d => d.bombId))].sort((a, b) => a - b);

    bombIds.forEach((bombId) => {
      const bombData = data.filter(d => d.bombId === bombId);
      datasets.push({
        label: this.getBombName(bombId),
        data: bombData.map((d) => {
          const point: any = {
            x: d.hour + d.minute / 60,
            y: bombId,
            dosagem: d.dosagem,
            origem: d.origem,
            scheduled: d.scheduled,
          };
          return point;
        }),
        backgroundColor: this.getPumpColor(bombId),
        borderColor: this.getPumpColor(bombId),
        pointRadius: 8,
        pointHoverRadius: 10,
        pointStyle: (ctx: any) => {
          const dataPoint = bombData[ctx.dataIndex];
          // Losango para executados, círculo para programados
          return (dataPoint?.isExecuted || !dataPoint?.scheduled) ? 'rectRot' : 'circle';
        },
      });
    });

    const config: ChartConfiguration = {
      type: 'scatter',
      data: {
        datasets: datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          intersect: false,
        },
        onHover: null as any,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              color: '#ffffff',
              font: { size: 11 },
              padding: 15,
              usePointStyle: true,
              pointStyle: 'circle',
            },
          },
          tooltip: {
            enabled: true,
            callbacks: {
              label: (context: any) => {
                const point = context.raw as any;
                if (!point) return '';
                return `${point.origem} - ${point.dosagem.toFixed(2)} ml às ${String(Math.floor(point.x)).padStart(2, '0')}:${String(Math.round((point.x % 1) * 60)).padStart(2, '0')}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 24,
            ticks: {
              stepSize: 2,
              color: '#94a3b8',
              callback: (value: any) => `${value}h`,
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          } as any,
          y: {
            type: 'linear',
            min: bombIds.length > 0 ? Math.min(...bombIds) - 0.5 : 0.5,
            max: bombIds.length > 0 ? Math.max(...bombIds) + 0.5 : 3.5,
            ticks: {
              stepSize: 1,
              color: '#94a3b8',
              callback: (value: any) => {
                // Mostrar apenas círculos coloridos no eixo Y
                const bombId = value as number;
                if (bombIds.includes(bombId)) {
                  return '● ';
                }
                return '';
              },
            },
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
          } as any,
        } as any,
      } as any,
    };

    this.dailyChart = new Chart(ctx, config);
  }

  private updateDailyChart(): void {
    if (!this.dailyChart) return;

    const data = this.getDailyData();
    const bombIds = [...new Set(data.map(d => d.bombId))].sort((a, b) => a - b);

    // Reconstruir datasets com novos dados
    this.dailyChart.data.datasets = bombIds.map((bombId) => {
      const bombData = data.filter(d => d.bombId === bombId);
      return {
        label: this.getBombName(bombId),
        data: bombData.map((d) => {
          const point: any = {
            x: d.hour + d.minute / 60,
            y: bombId,
            dosagem: d.dosagem,
            origem: d.origem,
            scheduled: d.scheduled,
          };
          return point;
        }),
        backgroundColor: this.getPumpColor(bombId),
        borderColor: this.getPumpColor(bombId),
        pointRadius: 8,
        pointHoverRadius: 10,
        pointStyle: (ctx: any) => {
          const dataPoint = bombData[ctx.dataIndex];
          return (dataPoint?.isExecuted || !dataPoint?.scheduled) ? 'rectRot' : 'circle';
        },
      };
    });

    this.dailyChart.update();
  }

  private getDailyData(): DailyDataPoint[] {
    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    // Logs executados hoje (excluindo testes)
    const executed = this.logs
      .filter((log) => log.timestamp.startsWith(todayStr) && log.origem.toLowerCase() !== 'teste')
      .map((log) => {
        const [, timePart] = log.timestamp.split(' ');
        const [hour, minute] = (timePart || '00:00').split(':').map(Number);
        return {
          hour: hour || 0,
          minute: minute || 0,
          bombId: log.bombaId,
          dosagem: log.dosagem,
          origem: log.origem,
          scheduled: false,
          isExecuted: true,
        };
      });

    // Schedules programados para hoje (que não foram testes)
    const dayOfWeek = today.getDay();
    const scheduled: DailyDataPoint[] = [];
    this.bombs.forEach((bomb) => {
      bomb.schedules.forEach((schedule) => {
        if (schedule.status && schedule.diasSemana[dayOfWeek]) {
          scheduled.push({
            hour: schedule.hour,
            minute: schedule.minute,
            bombId: bomb.id,
            dosagem: schedule.dosagem,
            origem: 'Programado',
            scheduled: true,
          });
        }
      });
    });

    return [...executed, ...scheduled];
  }

  private getPumpColor(id: number): string {
    const fromStorage = this.storedColors[String(id)];
    return fromStorage ?? this.defaultColors[id] ?? '#0F969C';
  }

  private getBombName(id: number): string {
    const bomb = this.bombs.find((b) => b.id === id);
    return bomb?.name || `Bomba ${id}`;
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
}
