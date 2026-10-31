import { PumpIdentity, ProductPotency } from './dosing.models';

/**
 * Produto de mercado com a potência informada pelo fabricante. A potência vai para o perfil da bomba e o usuário
 * pode ajustá-la em Produtos; `fonte` aponta a página oficial de onde o valor saiu.
 */
export interface CatalogProduct {
  id: string;
  marca: string;
  nome: string;
  identidade: PumpIdentity;
  potencia: ProductPotency | null;
  fonte: string;
  obs?: string;
  /** Produto em pó: potência por grama e receita do fabricante; a solução do usuário pode ter outra concentração. */
  po?: PowderInfo;
}

export interface PowderInfo {
  /** Quanto 1 g de pó eleva o parâmetro em 100 L. */
  elevaPorGrama: number;
  /** Concentração da receita do fabricante (g de pó por litro de solução). */
  receitaGramasPorLitro: number;
}

/** Galão americano em litros (a Brightwell informa a potência por galão). */
const US_GAL = 3.785;

const p = (doseMl: number, porLitros: number, eleva: number): ProductPotency => ({ doseMl, porLitros, eleva });

/** Potência de 10 ml em 100 L de uma solução com `gramasPorLitro` g de pó por litro. */
export function powderPotency(po: PowderInfo, gramasPorLitro: number): ProductPotency {
  const gramas = (gramasPorLitro * 10) / 1000;
  return p(10, 100, Math.round(gramas * po.elevaPorGrama * 10000) / 10000);
}

function powder(elevaPorGrama: number, receitaGramasPorLitro: number): { po: PowderInfo; potencia: ProductPotency } {
  const po = { elevaPorGrama, receitaGramasPorLitro };
  return { po, potencia: powderPotency(po, receitaGramasPorLitro) };
}

// Valores levantados em out/2026 nas páginas e manuais oficiais de cada marca (exceto onde `obs` diz outra coisa).
// Ficaram de fora produtos sem potência numérica oficial (All-For-Reef, Trace-Colors D, ESV B-Ionic…).
export const PRODUCT_CATALOG: CatalogProduct[] = [
  // Aquaforest
  { id: 'af-kh-plus', marca: 'Aquaforest', nome: 'KH Plus', identidade: 'KH', potencia: p(10, 100, 0.5), fonte: 'https://aquaforest.eu/en/products/lab/macroelements/kh-plus/' },
  { id: 'af-ca-plus', marca: 'Aquaforest', nome: 'Ca Plus', identidade: 'Ca', potencia: p(10, 100, 20), fonte: 'https://aquaforest.eu/en/products/lab/macroelements/ca-plus/', obs: 'Fórmula nova (selo vermelho); a antiga sobe 15 ppm' },
  { id: 'af-mg-plus', marca: 'Aquaforest', nome: 'Mg Plus', identidade: 'Mg', potencia: p(10, 100, 10), fonte: 'https://aquaforest.eu/en/products/lab/macroelements/mg-plus/' },
  { id: 'af-kh-pro', marca: 'Aquaforest', nome: 'KH Pro', identidade: 'KH', potencia: p(5, 100, 0.5), fonte: 'https://aquaforest.eu/en/products/seawater/water-treatment/kh-pro/', obs: 'Também adiciona um pouco de potássio' },
  { id: 'af-component-1-plus', marca: 'Aquaforest', nome: 'Component 1+', identidade: 'Ca', potencia: p(25, 100, 4.5), fonte: 'https://aquaforest.eu/en/product/component-123/' },
  { id: 'af-component-2-plus', marca: 'Aquaforest', nome: 'Component 2+', identidade: 'KH', potencia: p(25, 100, 0.65), fonte: 'https://aquaforest.eu/en/product/component-123/' },
  { id: 'af-component-3-plus', marca: 'Aquaforest', nome: 'Component 3+', identidade: 'Sal', potencia: null, fonte: 'https://aquaforest.eu/en/product/component-123/', obs: 'Parte de sal/traços do Balling (Mg sobe só ~0,38 ppm por 25 ml/100 L)' },
  { id: 'af-component-1-pro', marca: 'Aquaforest', nome: 'Component 1 Pro', identidade: 'Ca', potencia: p(25, 100, 9), fonte: 'https://aquaforest.eu/en/products/lab/macroelements/components-pro/' },
  { id: 'af-component-2-pro', marca: 'Aquaforest', nome: 'Component 2 Pro', identidade: 'KH', potencia: p(25, 100, 1.3), fonte: 'https://aquaforest.eu/en/products/lab/macroelements/components-pro/' },
  { id: 'af-component-3-pro', marca: 'Aquaforest', nome: 'Component 3 Pro', identidade: 'Sal', potencia: null, fonte: 'https://aquaforest.eu/en/products/lab/macroelements/components-pro/', obs: 'Parte de sal/traços do Balling (Mg sobe só ~0,76 ppm por 25 ml/100 L)' },
  { id: 'af-component-3in1', marca: 'Aquaforest', nome: 'Component 3in1', identidade: 'Ca', potencia: p(5, 100, 2), fonte: 'https://aquaforest.eu/en/products/seawater/water-treatment/component-3-in-1/', obs: 'Também sobe KH e Mg (sem número oficial de KH)' },
  // Balling em pó: 10 g em 100 L sobem ~36 ppm Ca / ~3,3 dKH; a solução de Mg do fabricante (10 g/L) sobe 1,2 ppm por 100 ml/100 L
  { id: 'af-calcium-solucao', marca: 'Aquaforest', nome: 'Calcium (pó, Balling)', identidade: 'Ca', ...powder(3.6, 50), fonte: 'https://aquaforest.eu/en/products/seawater/water-treatment/calcium/' },
  { id: 'af-kh-buffer-solucao', marca: 'Aquaforest', nome: 'KH Buffer (pó, Balling)', identidade: 'KH', ...powder(0.33, 80), fonte: 'https://aquaforest.eu/en/products/seawater/water-treatment/kh-buffer/' },
  { id: 'af-magnesium-solucao', marca: 'Aquaforest', nome: 'Magnesium (pó, Balling)', identidade: 'Mg', ...powder(1.2, 10), fonte: 'https://aquaforest.eu/en/products/seawater/water-treatment/magnesium/' },
  { id: 'af-kalium', marca: 'Aquaforest', nome: 'Kalium', identidade: 'K', potencia: p(10, 100, 10), fonte: 'https://aquaforest.eu/en/products/lab/microelements/kalium/' },
  { id: 'af-iodum', marca: 'Aquaforest', nome: 'Iodum', identidade: 'Iodo', potencia: p(10, 100, 0.1), fonte: 'https://aquaforest.eu/en/products/lab/microelements/iodum/' },
  { id: 'af-ferrum', marca: 'Aquaforest', nome: 'Ferrum', identidade: 'Ferro', potencia: p(1, 100, 0.001), fonte: 'https://aquaforest.eu/en/products/lab/microelements/ferrum/' },
  { id: 'af-strontium', marca: 'Aquaforest', nome: 'Strontium', identidade: 'Estroncio', potencia: p(10, 100, 1), fonte: 'https://aquaforest.eu/en/products/lab/microelements/strontium/' },
  { id: 'af-no3', marca: 'Aquaforest', nome: 'NO3+', identidade: 'Nitrato', potencia: p(1, 100, 0.5), fonte: 'https://aquaforest.eu/en/products/lab/microelements/no3/' },
  { id: 'af-po4', marca: 'Aquaforest', nome: 'PO4+', identidade: 'Fosfato', potencia: p(1, 100, 0.01), fonte: 'https://aquaforest.eu/en/products/lab/microelements/po4/' },

  // Red Sea
  { id: 'rs-foundation-a', marca: 'Red Sea', nome: 'Reef Foundation A (Calcium+)', identidade: 'Ca', potencia: p(1, 100, 2), fonte: 'https://www.redseafish.com/reef-care-program/foundation-elements/calcium-supplement/' },
  { id: 'rs-foundation-b', marca: 'Red Sea', nome: 'Reef Foundation B (KH/Alk)', identidade: 'KH', potencia: p(1, 100, 0.1), fonte: 'https://www.redseafish.com/reef-care-program/foundation-elements/kh-alkalinity-supplement/' },
  { id: 'rs-foundation-c', marca: 'Red Sea', nome: 'Reef Foundation C (Magnesium)', identidade: 'Mg', potencia: p(1, 100, 1), fonte: 'https://www.redseafish.com/reef-care-program/foundation-elements/magnesium-supplement/' },
  { id: 'rs-trace-a', marca: 'Red Sea', nome: 'Trace-Colors A (Iodine+)', identidade: 'Iodo', potencia: p(1, 100, 0.03), fonte: 'https://www.redseafish.com/reef-care-program/trace-elements/iodine-supplement/' },
  { id: 'rs-trace-b', marca: 'Red Sea', nome: 'Potassium+ (Trace-Colors B)', identidade: 'K', potencia: p(1, 100, 1.75), fonte: 'https://www.redseafish.com/reef-care-program/trace-elements/potassium-supplement/' },
  { id: 'rs-trace-c', marca: 'Red Sea', nome: 'Trace-Colors C (Iron+)', identidade: 'Ferro', potencia: p(1, 100, 0.01), fonte: 'https://www.redseafish.com/reef-care-program/trace-elements/iron-supplement/' },
  { id: 'rs-complete-1', marca: 'Red Sea', nome: 'Complete Reef Care #1 (Ca & Mg+)', identidade: 'Ca', potencia: p(1, 100, 1.4), fonte: 'https://g1.redseafish.com/wp-content/uploads/2024/03/24964_Complete-Reef-Care-Manual_FED_V24A-WEB.pdf' },
  { id: 'rs-complete-2', marca: 'Red Sea', nome: 'Complete Reef Care #2 (KH/Alk)', identidade: 'KH', potencia: p(1, 100, 0.1), fonte: 'https://g1.redseafish.com/wp-content/uploads/2024/03/24964_Complete-Reef-Care-Manual_FED_V24A-WEB.pdf' },
  // Pós Foundation: 1 ml/100 L da solução padrão sobe 2 ppm Ca (550 g/L), 0,034 dKH (100 g/L) e 1 ppm Mg (600 g/L)
  { id: 'rs-calcium-po', marca: 'Red Sea', nome: 'Calcium+ (pó)', identidade: 'Ca', ...powder(2 / 0.55, 550), fonte: 'https://g1.redseafish.com/wp-content/uploads/2020/11/24783_Manual-Foundation-Supplements_GB-DE-FR-NL-SP_v21c-WEB.pdf' },
  { id: 'rs-kh-po', marca: 'Red Sea', nome: 'KH/Alkalinity (pó)', identidade: 'KH', ...powder(0.34, 100), fonte: 'https://g1.redseafish.com/wp-content/uploads/2020/11/24783_Manual-Foundation-Supplements_GB-DE-FR-NL-SP_v21c-WEB.pdf' },
  { id: 'rs-magnesium-po', marca: 'Red Sea', nome: 'Magnesium (pó)', identidade: 'Mg', ...powder(1 / 0.6, 600), fonte: 'https://g1.redseafish.com/wp-content/uploads/2020/11/24783_Manual-Foundation-Supplements_GB-DE-FR-NL-SP_v21c-WEB.pdf' },

  // Tropic Marin
  { id: 'tm-calcium', marca: 'Tropic Marin', nome: 'Calcium (Components)', identidade: 'Ca', potencia: p(50, 100, 10), fonte: 'https://www.tropic-marin-smartinfo.com/calcium?lang=en' },
  { id: 'tm-carbonate', marca: 'Tropic Marin', nome: 'Carbonate (Components)', identidade: 'KH', potencia: p(50, 100, 1.4), fonte: 'https://www.tropic-marin-smartinfo.com/carbonate?lang=en' },
  { id: 'tm-magnesium', marca: 'Tropic Marin', nome: 'Magnesium (Components)', identidade: 'Mg', potencia: p(50, 100, 50), fonte: 'https://www.tropic-marin-smartinfo.com/magnesium?lang=en' },
  { id: 'tm-bio-magnesium', marca: 'Tropic Marin', nome: 'Bio-Magnesium Liquid', identidade: 'Mg', potencia: p(50, 100, 25), fonte: 'https://www.tropic-marin-smartinfo.com/bio-magnesium' },
  { id: 'tm-balling-a', marca: 'Tropic Marin', nome: 'Original Balling A (Calcium)', identidade: 'Ca', potencia: p(50, 100, 10), fonte: 'https://www.tropic-marin-smartinfo.com/original-balling-components' },
  { id: 'tm-balling-b', marca: 'Tropic Marin', nome: 'Original Balling B (Carbonate)', identidade: 'KH', potencia: p(50, 100, 1.4), fonte: 'https://www.tropic-marin-smartinfo.com/original-balling-components' },
  { id: 'tm-balling-c', marca: 'Tropic Marin', nome: 'Original Balling C (sal sem NaCl)', identidade: 'Sal', potencia: null, fonte: 'https://www.tropic-marin-smartinfo.com/original-balling-components?lang=en' },
  { id: 'tm-carbo-calcium-ca', marca: 'Tropic Marin', nome: 'Carbo-Calcium (solução)', identidade: 'Ca', potencia: p(10, 100, 4.3), fonte: 'https://www.tropic-marin-smartinfo.com/carbocalcium?lang=en', obs: 'Calculado da concentração oficial; a mesma dose sobe ~0,6 dKH' },
  { id: 'tm-carbo-calcium-kh', marca: 'Tropic Marin', nome: 'Carbo-Calcium (solução)', identidade: 'KH', potencia: p(10, 100, 0.6), fonte: 'https://www.tropic-marin-smartinfo.com/carbocalcium?lang=en', obs: 'Calculado da concentração oficial; a mesma dose sobe ~4,3 ppm de Ca' },
  { id: 'tm-liquid-buffer', marca: 'Tropic Marin', nome: 'Liquid Buffer', identidade: 'KH', potencia: p(30, 100, 0.8), fonte: 'https://www.tropic-marin-smartinfo.com/liquid-buffer', obs: 'Corretivo de pH/KH, não para dose diária' },
  { id: 'tm-potassium', marca: 'Tropic Marin', nome: 'Potassium', identidade: 'K', potencia: p(10, 100, 10), fonte: 'https://www.tropic-marin-smartinfo.com/potassium?lang=en' },
  { id: 'tm-iodine', marca: 'Tropic Marin', nome: 'Iodine (Components)', identidade: 'Iodo', potencia: p(1.5, 100, 0.015), fonte: 'https://www.tropic-marin-smartinfo.com/iodine?lang=en' },
  { id: 'tm-strontium', marca: 'Tropic Marin', nome: 'Strontium (Components)', identidade: 'Estroncio', potencia: p(5, 100, 1), fonte: 'https://www.tropic-marin-smartinfo.com/strontium?lang=en' },
  { id: 'tm-iron', marca: 'Tropic Marin', nome: 'Iron (Components)', identidade: 'Ferro', potencia: p(1, 100, 0.001), fonte: 'https://www.tropic-marin-smartinfo.com/iron?lang=en' },
  { id: 'tm-nitrogen', marca: 'Tropic Marin', nome: 'Nitrogen (Components)', identidade: 'Nitrato', potencia: p(1, 100, 1), fonte: 'https://www.tropic-marin-smartinfo.com/nitrogen?lang=en' },
  { id: 'tm-phosphate', marca: 'Tropic Marin', nome: 'Phosphate (Components)', identidade: 'Fosfato', potencia: p(2, 100, 0.02), fonte: 'https://www.tropic-marin-smartinfo.com/phosphate?lang=en' },

  // Fauna Marin
  { id: 'fm-balling-light-ca', marca: 'Fauna Marin', nome: 'Balling Light Calcium', identidade: 'Ca', potencia: p(10, 100, 11), fonte: 'https://lab.faunamarin.de/en/calc-balling-light' },
  { id: 'fm-balling-light-kh', marca: 'Fauna Marin', nome: 'Balling Light Carbonate', identidade: 'KH', potencia: p(10, 100, 0.5), fonte: 'https://lab.faunamarin.de/en/calc-balling-light' },
  { id: 'fm-balling-light-mg', marca: 'Fauna Marin', nome: 'Balling Light Magnesium', identidade: 'Mg', potencia: p(10, 100, 5), fonte: 'https://lab.faunamarin.de/en/calc-balling-light' },
  { id: 'fm-elementals-kh', marca: 'Fauna Marin', nome: 'Elementals KH', identidade: 'KH', potencia: p(20, 100, 1), fonte: 'https://lab.faunamarin.de/en/calc-elementals-once', obs: 'Da calculadora oficial da marca' },
  { id: 'fm-elementals-mg', marca: 'Fauna Marin', nome: 'Elementals Mg', identidade: 'Mg', potencia: p(1, 100, 1), fonte: 'https://lab.faunamarin.de/en/calc-elementals-once', obs: 'Da calculadora oficial da marca' },
  { id: 'fm-elementals-k', marca: 'Fauna Marin', nome: 'Elementals K', identidade: 'K', potencia: p(10, 100, 10), fonte: 'https://lab.faunamarin.de/en/calc-elementals-once', obs: 'Da calculadora oficial da marca' },
  { id: 'fm-elementals-i', marca: 'Fauna Marin', nome: 'Elementals I', identidade: 'Iodo', potencia: p(1, 100, 0.01), fonte: 'https://lab.faunamarin.de/en/calc-elementals-once', obs: 'Da calculadora oficial da marca' },
  { id: 'fm-elementals-sr', marca: 'Fauna Marin', nome: 'Elementals Sr', identidade: 'Estroncio', potencia: p(10, 100, 2), fonte: 'https://lab.faunamarin.de/en/calc-elementals-once', obs: 'Da calculadora oficial da marca' },
  { id: 'fm-elementals-fe', marca: 'Fauna Marin', nome: 'Elementals Fe', identidade: 'Ferro', potencia: p(1, 100, 0.004), fonte: 'https://lab.faunamarin.de/en/calc-elementals-once', obs: 'Da calculadora oficial da marca' },

  // Brightwell Aquatics (potência por galão americano)
  { id: 'bw-reef-code-a', marca: 'Brightwell', nome: 'Reef Code A', identidade: 'Ca', potencia: p(1, US_GAL, 16), fonte: 'https://www.brightwellaquatics.com/products/reefcodeat.php' },
  { id: 'bw-reef-code-b', marca: 'Brightwell', nome: 'Reef Code B', identidade: 'KH', potencia: p(1, US_GAL, 2.22), fonte: 'https://www.brightwellaquatics.com/products/reefcodebt.php' },
  { id: 'bw-alkalin83', marca: 'Brightwell', nome: 'Alkalin8.3', identidade: 'KH', potencia: p(1, US_GAL, 3.1), fonte: 'https://www.brightwellaquatics.com/products/alkalin83t.php' },
  { id: 'bw-calcion', marca: 'Brightwell', nome: 'Calcion', identidade: 'Ca', potencia: p(1, US_GAL, 40), fonte: 'https://www.brightwellaquatics.com/products/calciont.php' },
  { id: 'bw-liquid-reef', marca: 'Brightwell', nome: 'Liquid Reef', identidade: 'Ca', potencia: p(1, US_GAL, 37), fonte: 'https://www.brightwellaquatics.com/products/liquidReeft.php', obs: 'Também sobe KH (sem número oficial)' },
  { id: 'bw-magnesion', marca: 'Brightwell', nome: 'Magnesion', identidade: 'Mg', potencia: p(1, US_GAL, 26), fonte: 'https://www.brightwellaquatics.com/products/magnesiont.php' },
  { id: 'bw-potassion', marca: 'Brightwell', nome: 'Potassion', identidade: 'K', potencia: p(1, US_GAL, 21), fonte: 'https://www.brightwellaquatics.com/products/potassiont.php' },
  { id: 'bw-strontion', marca: 'Brightwell', nome: 'Strontion', identidade: 'Estroncio', potencia: p(1, US_GAL, 8), fonte: 'https://www.brightwellaquatics.com/products/strontiont.php' },
  { id: 'bw-ferrion', marca: 'Brightwell', nome: 'Ferrion', identidade: 'Ferro', potencia: p(1, US_GAL, 1), fonte: 'https://www.brightwellaquatics.com/products/ferriont.php', obs: 'Valor do site parece alto; confira no rótulo' },

  // Seachem
  { id: 'sc-reef-calcium', marca: 'Seachem', nome: 'Reef Calcium', identidade: 'Ca', potencia: p(5, 80, 3), fonte: 'https://www.seachem.com/reef-calcium.php' },
  { id: 'sc-reef-complete', marca: 'Seachem', nome: 'Reef Complete', identidade: 'Ca', potencia: p(5, 80, 10), fonte: 'https://www.seachem.com/reef-complete.php' },
  { id: 'sc-reef-carbonate', marca: 'Seachem', nome: 'Reef Carbonate', identidade: 'KH', potencia: p(5, 80, 0.7), fonte: 'https://www.seachem.com/reef-carbonate.php' },
  { id: 'sc-reef-fusion-1', marca: 'Seachem', nome: 'Reef Fusion 1', identidade: 'Ca', potencia: p(1, 25, 4), fonte: 'https://www.seachem.com/reef-fusion.php' },
  { id: 'sc-reef-fusion-2', marca: 'Seachem', nome: 'Reef Fusion 2', identidade: 'KH', potencia: p(1, 25, 0.49), fonte: 'https://www.seachem.com/reef-fusion.php' },
  { id: 'sc-reef-strontium', marca: 'Seachem', nome: 'Reef Strontium', identidade: 'Estroncio', potencia: p(5, 80, 0.6), fonte: 'https://www.seachem.com/reef-strontium.php' },
  { id: 'sc-reef-iodide', marca: 'Seachem', nome: 'Reef Iodide', identidade: 'Iodo', potencia: p(1, 80, 0.1), fonte: 'https://www.seachem.com/reef-iodide.php' },
  { id: 'sc-reef-potassium', marca: 'Seachem', nome: 'Reef Potassium', identidade: 'K', potencia: p(5, 160, 3), fonte: 'https://www.seachem.com/reef-potassium.php' },
  { id: 'sc-reef-iron', marca: 'Seachem', nome: 'Reef Iron', identidade: 'Ferro', potencia: p(2.5, 160, 0.08), fonte: 'https://www.seachem.com/reef-iron.php' },
  { id: 'sc-reef-nitrogen', marca: 'Seachem', nome: 'Reef Nitrogen', identidade: 'Nitrato', potencia: p(5, 160, 3.5), fonte: 'https://www.seachem.com/reef-nitrogen.php' },
  { id: 'sc-reef-phosphorus', marca: 'Seachem', nome: 'Reef Phosphorus', identidade: 'Fosfato', potencia: p(2.5, 160, 0.05), fonte: 'https://www.seachem.com/reef-phoshorus.php' },

  // Marcas nacionais
  { id: 'vm-veroestroncio', marca: 'Veromar', nome: 'VeroEstrôncio', identidade: 'Estroncio', potencia: p(1, 10, 3), fonte: 'https://veromar.com.br/sais_para_aquarismo/veroestroncio' },
  // 125 ml da solução de 84 g/L sobem 1,75 dKH em 200 L → 10,5 g em 200 L
  { id: 'vm-verokh-solucao', marca: 'Veromar', nome: 'VeroKH (pó)', identidade: 'KH', ...powder((1.75 * 2) / 10.5, 84), fonte: 'https://veromar.com.br/sais_para_aquarismo/verokh' },
  { id: 'ot-ionic-calcio', marca: 'OceanTech', nome: 'Ionic Cálcio', identidade: 'Ca', potencia: p(2, 50, 3.8), fonte: 'https://www.brfishaquarismo.com.br/suplemento/kit-balling-ocean-tech-ionic-calcio-magnesio-kh-1-litro', obs: 'Texto do rótulo publicado por loja; confira na embalagem' },
  { id: 'ot-ionic-kh', marca: 'OceanTech', nome: 'Ionic KH', identidade: 'KH', potencia: p(2, 50, 0.5), fonte: 'https://www.brfishaquarismo.com.br/suplemento/kit-balling-ocean-tech-ionic-calcio-magnesio-kh-1-litro', obs: 'Texto do rótulo publicado por loja; confira na embalagem' },
  { id: 'ot-ionic-mg', marca: 'OceanTech', nome: 'Ionic Mg', identidade: 'Mg', potencia: p(2, 50, 0.48), fonte: 'https://www.brfishaquarismo.com.br/suplemento/kit-balling-ocean-tech-ionic-calcio-magnesio-kh-1-litro', obs: 'Texto do rótulo publicado por loja; confira na embalagem' },
];

export function catalogLabel(product: CatalogProduct): string {
  return `${product.marca} ${product.nome}`;
}

export function productsFor(identidade: PumpIdentity): CatalogProduct[] {
  return PRODUCT_CATALOG.filter((product) => product.identidade === identidade).sort((a, b) =>
    catalogLabel(a).localeCompare(catalogLabel(b), 'pt-BR'),
  );
}

export function findCatalogProduct(id: string | null | undefined): CatalogProduct | undefined {
  return id ? PRODUCT_CATALOG.find((product) => product.id === id) : undefined;
}
