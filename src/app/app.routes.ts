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
    path: 'ajuste',
    loadComponent: () => import('./ajuste/ajuste.page').then((m) => m.AjustePage),
  },
  {
    path: 'produtos',
    loadComponent: () => import('./produtos/produtos.page').then((m) => m.ProdutosPage),
  },
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
];
