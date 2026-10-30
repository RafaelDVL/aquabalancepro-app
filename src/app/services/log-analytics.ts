import { BombConfig, LogEntry } from './doser.service';
import { MissedDose, expectedDoses, missedBetween } from './dose-check';
import { dailyDose } from './dosing-advisor';
import { parseDeviceTime } from './dosing-rules';
import { MeasuredParam, TestSession } from './dosing.models';

export type OrigemKind = 'programado' | 'manual' | 'calibracao' | 'outro';

export const ORIGEM_LABELS: Record<OrigemKind, string> = {
  programado: 'Programado',
  manual: 'Dose manual',
  calibracao: 'Calibração',
  outro: 'Outro',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
// Doses dos últimos minutos ainda podem estar na fila do ESP32
const GRACE_MS = 5 * 60 * 1000;

export function origemKind(origem: string | undefined): OrigemKind {
  const value = (origem ?? '').toLowerCase();
  if (value.startsWith('program')) return 'programado';
  if (value.startsWith('calibra')) return 'calibracao';
  if (value.startsWith('teste') || value.startsWith('manual')) return 'manual';
  return 'outro';
}

export interface ParsedLog extends LogEntry {
  quando: Date;
  kind: OrigemKind;
}

/** Converte os logs do ESP32 (timestamp "dd/MM/yyyy HH:mm") e ordena do mais recente para o mais antigo. */
export function parseLogs(logs: LogEntry[]): ParsedLog[] {
  return logs
    .map((log) => ({ ...log, quando: parseDeviceTime(log.timestamp), kind: origemKind(log.origem) }))
    .filter((log): log is ParsedLog => log.quando !== null)
    .sort((a, b) => b.quando.getTime() - a.quando.getTime());
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayLabel(date: Date, now: Date): string {
  const diff = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return `${WEEKDAYS[date.getDay()]}, ${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export interface DayGroup {
  key: string;
  label: string;
  logs: ParsedLog[];
  missed: MissedDose[];
  totalMl: number;
}

/** Agrupa logs e doses não executadas por dia, do mais recente para o mais antigo. */
export function groupByDay(logs: ParsedLog[], missed: MissedDose[], now: Date): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  const groupOf = (date: Date): DayGroup => {
    const key = dayKey(date);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: dayLabel(date, now), logs: [], missed: [], totalMl: 0 };
      groups.set(key, group);
    }
    return group;
  };
  for (const log of logs) {
    const group = groupOf(log.quando);
    group.logs.push(log);
    group.totalMl += Number(log.dosagem) || 0;
  }
  for (const dose of missed) groupOf(dose.quando).missed.push(dose);
  return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

/** Início real do período: não antes do log mais antigo disponível. */
export function coverageStart(logs: ParsedLog[], from: Date): Date {
  const oldest = logs[logs.length - 1]?.quando;
  return oldest && oldest > from ? startOfDay(oldest) : from;
}

export interface PumpPeriodStats {
  pumpId: number;
  nome: string;
  totalMl: number;
  mediaDia: number;
  manualMl: number;
  programadas: number;
  executadas: number;
  percentual: number | null;
}

/** Totais por bomba entre `from` e `to`; % executadas compara a agenda atual com os registros "Programado". */
export function periodStats(bombs: BombConfig[], logs: ParsedLog[], from: Date, to: Date): PumpPeriodStats[] {
  const days = Math.max(1, (to.getTime() - from.getTime()) / DAY_MS);
  const until = new Date(to.getTime() - GRACE_MS);
  return bombs.map((bomb) => {
    const own = logs.filter((log) => Number(log.bombaId) === bomb.id && log.quando >= from && log.quando <= to);
    const totalMl = own.reduce((sum, log) => sum + (Number(log.dosagem) || 0), 0);
    const manualMl = own.filter((log) => log.kind !== 'programado').reduce((sum, log) => sum + (Number(log.dosagem) || 0), 0);
    const programadas = expectedDoses([bomb], from, until).length;
    const perdidas = missedBetween([bomb], logs, from, until).length;
    const executadas = Math.max(0, programadas - perdidas);
    return {
      pumpId: bomb.id,
      nome: bomb.name || `Bomba ${bomb.id}`,
      totalMl,
      mediaDia: totalMl / days,
      manualMl,
      programadas,
      executadas,
      percentual: programadas ? Math.round((executadas / programadas) * 100) : null,
    };
  });
}

export interface DailySeries {
  labels: string[];
  series: { pumpId: number; nome: string; values: number[] }[];
}

/** ml por dia e por bomba nos últimos `days` dias (inclui hoje). */
export function dailySeries(bombs: BombConfig[], logs: ParsedLog[], days: number, now: Date): DailySeries {
  const first = startOfDay(addDays(now, -(days - 1)));
  const dates = Array.from({ length: days }, (_, i) => addDays(first, i));
  const index = new Map(dates.map((date, i) => [dayKey(date), i]));
  const series = bombs.map((bomb) => ({ pumpId: bomb.id, nome: bomb.name || `Bomba ${bomb.id}`, values: dates.map(() => 0) }));
  for (const log of logs) {
    const i = index.get(dayKey(log.quando));
    const target = series.find((item) => item.pumpId === Number(log.bombaId));
    if (i !== undefined && target) target.values[i] += Number(log.dosagem) || 0;
  }
  return {
    labels: dates.map((date) => `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`),
    series: series.filter((item) => item.values.some((value) => value > 0)),
  };
}

export interface StockForecast {
  pumpId: number;
  nome: string;
  estoque: number;
  consumoDia: number;
  dias: number | null;
  acabaEm: Date | null;
}

/** Previsão do fim do estoque pelo consumo real dos últimos 7 dias (ou pela agenda, sem logs). */
export function stockForecast(bombs: BombConfig[], logs: ParsedLog[], now: Date): StockForecast[] {
  const from = coverageStart(logs, addDays(now, -7));
  const days = Math.max(1, (now.getTime() - from.getTime()) / DAY_MS);
  return bombs.map((bomb) => {
    const used = logs
      .filter((log) => Number(log.bombaId) === bomb.id && log.quando >= from)
      .reduce((sum, log) => sum + (Number(log.dosagem) || 0), 0);
    const consumoDia = used > 0 ? used / days : dailyDose(bomb);
    const dias = consumoDia > 0 && bomb.quantidadeEstoque > 0 ? Math.floor(bomb.quantidadeEstoque / consumoDia) : null;
    return {
      pumpId: bomb.id,
      nome: bomb.name || `Bomba ${bomb.id}`,
      estoque: bomb.quantidadeEstoque,
      consumoDia,
      dias,
      acabaEm: dias !== null ? addDays(startOfDay(now), dias) : null,
    };
  });
}

export interface ParamPoint {
  x: number;
  y: number;
  ajuste: boolean;
}

/** Medidas de um parâmetro ao longo das sessões do Ajuste de Dosagem; `ajuste` marca quando as doses mudaram. */
export function paramSeries(sessoes: TestSession[], param: MeasuredParam): ParamPoint[] {
  const points = new Map<number, ParamPoint>();
  for (const session of sessoes) {
    const start = session.medidasInicio[param];
    if (start !== undefined) {
      const x = new Date(session.inicio).getTime();
      points.set(x, { x, y: start, ajuste: points.get(x)?.ajuste ?? false });
    }
    const end = session.medidasFim?.[param];
    if (session.fim && end !== undefined) {
      const x = new Date(session.fim).getTime();
      const ajuste = Object.keys(session.aplicado ?? {}).length > 0;
      points.set(x, { x, y: end, ajuste: ajuste || (points.get(x)?.ajuste ?? false) });
    }
  }
  return [...points.values()].sort((a, b) => a.x - b.x);
}

/** CSV com ";" e vírgula decimal (abre direto no Excel/Sheets em pt-BR). */
export function toCsv(logs: ParsedLog[], nameOf: (pumpId: number, fallback: string) => string): string {
  const escape = (value: string) => (/[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [...logs]
    .sort((a, b) => a.quando.getTime() - b.quando.getTime())
    .map((log) =>
      [
        log.timestamp.split(' ')[0],
        log.timestamp.split(' ')[1] ?? '',
        escape(nameOf(Number(log.bombaId), log.bomba)),
        String(log.dosagem).replace('.', ','),
        ORIGEM_LABELS[log.kind],
      ].join(';'),
    );
  return ['data;hora;bomba;dose_ml;origem', ...rows].join('\n');
}
