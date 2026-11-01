// Versão de PC: abre o app compilado (www/) numa janela própria.
//
// O app é servido por um servidor HTTP local em vez de file://, porque o roteador do Angular usa caminhos
// (/home, /logs...) e porque é assim que ele já roda no navegador: uma página em http://127.0.0.1 pode chamar
// o ESP32 em http://192.168.4.1 sem bloqueio de conteúdo misto.
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Porta fixa: o localStorage (cores das bombas, última conferência) é guardado por origem, e a origem inclui a porta.
const PORT = 47890;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WWW = app.isPackaged ? path.join(process.resourcesPath, 'www') : path.join(__dirname, '..', 'www');
const ICON = path.join(__dirname, '..', 'assets', 'logo.png');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let win = null;

function serveFile(res, file) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function handleRequest(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  const file = path.resolve(WWW, '.' + urlPath);
  if (!file.startsWith(WWW + path.sep) && file !== WWW) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (!err && stat.isFile()) {
      serveFile(res, file);
    } else if (!path.extname(urlPath)) {
      // Rota do Angular (/configuracao, /logs...): devolve o index.html e o roteador resolve.
      serveFile(res, path.join(WWW, 'index.html'));
    } else {
      res.writeHead(404).end();
    }
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 380,
    minHeight: 600,
    title: 'AquaBalancePro',
    backgroundColor: '#05161a',
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  // Links externos abrem no navegador do sistema, não dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(ORIGIN);
  win.on('closed', () => (win = null));
}

// Uma instância só: a segunda chamada traz a janela aberta para a frente (e a porta já estaria em uso).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    if (!fs.existsSync(path.join(WWW, 'index.html'))) {
      dialog.showErrorBox('AquaBalancePro', `App não encontrado em ${WWW}.\nRode "npm run build" antes.`);
      app.quit();
      return;
    }
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('AquaBalancePro', `Não foi possível abrir a porta ${PORT}: ${err.message}`);
      app.quit();
      return;
    }
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
