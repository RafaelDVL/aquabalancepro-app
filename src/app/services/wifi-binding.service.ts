import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

interface WifiBindingPlugin {
  bindToWifi(options?: { ssid?: string }): Promise<{ ok: boolean; ssid?: string }>;
  clearBinding(): Promise<{ ok: boolean }>;
}

const WifiBinding = registerPlugin<WifiBindingPlugin>('WifiBinding');

@Injectable({ providedIn: 'root' })
export class WifiBindingService {
  private lastAttempt = 0;
  private readonly throttleMs = 4000;

  async bindToWifi(ssid?: string): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') {
      return;
    }
    const now = Date.now();
    if (now - this.lastAttempt < this.throttleMs) {
      return;
    }
    this.lastAttempt = now;
    try {
      await WifiBinding.bindToWifi(ssid ? { ssid } : undefined);
    } catch {
      // ignora falhas de bind (ex: sem permissao ou wifi off)
    }
  }

  async clearBinding(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') {
      return;
    }
    try {
      await WifiBinding.clearBinding();
    } catch {
      // ignore
    }
  }
}
