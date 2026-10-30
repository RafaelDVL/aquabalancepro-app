import { BombConfig } from './doser.service';
import { evaluateRules, parseDeviceTime } from './dosing-rules';
import { DosingData, PumpProfile, defaultPumpProfile, defaultTankProfile } from './dosing.models';

const EVERY_DAY = [true, true, true, true, true, true, true];

function makeBomb(id: number, times: [number, number, number?][], days: boolean[] = EVERY_DAY, stock = 1000): BombConfig {
  return {
    id,
    name: `Bomba ${id}`,
    calibrCoef: 1,
    quantidadeEstoque: stock,
    schedules: [0, 1, 2].map((index) => {
      const time = times[index];
      return {
        id: index + 1,
        hour: time?.[0] ?? 0,
        minute: time?.[1] ?? 0,
        dosagem: time?.[2] ?? 2,
        status: Boolean(time),
        diasSemana: [...days],
      };
    }),
  };
}

function makeData(pumps: Partial<PumpProfile>[], tank: Partial<DosingData['tank']> = {}): DosingData {
  return {
    versao: 1,
    tank: { ...defaultTankProfile(), volumeLitros: 400, ...tank },
    pumps: pumps.map((pump) => ({ ...defaultPumpProfile(pump.pumpId!), ...pump })),
    sessoes: [],
  };
}

const NOW = new Date(2026, 9, 30, 12, 0);
const ids = (bombs: BombConfig[], data: DosingData) => evaluateRules({ bombs, data, now: NOW }).map((s) => s.id);

describe('dosing-rules', () => {
  const khCa = [
    { pumpId: 1, identidade: 'KH' as const },
    { pumpId: 2, identidade: 'Ca' as const },
  ];

  it('avisa KH e Ca a 30 min e sugere um horário livre', () => {
    const bombs = [makeBomb(1, [[8, 0]]), makeBomb(2, [[8, 30]])];
    const suggestion = evaluateRules({ bombs, data: makeData(khCa), now: NOW }).find((s) => s.id.startsWith('espaco'));
    expect(suggestion).toBeDefined();
    expect(suggestion!.correcao).toEqual({ tipo: 'mover-horario', pumpId: 1, scheduleIndex: 0, hour: 9, minute: 30 });
  });

  it('não avisa KH e Ca a 2 h de distância', () => {
    const bombs = [makeBomb(1, [[8, 0]]), makeBomb(2, [[10, 0]])];
    expect(ids(bombs, makeData(khCa)).some((id) => id.startsWith('espaco'))).toBeFalse();
  });

  it('não avisa quando os horários estão em dias diferentes', () => {
    const weekdays = [false, true, true, true, true, true, false];
    const weekend = [true, false, false, false, false, false, true];
    const bombs = [makeBomb(1, [[8, 0]], weekdays), makeBomb(2, [[8, 15]], weekend)];
    expect(ids(bombs, makeData(khCa)).some((id) => id.startsWith('espaco'))).toBeFalse();
  });

  it('avisa dose de KH concentrada', () => {
    // 1 ml em 100 L eleva 0,25 dKH → em 400 L cada ml sobe 0,0625; 6 ml ≈ 0,375 dKH
    const bombs = [makeBomb(1, [[2, 0, 6]])];
    const data = makeData([{ pumpId: 1, identidade: 'KH', potencia: { doseMl: 1, porLitros: 100, eleva: 0.25 } }]);
    expect(ids(bombs, data)).toContain('dose-concentrada-1-0');
  });

  it('avisa estoque baixo', () => {
    const bombs = [makeBomb(1, [[8, 0, 5]], EVERY_DAY, 20)];
    expect(ids(bombs, makeData([{ pumpId: 1, identidade: 'Mg' }]))).toContain('estoque-1');
  });

  it('sugere KH à noite quando há fotoperíodo', () => {
    const bombs = [makeBomb(1, [[14, 0]])];
    const data = makeData([{ pumpId: 1, identidade: 'KH' }], { fotoperiodo: { liga: '10:00', desliga: '20:00' } });
    expect(ids(bombs, data)).toContain('kh-noite-1-0');
  });

  it('avisa relógio do ESP32 fora de sincronia', () => {
    const suggestions = evaluateRules({
      bombs: [],
      data: makeData([]),
      now: NOW,
      deviceTime: parseDeviceTime('30/10/2026 08:30'),
    });
    expect(suggestions[0].correcao).toEqual({ tipo: 'sincronizar-relogio' });
  });

  it('lê a hora no formato do /status', () => {
    expect(parseDeviceTime('30/10/2026 14:03')?.getHours()).toBe(14);
    expect(parseDeviceTime('')).toBeNull();
  });
});
