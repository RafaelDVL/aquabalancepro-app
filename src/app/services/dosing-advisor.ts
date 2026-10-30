import { BombConfig, ScheduleConfig } from './doser.service';
import {
  DosingData,
  IDENTITIES,
  Measurements,
  MeasuredParam,
  PumpIdentity,
  PumpProfile,
  ProductPotency,
  TestSession,
  limiteDiarioOf,
  precisaoTesteOf,
} from './dosing.models';

export const DOSE_STEP = 0.5;
export const DOSE_MIN = 0.5;
export const DOSE_MAX = 15;
/** Ca consumido junto com 1 dKH quando o consumo vem de calcificação (CaCO3). */
export const CA_PER_DKH = 7.15;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Número formatado em pt-BR para as mensagens (vírgula decimal). */
export function fmt(value: number, decimals = 2): string {
  return round(value, decimals).toLocaleString('pt-BR');
}

export function activeDays(schedule: ScheduleConfig): number {
  return schedule.diasSemana.filter(Boolean).length;
}

export function isScheduleActive(schedule: ScheduleConfig): boolean {
  return schedule.status && activeDays(schedule) > 0;
}

/** Média diária em ml, considerando os dias da semana de cada horário. */
export function dailyDose(bomb: BombConfig): number {
  return bomb.schedules
    .filter(isScheduleActive)
    .reduce((sum, schedule) => sum + Number(schedule.dosagem) * (activeDays(schedule) / 7), 0);
}

/** Quanto 1 ml do produto eleva o parâmetro no aquário inteiro. */
export function effectivePotency(potency: ProductPotency | null, volumeLitros: number): number | null {
  if (!potency || volumeLitros <= 0) return null;
  return (potency.eleva * (potency.porLitros / volumeLitros)) / potency.doseMl;
}

export function formatHour(schedule: ScheduleConfig): string {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

export function daysBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MS_PER_DAY;
}

export interface ScheduleChange {
  index: number;
  hora: string;
  antes: number;
  depois: number;
}

export interface Distribution {
  horarios: ScheduleChange[];
  total: number;
  avisos: string[];
}

/**
 * Reparte uma dose diária entre os horários ativos em passos de 0,5 ml, mantendo a proporção atual
 * e usando o maior resto para a soma ficar o mais perto possível do alvo. O arredondamento para cima
 * nunca passa de `maxTotal` (trava de variação por ciclo).
 */
export function distributeDailyDose(bomb: BombConfig, target: number, maxTotal = Infinity): Distribution {
  const active = bomb.schedules
    .map((schedule, index) => ({ schedule, index, weight: activeDays(schedule) / 7 }))
    .filter(({ schedule }) => isScheduleActive(schedule));

  if (!active.length) {
    return { horarios: [], total: 0, avisos: ['Nenhum horário ativo nesta bomba. Ative um horário em Configuração.'] };
  }

  const avisos: string[] = [];
  const safeTarget = Math.max(0, target);
  const current = active.reduce((sum, item) => sum + Number(item.schedule.dosagem) * item.weight, 0);
  const totalWeight = active.reduce((sum, item) => sum + item.weight, 0);

  const ideals = active.map((item) =>
    current > 0 ? Number(item.schedule.dosagem) * (safeTarget / current) : safeTarget / totalWeight,
  );
  const doses = ideals.map((ideal) =>
    Math.min(DOSE_MAX, Math.max(DOSE_MIN, Math.floor(round(ideal / DOSE_STEP, 6)) * DOSE_STEP)),
  );
  let total = doses.reduce((sum, dose, i) => sum + dose * active[i].weight, 0);

  const byRemainder = ideals
    .map((ideal, i) => ({ i, remainder: ideal - doses[i] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { i } of byRemainder) {
    const step = DOSE_STEP * active[i].weight;
    if (
      doses[i] + DOSE_STEP <= DOSE_MAX &&
      total + step <= maxTotal + 1e-9 &&
      Math.abs(safeTarget - (total + step)) < Math.abs(safeTarget - total)
    ) {
      doses[i] += DOSE_STEP;
      total += step;
    }
  }

  ideals.forEach((ideal, i) => {
    if (ideal > DOSE_MAX) {
      avisos.push(
        `O horário ${formatHour(active[i].schedule)} precisaria de ${fmt(ideal, 1)} ml (máximo ${fmt(DOSE_MAX)}). Ative mais um horário.`,
      );
    }
  });
  if (safeTarget > 0 && ideals.some((ideal) => ideal < DOSE_MIN)) {
    avisos.push(`Dose baixa para ${active.length} horários: cada um precisa de pelo menos ${fmt(DOSE_MIN)} ml. Considere desativar um horário.`);
  }

  return {
    horarios: active.map((item, i) => ({
      index: item.index,
      hora: formatHour(item.schedule),
      antes: Number(item.schedule.dosagem),
      depois: round(doses[i], 2),
    })),
    total: round(total, 2),
    avisos,
  };
}

export type AdjustmentStatus = 'ajustar' | 'manter' | 'sem-dados' | 'sem-horario';

export interface PumpAdjustment {
  pumpId: number;
  nome: string;
  identidade: PumpIdentity;
  unidade: string;
  status: AdjustmentStatus;
  origem: 'teste' | 'vinculo';
  vinculadaA?: number;
  doseAtual: number;
  doseCalculada: number;
  doseNova: number;
  derivaDia?: number;
  consumoDia?: number;
  desvioDia?: number;
  horarios: ScheduleChange[];
  mensagens: string[];
  selecionada: boolean;
}

export interface AdjustmentInput {
  bombs: BombConfig[];
  data: DosingData;
  session: TestSession;
  medidasFim: Measurements;
  fim: Date;
  diasProxCiclo?: number;
}

export interface AdjustmentResult {
  dias: number;
  ajustes: PumpAdjustment[];
  avisos: string[];
}

function baseAdjustment(bomb: BombConfig, profile: PumpProfile, origem: 'teste' | 'vinculo'): PumpAdjustment {
  const doseAtual = round(dailyDose(bomb), 2);
  return {
    pumpId: bomb.id,
    nome: bomb.name || `Bomba ${bomb.id}`,
    identidade: profile.identidade,
    unidade: IDENTITIES[profile.identidade].unit,
    status: 'sem-dados',
    origem,
    doseAtual,
    doseCalculada: doseAtual,
    doseNova: doseAtual,
    horarios: [],
    mensagens: [],
    selecionada: false,
  };
}

function applyDistribution(
  adjustment: PumpAdjustment,
  bomb: BombConfig,
  target: number,
  potency: number | null,
  maxTotal = Infinity,
): void {
  const distribution = distributeDailyDose(bomb, target, maxTotal);
  adjustment.mensagens.push(...distribution.avisos);
  if (!distribution.horarios.length) {
    adjustment.status = 'sem-horario';
    return;
  }

  adjustment.horarios = distribution.horarios;
  adjustment.doseNova = distribution.total;
  if (potency !== null) {
    adjustment.desvioDia = round((distribution.total - target) * potency, 3);
  }

  const unchanged = distribution.horarios.every((item) => item.antes === item.depois);
  if (unchanged) {
    adjustment.status = 'manter';
    if (Math.abs(target - adjustment.doseAtual) > 0.01) {
      adjustment.mensagens.push(
        `Ajuste menor que o passo mínimo de ${fmt(DOSE_STEP)} ml — manter dose (calculado ${fmt(target, 2)} ml/dia).`,
      );
    }
  } else {
    adjustment.status = 'ajustar';
    adjustment.selecionada = true;
  }
}

function adjustMeasured(
  bomb: BombConfig,
  profile: PumpProfile,
  input: AdjustmentInput,
  dias: number,
  diasProxCiclo: number,
): PumpAdjustment {
  const param = profile.identidade as MeasuredParam;
  const info = IDENTITIES[param];
  const adjustment = baseAdjustment(bomb, profile, 'teste');
  const start = input.session.medidasInicio[param];
  const end = input.medidasFim[param];

  if (start === undefined || end === undefined) {
    adjustment.mensagens.push(`${info.label} não foi medido no início e no fim do teste.`);
    return adjustment;
  }

  const potency = effectivePotency(profile.potencia, input.data.tank.volumeLitros);
  if (potency === null) {
    adjustment.mensagens.push('Cadastre a potência do produto e o volume do aquário em Produtos.');
    return adjustment;
  }

  const doseInicio = input.session.dosesSnapshot[String(bomb.id)] ?? adjustment.doseAtual;
  if (Math.abs(doseInicio - adjustment.doseAtual) > 0.01) {
    adjustment.mensagens.push(
      `A dose mudou durante o teste (${fmt(doseInicio, 2)} → ${fmt(adjustment.doseAtual)} ml/dia). O cálculo usa a dose do início.`,
    );
  }

  const deriva = (end - start) / dias;
  const consumo = doseInicio * potency - deriva;
  adjustment.derivaDia = round(deriva, 3);
  adjustment.consumoDia = round(consumo, 3);

  const precisao = precisaoTesteOf(profile);
  const alvo = input.data.tank.alvos[param];
  if (Math.abs(end - start) <= precisao && Math.abs(alvo - end) <= precisao) {
    adjustment.status = 'manter';
    adjustment.mensagens.push('Variação dentro da margem do teste e perto do alvo — manter dose.');
    return adjustment;
  }

  const limite = limiteDiarioOf(profile);
  const correcao = Math.max(-limite, Math.min(limite, (alvo - end) / diasProxCiclo));
  let target = Math.max(0, (consumo + correcao) / potency);

  const base = adjustment.doseAtual;
  const variacao = input.data.tank.regras.variacaoMaxCiclo;
  let maxTotal = Infinity;
  if (base > 0 && variacao > 0) {
    const min = base * (1 - variacao);
    const max = base * (1 + variacao);
    maxTotal = max;
    if (target < min || target > max) {
      adjustment.mensagens.push(
        `Limitado a ±${Math.round(variacao * 100)}% por ciclo (o cálculo pedia ${fmt(target, 2)} ml/dia).`,
      );
      target = Math.min(max, Math.max(min, target));
    }
  }

  adjustment.doseCalculada = round(target, 2);
  applyDistribution(adjustment, bomb, target, potency, maxTotal);
  return adjustment;
}

export function computeAdjustments(input: AdjustmentInput): AdjustmentResult {
  const dias = daysBetween(new Date(input.session.inicio), input.fim);
  const diasProxCiclo = Math.max(1, input.diasProxCiclo ?? input.session.diasPlanejados);
  const avisos: string[] = [];

  if (dias < 1) {
    return { dias, ajustes: [], avisos: ['O teste precisa de pelo menos 1 dia para calcular o consumo.'] };
  }
  if (dias < input.session.diasPlanejados) {
    avisos.push(
      `Teste encerrado com ${fmt(dias, 1)} de ${input.session.diasPlanejados} dias. Períodos curtos aumentam o efeito do erro do teste.`,
    );
  }

  const profileOf = (pumpId: number) => input.data.pumps.find((pump) => pump.pumpId === pumpId);
  const ajustes: PumpAdjustment[] = [];

  for (const bomb of input.bombs) {
    const profile = profileOf(bomb.id);
    if (!profile || !IDENTITIES[profile.identidade].measured) continue;
    ajustes.push(adjustMeasured(bomb, profile, input, dias, diasProxCiclo));
  }

  for (const bomb of input.bombs) {
    const profile = profileOf(bomb.id);
    if (!profile?.vinculo || IDENTITIES[profile.identidade].measured) continue;
    const source = ajustes.find((item) => item.pumpId === profile.vinculo!.pumpId);
    if (!source || (source.status !== 'ajustar' && source.status !== 'manter')) continue;

    const adjustment = baseAdjustment(bomb, profile, 'vinculo');
    adjustment.vinculadaA = source.pumpId;
    const target = profile.vinculo.fator * source.doseNova;
    adjustment.doseCalculada = round(target, 2);
    adjustment.mensagens.push(`Segue ${fmt(profile.vinculo.fator)}× a dose de ${source.nome} (${fmt(source.doseNova)} ml/dia).`);
    applyDistribution(adjustment, bomb, target, null);
    ajustes.push(adjustment);
  }

  const kh = ajustes.find((item) => item.identidade === 'KH' && item.consumoDia !== undefined);
  const ca = ajustes.find((item) => item.identidade === 'Ca' && item.consumoDia !== undefined);
  if (kh?.consumoDia && ca?.consumoDia && kh.consumoDia > 0.05 && ca.consumoDia > 0) {
    const ratio = ca.consumoDia / kh.consumoDia;
    if (ratio < CA_PER_DKH * 0.6 || ratio > CA_PER_DKH * 1.4) {
      avisos.push(
        `Consumo de ${fmt(ratio, 1)} ppm de Ca por dKH (o esperado é ≈ ${fmt(CA_PER_DKH)}). Confira os testes ou outras fontes de Ca/KH (ex.: reator, ração, troca de água).`,
      );
    }
  }

  return { dias, ajustes, avisos };
}

/** Aplica os ajustes selecionados numa cópia da config das bombas. */
export function applyAdjustments(bombs: BombConfig[], ajustes: PumpAdjustment[]): BombConfig[] {
  return bombs.map((bomb) => {
    const adjustment = ajustes.find((item) => item.pumpId === bomb.id && item.selecionada && item.status === 'ajustar');
    if (!adjustment) return bomb;
    return {
      ...bomb,
      schedules: bomb.schedules.map((schedule, index) => {
        const change = adjustment.horarios.find((item) => item.index === index);
        return change ? { ...schedule, dosagem: change.depois } : schedule;
      }),
    };
  });
}
