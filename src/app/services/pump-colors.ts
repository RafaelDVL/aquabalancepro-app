// Cores das bombas: as escolhidas em Configuração (localStorage) ou as padrão
const STORAGE_KEY = 'abp-bomb-colors';

export const DEFAULT_PUMP_COLORS: Record<number, string> = {
  1: '#2DD4BF',
  2: '#F472B6',
  3: '#A855F7',
  4: '#3B82F6',
  5: '#F59E0B',
};

export function loadStoredColors(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function pumpColor(id: number, stored: Record<string, string>): string {
  return stored[String(id)] ?? DEFAULT_PUMP_COLORS[id] ?? '#0F969C';
}

export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '').trim();
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6) return `rgba(15, 150, 156, ${alpha})`;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
