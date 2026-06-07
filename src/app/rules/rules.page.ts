import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { addIcons } from 'ionicons';
import {
  add,
  closeOutline,
  createOutline,
  flashOutline,
  trashOutline,
} from 'ionicons/icons';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { DoserService, RelayRule, RuleAction } from '../services/doser.service';

@Component({
  selector: 'app-rules',
  templateUrl: './rules.page.html',
  styleUrls: ['./rules.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonInput,
    IonItem,
    IonModal,
    IonSelect,
    IonSelectOption,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
})
export class RulesPage {
  rules: RelayRule[] = [];
  loading = false;
  saving = false;
  errorMessage = '';
  toastMessage = '';
  toastOpen = false;

  modalOpen = false;
  editingIndex: number | null = null; // null = nova regra
  draft: RelayRule = this.emptyRule();

  readonly pumpOptions = [1, 2, 3, 4];
  readonly relayOptions = [1, 2, 3, 4];

  constructor(private readonly doser: DoserService) {
    addIcons({ add, closeOutline, createOutline, flashOutline, trashOutline });
  }

  ionViewWillEnter(): void {
    void this.loadRules();
  }

  async loadRules(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    try {
      this.rules = await firstValueFrom(this.doser.getRules());
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao carregar as regras.';
    } finally {
      this.loading = false;
    }
  }

  openCreate(): void {
    this.editingIndex = null;
    this.draft = this.emptyRule();
    this.errorMessage = '';
    this.modalOpen = true;
  }

  openEdit(index: number): void {
    this.editingIndex = index;
    this.draft = this.cloneRule(this.rules[index]);
    this.errorMessage = '';
    this.modalOpen = true;
  }

  closeModal(): void {
    this.modalOpen = false;
  }

  addAction(): void {
    if (this.draft.actions.length >= 4) return;
    this.draft.actions.push({ targetRelay: 1, turnOff: true, durationSec: 600 });
  }

  removeAction(index: number): void {
    this.draft.actions.splice(index, 1);
  }

  durationMin(action: RuleAction): number {
    return Math.round(action.durationSec / 60);
  }

  setDurationMin(action: RuleAction, minutes: number | string): void {
    const value = Number(minutes);
    action.durationSec = Number.isFinite(value) && value > 0 ? Math.round(value * 60) : 0;
  }

  actionSummary(action: RuleAction): string {
    const verb = action.turnOff ? 'Desligar' : 'Ligar';
    const duration = action.durationSec > 0 ? ` por ${this.durationMin(action)} min` : '';
    return `Rele ${action.targetRelay}: ${verb}${duration}`;
  }

  async saveDraft(): Promise<void> {
    const draft = this.cloneRule(this.draft);
    draft.name = draft.name?.trim() || `Regra ${this.rules.length + 1}`;
    if (!draft.actions.length) {
      this.errorMessage = 'Adicione ao menos uma acao.';
      return;
    }

    const next = [...this.rules];
    if (this.editingIndex === null) {
      next.push(draft);
    } else {
      next[this.editingIndex] = draft;
    }
    await this.persist(next, 'Regra salva.');
  }

  async toggleEnabled(index: number): Promise<void> {
    const next = this.rules.map((rule, i) => (i === index ? { ...rule, enabled: !rule.enabled } : rule));
    await this.persist(next, next[index].enabled ? 'Regra ativada.' : 'Regra desativada.');
  }

  async deleteRule(index: number): Promise<void> {
    const next = this.rules.filter((_, i) => i !== index);
    await this.persist(next, 'Regra excluida.');
  }

  private async persist(next: RelayRule[], successMessage: string): Promise<void> {
    this.saving = true;
    this.errorMessage = '';
    try {
      await firstValueFrom(this.doser.saveRules(next));
      this.rules = next;
      this.toastMessage = successMessage;
      this.toastOpen = true;
      this.modalOpen = false;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Falha ao salvar as regras.';
    } finally {
      this.saving = false;
    }
  }

  private emptyRule(): RelayRule {
    return {
      name: '',
      triggerPumpId: 1,
      enabled: true,
      actions: [{ targetRelay: 1, turnOff: true, durationSec: 600 }],
    };
  }

  private cloneRule(rule: RelayRule): RelayRule {
    return {
      name: rule.name,
      triggerPumpId: rule.triggerPumpId,
      enabled: rule.enabled,
      actions: rule.actions.map((action) => ({ ...action })),
    };
  }
}
