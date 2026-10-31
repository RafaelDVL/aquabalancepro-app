// Depuração do app no celular pelo cabo USB (mesmo protocolo do chrome://inspect).
// Mostra console (com objetos completos), erros e requisições ao ESP32.
//
//   node scripts/phone-debug.mjs                 acompanha até Ctrl+C
//   node scripts/phone-debug.mjs --seconds 20    acompanha por 20 s
//   node scripts/phone-debug.mjs --reload        recarrega o app para pegar a inicialização
//   node scripts/phone-debug.mjs --eval "location.href"
//
// Precisa do build de debug instalado (WebView depurável) e da depuração USB ligada.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = 'com.aquabalancepro.app';
const PORT = 9222;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const seconds = Number(option('--seconds') ?? 0);
const evalExpr = option('--eval');
const reload = args.includes('--reload');

function findAdb() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
  const candidate = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  return existsSync(candidate) ? candidate : 'adb';
}

const adb = findAdb();
const run = (...params) => execFileSync(adb, params, { encoding: 'utf8' }).trim();

const pid = run('shell', 'pidof', PACKAGE);
if (!pid) {
  console.error(`App ${PACKAGE} não está aberto no celular.`);
  process.exit(1);
}
run('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
const pages = await (await fetch(`http://localhost:${PORT}/json`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) {
  console.error('WebView do app não encontrado.');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const requests = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const time = () => new Date().toLocaleTimeString('pt-BR');
const isLocalAsset = (url) => url.startsWith('http://localhost/') || url.startsWith('data:');

async function describe(arg) {
  if (arg.type === 'string') return arg.value;
  if (arg.value !== undefined || arg.type === 'undefined') return String(arg.value);
  if (!arg.objectId) return arg.description ?? arg.type;
  try {
    const { result } = await send('Runtime.callFunctionOn', {
      objectId: arg.objectId,
      functionDeclaration:
        'function () { if (this instanceof Error) return this.stack || String(this); try { return JSON.stringify(this, null, 2); } catch { return String(this); } }',
      returnByValue: true,
    });
    return result.value ?? arg.description;
  } catch {
    return arg.description ?? arg.type;
  }
}

async function handle(method, params) {
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const text = (await Promise.all(params.args.map(describe))).join(' ');
      console.log(`${time()} [console.${params.type}] ${text}`);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const details = params.exceptionDetails;
      console.log(`${time()} [ERRO] ${details.exception?.description ?? details.text}`);
      break;
    }
    case 'Log.entryAdded':
      console.log(`${time()} [${params.entry.level}] ${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
      break;
    case 'Network.requestWillBeSent':
      if (!isLocalAsset(params.request.url)) {
        requests.set(params.requestId, { url: params.request.url, method: params.request.method, start: Date.now() });
      }
      break;
    case 'Network.responseReceived': {
      const request = requests.get(params.requestId);
      if (request) request.status = params.response.status;
      break;
    }
    case 'Network.loadingFinished': {
      const request = requests.get(params.requestId);
      if (!request) break;
      requests.delete(params.requestId);
      console.log(`${time()} [rede] ${request.method} ${request.url} → ${request.status} (${Date.now() - request.start} ms)`);
      break;
    }
    case 'Network.loadingFailed': {
      const request = requests.get(params.requestId);
      if (!request) break;
      requests.delete(params.requestId);
      console.log(`${time()} [rede] ${request.method} ${request.url} → FALHOU: ${params.errorText} (${Date.now() - request.start} ms)`);
      break;
    }
  }
}

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    return;
  }
  if (message.method) void handle(message.method, message.params);
});

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
console.log(`${time()} Conectado: ${page.url}`);

if (evalExpr) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: evalExpr, awaitPromise: true, returnByValue: true });
  console.log(exceptionDetails ? `ERRO: ${exceptionDetails.exception?.description}` : JSON.stringify(result.value, null, 2));
  ws.close();
  process.exit(0);
}

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
if (reload) await send('Page.reload');

if (seconds > 0) {
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, seconds * 1000);
}
