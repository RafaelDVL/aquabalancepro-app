import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications, LocalNotificationSchema } from '@capacitor/local-notifications';
import { BombConfig } from './doser.service';
import { isScheduleActive } from './dosing-advisor';
import { DosingData, IDENTITIES, openSession } from './dosing.models';

const CHANNEL_ID = 'doses';
// Faixas de id: 1000–1999 doses (bomba × horário × dia), 9000 lembrete de teste
const DOSE_ID_BASE = 1000;
const DOSE_ID_MAX = 1999;
const TEST_REMINDER_ID = 9000;

/** Agenda no próprio celular avisos das doses programadas e do lembrete de teste. */
@Injectable({ providedIn: 'root' })
export class DoseNotificationsService {
  private channelReady = false;

  get supported(): boolean {
    return Capacitor.getPlatform() === 'android';
  }

  async sync(bombs: BombConfig[], data: DosingData): Promise<void> {
    if (!this.supported) return;
    try {
      const permission = await LocalNotifications.checkPermissions();
      const display =
        permission.display === 'granted' ? 'granted' : (await LocalNotifications.requestPermissions()).display;
      if (display !== 'granted') return;

      await this.ensureChannel();
      await this.cancelOwn();

      const notifications = [
        ...(data.tank.notificarDoses ? this.doseNotifications(bombs, data) : []),
        ...this.testReminder(data),
      ];
      if (notifications.length) {
        await LocalNotifications.schedule({ notifications });
      }
    } catch (error) {
      console.warn('[notificacoes] Falha ao agendar', error);
    }
  }

  private doseNotifications(bombs: BombConfig[], data: DosingData): LocalNotificationSchema[] {
    const result: LocalNotificationSchema[] = [];
    for (const bomb of bombs) {
      const profile = data.pumps.find((pump) => pump.pumpId === bomb.id);
      const name = bomb.name || `Bomba ${bomb.id}`;
      const label =
        profile && profile.identidade !== 'Nenhuma' ? `${IDENTITIES[profile.identidade].short} (${name})` : name;

      bomb.schedules.forEach((schedule, scheduleIndex) => {
        if (!isScheduleActive(schedule)) return;
        schedule.diasSemana.forEach((active, day) => {
          if (!active) return;
          const id = DOSE_ID_BASE + bomb.id * 100 + scheduleIndex * 10 + day;
          if (id > DOSE_ID_MAX) return;
          result.push({
            id,
            channelId: CHANNEL_ID,
            title: 'Dosagem programada',
            body: `${label}: ${schedule.dosagem.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} ml`,
            // Weekday do Capacitor: 1 = domingo … 7 = sábado; diasSemana: 0 = domingo
            schedule: { on: { weekday: day + 1, hour: schedule.hour, minute: schedule.minute }, allowWhileIdle: true },
          });
        });
      });
    }
    return result;
  }

  private testReminder(data: DosingData): LocalNotificationSchema[] {
    const session = openSession(data);
    if (!session) return [];
    const at = new Date(new Date(session.inicio).getTime() + session.diasPlanejados * 24 * 60 * 60 * 1000);
    if (at.getTime() <= Date.now()) return [];
    return [
      {
        id: TEST_REMINDER_ID,
        channelId: CHANNEL_ID,
        title: 'Hora de medir KH e Ca',
        body: `O teste de ${session.diasPlanejados} dias terminou. Abra o Ajuste de Dosagem para calcular as novas doses.`,
        schedule: { at, allowWhileIdle: true },
      },
    ];
  }

  private async ensureChannel(): Promise<void> {
    if (this.channelReady) return;
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Doses e testes',
      description: 'Avisos das dosagens programadas e lembretes de teste',
      importance: 4,
    });
    this.channelReady = true;
  }

  private async cancelOwn(): Promise<void> {
    const pending = await LocalNotifications.getPending();
    const own = pending.notifications.filter(
      (item) => (item.id >= DOSE_ID_BASE && item.id <= DOSE_ID_MAX) || item.id === TEST_REMINDER_ID,
    );
    if (own.length) {
      await LocalNotifications.cancel({ notifications: own.map((item) => ({ id: item.id })) });
    }
  }
}
