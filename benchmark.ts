interface DailyDataPoint {
  bombId: number;
  [key: string]: any;
}

function generateData(size: number, numBombs: number): DailyDataPoint[] {
  const data: DailyDataPoint[] = [];
  for (let i = 0; i < size; i++) {
    data.push({ bombId: Math.floor(Math.random() * numBombs) + 1, val: i });
  }
  return data;
}

const dataSize = 100000;
const numBombs = 100;
const data = generateData(dataSize, numBombs);
const bombIds = [...new Set(data.map(d => d.bombId))].sort((a, b) => a - b);

// Original
console.time('Original');
const datasets1 = [];
bombIds.forEach((bombId) => {
  const bombData = data.filter(d => d.bombId === bombId);
  datasets1.push(bombData.length);
});
console.timeEnd('Original');

// Optimized
console.time('Optimized');
const datasets2 = [];
const groupedData = data.reduce((acc, curr) => {
  if (!acc[curr.bombId]) {
    acc[curr.bombId] = [];
  }
  acc[curr.bombId].push(curr);
  return acc;
}, {} as Record<number, DailyDataPoint[]>);

bombIds.forEach((bombId) => {
  const bombData = groupedData[bombId] || [];
  datasets2.push(bombData.length);
});
console.timeEnd('Optimized');
