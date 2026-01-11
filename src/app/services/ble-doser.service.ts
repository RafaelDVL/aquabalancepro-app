import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const TIME_CHARACTERISTIC_UUID = 'abcd1234-5678-90ab-cdef-1234567890ab';
const CONFIG_CHARACTERISTIC_UUID = 'dcba4321-8765-4321-abcd-0987654321ef';
const TEST_CHARACTERISTIC_UUID = 'efab4321-8765-4321-abcd-0987654321ff';

const DEFAULT_BOMBS = Array.from({ length: 3 }, (_, index) => ({
  id: index + 1,
  name: `Bomba ${index + 1}`,
  hour: 0,
  minute: 0,
  dosagem: 0.5,
  status: false,
  calibrCoef: 1,
  quantidadeEstoque: 0,
  diasSemana: Array.from({ length: 7 }, () => false),
}));

export interface BombConfig {
  id: number;
  name: string;
  hour: number;
  minute: number;
  dosagem: number;
  status: boolean;
  calibrCoef: number;
  quantidadeEstoque: number;
  diasSemana: boolean[];
}

export interface DeviceStatus {
  time?: string;
  wifiConnected?: boolean;
  wifiRssi?: number;
  firebaseReady?: boolean;
  lastUpdated?: Date;
}

export interface ConnectedDevice {
  id: string;
  name?: string;
}

@Injectable({ providedIn: 'root' })
export class BleDoserService {
  readonly device$ = new BehaviorSubject<ConnectedDevice | null>(null);
  readonly status$ = new BehaviorSubject<DeviceStatus>({});
  readonly config$ = new BehaviorSubject<BombConfig[]>([...DEFAULT_BOMBS]);
  readonly isConnected$ = new BehaviorSubject<boolean>(false);

  private device?: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private service?: BluetoothRemoteGATTService;
  private timeCharacteristic?: BluetoothRemoteGATTCharacteristic;
  private configCharacteristic?: BluetoothRemoteGATTCharacteristic;
  private testCharacteristic?: BluetoothRemoteGATTCharacteristic;
  private configReceiving = false;
  private configBuffer = '';
  private pendingConfigResolve?: (config: BombConfig[]) => void;
  private pendingConfigReject?: (error: Error) => void;
  private configListenerAttached = false;
  private timeListenerAttached = false;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  async requestDevice(): Promise<void> {
    if (!('bluetooth' in navigator)) {
      throw new Error('Bluetooth nao esta disponivel neste dispositivo.');
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this.isConnected$.next(false);
      this.status$.next({});
    });

    await this.connect();
  }

  async connect(): Promise<void> {
    if (!this.device) {
      throw new Error('Nenhum dispositivo selecionado.');
    }

    this.server = await this.device.gatt?.connect();
    if (!this.server) {
      throw new Error('Falha ao conectar no GATT.');
    }

    this.service = await this.server.getPrimaryService(SERVICE_UUID);
    this.timeCharacteristic = await this.service.getCharacteristic(TIME_CHARACTERISTIC_UUID);
    this.configCharacteristic = await this.service.getCharacteristic(CONFIG_CHARACTERISTIC_UUID);
    this.testCharacteristic = await this.service.getCharacteristic(TEST_CHARACTERISTIC_UUID);

    this.device$.next({ id: this.device.id, name: this.device.name || 'ESP32 Aquario' });
    this.isConnected$.next(true);

    await this.startStatusNotifications();
    await this.startConfigNotifications();
  }

  async disconnect(): Promise<void> {
    if (this.server?.connected) {
      this.server.disconnect();
    }
    this.isConnected$.next(false);
    this.status$.next({});
  }

  async syncTime(date: Date = new Date()): Promise<void> {
    if (!this.timeCharacteristic) {
      throw new Error('Caracteristica de tempo nao disponivel.');
    }
    const payload = this.formatDateTime(date);
    await this.timeCharacteristic.writeValue(this.encoder.encode(payload));
  }

  async fetchConfig(): Promise<BombConfig[]> {
    if (!this.configCharacteristic) {
      throw new Error('Caracteristica de configuracao nao disponivel.');
    }

    const config = await this.readConfigViaChunks();
    this.config$.next(config);
    return config;
  }

  async saveConfig(bombs: BombConfig[]): Promise<void> {
    if (!this.configCharacteristic) {
      throw new Error('Caracteristica de configuracao nao disponivel.');
    }

    const json = this.buildConfigJson(bombs);
    await this.sendConfigViaChunks(json);
    this.config$.next(bombs);
  }

  async testDose(bombaIndex: number, dosagem: number): Promise<void> {
    if (!this.testCharacteristic) {
      throw new Error('Caracteristica de teste nao disponivel.');
    }

    const payload = JSON.stringify({ bomb: bombaIndex, dosagem });
    await this.testCharacteristic.writeValue(this.encoder.encode(payload));
  }

  private async startStatusNotifications(): Promise<void> {
    if (!this.timeCharacteristic || this.timeListenerAttached) {
      return;
    }

    await this.timeCharacteristic.startNotifications();
    this.timeCharacteristic.addEventListener('characteristicvaluechanged', (event: Event) => {
      const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
      if (!characteristic?.value) {
        return;
      }
      const payload = this.decoder.decode(characteristic.value.buffer.slice(
        characteristic.value.byteOffset,
        characteristic.value.byteOffset + characteristic.value.byteLength,
      ));
      this.handleStatusPayload(payload);
    });
    this.timeListenerAttached = true;
  }

  private async startConfigNotifications(): Promise<void> {
    if (!this.configCharacteristic || this.configListenerAttached) {
      return;
    }

    await this.configCharacteristic.startNotifications();
    this.configCharacteristic.addEventListener('characteristicvaluechanged', (event: Event) => {
      const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
      if (!characteristic?.value) {
        return;
      }
      const payload = this.decoder.decode(characteristic.value.buffer.slice(
        characteristic.value.byteOffset,
        characteristic.value.byteOffset + characteristic.value.byteLength,
      ));
      this.handleConfigChunk(payload);
    });
    this.configListenerAttached = true;
  }

  private handleStatusPayload(payload: string): void {
    try {
      const data = JSON.parse(payload) as {
        time?: string;
        wifi?: { connected?: boolean; rssi?: number };
        firebase?: { ready?: boolean };
      };
      this.status$.next({
        time: data.time,
        wifiConnected: data.wifi?.connected ?? false,
        wifiRssi: data.wifi?.rssi,
        firebaseReady: data.firebase?.ready ?? false,
        lastUpdated: new Date(),
      });
    } catch {
      // Ignore malformed payloads.
    }
  }

  private async readConfigViaChunks(): Promise<BombConfig[]> {
    if (!this.configCharacteristic) {
      throw new Error('Caracteristica de configuracao nao disponivel.');
    }

    const pending = new Promise<BombConfig[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingConfigReject) {
          this.pendingConfigReject(new Error('Tempo esgotado ao ler configuracao.'));
        }
        this.pendingConfigResolve = undefined;
        this.pendingConfigReject = undefined;
        this.configReceiving = false;
        this.configBuffer = '';
      }, 6000);

      this.pendingConfigResolve = (config) => {
        clearTimeout(timeoutId);
        resolve(config);
      };
      this.pendingConfigReject = (error) => {
        clearTimeout(timeoutId);
        reject(error);
      };
    });

    await this.configCharacteristic.writeValue(this.encoder.encode('CFG_GET'));

    return pending;
  }

  private async sendConfigViaChunks(payload: string): Promise<void> {
    if (!this.configCharacteristic) {
      throw new Error('Caracteristica de configuracao nao disponivel.');
    }

    await this.configCharacteristic.writeValue(this.encoder.encode('CFG_START'));
    for (let i = 0; i < payload.length; i += 20) {
      const chunk = payload.slice(i, i + 20);
      await this.configCharacteristic.writeValue(this.encoder.encode(chunk));
      await this.sleep(15);
    }
    await this.configCharacteristic.writeValue(this.encoder.encode('CFG_END'));
  }

  private handleConfigChunk(chunk: string): void {
    if (chunk === 'CFG_START') {
      this.configReceiving = true;
      this.configBuffer = '';
      return;
    }

    if (chunk === 'CFG_END') {
      this.configReceiving = false;
      const config = this.parseConfigJson(this.configBuffer);
      if (this.pendingConfigResolve) {
        this.pendingConfigResolve(config);
        this.pendingConfigResolve = undefined;
        this.pendingConfigReject = undefined;
      }
      return;
    }

    if (this.configReceiving) {
      this.configBuffer += chunk;
      return;
    }
  }

  private parseConfigJson(payload: string): BombConfig[] {
    try {
      const data = JSON.parse(payload) as Record<string, any>;
      return [1, 2, 3].map((index) => {
        const key = `bomb${index}`;
        const item = data[key] ?? {};
        const time = item.time ?? {};
        const dias = Array.isArray(item.diasSemanaSelecionados) ? item.diasSemanaSelecionados : [];
        return {
          id: index,
          name: item.name ?? `Bomba ${index}`,
          hour: Number(time.hour ?? 0),
          minute: Number(time.minute ?? 0),
          dosagem: Number(item.dosagem ?? 0),
          status: Boolean(item.status),
          calibrCoef: Number(item.calibrCoef ?? 1),
          quantidadeEstoque: Number(item.quantidadeEstoque ?? 0),
          diasSemana: Array.from({ length: 7 }, (_, day) => Boolean(dias[day])),
        };
      });
    } catch {
      return [...DEFAULT_BOMBS];
    }
  }

  private buildConfigJson(bombs: BombConfig[]): string {
    const payload: Record<string, unknown> = {};
    bombs.forEach((bomb, index) => {
      payload[`bomb${index + 1}`] = {
        time: { hour: bomb.hour, minute: bomb.minute },
        dosagem: Number(bomb.dosagem),
        status: Boolean(bomb.status),
        calibrCoef: Number(bomb.calibrCoef),
        name: bomb.name || `Bomba ${index + 1}`,
        quantidadeEstoque: Number(bomb.quantidadeEstoque ?? 0),
        diasSemanaSelecionados: Array.from({ length: 7 }, (_, day) => Boolean(bomb.diasSemana?.[day])),
      };
    });
    return JSON.stringify(payload);
  }

  private formatDateTime(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
