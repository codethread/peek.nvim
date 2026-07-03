import { debounce, findLast, getInjectConfig } from './util.ts';
import { slidingWindows } from 'https://deno.land/std@0.217.0/collections/sliding_windows.ts';
// @deno-types="https://raw.githubusercontent.com/patrick-steele-idem/morphdom/master/index.d.ts"
import morphdom from 'https://esm.sh/morphdom@2.7.2?no-dts';
import mermaid from './mermaid.ts';
import graphviz from './graphviz.ts';

const window = globalThis;
// const _log = Reflect.get(window, '_log');

type SourceId = string;

type PreviewState = {
  id: SourceId;
  label: string;
  html: string;
  lcount: number;
  line?: number;
  base?: string;
};

type PreviewMessage =
  | { action: 'show'; html: string; lcount: number; sourceId?: SourceId }
  | { action: 'scroll'; line: number; sourceId?: SourceId }
  | { action: 'base'; base: string; sourceId?: SourceId }
  | { action: 'label'; label: string; sourceId?: SourceId }
  | { action: 'tabs'; tabs: PreviewState[]; activeId?: SourceId };

addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const markdownBody = document.getElementById('peek-markdown-body') as HTMLDivElement;
  const base = document.getElementById('peek-base') as HTMLBaseElement;
  const tabbar = document.getElementById('peek-tabs') as HTMLDivElement;
  const outline = document.getElementById('peek-outline') as HTMLElement;
  const outlineToggle = document.getElementById('peek-outline-toggle') as HTMLButtonElement;
  const outlineScrim = document.getElementById('peek-outline-scrim') as HTMLDivElement;
  const peek = getInjectConfig();
  const sessions = new Map<SourceId, PreviewState>();
  let activeId: SourceId | undefined;
  let source: { lcount: number } | undefined;
  let blocks: HTMLElement[][] | undefined;
  let scroll: { line: number } | undefined;

  const zoom = {
    level: 100,
    zoomMin: 50,
    zoomMax: 250,
    zoomStep: 10,
    zoomLabel: document.getElementById('peek-zoom-label') as HTMLDivElement,
    init() {
      this.level = Number(localStorage.getItem('zoom-level')) || this.level;
      this.update(this.level === 100);
    },
    up() {
      this.level = Math.min(this.level + this.zoomStep, this.zoomMax);
      this.update();
    },
    down() {
      this.level = Math.max(this.level - this.zoomStep, this.zoomMin);
      this.update();
    },
    reset() {
      this.level = 100;
      this.update();
    },
    update(silent?: boolean) {
      localStorage.setItem('zoom-level', String(this.level));
      markdownBody.style.setProperty('font-size', `${this.level}%`);
      if (silent) return;
      this.zoomLabel.textContent = `${this.level}%`;
      this.zoomLabel.animate([
        { opacity: 1 },
        { opacity: 1, offset: 0.75 },
        { opacity: 0 },
      ], { duration: 1000 });
    },
  };

  if (peek.theme) body.setAttribute('data-theme', peek.theme);
  if (peek.ctx === 'webview') zoom.init();

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const ctrl: Record<string, () => void> = {
      '=': zoom.up.bind(zoom),
      '-': zoom.down.bind(zoom),
      '0': zoom.reset.bind(zoom),
    };
    const plain: Record<string, () => void> = {
      'Escape': () => {
        if (peek.ctx === 'webview') {
          Reflect.get(window, '_close')?.();
        }
      },
      'j': () => {
        window.scrollBy({ top: 50 });
      },
      'k': () => {
        window.scrollBy({ top: -50 });
      },
      'd': () => {
        window.scrollBy({ top: window.innerHeight / 2 });
      },
      'u': () => {
        window.scrollBy({ top: -window.innerHeight / 2 });
      },
      'g': () => {
        window.scrollTo({ top: 0 });
      },
      'G': () => {
        window.scrollTo({ top: document.body.scrollHeight });
      },
    };
    const action = event.ctrlKey && peek.ctx === 'webview' ? ctrl[event.key] : plain[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  });

  onload = () => {
    const item = sessionStorage.getItem('session');
    if (!item) return;

    const session = JSON.parse(item);
    base.href = session.base;
    onPreview({ html: session.html, lcount: session.lcount });
    onScroll({ line: session.line });
  };

  onbeforeunload = () => {
    sessionStorage.setItem(
      'session',
      JSON.stringify({
        base: base.href,
        html: markdownBody.innerHTML,
        lcount: source?.lcount,
        line: scroll?.line,
      }),
    );
  };

  const socket = new WebSocket(`ws://${peek.serverUrl}/`);

  socket.binaryType = 'arraybuffer';

  socket.onclose = (event) => {
    if (!event.wasClean) {
      close();
      location.reload();
    }
  };

  socket.onmessage = async (event) => {
    const data = await parseMessage(event.data);

    switch (data.action) {
      case 'tabs':
        onTabs(data);
        break;
      case 'show':
        updateSession(data.sourceId, { html: data.html, lcount: data.lcount });
        if (isActive(data.sourceId)) onPreview(data);
        break;
      case 'scroll':
        updateSession(data.sourceId, { line: Number(data.line) });
        if (isActive(data.sourceId)) onScroll({ line: Number(data.line) });
        break;
      case 'base':
        updateSession(data.sourceId, { base: data.base });
        if (isActive(data.sourceId)) base.href = data.base;
        break;
      case 'label':
        updateSession(data.sourceId, { label: data.label });
        renderTabs(Array.from(sessions.values()));
        break;
      default:
        break;
    }
  };

  async function parseMessage(data: string | ArrayBuffer | Blob): Promise<PreviewMessage> {
    if (data instanceof Blob) data = await data.text();
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
    return JSON.parse(data);
  }

  function isActive(sourceId?: SourceId) {
    return !sourceId || sourceId === activeId;
  }

  function updateSession(sourceId: SourceId | undefined, patch: Partial<PreviewState>) {
    if (!sourceId) return;
    sessions.set(sourceId, {
      id: sourceId,
      label: '',
      lcount: 1,
      html: '',
      ...sessions.get(sourceId),
      ...patch,
    });
  }

  function onTabs(data: Extract<PreviewMessage, { action: 'tabs' }>) {
    sessions.clear();

    for (const tab of data.tabs) {
      sessions.set(tab.id, tab);
    }

    activeId = data.activeId || data.tabs[0]?.id;
    renderTabs(data.tabs);

    const active = activeId ? sessions.get(activeId) : undefined;
    if (!active) {
      source = undefined;
      blocks = undefined;
      scroll = undefined;
      base.removeAttribute('href');
      markdownBody.innerHTML = '<div class="peek-loader"></div>';
      return;
    }

    activateSession(active);
  }

  function activateSession(active: PreviewState) {
    base.href = active.base || '';
    onPreview({ html: active.html, lcount: active.lcount });

    if (active.line) {
      onScroll({ line: active.line });
    } else {
      scroll = undefined;
      window.scrollTo({ top: 0 });
    }
  }

  function tabLabel(label: string) {
    return label.split(/[\\/]/).filter(Boolean).pop() || label;
  }

  function renderTabs(tabs: PreviewState[]) {
    tabbar.hidden = tabs.length < 2;
    tabbar.replaceChildren(...tabs.map((tab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'peek-tab';
      button.textContent = tabLabel(tab.label);
      button.title = tab.label;
      button.toggleAttribute('aria-current', tab.id === activeId);
      button.addEventListener('click', () => {
        activeId = tab.id;
        socket.send(JSON.stringify({ action: 'activate', sourceId: tab.id }));
        const active = sessions.get(tab.id);
        if (!active) return;
        activateSession(active);
        renderTabs(Array.from(sessions.values()));
      });
      return button;
    }));
  }

  const buildOutline = (() => {
    let headings: HTMLElement[] = [];
    let links: HTMLElement[] = [];
    let raf = 0;

    function setDrawer(open: boolean) {
      outline.toggleAttribute('data-open', open);
      outlineScrim.hidden = !open;
      outlineToggle.setAttribute('aria-expanded', String(open));
    }

    outlineToggle.addEventListener('click', () => {
      setDrawer(!outline.hasAttribute('data-open'));
    });
    outlineScrim.addEventListener('click', () => setDrawer(false));
    // crossing the rail/drawer breakpoint retires the drawer chrome, so normalise the
    // open state to avoid it reappearing already-open when narrowing again
    matchMedia('(min-width: 72rem)').addEventListener('change', () => setDrawer(false));

    function syncActive() {
      raf = 0;
      if (!headings.length) return;
      // the last heading scrolled past the reading offset is the current section
      let active = 0;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top - 100 <= 0) active = i;
        else break;
      }
      links.forEach((link, i) => link.toggleAttribute('aria-current', i === active));
    }

    window.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(syncActive);
    }, { passive: true });

    return () => {
      headings = Array.from(markdownBody.querySelectorAll('h1, h2, h3, h4, h5, h6'));

      links = headings.map((heading) => {
        const level = Number(heading.tagName[1]);
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'peek-outline-link';
        link.textContent = heading.textContent?.trim() || '';
        link.title = link.textContent;
        link.style.paddingLeft = `${(level - 1) * 12 + 8}px`;
        link.addEventListener('click', () => {
          heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setDrawer(false);
        });
        return link;
      });

      outline.replaceChildren(...links);

      const empty = headings.length === 0;
      outline.hidden = empty;
      outlineToggle.hidden = empty;
      if (empty) setDrawer(false);

      syncActive();
    };
  })();

  const onPreview = (() => {
    mermaid.init();

    const renderGraphs = debounce(
      (() => {
        const parser = new DOMParser();

        function finishRender(el: Element, svgElement: Element) {
          el.querySelector('.peek-loader')?.remove();
          el.parentElement?.style.setProperty(
            'height',
            window.getComputedStyle(svgElement).getPropertyValue('height'),
          );
        }

        async function renderMermaid(el: Element) {
          const svg = await mermaid.render(
            `${el.id}-svg`,
            el.getAttribute('data-graph-definition')!,
            el,
          );

          if (svg) {
            const svgElement = parser.parseFromString(svg, 'text/html').body;
            el.appendChild(svgElement);
            finishRender(el, svgElement);
          }
        }

        async function renderGraphviz(el: Element) {
          const svgElement = await graphviz.render(el.getAttribute('data-graph-definition')!);

          if (svgElement) {
            el.appendChild(svgElement);
            finishRender(el, svgElement);
          }
        }

        async function render(el: Element) {
          if (el.getAttribute('data-graph') === 'mermaid') {
            await renderMermaid(el);
          } else if (el.getAttribute('data-graph') === 'graphviz') {
            await renderGraphviz(el);
          }
        }

        return () => {
          Array.from(markdownBody.querySelectorAll('div[data-graph]'))
            .filter((el) => !el.querySelector('svg'))
            .forEach(render);
        };
      })(),
      200,
    );

    const morphdomOptions: Parameters<typeof morphdom>[2] = {
      childrenOnly: true,
      getNodeKey: (node) => {
        if (node instanceof HTMLElement && node.hasAttribute('data-graph')) {
          return node.id;
        }
        return null;
      },
      onNodeAdded: (node) => {
        if (node instanceof HTMLElement && node.hasAttribute('data-graph')) {
          renderGraphs();
        }
        return node;
      },
      onBeforeElUpdated: (fromEl: HTMLElement, toEl: HTMLElement) => {
        if (fromEl.hasAttribute('open')) {
          toEl.setAttribute('open', 'true');
        } else if (
          fromEl.classList.contains('peek-graph-container') &&
          toEl.classList.contains('peek-graph-container')
        ) {
          toEl.style.height = fromEl.style.height;
        }
        return !fromEl.isEqualNode(toEl);
      },
      onBeforeElChildrenUpdated(_, toEl) {
        return !toEl.hasAttribute('data-graph');
      },
    };

    const mutationObserver = new MutationObserver(() => {
      blocks = slidingWindows(Array.from(document.querySelectorAll('[data-line-begin]')), 2, {
        step: 1,
        partial: true,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (scroll) onScroll(scroll);
    });

    mutationObserver.observe(markdownBody, { childList: true });
    resizeObserver.observe(markdownBody);

    return (data: { html: string; lcount: number }) => {
      source = { lcount: data.lcount };
      morphdom(markdownBody, `<main>${data.html}</main>`, morphdomOptions);
      buildOutline();
    };
  })();

  const onScroll = (() => {
    function getBlockOnLine(line: number) {
      return findLast(blocks, (block) => line >= Number(block[0].dataset.lineBegin));
    }

    function getOffset(elem: HTMLElement): number {
      let current: HTMLElement | null = elem;
      let top = 0;

      while (top === 0 && current) {
        top = current.getBoundingClientRect().top;
        current = current.parentElement;
      }

      return top + window.scrollY;
    }

    return (data: { line: number }) => {
      scroll = data;

      if (!blocks || !blocks[0] || !source) return;

      const block = getBlockOnLine(data.line) || blocks[0];
      const target = block[0];
      const next = target ? block[1] : blocks[0][0];

      const offsetBegin = target ? getOffset(target) : 0;
      const offsetEnd = next
        ? getOffset(next)
        : offsetBegin + target.getBoundingClientRect().height;

      const lineBegin = target ? Number(target.dataset.lineBegin) : 1;
      const lineEnd = next ? Number(next.dataset.lineBegin) : source.lcount + 1;

      const pixPerLine = (offsetEnd - offsetBegin) / (lineEnd - lineBegin);
      const scrollPix = (data.line - lineBegin) * pixPerLine;

      window.scroll({ top: offsetBegin + scrollPix - window.innerHeight / 2 + pixPerLine / 2 });
    };
  })();
});
