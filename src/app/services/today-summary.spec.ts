import { BombConfig, LogEntry } from './doser.service';
import { buildTodaySummary, formatCountdown } from './today-summary';

const EVERY_DAY = [true, true, true, true, true, true, true];

function bomb(id: number, times: [number, number][], stock = 0): BombConfig {
  return {
    id,
    name: `Bomba ${id}`,
    calibrCoef: 1,
    quantidadeEstoque: stock,
    schedules: [0, 1, 2].map((index) => ({
      id: index + 1,
      hour: times[index]?.[0] ?? 0,
      minute: times[index]?.[1] ?? 0,
      dosagem: 1,
      status: Boolean(times[index]),
      diasSemana: [...EVERY_DAY],
    })),
  };
}

function log(bombaId: number, timestamp: string): LogEntry {
  return { bombaId, timestamp, bomba: `Bomba ${bombaId}`, dosagem: 1, origem: 'Programado' };
}

describe('today-summary', () => {
  const now = new Date(2026, 9, 30, 13, 50);

  it('marca doses feitas, perdidas e pendentes', () => {
    const summary = buildTodaySummary(
      [bomb(1, [[8, 0], [12, 0], [16, 0]])],
      [log(1, '30/10/2026 08:01'), log(1, '29/10/2026 12:00')],
      now,
    );
    expect(summary.pumps[0].doses.map((dose) => dose.estado)).toEqual(['feita', 'perdida', 'pendente']);
    expect(summary.feitas).toBe(1);
    expect(summary.total).toBe(3);
  });

  it('aponta a próxima dose entre todas as bombas', () => {
    const summary = buildTodaySummary([bomb(1, [[16, 0]]), bomb(2, [[14, 30]])], [], now);
    expect(summary.proxima?.pumpId).toBe(2);
    expect(summary.proxima?.emMinutos).toBe(40);
  });

  it('mostra a primeira dose de amanhã quando as de hoje acabaram', () => {
    const summary = buildTodaySummary([bomb(1, [[8, 0], [12, 0]])], [], now);
    expect(summary.proxima?.amanha).toBeTrue();
    expect(summary.proxima?.hora).toBe('08:00');
    expect(summary.proxima?.emMinutos).toBe(18 * 60 + 10);
  });

  it('omite bombas sem dose hoje e calcula dias de estoque', () => {
    const summary = buildTodaySummary([bomb(1, []), bomb(2, [[20, 0], [21, 0]], 30)], [], now);
    expect(summary.pumps.length).toBe(1);
    expect(summary.pumps[0].diasEstoque).toBe(15);
  });

  it('formata a contagem regressiva', () => {
    expect(formatCountdown(0)).toBe('agora');
    expect(formatCountdown(15)).toBe('em 15 min');
    expect(formatCountdown(130)).toBe('em 2h10');
    expect(formatCountdown(120)).toBe('em 2h');
  });
});
