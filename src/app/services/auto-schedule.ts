import { BombConfig, ScheduleConfig } from './doser.service';
import { formatHour, isScheduleActive } from './dosing-advisor';
import { DosingData, PumpIdentity, pumpTitle } from './dosing.models';

const MINUTES_PER_DAY = 24 * 60;
/** Horários sugeridos caem em múltiplos de 15 min. */
const STEP_MIN = 15;
/** Acima disso, afastar mais um par incompatível não traz ganho. */
const MAX_USEFUL_SEPARATION = 240;
/** Distância desejada entre doses de bombas quaisquer (evita fila no ESP32). */
const MIN_ANY_SEPARATION = 30;

export interface AutoScheduleTime {
  scheduleIndex: number;
  hour: number;
  minute: number;
}

export interface AutoScheduleChange {
  pumpId: number;
  title: string;
  antes: string[];
  depois: string[];
  horarios: AutoScheduleTime[];
}

interface Placed {
  minutes: number;
  identidade: PumpIdentity;
}

interface Score {
  feasible: boolean;
  separation: number;
  night: number;
  anyDistance: number;
  shift: number;
}

function circularDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(diff, MINUTES_PER_DAY - diff);
}

function minutesOf(schedule: ScheduleConfig): number {
  return schedule.hour * 60 + schedule.minute;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseHHMM(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function better(a: Score, b: Score): boolean {
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.separation !== b.separation) return a.separation > b.separation;
  if (a.night !== b.night) return a.night > b.night;
  if (a.anyDistance !== b.anyDistance) return a.anyDistance > b.anyDistance;
  return a.shift < b.shift;
}

/**
 * Sugere novos horários para as bombas ativas: espalha as doses de cada bomba igualmente no dia,
 * afasta os pares incompatíveis (KH × Ca…) o máximo possível, evita doses de bombas diferentes no
 * mesmo horário e, com fotoperíodo cadastrado, prefere o KH com as luzes apagadas. Entre opções
 * equivalentes fica a mais próxima da agenda atual. Doses, dias e quantidade de horários não mudam.
 * Devolve só as bombas cujos horários mudariam.
 */
export function autoSchedule(bombs: BombConfig[], data: DosingData): AutoScheduleChange[] {
  const { intervaloMinimo, paresIncompativeis } = data.tank.regras;
  const identityOf = (pumpId: number): PumpIdentity =>
    data.pumps.find((pump) => pump.pumpId === pumpId)?.identidade ?? 'Nenhuma';
  const incompatible = (a: PumpIdentity, b: PumpIdentity) =>
    a !== 'Nenhuma' && paresIncompativeis.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const inPair = (identity: PumpIdentity) => paresIncompativeis.some((pair) => pair.includes(identity));

  const on = parseHHMM(data.tank.fotoperiodo?.liga);
  const off = parseHHMM(data.tank.fotoperiodo?.desliga);
  const isDark = (minutes: number) =>
    on !== null && off !== null && on !== off && !(on < off ? minutes >= on && minutes < off : minutes >= on || minutes < off);

  const pumps = bombs
    .map((bomb) => ({
      bomb,
      identidade: identityOf(bomb.id),
      active: bomb.schedules
        .map((schedule, index) => ({ schedule, index }))
        .filter(({ schedule }) => isScheduleActive(schedule))
        .sort((a, b) => minutesOf(a.schedule) - minutesOf(b.schedule)),
    }))
    .filter((pump) => pump.active.length > 0)
    // Primeiro as bombas com restrição (pares incompatíveis), depois as com mais doses
    .sort(
      (a, b) =>
        Number(inPair(b.identidade)) - Number(inPair(a.identidade)) ||
        b.active.length - a.active.length ||
        a.bomb.id - b.bomb.id,
    );

  const placed: Placed[] = [];
  const changes: AutoScheduleChange[] = [];

  for (const pump of pumps) {
    const count = pump.active.length;
    const period = Math.floor(MINUTES_PER_DAY / count / STEP_MIN) * STEP_MIN;
    const current = pump.active.map(({ schedule }) => minutesOf(schedule));
    let best: { score: Score; times: number[] } | null = null;

    for (let offset = 0; offset < period; offset += STEP_MIN) {
      const base = Array.from({ length: count }, (_, k) => (offset + k * period) % MINUTES_PER_DAY);
      // Mantém a ordem atual dos horários escolhendo a rotação que menos desloca
      let times = base;
      let shift = Infinity;
      for (let rotation = 0; rotation < count; rotation++) {
        const rotated = base.map((_, i) => base[(i + rotation) % count]);
        const total = rotated.reduce((sum, minutes, i) => sum + circularDiff(minutes, current[i]), 0);
        if (total < shift) {
          shift = total;
          times = rotated;
        }
      }

      let incompatDistance = Infinity;
      let anyDistance = Infinity;
      for (const minutes of times) {
        for (const other of placed) {
          const diff = circularDiff(minutes, other.minutes);
          anyDistance = Math.min(anyDistance, diff);
          if (incompatible(pump.identidade, other.identidade)) incompatDistance = Math.min(incompatDistance, diff);
        }
      }

      const score: Score = {
        feasible: incompatDistance >= intervaloMinimo,
        separation: Math.min(incompatDistance, MAX_USEFUL_SEPARATION),
        night: pump.identidade === 'KH' ? times.filter(isDark).length : 0,
        anyDistance: Math.min(anyDistance, MIN_ANY_SEPARATION),
        shift,
      };
      if (!best || better(score, best.score)) best = { score, times };
    }

    const times = best!.times;
    times.forEach((minutes) => placed.push({ minutes, identidade: pump.identidade }));

    if (times.some((minutes, i) => minutes !== current[i])) {
      const name = pump.bomb.name || `Bomba ${pump.bomb.id}`;
      const profile = data.pumps.find((item) => item.pumpId === pump.bomb.id);
      changes.push({
        pumpId: pump.bomb.id,
        title: pumpTitle(profile, name),
        antes: pump.active.map(({ schedule }) => formatHour(schedule)),
        depois: times.map(hhmm),
        horarios: pump.active.map(({ index }, i) => ({
          scheduleIndex: index,
          hour: Math.floor(times[i] / 60),
          minute: times[i] % 60,
        })),
      });
    }
  }

  return changes.sort((a, b) => a.pumpId - b.pumpId);
}
