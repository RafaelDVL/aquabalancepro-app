import { BombConfig, ScheduleConfig } from './doser.service';
import { dailyDose, daysBetween, effectivePotency, fmt, formatHour, isScheduleActive } from './dosing-advisor';
import { DosingData, IDENTITIES, PumpIdentity, PumpProfile, limiteDiarioOf, openSession, pumpTitle } from './dosing.models';

export type RuleFix =
  | { tipo: 'mover-horario'; pumpId: number; scheduleIndex: number; hour: number; minute: number }
  | { tipo: 'sincronizar-relogio' };

export interface Suggestion {
  id: string;
  nivel: 'info' | 'aviso';
  mensagem: string;
  correcao?: RuleFix;
  descricaoCorrecao?: string;
  /** Horários envolvidos, para a tela de Configuração marcar cada linha. */
  horarios?: ScheduleRef[];
}

export interface ScheduleRef {
  pumpId: number;
  scheduleIndex: number;
}

export interface RulesContext {
  bombs: BombConfig[];
  data: DosingData;
  now: Date;
  /** Hora informada pelo ESP32 em /status, se disponível. */
  deviceTime?: Date | null;
}

const MINUTES_PER_DAY = 24 * 60;
const MAX_CLOCK_DRIFT_MIN = 2;
const MG_CA_RATIO = { min: 2.8, max: 3.6 };

function flatMap<T, U>(items: T[], fn: (item: T) => U[]): U[] {
  return items.reduce<U[]>((acc, item) => acc.concat(fn(item)), []);
}

function minutesOf(schedule: ScheduleConfig): number {
  return schedule.hour * 60 + schedule.minute;
}

function circularDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(diff, MINUTES_PER_DAY - diff);
}

function sharesDay(a: ScheduleConfig, b: ScheduleConfig): boolean {
  return a.diasSemana.some((active, day) => active && b.diasSemana[day]);
}

function hhmm(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Converte "dd/MM/yyyy HH:mm" (formato do /status) em Date local. */
export function parseDeviceTime(value: string | undefined): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value?.trim() ?? '');
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute, second || 0);
}

interface PumpEntry {
  bomb: BombConfig;
  profile: PumpProfile;
  title: string;
}

function entries(ctx: RulesContext): PumpEntry[] {
  return ctx.bombs.map((bomb) => {
    const profile = ctx.data.pumps.find((pump) => pump.pumpId === bomb.id) ?? {
      pumpId: bomb.id,
      identidade: 'Nenhuma' as PumpIdentity,
      produto: '',
      catalogoId: null,
      gramasPorLitro: null,
      potencia: null,
      vinculo: null,
      limiteDiario: null,
      precisaoTeste: null,
    };
    return { bomb, profile, title: pumpTitle(profile, bomb.name || `Bomba ${bomb.id}`) };
  });
}

function activeSchedules(bomb: BombConfig): { schedule: ScheduleConfig; index: number }[] {
  return bomb.schedules.map((schedule, index) => ({ schedule, index })).filter(({ schedule }) => isScheduleActive(schedule));
}

function spacingRule(ctx: RulesContext, pumps: PumpEntry[]): Suggestion[] {
  const result: Suggestion[] = [];
  const interval = ctx.data.tank.regras.intervaloMinimo;
  if (interval <= 0) return result;

  for (const [first, second] of ctx.data.tank.regras.paresIncompativeis) {
    const movers = pumps.filter((pump) => pump.profile.identidade === first);
    const others = pumps.filter((pump) => pump.profile.identidade === second && !movers.includes(pump));
    const blocking = flatMap(others, (pump) => activeSchedules(pump.bomb).map(({ schedule }) => schedule));

    for (const mover of movers) {
      const own = activeSchedules(mover.bomb);
      for (const { schedule, index } of own) {
        for (const other of others) {
          for (const { schedule: otherSchedule, index: otherIndex } of activeSchedules(other.bomb)) {
            if (!sharesDay(schedule, otherSchedule)) continue;
            const diff = circularDiff(minutesOf(schedule), minutesOf(otherSchedule));
            if (diff >= interval) continue;

            const candidates = [minutesOf(otherSchedule) + interval, minutesOf(otherSchedule) - interval];
            const free = candidates
              .map((minutes) => ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY)
              .find(
                (minutes) =>
                  blocking.every((block) => !sharesDay(schedule, block) || circularDiff(minutes, minutesOf(block)) >= interval) &&
                  own.every((item) => item.index === index || minutesOf(item.schedule) !== minutes),
              );

            result.push({
              id: `espaco-${mover.bomb.id}-${index}-${other.bomb.id}`,
              nivel: 'aviso',
              mensagem:
                `${mover.title} às ${formatHour(schedule)} e ${other.title} às ${formatHour(otherSchedule)} ficam a ${diff} min. ` +
                `Doses próximas de ${IDENTITIES[first].short} e ${IDENTITIES[second].short} podem precipitar; mantenha pelo menos ${interval} min.`,
              horarios: [
                { pumpId: mover.bomb.id, scheduleIndex: index },
                { pumpId: other.bomb.id, scheduleIndex: otherIndex },
              ],
              ...(free !== undefined
                ? {
                    correcao: {
                      tipo: 'mover-horario' as const,
                      pumpId: mover.bomb.id,
                      scheduleIndex: index,
                      hour: Math.floor(free / 60),
                      minute: free % 60,
                    },
                    descricaoCorrecao: `Mover ${mover.title} para ${hhmm(free)}`,
                  }
                : {}),
            });
          }
        }
      }
    }
  }
  return result;
}

function potencyRules(ctx: RulesContext, pumps: PumpEntry[]): Suggestion[] {
  const result: Suggestion[] = [];
  const volume = ctx.data.tank.volumeLitros;
  for (const pump of pumps) {
    const info = IDENTITIES[pump.profile.identidade];
    const potency = effectivePotency(pump.profile.potencia, volume);
    if (potency === null) continue;

    if (pump.profile.identidade === 'KH') {
      const limit = ctx.data.tank.regras.limitePorDoseKH;
      for (const { schedule, index } of activeSchedules(pump.bomb)) {
        const rise = schedule.dosagem * potency;
        if (limit > 0 && rise > limit) {
          result.push({
            id: `dose-concentrada-${pump.bomb.id}-${index}`,
            nivel: 'aviso',
            mensagem: `A dose de ${fmt(schedule.dosagem)} ml de ${pump.title} às ${formatHour(schedule)} sobe ~${fmt(rise, 2)} dKH de uma vez (limite ${fmt(limit)}). Divida em mais horários.`,
            horarios: [{ pumpId: pump.bomb.id, scheduleIndex: index }],
          });
        }
      }
    }

    const limiteDiario = limiteDiarioOf(pump.profile);
    const added = dailyDose(pump.bomb) * potency;
    if (info.measured && limiteDiario > 0 && added > limiteDiario) {
      result.push({
        id: `teto-diario-${pump.bomb.id}`,
        nivel: 'info',
        mensagem: `${pump.title} adiciona ~${fmt(added, 2)} ${info.unit}/dia, acima de ${fmt(limiteDiario)} ${info.unit}/dia. Se o consumo cair, o parâmetro pode subir rápido.`,
      });
    }
  }
  return result;
}

function nightKhRule(ctx: RulesContext, pumps: PumpEntry[]): Suggestion[] {
  const period = ctx.data.tank.fotoperiodo;
  if (!period) return [];
  const on = parseHHMM(period.liga);
  const off = parseHHMM(period.desliga);
  if (on === null || off === null || on === off) return [];

  const isLit = (minutes: number) => (on < off ? minutes >= on && minutes < off : minutes >= on || minutes < off);
  return pumps
    .filter((pump) => pump.profile.identidade === 'KH')
    .reduce<Suggestion[]>((acc, pump) => acc.concat(
      activeSchedules(pump.bomb)
        .filter(({ schedule }) => isLit(minutesOf(schedule)))
        .map(({ schedule, index }) => ({
          id: `kh-noite-${pump.bomb.id}-${index}`,
          nivel: 'info' as const,
          mensagem: `${pump.title} às ${formatHour(schedule)} cai com as luzes acesas. À noite o pH tende a cair, e dosar KH nesse período ajuda a segurá-lo.`,
        })),
    ), []);
}

function stockRule(ctx: RulesContext, pumps: PumpEntry[]): Suggestion[] {
  const minDays = ctx.data.tank.regras.diasEstoqueMin;
  return flatMap(pumps, (pump) => {
    const perDay = dailyDose(pump.bomb);
    if (perDay <= 0) return [];
    const days = pump.bomb.quantidadeEstoque / perDay;
    if (days >= minDays) return [];
    return [
      {
        id: `estoque-${pump.bomb.id}`,
        nivel: 'aviso' as const,
        mensagem:
          pump.bomb.quantidadeEstoque <= 0
            ? `Estoque de ${pump.title} zerado ou não cadastrado.`
            : `Restam ~${Math.floor(days)} dias de ${pump.title} (${fmt(pump.bomb.quantidadeEstoque, 0)} ml).`,
      },
    ];
  });
}

function ratioRule(ctx: RulesContext): Suggestion[] {
  const last = [...ctx.data.sessoes].reverse().find((session) => session.medidasFim ?? session.medidasInicio);
  const values = last?.medidasFim ?? last?.medidasInicio;
  if (!values?.Mg || !values.Ca) return [];
  const ratio = values.Mg / values.Ca;
  if (ratio >= MG_CA_RATIO.min && ratio <= MG_CA_RATIO.max) return [];
  return [
    {
      id: 'mg-ca',
      nivel: 'info',
      mensagem: `Mg/Ca = ${fmt(ratio, 2)} no último teste (${fmt(values.Mg)} / ${fmt(values.Ca)}). O usual em reef fica entre ${fmt(MG_CA_RATIO.min)} e ${fmt(MG_CA_RATIO.max)}.`,
    },
  ];
}

function sessionRule(ctx: RulesContext): Suggestion[] {
  const session = openSession(ctx.data);
  if (!session) return [];
  const elapsed = daysBetween(new Date(session.inicio), ctx.now);
  if (elapsed < session.diasPlanejados) return [];
  return [
    {
      id: 'teste-vencido',
      nivel: 'aviso',
      mensagem: `Hora de medir: o teste de ${session.diasPlanejados} dias começou em ${new Date(session.inicio).toLocaleDateString('pt-BR')}.`,
    },
  ];
}

function profileRule(ctx: RulesContext, pumps: PumpEntry[]): Suggestion[] {
  const result: Suggestion[] = [];
  for (const pump of pumps) {
    if (!activeSchedules(pump.bomb).length) continue;
    const info = IDENTITIES[pump.profile.identidade];
    if (pump.profile.identidade === 'Nenhuma') {
      result.push({ id: `perfil-${pump.bomb.id}`, nivel: 'info', mensagem: `Defina o tipo de produto de ${pump.title} na Configuração ou em Produtos.` });
    } else if (info.measured && (!pump.profile.potencia || ctx.data.tank.volumeLitros <= 0)) {
      result.push({
        id: `potencia-${pump.bomb.id}`,
        nivel: 'info',
        mensagem: `Cadastre a potência do produto de ${pump.title} e o volume do aquário para calcular os ajustes.`,
      });
    }
  }
  return result;
}

function clockRule(ctx: RulesContext): Suggestion[] {
  if (!ctx.deviceTime) return [];
  const driftMin = Math.abs(ctx.now.getTime() - ctx.deviceTime.getTime()) / 60000;
  if (driftMin <= MAX_CLOCK_DRIFT_MIN) return [];
  return [
    {
      id: 'relogio',
      nivel: 'aviso',
      mensagem: `O relógio do ESP32 está ${Math.round(driftMin)} min diferente do celular. As doses acontecem pela hora do ESP32.`,
      correcao: { tipo: 'sincronizar-relogio' },
      descricaoCorrecao: 'Sincronizar relógio',
    },
  ];
}

export function evaluateRules(ctx: RulesContext): Suggestion[] {
  const pumps = entries(ctx);
  const suggestions = [
    ...clockRule(ctx),
    ...sessionRule(ctx),
    ...spacingRule(ctx, pumps),
    ...potencyRules(ctx, pumps),
    ...stockRule(ctx, pumps),
    ...nightKhRule(ctx, pumps),
    ...ratioRule(ctx),
    ...profileRule(ctx, pumps),
  ];
  return suggestions.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'aviso' ? -1 : 1));
}
