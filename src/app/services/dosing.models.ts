export type PumpIdentity =
  | 'KH'
  | 'Ca'
  | 'Mg'
  | 'K'
  | 'Iodo'
  | 'Ferro'
  | 'Estroncio'
  | 'Tracos'
  | 'Nitrato'
  | 'Fosfato'
  | 'Carbono'
  | 'Aminoacidos'
  | 'Bacterias'
  | 'Alimento'
  | 'Sal'
  | 'Kalkwasser'
  | 'Outro'
  | 'Nenhuma';
export type MeasuredParam = 'KH' | 'Ca' | 'Mg';

export type IdentityGroup = 'Macroelementos' | 'Microelementos' | 'Nutrientes' | 'Carbono e alimentação' | 'Outros';

export interface IdentityInfo {
  label: string;
  /** Rótulo curto para selos (ex.: "Cálcio", "Traços"). */
  short: string;
  group: IdentityGroup;
  unit: string;
  measured: boolean;
  limiteDiario: number;
  precisaoTeste: number;
}

// Limites de referência; o usuário pode sobrescrever por bomba em Produtos.
export const IDENTITIES: Record<PumpIdentity, IdentityInfo> = {
  KH: { label: 'KH (Alcalinidade)', short: 'KH', group: 'Macroelementos', unit: 'dKH', measured: true, limiteDiario: 0.5, precisaoTeste: 0.2 },
  Ca: { label: 'Cálcio', short: 'Cálcio', group: 'Macroelementos', unit: 'ppm', measured: true, limiteDiario: 15, precisaoTeste: 10 },
  Mg: { label: 'Magnésio', short: 'Magnésio', group: 'Macroelementos', unit: 'ppm', measured: true, limiteDiario: 50, precisaoTeste: 30 },
  Sal: { label: 'Reef salt / sal sem NaCl', short: 'Sal', group: 'Macroelementos', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Kalkwasser: { label: 'Kalkwasser', short: 'Kalk', group: 'Macroelementos', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  K: { label: 'Potássio', short: 'Potássio', group: 'Microelementos', unit: 'ppm', measured: false, limiteDiario: 10, precisaoTeste: 10 },
  Iodo: { label: 'Iodo', short: 'Iodo', group: 'Microelementos', unit: 'ppm', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Ferro: { label: 'Ferro', short: 'Ferro', group: 'Microelementos', unit: 'ppm', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Estroncio: { label: 'Estrôncio', short: 'Estrôncio', group: 'Microelementos', unit: 'ppm', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Tracos: { label: 'Elementos-traço (mix)', short: 'Traços', group: 'Microelementos', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Nitrato: { label: 'Nitrato (NO₃)', short: 'Nitrato', group: 'Nutrientes', unit: 'ppm', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Fosfato: { label: 'Fosfato (PO₄)', short: 'Fosfato', group: 'Nutrientes', unit: 'ppm', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Carbono: { label: 'Carbono (NoPox, vodka…)', short: 'Carbono', group: 'Carbono e alimentação', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Bacterias: { label: 'Bactérias / probióticos', short: 'Bactérias', group: 'Carbono e alimentação', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Aminoacidos: { label: 'Aminoácidos', short: 'Aminoácidos', group: 'Carbono e alimentação', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Alimento: { label: 'Alimento líquido / fito', short: 'Alimento', group: 'Carbono e alimentação', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Outro: { label: 'Outro', short: 'Outro', group: 'Outros', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
  Nenhuma: { label: 'Não definido', short: '', group: 'Outros', unit: '', measured: false, limiteDiario: 0, precisaoTeste: 0 },
};

export const IDENTITY_ORDER: PumpIdentity[] = [
  'KH',
  'Ca',
  'Mg',
  'Sal',
  'Kalkwasser',
  'K',
  'Iodo',
  'Ferro',
  'Estroncio',
  'Tracos',
  'Nitrato',
  'Fosfato',
  'Carbono',
  'Bacterias',
  'Aminoacidos',
  'Alimento',
  'Outro',
  'Nenhuma',
];

/** Tipos agrupados para os seletores (optgroup). */
export const IDENTITY_GROUPS: { group: IdentityGroup; items: { value: PumpIdentity; label: string }[] }[] = IDENTITY_ORDER.reduce<
  { group: IdentityGroup; items: { value: PumpIdentity; label: string }[] }[]
>((acc, value) => {
  const { group, label } = IDENTITIES[value];
  const entry = acc.find((item) => item.group === group) ?? acc[acc.push({ group, items: [] }) - 1];
  entry.items.push({ value, label });
  return acc;
}, []);

/** Pares que não devem ser dosados perto um do outro; o primeiro é o que a sugestão move. */
export const DEFAULT_INCOMPATIBLE_PAIRS: [PumpIdentity, PumpIdentity][] = [
  ['KH', 'Ca'],
  ['Kalkwasser', 'KH'],
  ['Fosfato', 'Ca'],
];

/** O produto tem efeito mensurável cadastrável (ml em L sobem X unidade). */
export function hasPotencyUnit(identidade: PumpIdentity): boolean {
  return IDENTITIES[identidade].unit !== '';
}
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
      paresIncompativeis: DEFAULT_INCOMPATIBLE_PAIRS.map(([a, b]) => [a, b] as [PumpIdentity, PumpIdentity]),
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

function mergePairs(base: [PumpIdentity, PumpIdentity][], extra: [PumpIdentity, PumpIdentity][]): [PumpIdentity, PumpIdentity][] {
  const result = [...base];
  for (const [a, b] of extra) {
    if (!result.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) result.push([a, b]);
  }
  return result;
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
      // Pares padrão sempre valem (não há tela para removê-los); os salvos somam aos padrões
      paresIncompativeis: mergePairs(
        defaults.regras.paresIncompativeis,
        Array.isArray(rawRules['paresIncompativeis'])
          ? (rawRules['paresIncompativeis'] as [PumpIdentity, PumpIdentity][]).filter(
              (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((id) => IDENTITY_ORDER.includes(id)),
            )
          : [],
      ),
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

/** O nome da bomba já diz o tipo (ex.: bomba "Calcio" com tipo Cálcio) — evita "Cálcio (Calcio)". */
export function nameMatchesIdentity(name: string, identidade: PumpIdentity): boolean {
  const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return plain(name) === plain(IDENTITIES[identidade].short);
}

export function pumpTitle(profile: PumpProfile | undefined, name: string): string {
  if (!profile || profile.identidade === 'Nenhuma' || nameMatchesIdentity(name, profile.identidade)) return name;
  return `${IDENTITIES[profile.identidade].short} (${name})`;
}
