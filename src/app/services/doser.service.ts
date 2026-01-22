import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';

export interface ScheduleConfig {
  id: number;
  hour: number;
  minute: number;
  dosagem: number;
  status: boolean;
  diasSemana: boolean[];
}

export interface BombConfig {
  id: number;
  name: string;
  calibrCoef: number;
  quantidadeEstoque: number;
  schedules: ScheduleConfig[];
}

export interface DeviceStatus {
  time?: string;
  wifiConnected?: boolean;
  wifiRssi?: number;
  wifiIp?: string;
  apSsid?: string;
  apIp?: string;
  firebaseReady?: boolean;
}

export interface ApiStatusResponse {
  ok: boolean;
  message?: string;
}

export interface LogEntry {
  timestamp: string;
  bomba: string;
  dosagem: number;
  origem: string;
}

interface RawStatus {
  time?: string;
  wifi?: { connected?: boolean; rssi?: number; ip?: string };
  ap?: { ssid?: string; ip?: string };
  firebase?: { ready?: boolean };
}

interface RawSchedule {
  id?: number;
  time?: { hour?: number; minute?: number };
  dosagem?: number;
  status?: boolean;
  diasSemanaSelecionados?: boolean[];
}

interface RawBomb {
  name?: string;
  calibrCoef?: number;
  quantidadeEstoque?: number;
  schedules?: RawSchedule[];
  time?: { hour?: number; minute?: number };
  dosagem?: number;
  status?: boolean;
  diasSemanaSelecionados?: boolean[];
}

type RawConfig = Record<string, RawBomb>;

@Injectable({ providedIn: 'root' })
export class DoserService {
  private readonly apiUrl = 'http://192.168.4.1';
  private readonly scheduleCount = 3;
  private readonly plainJsonHeaders = new HttpHeaders({
    'Content-Type': 'text/plain',
  });

  constructor(private readonly http: HttpClient) {}

  getStatus(): Observable<DeviceStatus> {
    return this.http.get<RawStatus>(`${this.apiUrl}/status`).pipe(
      map((raw) => ({
        time: raw.time,
        wifiConnected: raw.wifi?.connected ?? false,
        wifiRssi: raw.wifi?.rssi,
        wifiIp: raw.wifi?.ip,
        apSsid: raw.ap?.ssid,
        apIp: raw.ap?.ip,
        firebaseReady: raw.firebase?.ready ?? false,
      })),
    );
  }

  getConfig(): Observable<BombConfig[]> {
    return this.http.get<RawConfig>(`${this.apiUrl}/config`).pipe(
      map((raw) => this.mapBombs(raw)),
    );
  }

  saveConfig(bombs: BombConfig[]): Observable<ApiStatusResponse> {
    const payload = this.buildConfigPayload(bombs);
    return this.http.post<ApiStatusResponse>(
      `${this.apiUrl}/config`,
      JSON.stringify(payload),
      { headers: this.plainJsonHeaders },
    );
  }

  setTime(date: Date): Observable<ApiStatusResponse> {
    return this.http.post<ApiStatusResponse>(
      `${this.apiUrl}/time`,
      JSON.stringify({ time: this.formatDateTime(date) }),
      { headers: this.plainJsonHeaders },
    );
  }

  testDose(bombId: number, dosagem: number, origem?: string): Observable<ApiStatusResponse> {
    return this.http.post<ApiStatusResponse>(
      `${this.apiUrl}/dose`,
      JSON.stringify({ bomb: bombId, dosagem, origem }),
      { headers: this.plainJsonHeaders },
    );
  }

  getLogs(): Observable<LogEntry[]> {
    return this.http.get<LogEntry[] | { logs?: LogEntry[] }>(`${this.apiUrl}/logs`).pipe(
      map((response) => {
        if (Array.isArray(response)) {
          return response;
        }
        if (response && Array.isArray(response.logs)) {
          return response.logs;
        }
        return [];
      }),
    );
  }

  clearLogs(): Observable<ApiStatusResponse> {
    return this.http.delete<ApiStatusResponse>(`${this.apiUrl}/logs`);
  }

  private mapBombs(raw: RawConfig): BombConfig[] {
    return [1, 2, 3].map((id) => {
      const key = `bomb${id}`;
      const bomb = raw?.[key] ?? {};
      const legacySchedule: RawSchedule = {
        time: bomb.time,
        dosagem: bomb.dosagem,
        status: bomb.status,
        diasSemanaSelecionados: bomb.diasSemanaSelecionados,
      };

      const rawSchedules = bomb.schedules?.length ? bomb.schedules : [legacySchedule];
      const schedules = Array.from({ length: this.scheduleCount }, (_, index) =>
        this.toSchedule(rawSchedules[index], index),
      );

      return {
        id,
        name: bomb.name ?? `Bomba ${id}`,
        calibrCoef: Number(bomb.calibrCoef ?? 1),
        quantidadeEstoque: Number(bomb.quantidadeEstoque ?? 0),
        schedules,
      };
    });
  }

  private toSchedule(raw: RawSchedule | undefined, index: number): ScheduleConfig {
    const time = raw?.time ?? {};
    const dias = raw?.diasSemanaSelecionados ?? [];
    return {
      id: raw?.id ?? index + 1,
      hour: Number(time.hour ?? 0),
      minute: Number(time.minute ?? 0),
      dosagem: Number(raw?.dosagem ?? 0.5),
      status: Boolean(raw?.status ?? false),
      diasSemana: Array.from({ length: 7 }, (_, day) => Boolean(dias[day])),
    };
  }

  private buildConfigPayload(bombs: BombConfig[]): RawConfig {
    const payload: RawConfig = {};

    bombs.forEach((bomb, index) => {
      payload[`bomb${index + 1}`] = {
        name: bomb.name,
        calibrCoef: bomb.calibrCoef,
        quantidadeEstoque: bomb.quantidadeEstoque,
        schedules: bomb.schedules.map((schedule, scheduleIndex) => ({
          id: scheduleIndex + 1,
          time: { hour: schedule.hour, minute: schedule.minute },
          dosagem: schedule.dosagem,
          status: schedule.status,
          diasSemanaSelecionados: Array.from({ length: 7 }, (_, day) =>
            Boolean(schedule.diasSemana?.[day]),
          ),
        })),
      };
    });

    return payload;
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
}
