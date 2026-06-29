import { parseArgs } from 'https://deno.land/std@0.217.0/cli/parse_args.ts';
import { dirname, fromFileUrl, join, normalize } from 'https://deno.land/std@0.217.0/path/mod.ts';
import { open } from 'https://deno.land/x/open@v0.0.6/index.ts';
import { readChunks } from './read.ts';
import log from './log.ts';
import { render } from './markdownit.ts';

const __args = parseArgs(Deno.args);
const __dirname = dirname(new URL(import.meta.url).pathname);

const DENO_ENV = Deno.env.get('DENO_ENV');

const logger = log.setupLogger();
const version = Deno.version;

logger.info(`DENO_ENV: ${DENO_ENV}`, ...Deno.args);
logger.info(`deno: ${version.deno} v8: ${version.v8} typescript: ${version.typescript}`);

type SourceId = string;

type PreviewState = {
  id: SourceId;
  label: string;
  html: string;
  lcount: number;
  line?: string;
  base?: string;
};

type PreviewMessage =
  | { action: 'show'; html: string; lcount: number; sourceId?: SourceId }
  | { action: 'scroll'; line: string; sourceId?: SourceId }
  | { action: 'base'; base: string; sourceId?: SourceId }
  | { action: 'label'; label: string; sourceId?: SourceId }
  | { action: 'tabs'; tabs: PreviewState[]; activeId?: SourceId }
  | { action: 'registered'; sourceId: SourceId; label: string }
  | { action: 'activate'; sourceId: SourceId };

function describeMessage(message: PreviewMessage) {
  switch (message.action) {
    case 'show':
      return `show source=${
        message.sourceId || '-'
      } html=${message.html.length} lcount=${message.lcount}`;
    case 'scroll':
      return `scroll source=${message.sourceId || '-'} line=${message.line}`;
    case 'base':
      return `base source=${message.sourceId || '-'} base=${message.base}`;
    case 'label':
      return `label source=${message.sourceId || '-'} label=${message.label}`;
    case 'tabs':
      return `tabs count=${message.tabs.length} active=${message.activeId || '-'}`;
    case 'registered':
      return `registered source=${message.sourceId} label=${message.label}`;
    case 'activate':
      return `activate source=${message.sourceId}`;
  }
}

function send(socket: WebSocket, message: PreviewMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    logger.info(`ws send ${describeMessage(message)}`);
    socket.send(JSON.stringify(message));
  }
}

function sourceSnapshot(source: PreviewState): PreviewState {
  return { ...source };
}

function createHub() {
  let nextSourceNumber = 1;
  const viewers = new Set<WebSocket>();
  const viewerActiveIds = new Map<WebSocket, SourceId | undefined>();
  const sources = new Map<SourceId, PreviewState>();

  function defaultActiveId(activeId?: SourceId) {
    return activeId && sources.has(activeId) ? activeId : sources.keys().next().value;
  }

  function tabsMessage(activeId?: SourceId): PreviewMessage {
    return {
      action: 'tabs',
      tabs: Array.from(sources.values(), sourceSnapshot),
      activeId: defaultActiveId(activeId),
    };
  }

  function broadcast(message: PreviewMessage) {
    for (const viewer of viewers) send(viewer, message);
  }

  function broadcastTabs() {
    for (const viewer of viewers) {
      const activeId = defaultActiveId(viewerActiveIds.get(viewer));
      viewerActiveIds.set(viewer, activeId);
      send(viewer, tabsMessage(activeId));
    }
  }

  function registerSource() {
    const sourceNumber = nextSourceNumber++;
    const source: PreviewState = {
      id: crypto.randomUUID(),
      label: String(sourceNumber),
      html: '',
      lcount: 1,
    };

    sources.set(source.id, source);
    logger.info(
      `hub source registered id=${source.id} label=${source.label} total=${sources.size}`,
    );
    broadcastTabs();

    return source;
  }

  function unregisterSource(sourceId: SourceId) {
    if (!sources.delete(sourceId)) return;
    logger.info(`hub source unregistered id=${sourceId} total=${sources.size}`);
    broadcastTabs();
  }

  function updateSource(sourceId: SourceId, message: PreviewMessage) {
    const source = sources.get(sourceId);
    if (!source) return;

    switch (message.action) {
      case 'show':
        source.html = message.html;
        source.lcount = message.lcount;
        break;
      case 'scroll':
        source.line = message.line;
        break;
      case 'base':
        source.base = message.base;
        break;
      case 'label':
        source.label = message.label;
        break;
      default:
        return;
    }

    logger.info(`hub source update ${describeMessage({ ...message, sourceId })}`);
    if (message.action === 'label') {
      broadcastTabs();
    } else {
      broadcast({ ...message, sourceId });
    }
  }

  function addViewer(socket: WebSocket) {
    viewers.add(socket);
    viewerActiveIds.set(socket, defaultActiveId());
    logger.info(
      `hub viewer connected viewers=${viewers.size} active=${viewerActiveIds.get(socket) || '-'}`,
    );
    send(socket, tabsMessage(viewerActiveIds.get(socket)));

    socket.onmessage = (event) => {
      const data = parseSocketMessage(event.data);
      if (data?.action !== 'activate') return;
      if (!sources.has(data.sourceId)) return;
      viewerActiveIds.set(socket, data.sourceId);
      logger.info(`hub viewer activate source=${data.sourceId}`);
      send(socket, tabsMessage(data.sourceId));
    };

    socket.onclose = () => {
      viewers.delete(socket);
      viewerActiveIds.delete(socket);
      logger.info(`hub viewer disconnected viewers=${viewers.size}`);
    };
  }

  function addSource(socket: WebSocket) {
    const source = registerSource();
    send(socket, { action: 'registered', sourceId: source.id, label: source.label });

    socket.onmessage = (event) => {
      const data = parseSocketMessage(event.data);
      if (data) updateSource(source.id, data);
    };

    socket.onclose = () => {
      unregisterSource(source.id);
    };
  }

  return {
    registerSource,
    unregisterSource,
    updateSource,
    addViewer,
    addSource,
  };
}

function parseSocketMessage(data: string | ArrayBuffer | Blob): PreviewMessage | undefined {
  if (data instanceof ArrayBuffer) {
    data = new TextDecoder().decode(data);
  }

  if (typeof data !== 'string') return;

  try {
    return JSON.parse(data);
  } catch (_) {
    return;
  }
}

async function readStdin(onMessage: (message: PreviewMessage) => void) {
  if (DENO_ENV === 'development') return;

  const decoder = new TextDecoder();
  const generator = readChunks(Deno.stdin);

  logger.info('stdin reader started');

  for await (const chunk of generator) {
    const action = decoder.decode(chunk.buffer);
    logger.info(`stdin action=${action}`);

    switch (action) {
      case 'show': {
        const content = decoder.decode((await generator.next()).value!);
        const message = {
          action: 'show' as const,
          html: render(content),
          lcount: (content.match(/(?:\r?\n)/g) || []).length + 1,
        };
        logger.info(`stdin show content=${content.length} html=${message.html.length}`);
        onMessage(message);
        break;
      }
      case 'scroll':
        onMessage({ action, line: decoder.decode((await generator.next()).value!) });
        break;
      case 'base':
        onMessage({
          action,
          base: normalize(decoder.decode((await generator.next()).value!) + '/'),
        });
        break;
      case 'label':
        onMessage({ action, label: decoder.decode((await generator.next()).value!) });
        break;
      case 'close':
        return;
      default:
        break;
    }
  }
}

async function init(socket: WebSocket) {
  if (DENO_ENV === 'development') {
    return void (await import(join(__dirname, 'ipc_dev.ts'))).default(socket);
  }

  try {
    await readStdin((message) => send(socket, message));
  } catch (e) {
    if (!(e instanceof Error) || e.name !== 'InvalidStateError') throw e;
  }
}

async function attachToPersistentServer(port: number) {
  logger.info(`attach source to existing server port=${port}`);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?role=source`);

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      logger.info(`attached source to existing server port=${port}`);
      resolve();
    };
    socket.onerror = () => reject(new Error(`Unable to connect to Peek server on port ${port}`));
  });

  await readStdin((message) => send(socket, message))
    .catch((e) => {
      if (!(e instanceof Error) || e.message !== 'EOF') throw e;
    })
    .finally(() => socket.close());
}

(() => {
  const app = __args['app'] ? JSON.parse(__args['app']) : 'webview';

  if (app === 'webview') {
    const onListen: Deno.ServeOptions['onListen'] = ({ hostname, port }) => {
      const serverUrl = `${hostname.replace('0.0.0.0', 'localhost')}:${port}`;
      logger.info(`listening on ${serverUrl}`);
      const webview = new Deno.Command('deno', {
        cwd: dirname(fromFileUrl(Deno.mainModule)),
        args: [
          'run',
          '--quiet',
          '--allow-read',
          '--allow-write',
          '--allow-env',
          '--allow-net',
          '--allow-ffi',
          '--unstable',
          '--no-check',
          'webview.js',
          `--url=${new URL('index.html', Deno.mainModule).href}`,
          `--theme=${__args['theme']}`,
          `--serverUrl=${serverUrl}`,
        ],
        stdin: 'null',
      });

      webview.output().then((status) => {
        logger.info(`webview closed, code: ${status.code}`);
        Deno.exit();
      });
    };

    Deno.serve({ port: 0, onListen }, (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);

      socket.onopen = () => {
        init(socket);
      };

      return response;
    });

    return;
  }

  async function findFile(url: string) {
    const path = new URL(url).pathname.replace(/^\//, '') || 'index.html';

    for (const base of [Deno.mainModule, 'file:']) {
      try {
        return { file: await Deno.open(new URL(path, base)), path };
      } catch (_) { /**/ }
    }
  }

  function contentType(path: string) {
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.js')) return 'text/javascript';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    if (path.endsWith('.ico')) return 'image/x-icon';
    if (path.endsWith('.woff2')) return 'font/woff2';
    return 'application/octet-stream';
  }

  const port = app === 'ssh' ? Number(__args['port'] || 3000) : 0;
  const hub = createHub();

  const onListen: Deno.ServeOptions['onListen'] = ({ hostname, port }) => {
    const serverUrl = `${hostname.replace('0.0.0.0', 'localhost')}:${port}`;
    logger.info(`listening on ${serverUrl}`);

    if (app === 'ssh') return;

    const url = new URL(`http://${serverUrl}`);
    const searchParams = new URLSearchParams({ theme: __args.theme });
    url.search = searchParams.toString();

    open(url.href, { app: app !== 'browser' && app })
      .catch((e) => {
        Deno.stderr.writeSync(new TextEncoder().encode(`${[app].flat().join(' ')}: ${e.message}`));
        Deno.exit();
      });
  };

  try {
    Deno.serve(
      { hostname: app === 'ssh' ? '127.0.0.1' : undefined, port, onListen },
      async (request) => {
        const url = new URL(request.url);
        const upgrade = request.headers.get('upgrade') || '';
        logger.info(
          `http request method=${request.method} path=${url.pathname} websocket=${
            upgrade.toLowerCase() == 'websocket'
          } role=${url.searchParams.get('role') || '-'}`,
        );

        if (upgrade.toLowerCase() != 'websocket') {
          if (app === 'ssh' && url.pathname === '/' && !url.searchParams.has('theme')) {
            url.searchParams.set('theme', String(__args.theme));
            return Response.redirect(url, 307);
          }

          const result = await findFile(request.url);
          if (!result) return new Response('Not Found', { status: 404 });

          return new Response(result.file.readable, {
            headers: { 'content-type': contentType(result.path) },
          });
        }

        const { socket, response } = Deno.upgradeWebSocket(request);
        const role = url.searchParams.get('role');

        socket.onopen = () => {
          logger.info(`ws open role=${role || 'viewer'} app=${app}`);
          if (app === 'ssh' && role === 'source') {
            hub.addSource(socket);
          } else if (app === 'ssh') {
            hub.addViewer(socket);
          } else {
            init(socket);
          }
        };

        socket.onerror = () => logger.info(`ws error role=${role || 'viewer'} app=${app}`);

        return response;
      },
    );
  } catch (error) {
    if (app !== 'ssh' || !(error instanceof Deno.errors.AddrInUse)) throw error;
    logger.info(`server port in use; switching to source attach port=${port}`);
    attachToPersistentServer(port).catch((e) => {
      Deno.stderr.writeSync(new TextEncoder().encode(`${e.message}\n`));
      Deno.exit(1);
    });
    return;
  }

  if (app === 'ssh') {
    logger.info(`ssh hub owner reading stdin port=${port}`);
    const source = hub.registerSource();
    readStdin((message) => hub.updateSource(source.id, message))
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== 'EOF') throw e;
      })
      .finally(() => hub.unregisterSource(source.id));
  }
})();

const win_signals = ['SIGINT', 'SIGBREAK'] as const;
const unix_signals = ['SIGINT', 'SIGUSR2', 'SIGTERM', 'SIGPIPE', 'SIGHUP'] as const;
const signals = Deno.build.os === 'windows' ? win_signals : unix_signals;

for (const signal of signals) {
  Deno.addSignalListener(signal, () => {
    logger.info('SIGNAL:', signal);
    Deno.exit();
  });
}
