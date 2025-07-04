const DEFAULT_OPTIONS: Required<ScanOptions> = {
  includeShadowDom: true,
  maxDepth: 7,
  iframeTraversal: true,
};

let cachedFields: FieldInfo[] | null = null;
let observer: MutationObserver | null = null;

/* ---------- Utility --------------------------------------------------------------------- */
const runtime = ((): chrome.runtime | undefined => {
  // Firefox uses browser, others chrome
  if (typeof chrome !== 'undefined' && chrome.runtime) return chrome.runtime;
  // @ts-ignore
  if (typeof browser !== 'undefined' && browser.runtime) return browser.runtime;
  return undefined;
})();

function isSameOriginIframe(iframe: HTMLIFrameElement): boolean {
  try {
    void iframe.contentDocument; // will throw if cross-origin
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

function uniqueSelector(el: Element, root: Document | ShadowRoot = document): string {
  if (el.id && root.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`;
  }

  const paths: string[] = [];
  let element: Element | null = el;
  while (element && element !== root) {
    const tag = element.tagName.toLowerCase();
    let selector = tag;
    if (element.className) {
      const className = element.className
        .toString()
        .split(/\s+/)
        .filter(Boolean)
        .map(cls => `.${CSS.escape(cls)}`)
        .join('');
      if (className) {
        selector += className;
        if (root.querySelectorAll(selector).length === 1) {
          paths.unshift(selector);
          break;
        }
      }
    }

    const parent = element.parentElement;
    if (!parent) break;

    const siblings = Array.from(parent.children).filter(
      sib => sib.tagName === element!.tagName
    );
    if (siblings.length > 1) {
      const index = siblings.indexOf(element) + 1;
      selector += `:nth-of-type(${index})`;
    }

    paths.unshift(selector);
    element = parent;
  }
  return paths.join(' > ');
}

function extractLabelText(el: Element): string | undefined {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return (l.textContent || '').trim();
    }
  }
  // fallback: previous sibling label
  let prev = el.previousElementSibling;
  if (prev && prev.tagName.toLowerCase() === 'label')
    return (prev.textContent || '').trim();
  return undefined;
}

/* ---------- Deep Query Helper ----------------------------------------------------------- */
/**
 * Deep-query supporting ShadowDOM and same-origin iframes.
 * Uses the delimiter `>>>` between boundaries.
 * Example: 'iframe.foo >>> custom-element >>> input[name=email]'
 */
function queryDeepAll(deepSelector: string): Element[] {
  const parts = deepSelector
    .split(/\s*>>>\s*/)
    .map(p => p.trim())
    .filter(Boolean);
  if (!parts.length) return [];

  let currentContexts: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const part = parts[i];
    const nextContexts: (Document | ShadowRoot | Element)[] = [];
    currentContexts.forEach(ctx => {
      const matches = Array.from(ctx.querySelectorAll(part));
      matches.forEach(match => {
        if (isLast) {
          nextContexts.push(match);
        } else {
          let nextRoot: Document | ShadowRoot | null = null;
          if (match instanceof HTMLIFrameElement && isSameOriginIframe(match) && match.contentDocument) {
            nextRoot = match.contentDocument;
          } else if ((match as HTMLElement).shadowRoot) {
            nextRoot = (match as HTMLElement).shadowRoot!;
          }
          if (nextRoot) {
            nextContexts.push(nextRoot);
          }
        }
      });
    });
    if (!nextContexts.length) return [];
    if (isLast) {
      return nextContexts.filter((n): n is Element => n instanceof Element);
    }
    currentContexts = nextContexts.filter(
      (n): n is Document | ShadowRoot => !(n instanceof Element)
    );
  }
  return [];
}

/* ---------- DOM Scanning ---------------------------------------------------------------- */
export function scanDOM(options: ScanOptions = {}): FieldInfo[] {
  const cfg: Required<ScanOptions> = { ...DEFAULT_OPTIONS, ...options };
  const visited = new WeakSet<Node>();
  const results: FieldInfo[] = [];

  function traverse(
    node: Node,
    depth: number,
    rootForSelector: Document | ShadowRoot,
    pathParts: string[]
  ) {
    if (depth > cfg.maxDepth || visited.has(node)) return;
    visited.add(node);

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement).isContentEditable
      ) {
        const selector = uniqueSelector(el, rootForSelector);
        const deepSelector =
          pathParts.length > 0
            ? `${pathParts.join(' >>> ')} >>> ${selector}`
            : selector;
        const info: FieldInfo = {
          selector: deepSelector,
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
          nameAttr: (el as HTMLInputElement).name || undefined,
          label: extractLabelText(el),
        };
        results.push(info);
      }

      // Shadow DOM
      if (cfg.includeShadowDom && (el as HTMLElement).shadowRoot) {
        const hostSelector = uniqueSelector(el, rootForSelector);
        traverse(
          (el as HTMLElement).shadowRoot as ShadowRoot,
          depth + 1,
          (el as HTMLElement).shadowRoot!,
          [...pathParts, hostSelector]
        );
      }

      // Iframes
      if (cfg.iframeTraversal && el.tagName === 'IFRAME') {
        const iframe = el as HTMLIFrameElement;
        if (isSameOriginIframe(iframe) && iframe.contentDocument) {
          const iframeSelector = uniqueSelector(iframe, rootForSelector);
          traverse(
            iframe.contentDocument,
            depth + 1,
            iframe.contentDocument,
            [...pathParts, iframeSelector]
          );
        }
      }
    }

    // Children
    node.childNodes.forEach(child =>
      traverse(child, depth + 1, rootForSelector, pathParts)
    );
  }

  traverse(document, 0, document, []);
  cachedFields = results;
  sendResults({ type: 'scan-complete', fields: results });
  return results;
}

/* ---------- Form Filling ---------------------------------------------------------------- */
export async function fillForm(
  mapping: Mapping,
  rowData: RowData
): Promise<void> {
  const pending: Promise<void>[] = [];
  Object.entries(mapping).forEach(([column, selector]) => {
    const value = rowData[column];
    if (value === undefined) return;

    const targets = queryDeepAll(selector);
    targets.forEach(el => {
      pending.push(
        (async () => {
          // Simulate human delay
          await delay(100 + Math.random() * 250);

          if (el instanceof HTMLInputElement) {
            if (el.type === 'checkbox') {
              let shouldCheck = false;
              if (Array.isArray(value)) {
                shouldCheck = value.map(String).includes(el.value || 'on');
              } else if (typeof value === 'string') {
                const strVal = value.toLowerCase();
                shouldCheck =
                  strVal === el.value.toLowerCase() ||
                  strVal === 'true' ||
                  strVal === '1' ||
                  strVal === 'on' ||
                  strVal === 'yes';
              } else {
                shouldCheck = Boolean(value);
              }

              if (el.checked !== shouldCheck) {
                el.checked = shouldCheck;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else if (el.type === 'radio') {
              const match = String(value) === el.value;
              if (match && !el.checked) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else {
              el.value = String(value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else if (el instanceof HTMLTextAreaElement) {
            el.value = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el instanceof HTMLSelectElement) {
            el.value = String(value);
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if ((el as HTMLElement).isContentEditable) {
            (el as HTMLElement).innerText = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      );
    });
  });

  await Promise.all(pending);
  sendResults({ type: 'fill-complete', success: true });
}

/* ---------- Mutation Observation --------------------------------------------------------- */
export function observeMutations(): void {
  if (observer) return; // already observing

  let debounceTimer: number | null = null;
  observer = new MutationObserver(() => {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      scanDOM(); // refresh cache after quiet period
    }, 300);
  });
  observer.observe(document, { childList: true, subtree: true });
}

/* ---------- Messaging ------------------------------------------------------------------- */
function sendResults(payload: unknown): void {
  try {
    runtime?.sendMessage(payload);
  } catch {
    // runtime might be unavailable in some contexts
  }
}

/* ---------- Init ------------------------------------------------------------------------ */
export function initContentScript(): void {
  if (runtime) {
    runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        switch (msg?.command) {
          case 'scan':
            sendResponse(scanDOM(msg.options));
            break;
          case 'fill':
            await fillForm(msg.mapping, msg.rowData);
            sendResponse({ ok: true });
            break;
          default:
            break;
        }
      })();
      // Indicate async response when necessary
      return true;
    });
  }

  // Initial scan and observer start
  scanDOM();
  observeMutations();
}

// Automatically run
initContentScript();