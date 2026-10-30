import { BombConfig, LogEntry } from './doser.service';
import { isScheduleActive } from './dosing-advisor';
import { parseDeviceTime } from './dosing-rules';

export interface MissedDose {
  pumpId: number;
  nome: string;
  quando: Date;
  dosagem: number;
}

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;
const TOLERANCE_MS = 3 * 60 * 1000;

/** Horários programados (pela agenda atual) entre `from` e `to`. */
export function expectedDoses(bombs: BombConfig[], from: Date, to: Date): MissedDose[] {
  const result: MissedDose[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor <= to) {
    const weekday = cursor.getDay();
    for (const bomb of bombs) {
      for (const schedule of bomb.schedules) {
        if (!isScheduleActive(schedule) || !schedule.diasSemana[weekday]) continue;
        const quando = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), schedule.hour, schedule.minute);
        if (quando >= from && quando <= to) {
          result.push({ pumpId: bomb.id, nome: bomb.name || `Bomba ${bomb.id}`, quando, dosagem: schedule.dosagem });
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

/**
 * Doses programadas desde a última conferência que não aparecem no log do ESP32.
 * Olha no máximo 7 dias para trás e ignora os últimos 5 minutos (dose pode estar na fila).
 */
export function findMissedDoses(bombs: BombConfig[], logs: LogEntry[], since: Date | null, now: Date): MissedDose[] {
  const from = new Date(Math.max(since?.getTime() ?? 0, now.getTime() - MAX_WINDOW_MS));
  const to = new Date(now.getTime() - GRACE_MS);
  if (to <= from) return [];
  return missedBetween(bombs, logs, from, to);
}

/** Doses programadas entre `from` e `to` (pela agenda atual) sem registro "Programado" no log. */
export function missedBetween(bombs: BombConfig[], logs: LogEntry[], from: Date, to: Date): MissedDose[] {
  const programmed = logs
    .filter((log) => log.origem === 'Programado')
    .map((log) => ({ pumpId: Number(log.bombaId), quando: parseDeviceTime(log.timestamp) }))
    .filter((log): log is { pumpId: number; quando: Date } => log.quando !== null);

  return expectedDoses(bombs, from, to).filter(
    (dose) =>
      !programmed.some(
        (log) => log.pumpId === dose.pumpId && Math.abs(log.quando.getTime() - dose.quando.getTime()) <= TOLERANCE_MS,
      ),
  );
}
