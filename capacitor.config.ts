import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aquabalancepro.app',
  appName: 'AquaBalancePro',
  webDir: 'www',
  server: {
    androidScheme: 'http'
  }
};

export default config;
