import { BombConfig, LogEntry } from './doser.service';
import {
  dailySeries,
  groupByDay,
  origemKind,
  paramSeries,
  parseLogs,
  periodStats,
  stockForecast,
  toCsv,
} from './log-analytics';
import { TestSession } from './dosing.models';

const EVERY_DAY = [true, true, true, true, true, true, true];

const bomb: BombConfig = {
  id: 1,
  name: 'Cálcio',
  calibrCoef: 1,
  quantidadeEstoque: 100,
  schedules: [
    { id: 1, hour: 8, minute: 0, dosagem: 2, status: true, diasSemana: [...EVERY_DAY] },
    { id: 2, hour: 20, minute: 0, dosagem: 2, status: true, diasSemana: [...EVERY_DAY] },
    { id: 3, hour: 0, minute: 0, dosagem: 1, status: false, diasSemana: [...EVERY_DAY] },
  ],
};

function log(timestamp: string, dosagem = 2, origem = 'Programado'): LogEntry {
  return { bombaId: 1, timestamp, bomba: 'Cálcio antigo', dosagem, origem };
}

const now = new Date(2026, 9, 30, 21, 0);
const logs = parseLogs([
  log('29/10/2026 08:00'),
  log('29/10/2026 20:00'),
  log('30/10/2026 08:01'),
  log('30/10/2026 12:00', 1.5, 'Teste'),
  log('data inválida'),
]);

describe('log-analytics', () => {
  it('classifica a origem dos registros', () => {
    expect(origemKind('Programado')).toBe('programado');
    expect(origemKind('Teste')).toBe('manual');
    expect(origemKind('Calibracao')).toBe('calibracao');
  });

  it('ordena do mais recente e descarta datas inválidas', () => {
    expect(logs.length).toBe(4);
    expect(logs[0].kind).toBe('manual');
  });

  it('agrupa por dia com total e doses não executadas', () => {
    const groups = groupByDay(logs, [{ pumpId: 1, nome: 'Cálcio', quando: new Date(2026, 9, 30, 20, 0), dosagem: 2 }], now);
    expect(groups.map((group) => group.label)).toEqual(['Hoje', 'Ontem']);
    expect(groups[0].totalMl).toBe(3.5);
    expect(groups[0].missed.length).toBe(1);
  });

  it('calcula total, média e % de doses executadas', () => {
    const [stats] = periodStats([bomb], logs, new Date(2026, 9, 29, 0, 0), now);
    expect(stats.totalMl).toBe(7.5);
    expect(stats.manualMl).toBe(1.5);
    expect(stats.programadas).toBe(4);
    expect(stats.executadas).toBe(3);
    expect(stats.percentual).toBe(75);
  });

  it('monta a série de ml por dia', () => {
    const series = dailySeries([bomb], logs, 3, now);
    expect(series.labels).toEqual(['28/10', '29/10', '30/10']);
    expect(series.series[0].values).toEqual([0, 4, 3.5]);
  });

  it('prevê o fim do estoque pelo consumo real', () => {
    const [forecast] = stockForecast([bomb], logs, now);
    expect(forecast.dias).not.toBeNull();
    expect(forecast.acabaEm).not.toBeNull();
  });

  it('monta a série de um parâmetro e marca ajustes', () => {
    const sessoes: TestSession[] = [
      {
        id: 'a',
        inicio: '2026-10-16T10:00:00.000Z',
        diasPlanejados: 7,
        medidasInicio: { KH: 8 },
        dosesSnapshot: {},
        fim: '2026-10-23T10:00:00.000Z',
        medidasFim: { KH: 7.5 },
        aplicado: { '1': { antes: 4, depois: 5 } },
      },
      { id: 'b', inicio: '2026-10-23T10:00:00.000Z', diasPlanejados: 7, medidasInicio: { KH: 7.5 }, dosesSnapshot: {} },
    ];
    const points = paramSeries(sessoes, 'KH');
    expect(points.map((point) => point.y)).toEqual([8, 7.5]);
    expect(points[1].ajuste).toBeTrue();
  });

  it('gera CSV com ponto e vírgula e vírgula decimal', () => {
    const csv = toCsv(logs, () => 'Cálcio');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('data;hora;bomba;dose_ml;origem');
    expect(lines).toContain('30/10/2026;12:00;Cálcio;1,5;Dose manual');
  });
});
