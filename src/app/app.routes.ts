import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    path: 'configuracao',
    loadComponent: () =>
      import('./configuracao/configuracao.page').then((m) => m.ConfiguracaoPage),
  },
  {
    path: 'calibracao',
    loadComponent: () =>
      import('./calibracao/calibracao.page').then((m) => m.CalibracaoPage),
  },
  {
    path: 'logs',
    loadComponent: () => import('./logs/logs.page').then((m) => m.LogsPage),
  },
  {
    path: 'analytics',
    loadComponent: () => import('./analytics/analytics.page').then((m) => m.AnalyticsPage),
  },
  {
    path: 'relays',
    loadComponent: () => import('./relays/relays.page').then((m) => m.RelaysPage),
  },
  {
    path: 'rules',
    loadComponent: () => import('./rules/rules.page').then((m) => m.RulesPage),
  },
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
];
