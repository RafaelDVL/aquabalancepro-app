export type PumpIdentity = 'KH' | 'Ca' | 'Mg' | 'K' | 'Carbono' | 'Outro' | 'Nenhuma';
export type MeasuredParam = 'KH' | 'Ca' | 'Mg';

export interface IdentityInfo {
  label: string;
  unit: string;
  measured: boolean;
  limiteDiario: number;
  precisaoTeste: number;
}

// Limites de referência; o usuário pode sobrescrever por bomba em Produtos.
export const IDENTITIES: Record<PumpIdentity, IdentityInfo> = {
  KH: { label: 'KH (Alcalinidade)', unit: 'dKH', measured: true, limiteDiario: 0.5, precisaoTeste: 0.2 },
  Ca: { label: 'Cálcio', unit: 'ppm', measured: true, limiteDiario: 15, precisaoTeste: 10 },
  Mg: { label: 'Magnésio', unit: 'ppm', measured: true, limiteDiario: 50, precisaoTeste: 30 },
  K: { label: 'Potássio', unit: 'ppm', measured: false, limiteDiario: 10, precisaoTeste: 10 },
  Carbono: { label: 'Carbono', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Outro: { label: 'Outro', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Nenhuma: { label: 'Não definido', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
};

export const IDENTITY_ORDER: PumpIdentity[] = ['KH', 'Ca', 'Mg', 'K', 'Carbono', 'Outro', 'Nenhuma'];
export const MEASURED_PARAMS: MeasuredParam[] = ['KH', 'Ca', 'Mg'];
export const SESSION_DAY_OPTIONS = [3, 5, 7, 10, 14];
export const MAX_SESSIONS = 52;

/** "doseMl ml em porLitros L elevam o parâmetro em eleva (unidade da identidade)". */
export interface ProductPotency {
  doseMl: number;
  porLitros: number;
  eleva: number;
}

export interface PumpLink {
  pumpId: number;
  fator: number;
}

export interface PumpProfile {
  pumpId: number;
  identidade: PumpIdentity;
  produto: string;
  potencia: ProductPotency | null;
  vinculo: PumpLink | null;
  limiteDiario: number | null;
  precisaoTeste: number | null;
}

export interface RulesConfig {
  intervaloMinimo: number;
  limitePorDoseKH: number;
  variacaoMaxCiclo: number;
  diasEstoqueMin: number;
  paresIncompativeis: [PumpIdentity, PumpIdentity][];
}

export interface Photoperiod {
  liga: string;
  desliga: string;
}

export interface TankProfile {
  volumeLitros: number;
  alvos: Record<MeasuredParam, number>;
  fotoperiodo: Photoperiod | null;
  regras: RulesConfig;
  notificarDoses: boolean;
}

export type Measurements = Partial<Record<MeasuredParam, number>>;

export interface AppliedChange {
  antes: number;
  depois: number;
}

export interface TestSession {
  id: string;
  inicio: string;
  diasPlanejados: number;
  medidasInicio: Measurements;
  dosesSnapshot: Record<string, number>;
  fim?: string;
  medidasFim?: Measurements;
  aplicado?: Record<string, AppliedChange>;
}

export interface DosingData {
  versao: 1;
  tank: TankProfile;
  pumps: PumpProfile[];
  sessoes: TestSession[];
}

export function defaultTankProfile(): TankProfile {
  return {
    volumeLitros: 0,
    alvos: { KH: 8, Ca: 430, Mg: 1350 },
    fotoperiodo: null,
    regras: {
      intervaloMinimo: 60,
      limitePorDoseKH: 0.3,
      variacaoMaxCiclo: 0.3,
      diasEstoqueMin: 7,
      paresIncompativeis: [['KH', 'Ca']],
    },
    notificarDoses: true,
  };
}

export function defaultPumpProfile(pumpId: number): PumpProfile {
  return {
    pumpId,
    identidade: 'Nenhuma',
    produto: '',
    potencia: null,
    vinculo: null,
    limiteDiario: null,
    precisaoTeste: null,
  };
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMeasurements(raw: unknown): Measurements {
  const result: Measurements = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const param of MEASURED_PARAMS) {
    const value = toOptionalNumber((raw as Record<string, unknown>)[param]);
    if (value !== null) result[param] = value;
  }
  return result;
}

function normalizePotency(raw: unknown): ProductPotency | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const potency = {
    doseMl: toNumber(value['doseMl'], 0),
    porLitros: toNumber(value['porLitros'], 0),
    eleva: toNumber(value['eleva'], 0),
  };
  return potency.doseMl > 0 && potency.porLitros > 0 && potency.eleva > 0 ? potency : null;
}

/** Converte o JSON salvo no ESP32 (ou `{}`) num documento completo, com defaults para o que faltar. */
export function normalizeDosingData(raw: unknown, pumpIds: number[]): DosingData {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const defaults = defaultTankProfile();
  const rawTank = (source['tank'] ?? {}) as Record<string, any>;
  const rawRules = (rawTank['regras'] ?? {}) as Record<string, any>;

  const tank: TankProfile = {
    volumeLitros: toNumber(rawTank['volumeLitros'], defaults.volumeLitros),
    alvos: {
      KH: toNumber(rawTank['alvos']?.KH, defaults.alvos.KH),
      Ca: toNumber(rawTank['alvos']?.Ca, defaults.alvos.Ca),
      Mg: toNumber(rawTank['alvos']?.Mg, defaults.alvos.Mg),
    },
    fotoperiodo:
      rawTank['fotoperiodo']?.liga && rawTank['fotoperiodo']?.desliga
        ? { liga: String(rawTank['fotoperiodo'].liga), desliga: String(rawTank['fotoperiodo'].desliga) }
        : null,
    regras: {
      intervaloMinimo: toNumber(rawRules['intervaloMinimo'], defaults.regras.intervaloMinimo),
      limitePorDoseKH: toNumber(rawRules['limitePorDoseKH'], defaults.regras.limitePorDoseKH),
      variacaoMaxCiclo: toNumber(rawRules['variacaoMaxCiclo'], defaults.regras.variacaoMaxCiclo),
      diasEstoqueMin: toNumber(rawRules['diasEstoqueMin'], defaults.regras.diasEstoqueMin),
      paresIncompativeis: Array.isArray(rawRules['paresIncompativeis'])
        ? (rawRules['paresIncompativeis'] as [PumpIdentity, PumpIdentity][]).filter(
            (pair) => Array.isArray(pair) && pair.length === 2,
          )
        : defaults.regras.paresIncompativeis,
    },
    notificarDoses: rawTank['notificarDoses'] !== undefined ? Boolean(rawTank['notificarDoses']) : defaults.notificarDoses,
  };

  const rawPumps = Array.isArray(source['pumps']) ? (source['pumps'] as Record<string, any>[]) : [];
  const pumps = pumpIds.map((pumpId) => {
    const raw = rawPumps.find((pump) => Number(pump?.['pumpId']) === pumpId);
    if (!raw) return defaultPumpProfile(pumpId);
    const identidade = IDENTITY_ORDER.includes(raw['identidade']) ? (raw['identidade'] as PumpIdentity) : 'Nenhuma';
    const linkPump = toOptionalNumber(raw['vinculo']?.pumpId);
    const linkFactor = toOptionalNumber(raw['vinculo']?.fator);
    return {
      pumpId,
      identidade,
      produto: typeof raw['produto'] === 'string' ? raw['produto'] : '',
      potencia: normalizePotency(raw['potencia']),
      vinculo: linkPump && linkFactor && linkFactor > 0 && linkPump !== pumpId ? { pumpId: linkPump, fator: linkFactor } : null,
      limiteDiario: toOptionalNumber(raw['limiteDiario']),
      precisaoTeste: toOptionalNumber(raw['precisaoTeste']),
    };
  });

  const rawSessions = Array.isArray(source['sessoes']) ? (source['sessoes'] as Record<string, any>[]) : [];
  const sessoes: TestSession[] = rawSessions
    .filter((session) => session && typeof session['inicio'] === 'string')
    .map((session) => ({
      id: String(session['id'] ?? session['inicio']),
      inicio: session['inicio'],
      diasPlanejados: toNumber(session['diasPlanejados'], 7),
      medidasInicio: normalizeMeasurements(session['medidasInicio']),
      dosesSnapshot: { ...(session['dosesSnapshot'] ?? {}) },
      ...(typeof session['fim'] === 'string' ? { fim: session['fim'] } : {}),
      ...(session['medidasFim'] ? { medidasFim: normalizeMeasurements(session['medidasFim']) } : {}),
      ...(session['aplicado'] ? { aplicado: { ...session['aplicado'] } } : {}),
    }))
    .slice(-MAX_SESSIONS);

  return { versao: 1, tank, pumps, sessoes };
}

export function openSession(data: DosingData): TestSession | undefined {
  const last = data.sessoes[data.sessoes.length - 1];
  return last && !last.fim ? last : undefined;
}

export function limiteDiarioOf(profile: PumpProfile): number {
  return profile.limiteDiario ?? IDENTITIES[profile.identidade].limiteDiario;
}

export function precisaoTesteOf(profile: PumpProfile): number {
  return profile.precisaoTeste ?? IDENTITIES[profile.identidade].precisaoTeste;
}

export function pumpTitle(profile: PumpProfile | undefined, name: string): string {
  if (!profile || profile.identidade === 'Nenhuma') return name;
  return `${IDENTITIES[profile.identidade].label} (${name})`;
}
