import { BombConfig } from './doser.service';
import {
  applyAdjustments,
  computeAdjustments,
  dailyDose,
  distributeDailyDose,
  effectivePotency,
} from './dosing-advisor';
import { DosingData, PumpProfile, TestSession, defaultPumpProfile, defaultTankProfile } from './dosing.models';

const EVERY_DAY = [true, true, true, true, true, true, true];

function makeBomb(id: number, doses: number[], days: boolean[] = EVERY_DAY): BombConfig {
  return {
    id,
    name: `Bomba ${id}`,
    calibrCoef: 1,
    quantidadeEstoque: 1000,
    schedules: [0, 1, 2].map((index) => ({
      id: index + 1,
      hour: 8 + index * 6,
      minute: 0,
      dosagem: doses[index] ?? 0.5,
      status: doses[index] !== undefined,
      diasSemana: [...days],
    })),
  };
}

// 1 ml em 100 L eleva 0,25 → em 400 L, 1 ml eleva 0,0625
const POTENCY = { doseMl: 1, porLitros: 100, eleva: 0.25 };

function profile(pumpId: number, overrides: Partial<PumpProfile>): PumpProfile {
  return { ...defaultPumpProfile(pumpId), ...overrides };
}

function makeData(pumps: PumpProfile[]): DosingData {
  return { versao: 1, tank: { ...defaultTankProfile(), volumeLitros: 400 }, pumps, sessoes: [] };
}

function makeSession(medidasInicio: TestSession['medidasInicio'], dosesSnapshot: Record<string, number>): TestSession {
  return { id: 's1', inicio: '2026-10-01T08:00:00.000Z', diasPlanejados: 7, medidasInicio, dosesSnapshot };
}

const END = new Date('2026-10-08T08:00:00.000Z');

describe('dosing-advisor', () => {
  it('calcula a média diária respeitando os dias da semana', () => {
    const monWedFri = [false, true, false, true, false, true, false];
    expect(dailyDose(makeBomb(1, [7], monWedFri))).toBeCloseTo(3, 5);
  });

  it('calcula a potência efetiva pelo volume do aquário', () => {
    expect(effectivePotency(POTENCY, 400)).toBeCloseTo(0.0625, 6);
    expect(effectivePotency(POTENCY, 0)).toBeNull();
  });

  it('reparte pelo maior resto em passos de 0,5 ml', () => {
    const result = distributeDailyDose(makeBomb(1, [1, 1, 1]), 2.5);
    expect(result.horarios.map((item) => item.depois)).toEqual([1, 1, 0.5]);
    expect(result.total).toBe(2.5);
  });

  it('não arredonda para cima além da trava de variação', () => {
    const threeDays = [false, true, false, true, false, true, false];
    // 1 ml em 3 dias = 0,43 ml/dia; alvo 0,56 com teto 0,56 → 1,5 ml (0,64) furaria a trava
    const result = distributeDailyDose(makeBomb(1, [1], threeDays), 0.56, 0.56);
    expect(result.horarios[0].depois).toBe(1);
  });

  it('avisa quando um horário passaria de 15 ml', () => {
    const result = distributeDailyDose(makeBomb(1, [10]), 20);
    expect(result.horarios[0].depois).toBe(15);
    expect(result.avisos.join(' ')).toContain('Ative mais um horário');
  });

  it('aumenta a dose de KH quando o KH caiu', () => {
    const bombs = [makeBomb(1, [4, 4, 4])];
    const data = makeData([profile(1, { identidade: 'KH', potencia: POTENCY })]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ KH: 8 }, { '1': 12 }),
      medidasFim: { KH: 7.3 },
      fim: END,
    });

    const kh = result.ajustes[0];
    expect(kh.status).toBe('ajustar');
    expect(kh.consumoDia).toBeCloseTo(0.85, 3);
    expect(kh.doseCalculada).toBeCloseTo(15.2, 2);
    expect(kh.horarios.map((item) => item.depois)).toEqual([5, 5, 5]);
    expect(kh.desvioDia).toBeCloseTo(-0.0125, 2);
  });

  it('mantém a dose quando a variação está dentro da margem do teste e perto do alvo', () => {
    const bombs = [makeBomb(1, [4, 4, 4])];
    const data = makeData([profile(1, { identidade: 'KH', potencia: POTENCY })]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ KH: 8.0 }, { '1': 12 }),
      medidasFim: { KH: 7.9 },
      fim: END,
    });
    expect(result.ajustes[0].status).toBe('manter');
  });

  it('limita a mudança a ±30% por ciclo', () => {
    const bombs = [makeBomb(1, [2, 2])];
    const data = makeData([profile(1, { identidade: 'KH', potencia: POTENCY })]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ KH: 8 }, { '1': 4 }),
      medidasFim: { KH: 6 },
      fim: END,
    });
    const kh = result.ajustes[0];
    expect(kh.doseCalculada).toBeCloseTo(5.2, 2);
    expect(kh.mensagens.join(' ')).toContain('±30%');
  });

  it('mantém quando o ajuste é menor que o passo de 0,5 ml', () => {
    const bombs = [makeBomb(1, [4, 4, 4])];
    const data = makeData([profile(1, { identidade: 'KH', potencia: POTENCY })]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ KH: 7.5 }, { '1': 12 }),
      medidasFim: { KH: 7.8 },
      fim: END,
    });
    const kh = result.ajustes[0];
    expect(kh.doseCalculada).toBeCloseTo(11.77, 2);
    expect(kh.status).toBe('manter');
    expect(kh.mensagens.join(' ')).toContain('passo mínimo');
  });

  it('marca sem horário quando a bomba não tem horário ativo', () => {
    const bombs = [makeBomb(1, [])];
    const data = makeData([profile(1, { identidade: 'Ca', potencia: { doseMl: 10, porLitros: 100, eleva: 10 } })]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ Ca: 430 }, { '1': 0 }),
      medidasFim: { Ca: 380 },
      fim: END,
    });
    expect(result.ajustes[0].status).toBe('sem-horario');
  });

  it('marca sem dados quando o parâmetro não foi medido', () => {
    const bombs = [makeBomb(1, [3])];
    const data = makeData([profile(1, { identidade: 'Mg', potencia: POTENCY })]);
    const result = computeAdjustments({ bombs, data, session: makeSession({}, {}), medidasFim: {}, fim: END });
    expect(result.ajustes[0].status).toBe('sem-dados');
  });

  it('sugere a dose da bomba vinculada pelo fator', () => {
    const bombs = [makeBomb(1, [4, 4, 4]), makeBomb(2, [1, 1])];
    const data = makeData([
      profile(1, { identidade: 'KH', potencia: POTENCY }),
      profile(2, { identidade: 'K', vinculo: { pumpId: 1, fator: 0.2 } }),
    ]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ KH: 8 }, { '1': 12 }),
      medidasFim: { KH: 7.3 },
      fim: END,
    });
    const k = result.ajustes.find((item) => item.pumpId === 2)!;
    expect(k.origem).toBe('vinculo');
    expect(k.doseCalculada).toBeCloseTo(3, 2);
    expect(k.horarios.map((item) => item.depois)).toEqual([1.5, 1.5]);
  });

  it('exige pelo menos 1 dia de teste', () => {
    const result = computeAdjustments({
      bombs: [makeBomb(1, [4])],
      data: makeData([profile(1, { identidade: 'KH', potencia: POTENCY })]),
      session: makeSession({ KH: 8 }, { '1': 4 }),
      medidasFim: { KH: 7.9 },
      fim: new Date('2026-10-01T12:00:00.000Z'),
    });
    expect(result.ajustes.length).toBe(0);
    expect(result.avisos.length).toBe(1);
  });

  it('aplica só os ajustes selecionados', () => {
    const bombs = [makeBomb(1, [4, 4, 4])];
    const data = makeData([profile(1, { identidade: 'KH', potencia: POTENCY })]);
    const result = computeAdjustments({
      bombs,
      data,
      session: makeSession({ KH: 8 }, { '1': 12 }),
      medidasFim: { KH: 7.3 },
      fim: END,
    });
    expect(applyAdjustments(bombs, result.ajustes)[0].schedules[0].dosagem).toBe(5);
    result.ajustes[0].selecionada = false;
    expect(applyAdjustments(bombs, result.ajustes)[0].schedules[0].dosagem).toBe(4);
  });
});
