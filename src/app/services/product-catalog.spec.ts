import { IDENTITY_ORDER, hasPotencyUnit } from './dosing.models';
import { PRODUCT_CATALOG, findCatalogProduct, powderPotency, productsFor } from './product-catalog';

describe('product-catalog', () => {
  it('tem ids únicos', () => {
    const ids = PRODUCT_CATALOG.map((product) => product.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('usa tipos válidos e fonte oficial em https', () => {
    for (const product of PRODUCT_CATALOG) {
      expect(IDENTITY_ORDER).withContext(product.id).toContain(product.identidade);
      expect(product.fonte).withContext(product.id).toMatch(/^https:\/\//);
    }
  });

  it('traz potência positiva só para tipos com unidade', () => {
    for (const product of PRODUCT_CATALOG) {
      if (!product.potencia) continue;
      expect(hasPotencyUnit(product.identidade)).withContext(product.id).toBeTrue();
      const { doseMl, porLitros, eleva } = product.potencia;
      expect(doseMl > 0 && porLitros > 0 && eleva > 0).withContext(product.id).toBeTrue();
    }
  });

  it('tem o Balling em pó da Aquaforest e o Potassium+ da Red Sea', () => {
    expect(findCatalogProduct('af-calcium-solucao')?.identidade).toBe('Ca');
    expect(findCatalogProduct('af-kh-buffer-solucao')?.identidade).toBe('KH');
    expect(findCatalogProduct('af-magnesium-solucao')?.identidade).toBe('Mg');
    expect(findCatalogProduct('rs-trace-b')?.potencia).toEqual({ doseMl: 1, porLitros: 100, eleva: 1.75 });
  });

  it('calcula a potência do pó pela receita do fabricante', () => {
    // Aquaforest: 100 ml da solução de 50 g/L sobem 18 ppm em 100 L → 10 ml sobem 1,8
    expect(findCatalogProduct('af-calcium-solucao')!.potencia!.eleva).toBeCloseTo(1.8, 3);
    expect(findCatalogProduct('af-kh-buffer-solucao')!.potencia!.eleva).toBeCloseTo(0.264, 3);
    expect(findCatalogProduct('af-magnesium-solucao')!.potencia!.eleva).toBeCloseTo(0.12, 3);
    // Red Sea: 1 ml da solução de 550 g/L sobe 2 ppm → 10 ml sobem 20
    expect(findCatalogProduct('rs-calcium-po')!.potencia!.eleva).toBeCloseTo(20, 2);
  });

  it('acompanha a concentração da solução do usuário', () => {
    const po = findCatalogProduct('af-magnesium-solucao')!.po!;
    expect(powderPotency(po, 100).eleva).toBeCloseTo(1.2, 3);
    expect(powderPotency(po, 200).eleva).toBeCloseTo(2 * powderPotency(po, 100).eleva, 6);
  });

  it('filtra por tipo e encontra pelo id', () => {
    const first = PRODUCT_CATALOG[0];
    if (!first) return;
    expect(productsFor(first.identidade)).toContain(first);
    expect(findCatalogProduct(first.id)).toBe(first);
    expect(findCatalogProduct(null)).toBeUndefined();
  });
});
