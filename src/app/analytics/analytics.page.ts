import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { ViewWillEnter, ViewWillLeave } from '@ionic/angular/standalone';
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
  scheduledTime?: string; // New: stores original scheduled time if merged
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
export class AnalyticsPage implements ViewWillEnter, ViewWillLeave {
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

  async ionViewWillEnter(): Promise<void> {
    this.storedColors = this.getStoredColors();
    await this.loadData();
    // Pequeno delay para garantir que o canvas esteja renderizado no DOM
    setTimeout(() => {
      this.createCharts();
    }, 100);
  }

  ionViewWillLeave(): void {
    if (this.dailyChart) {
      this.dailyChart.destroy();
      this.dailyChart = undefined;
    }
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
      // Se o gráfico já existir (re-load manual), atualiza.
      // Caso contrário, será criado no ionViewWillEnter/setTimeout
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
    
    // Garantir limpeza anterior
    if (this.dailyChart) {
      this.dailyChart.destroy();
      this.dailyChart = undefined;
    }

    const ctx = this.dailyCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const data = this.getDailyData();

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
            scheduledTime: d.scheduledTime, // Pass through
            isExecuted: d.isExecuted
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

                const hour = Math.floor(point.x);
                const minute = Math.round((point.x % 1) * 60);
                const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                if (point.scheduledTime) {
                  return `Programado: ${point.scheduledTime} - Executado: ${timeStr} (${point.dosagem.toFixed(1)}ml)`;
                }
                
                const prefix = point.scheduled ? 'Programado' : 'Executado';
                return `${prefix}: ${timeStr} (${point.dosagem.toFixed(1)}ml) - ${point.origem}`;
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

    // Reconstruir datasets
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
            scheduledTime: d.scheduledTime,
            isExecuted: d.isExecuted
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

    // 1. Obter executados hoje
    const executed: DailyDataPoint[] = this.logs
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

    // 2. Obter programados para hoje
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

    // 3. Mesclar (Matching)
    // Se houver um executado com mesmo BombID e Dosagem, e horário PRÓXIMO (+/- 15 min),
    // consideramos que o programado JÁ FOI executado.
    // Marcamos o executado com "scheduledTime" e REMOVEMOS o scheduled da lista.

    const finalScheduled: DailyDataPoint[] = [];

    scheduled.forEach((sched) => {
      const schedTimeVal = sched.hour * 60 + sched.minute;

      // Tentar encontrar um executado correspondente
      const matchIndex = executed.findIndex((exec) => {
        // Já foi mergeado?
        if (exec.scheduledTime) return false;
        
        // Mesma bomba e dosagem aprox (float compare)
        if (exec.bombId !== sched.bombId) return false;
        if (Math.abs(exec.dosagem - sched.dosagem) > 0.05) return false;

        // Tolerância de tempo (ex: +/- 30 minutos)
        // Isso cobre casos onde o relógio do ESP estava levemente adiantado/atrasado ou delay de rede
        const execTimeVal = exec.hour * 60 + exec.minute;
        const diff = Math.abs(execTimeVal - schedTimeVal);
        return diff <= 30; 
      });

      if (matchIndex !== -1) {
        // Encontrou correspondência!
        // Atualiza o executado com infos do programado
        const scheduledTimeStr = `${String(sched.hour).padStart(2,'0')}:${String(sched.minute).padStart(2,'0')}`;
        executed[matchIndex].scheduledTime = scheduledTimeStr;
        // NÃO adiciona ao finalScheduled pois já está representado no executado
      } else {
        // Não encontrou, então ainda deve acontecer (ou falhou/foi perdido)
        finalScheduled.push(sched);
      }
    });

    // IMPORTANTE: Retornar [...scheduled, ...executed]
    // Isso garante que os 'executed' (Losangos) sejam desenhados POR ÚLTIMO (em cima)
    return [...finalScheduled, ...executed];
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
