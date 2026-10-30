import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToast,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { BombConfig, DoserService } from '../services/doser.service';
import {
  DosingData,
  IDENTITIES,
  IDENTITY_ORDER,
  MEASURED_PARAMS,
  MeasuredParam,
  PumpIdentity,
  PumpProfile,
} from '../services/dosing.models';
import { DoseNotificationsService } from '../services/dose-notifications.service';

interface PumpForm {
  pumpId: number;
  nome: string;
  identidade: PumpIdentity;
  produto: string;
  doseMl: number | null;
  porLitros: number | null;
  eleva: number | null;
  vinculoPumpId: number | null;
  vinculoFator: number | null;
  limiteDiario: number | null;
  precisaoTeste: number | null;
}

@Component({
  selector: 'app-produtos',
  templateUrl: './produtos.page.html',
  imports: [
    CommonModule,
    FormsModule,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonTitle,
    IonToast,
    IonToggle,
    IonToolbar,
  ],
})
export class ProdutosPage {
  readonly identities = IDENTITY_ORDER.map((value) => ({ value, label: IDENTITIES[value].label }));
  readonly params = MEASURED_PARAMS;
  readonly info = IDENTITIES;
  bombs: BombConfig[] = [];
  data: DosingData | null = null;
  forms: PumpForm[] = [];
  luzLiga = '';
  luzDesliga = '';
  variacaoPercent = 30;
  loading = false;
  saving = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;

  constructor(
    private readonly doser: DoserService,
    private readonly notifications: DoseNotificationsService,
  ) {}

  async ionViewWillEnter(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      this.bombs = await firstValueFrom(this.doser.getConfig());
      this.data = await firstValueFrom(this.doser.getDosingData(this.bombs.map((bomb) => bomb.id)));
      this.forms = this.data.pumps.map((profile) => this.toForm(profile));
      this.luzLiga = this.data.tank.fotoperiodo?.liga ?? '';
      this.luzDesliga = this.data.tank.fotoperiodo?.desliga ?? '';
      this.variacaoPercent = Math.round(this.data.tank.regras.variacaoMaxCiclo * 100);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar os produtos.';
    } finally {
      this.loading = false;
    }
  }

  paramLabel(param: MeasuredParam): string {
    return `${IDENTITIES[param].label} (${IDENTITIES[param].unit})`;
  }

  unitOf(form: PumpForm): string {
    return IDENTITIES[form.identidade].unit || 'unid.';
  }

  isMeasured(form: PumpForm): boolean {
    return IDENTITIES[form.identidade].measured;
  }

  hasPotency(form: PumpForm): boolean {
    return form.identidade !== 'Carbono' && form.identidade !== 'Outro' && form.identidade !== 'Nenhuma';
  }

  linkOptions(form: PumpForm): PumpForm[] {
    return this.forms.filter((other) => other.pumpId !== form.pumpId);
  }

  async save(): Promise<void> {
    if (!this.data) return;
    this.saving = true;
    this.errorMessage = '';
    try {
      const data: DosingData = {
        ...this.data,
        tank: {
          ...this.data.tank,
          fotoperiodo: this.luzLiga && this.luzDesliga ? { liga: this.luzLiga, desliga: this.luzDesliga } : null,
          regras: { ...this.data.tank.regras, variacaoMaxCiclo: Math.max(0, Number(this.variacaoPercent) || 0) / 100 },
        },
        pumps: this.forms.map((form) => this.toProfile(form)),
      };
      await firstValueFrom(this.doser.saveDosingData(data));
      this.data = data;
      await this.notifications.sync(this.bombs, data);
      this.toastMessage = 'Produtos salvos.';
      this.toastOpen = true;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar os produtos.';
    } finally {
      this.saving = false;
    }
  }

  private toForm(profile: PumpProfile): PumpForm {
    const bomb = this.bombs.find((item) => item.id === profile.pumpId);
    return {
      pumpId: profile.pumpId,
      nome: bomb?.name || `Bomba ${profile.pumpId}`,
      identidade: profile.identidade,
      produto: profile.produto,
      doseMl: profile.potencia?.doseMl ?? null,
      porLitros: profile.potencia?.porLitros ?? null,
      eleva: profile.potencia?.eleva ?? null,
      vinculoPumpId: profile.vinculo?.pumpId ?? null,
      vinculoFator: profile.vinculo?.fator ?? null,
      limiteDiario: profile.limiteDiario,
      precisaoTeste: profile.precisaoTeste,
    };
  }

  private toProfile(form: PumpForm): PumpProfile {
    const positive = (value: number | null) => (value !== null && Number(value) > 0 ? Number(value) : null);
    const doseMl = positive(form.doseMl);
    const porLitros = positive(form.porLitros);
    const eleva = positive(form.eleva);
    const linkPump = positive(form.vinculoPumpId);
    const linkFactor = positive(form.vinculoFator);
    return {
      pumpId: form.pumpId,
      identidade: form.identidade,
      produto: form.produto.trim(),
      potencia: this.hasPotency(form) && doseMl && porLitros && eleva ? { doseMl, porLitros, eleva } : null,
      vinculo: linkPump && linkFactor && linkPump !== form.pumpId ? { pumpId: linkPump, fator: linkFactor } : null,
      limiteDiario: positive(form.limiteDiario),
      precisaoTeste: positive(form.precisaoTeste),
    };
  }
}
