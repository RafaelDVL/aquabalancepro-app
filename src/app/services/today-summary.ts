import { BombConfig, LogEntry } from './doser.service';
import { dailyDose, isScheduleActive } from './dosing-advisor';

export type TodayDoseState = 'feita' | 'perdida' | 'pendente';

export interface TodayDose {
  hora: string;
  minutos: number;
  dosagem: number;
  estado: TodayDoseState;
}

export interface TodayPump {
  pumpId: number;
  nome: string;
  doses: TodayDose[];
  estoque: number;
  diasEstoque: number | null;
}

export interface NextDose {
  pumpId: number;
  nome: string;
  hora: string;
  dosagem: number;
  emMinutos: number;
  amanha: boolean;
}

export interface TodaySummary {
  pumps: TodayPump[];
  feitas: number;
  total: number;
  proxima: NextDose | null;
}

// Mesma tolerância do gráfico de Analytics para casar dose programada com o log
const MATCH_TOLERANCE_MIN = 30;
const GRACE_MIN = 5;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Doses de hoje por bomba (feitas pelo log do ESP32, perdidas ou pendentes) e a próxima dose. */
export function buildTodaySummary(bombs: BombConfig[], logs: LogEntry[], now: Date): TodaySummary {
  const todayPrefix = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const weekday = now.getDay();

  const todayLogs = logs
    .filter((log) => log.origem === 'Programado' && log.timestamp.startsWith(todayPrefix))
    .map((log) => {
      const [hour, minute] = (log.timestamp.split(' ')[1] ?? '00:00').split(':').map(Number);
      return { pumpId: Number(log.bombaId), minutos: (hour || 0) * 60 + (minute || 0), usado: false };
    });

  let proxima: NextDose | null = null;
  const pumps: TodayPump[] = [];

  for (const bomb of bombs) {
    const nome = bomb.name || `Bomba ${bomb.id}`;
    const doses = bomb.schedules
      .filter((schedule) => isScheduleActive(schedule) && schedule.diasSemana[weekday])
      .map((schedule) => ({ schedule, minutos: schedule.hour * 60 + schedule.minute }))
      .sort((a, b) => a.minutos - b.minutos)
      .map(({ schedule, minutos }): TodayDose => {
        const match = todayLogs.find(
          (log) => !log.usado && log.pumpId === bomb.id && Math.abs(log.minutos - minutos) <= MATCH_TOLERANCE_MIN,
        );
        if (match) match.usado = true;
        const estado: TodayDoseState = match ? 'feita' : minutos + GRACE_MIN < nowMinutes ? 'perdida' : 'pendente';
        const hora = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
        if (estado === 'pendente' && (!proxima || minutos - nowMinutes < proxima.emMinutos)) {
          proxima = {
            pumpId: bomb.id,
            nome,
            hora,
            dosagem: schedule.dosagem,
            emMinutos: Math.max(0, minutos - nowMinutes),
            amanha: false,
          };
        }
        return { hora, minutos, dosagem: schedule.dosagem, estado };
      });

    if (!doses.length) continue;
    const perDay = dailyDose(bomb);
    pumps.push({
      pumpId: bomb.id,
      nome,
      doses,
      estoque: bomb.quantidadeEstoque,
      diasEstoque: perDay > 0 && bomb.quantidadeEstoque > 0 ? Math.floor(bomb.quantidadeEstoque / perDay) : null,
    });
  }

  const all = pumps.reduce<TodayDose[]>((acc, pump) => acc.concat(pump.doses), []);
  return {
    pumps,
    feitas: all.filter((dose) => dose.estado === 'feita').length,
    total: all.length,
    proxima: proxima ?? firstDoseTomorrow(bombs, now),
  };
}

function firstDoseTomorrow(bombs: BombConfig[], now: Date): NextDose | null {
  const weekday = (now.getDay() + 1) % 7;
  const untilMidnight = 24 * 60 - (now.getHours() * 60 + now.getMinutes());
  let best: NextDose | null = null;
  for (const bomb of bombs) {
    for (const schedule of bomb.schedules) {
      if (!isScheduleActive(schedule) || !schedule.diasSemana[weekday]) continue;
      const minutos = schedule.hour * 60 + schedule.minute;
      if (!best || untilMidnight + minutos < best.emMinutos) {
        best = {
          pumpId: bomb.id,
          nome: bomb.name || `Bomba ${bomb.id}`,
          hora: `${pad(schedule.hour)}:${pad(schedule.minute)}`,
          dosagem: schedule.dosagem,
          emMinutos: untilMidnight + minutos,
          amanha: true,
        };
      }
    }
  }
  return best;
}

/** "em 2h10", "em 15 min", "agora". */
export function formatCountdown(minutes: number): string {
  if (minutes <= 0) return 'agora';
  if (minutes < 60) return `em ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `em ${hours}h${pad(rest)}` : `em ${hours}h`;
}
