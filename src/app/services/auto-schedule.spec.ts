import { BombConfig } from './doser.service';
import { autoSchedule } from './auto-schedule';
import { evaluateRules } from './dosing-rules';
import { DosingData, PumpProfile, defaultPumpProfile, defaultTankProfile } from './dosing.models';

const EVERY_DAY = [true, true, true, true, true, true, true];

function makeBomb(id: number, times: [number, number][]): BombConfig {
  return {
    id,
    name: `Bomba ${id}`,
    calibrCoef: 1,
    quantidadeEstoque: 1000,
    schedules: [0, 1, 2].map((index) => ({
      id: index + 1,
      hour: times[index]?.[0] ?? 0,
      minute: times[index]?.[1] ?? 0,
      dosagem: 2,
      status: Boolean(times[index]),
      diasSemana: [...EVERY_DAY],
    })),
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

function apply(bombs: BombConfig[], data: DosingData): BombConfig[] {
  const changes = autoSchedule(bombs, data);
  return bombs.map((bomb) => {
    const change = changes.find((item) => item.pumpId === bomb.id);
    if (!change) return bomb;
    return {
      ...bomb,
      schedules: bomb.schedules.map((schedule, index) => {
        const time = change.horarios.find((item) => item.scheduleIndex === index);
        return time ? { ...schedule, hour: time.hour, minute: time.minute } : schedule;
      }),
    };
  });
}

const minutes = (bomb: BombConfig) =>
  bomb.schedules.filter((schedule) => schedule.status).map((schedule) => schedule.hour * 60 + schedule.minute);

function circular(a: number, b: number): number {
  const diff = Math.abs(a - b) % 1440;
  return Math.min(diff, 1440 - diff);
}

describe('auto-schedule', () => {
  const khCa = makeData([
    { pumpId: 1, identidade: 'KH' },
    { pumpId: 2, identidade: 'Ca' },
  ]);

  it('afasta KH e Ca e deixa a agenda sem avisos de espaçamento', () => {
    const bombs = [makeBomb(1, [[8, 0], [12, 0], [20, 0]]), makeBomb(2, [[8, 30], [12, 30], [20, 30]])];
    const result = apply(bombs, khCa);
    const rules = evaluateRules({ bombs: result, data: khCa, now: new Date() });
    expect(rules.some((rule) => rule.id.startsWith('espaco'))).toBeFalse();
    for (const kh of minutes(result[0])) {
      for (const ca of minutes(result[1])) expect(circular(kh, ca)).toBeGreaterThanOrEqual(240);
    }
  });

  it('espalha as doses igualmente e mantém a mais próxima da agenda atual', () => {
    const [change] = autoSchedule([makeBomb(1, [[8, 0], [12, 0], [20, 0]])], khCa);
    expect(change.antes).toEqual(['08:00', '12:00', '20:00']);
    expect(change.depois).toEqual(['04:00', '12:00', '20:00']);
  });

  it('não sugere nada quando a agenda já é a melhor', () => {
    const bombs = [makeBomb(1, [[0, 0], [8, 0], [16, 0]]), makeBomb(2, [[4, 0], [12, 0], [20, 0]])];
    expect(autoSchedule(bombs, khCa)).toEqual([]);
  });

  it('separa bombas sem relação que caem no mesmo horário', () => {
    const data = makeData([
      { pumpId: 1, identidade: 'Carbono' },
      { pumpId: 2, identidade: 'K' },
    ]);
    const result = apply([makeBomb(1, [[9, 0]]), makeBomb(2, [[9, 0]])], data);
    expect(circular(minutes(result[0])[0], minutes(result[1])[0])).toBeGreaterThanOrEqual(30);
  });

  it('prefere KH com as luzes apagadas quando há fotoperíodo', () => {
    const data = makeData([{ pumpId: 1, identidade: 'KH' }], { fotoperiodo: { liga: '10:00', desliga: '20:00' } });
    const result = apply([makeBomb(1, [[12, 0], [15, 0]])], data);
    const dark = minutes(result[0]).filter((value) => value < 600 || value >= 1200);
    expect(dark.length).toBe(2);
  });

  it('ignora horários desativados', () => {
    const bomb = makeBomb(1, [[8, 0]]);
    bomb.schedules[1] = { ...bomb.schedules[1], hour: 8, minute: 0, status: false };
    const changes = autoSchedule([bomb, makeBomb(2, [[8, 0]])], khCa);
    expect(changes.every((change) => change.horarios.every((time) => time.scheduleIndex === 0))).toBeTrue();
  });
});
