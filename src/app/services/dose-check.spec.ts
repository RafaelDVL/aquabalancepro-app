import { BombConfig, LogEntry } from './doser.service';
import { expectedDoses, findMissedDoses } from './dose-check';

const bomb: BombConfig = {
  id: 2,
  name: 'Cálcio',
  calibrCoef: 1,
  quantidadeEstoque: 1000,
  schedules: [
    { id: 1, hour: 8, minute: 0, dosagem: 4, status: true, diasSemana: [true, true, true, true, true, true, true] },
    { id: 2, hour: 20, minute: 0, dosagem: 4, status: true, diasSemana: [true, true, true, true, true, true, true] },
    { id: 3, hour: 0, minute: 0, dosagem: 1, status: false, diasSemana: [true, true, true, true, true, true, true] },
  ],
};

function log(timestamp: string): LogEntry {
  return { bombaId: 2, timestamp, bomba: 'Cálcio', dosagem: 4, origem: 'Programado' };
}

describe('dose-check', () => {
  it('lista os horários programados no intervalo', () => {
    const doses = expectedDoses([bomb], new Date(2026, 9, 29, 0, 0), new Date(2026, 9, 30, 23, 59));
    expect(doses.length).toBe(4);
  });

  it('aponta a dose que não está no log', () => {
    const since = new Date(2026, 9, 29, 7, 0);
    const now = new Date(2026, 9, 30, 9, 0);
    const missed = findMissedDoses([bomb], [log('29/10/2026 08:00'), log('29/10/2026 20:01')], since, now);
    expect(missed.length).toBe(1);
    expect(missed[0].quando.getDate()).toBe(30);
  });

  it('ignora doses dos últimos 5 minutos', () => {
    const missed = findMissedDoses([bomb], [], new Date(2026, 9, 30, 7, 0), new Date(2026, 9, 30, 8, 3));
    expect(missed.length).toBe(0);
  });
});
