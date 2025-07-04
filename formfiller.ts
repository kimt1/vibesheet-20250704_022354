// --- Type Definitions for context ---
type Primitive = string | number | boolean;
interface FieldMapping {
    selector: string;
    column: string;
    type: string;
    framePath: (string | number)[];
}
interface FillOptions {
    scrollIntoView?: boolean;
    minDelay?: number;
    maxDelay?: number;
}


const DEFAULT_OPTIONS: Required<FillOptions> = {
  scrollIntoView: true,
  minDelay: 30,
  maxDelay: 140,
};
export class FormFiller {
  /*********************************************************
   * PUBLIC API
   *********************************************************/

  /**
   * Deep-scans the active document (main + iframes + shadowRoots) and
   * returns a list of form field mappings.
   */
  public static scanPage(): FieldMapping[] {
    const mappings: FieldMapping[] = [];
    this._walkContext(window, [], (el, framePath) => {
      if (this._isFillable(el)) {
        mappings.push({
          column: `COL_${mappings.length + 1}`,
          selector: this._getUniqueSelector(el),
          framePath: [...framePath],
          type: (el as HTMLElement).tagName.toLowerCase(),
        });
      }
    });
    return mappings;
  }

  /**
   * Fills a single row of data into the page using the provided mappings.
   *
   * @param rowData   Key/value object where key is column header.
   * @param mappings  Mappings returned by `scanPage` (can be trimmed / re-ordered).
   * @param opts      Behavioural options.
   */
  public static async fillRow(
    rowData: Record<string, Primitive>,
    mappings: FieldMapping[],
    opts: FillOptions = {},
  ): Promise<void> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    for (const map of mappings) {
      if (!(map.column in rowData)) continue;
      const value = rowData[map.column] as Primitive;
      if (value === undefined || value === null) continue;
      // Resolve element reference
      const element = this._resolveElement(map);
      if (!element) continue;

      await this._applyValue(element, value, options);
    }
  }

  /*********************************************************
   * CORE UTILS
   *********************************************************/

  private static async _applyValue(
    element: Element,
    value: Primitive,
    opts: Required<FillOptions>,
  ): Promise<void> {
    if (!(element as HTMLElement).isConnected) return;
    if (opts.scrollIntoView) {
      try {
        (element as HTMLElement).scrollIntoView({
          block: 'center',
          inline: 'center',
          behavior: 'smooth',
        });
      } catch {
        /* ignore */
      }
    }

    const tag = element.tagName.toLowerCase();
    const typeAttr = (element as HTMLInputElement).type?.toLowerCase?.() ?? '';

    switch (tag) {
      case 'select':
        await this._setSelectValue(element as HTMLSelectElement, String(value));
        break;

      case 'input':
        if (['checkbox', 'radio'].includes(typeAttr)) {
          await this._toggleCheckable(element as HTMLInputElement, Boolean(value));
        } else {
          await this._typeText(element as HTMLInputElement, String(value), opts);
        }
        break;

      case 'textarea':
        await this._typeText(element as HTMLTextAreaElement, String(value), opts);
        break;

      default:
        if ((element as HTMLElement).isContentEditable) {
          await this._typeContentEditable(element as HTMLElement, String(value), opts);
        } else {
          await this._typeText(element as HTMLInputElement, String(value), opts);
        }
        break;
    }
  }

  private static async _typeText(
    el: HTMLInputElement | HTMLTextAreaElement,
    text: string,
    opts: Required<FillOptions>,
  ): Promise<void> {
    el.focus();
    el.select?.();
    el.value = '';
    this._dispatchEvents(el, ['input']);

    for (const char of text) {
      el.value += char;
      this._dispatchEvents(el, ['input']);
      await this._sleep(this._rand(opts.minDelay, opts.maxDelay));
    }

    this._dispatchEvents(el, ['blur', 'change']);
  }

  private static async _typeContentEditable(
    el: HTMLElement,
    text: string,
    opts: Required<FillOptions>,
  ): Promise<void> {
    el.focus();
    // Clear existing content
    document.execCommand?.('selectAll', false);
    document.execCommand?.('delete', false);
    this._dispatchEvents(el, ['input']);

    for (const char of text) {
      document.execCommand?.('insertText', false, char);
      this._dispatchEvents(el, ['input']);
      await this._sleep(this._rand(opts.minDelay, opts.maxDelay));
    }

    this._dispatchEvents(el, ['blur', 'change']);
  }

  private static async _setSelectValue(el: HTMLSelectElement, value: string): Promise<void> {
    const option = Array.from(el.options).find(
      (o) => o.value === value || o.textContent?.trim() === value,
    );
    if (option) {
      el.value = option.value;
      this._dispatchEvents(el, ['input', 'change']);
    }
  }

  private static async _toggleCheckable(el: HTMLInputElement, checked: boolean): Promise<void> {
    if (el.checked !== checked) {
      el.click();
      await this._sleep(this._rand(60, 180));
    }
  }

  /*********************************************************
   * DOM TRAVERSAL
   *********************************************************/

  private static _walkContext(
    win: Window,
    path: (string | number)[],
    cb: (el: Element, framePath: (string | number)[]) => void,
  ): void {
    const visitRoot = (root: ParentNode, currentPath: (string | number)[]) => {
      try {
        // Invoke callback on fillable elements within current root
        const elements = root.querySelectorAll<HTMLElement>(
          'input, select, textarea, [contenteditable]',
        );
        elements.forEach((el) => cb(el, currentPath));

        // Traverse nested shadowRoots
        root.querySelectorAll<HTMLElement>('*').forEach((node) => {
          // @ts-ignore
          if (node.shadowRoot) {
            const hostSelector = this._getUniqueSelector(node);
            const nextPath = currentPath.concat(hostSelector);
            visitRoot((node as HTMLElement).shadowRoot, nextPath);
          }
        });
      } catch {
        /* ignore */
      }
    };

    try {
      const doc = win.document;
      visitRoot(doc, path);
      // Walk iframes
      const frames = doc.querySelectorAll('iframe');
      frames.forEach((frame, idx) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const childWin = (frame as HTMLIFrameElement).contentWindow!;
          this._walkContext(childWin, path.concat(idx), cb);
        } catch {
          /* cross-origin */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /*********************************************************
   * ELEMENT RESOLUTION
   *********************************************************/

  private static _resolveElement(map: FieldMapping): Element | null {
    let ctx: Document | ShadowRoot | null = document;
    let currentWin: Window | null = window;

    for (const hop of map.framePath) {
      if (typeof hop === 'number') {
        const iframe = currentWin?.document.querySelectorAll('iframe')[hop] as HTMLIFrameElement;
        if (!iframe?.contentWindow) return null;
        currentWin = iframe.contentWindow;
        ctx = currentWin.document;
      } else {
        // ShadowRoot navigation via CSS selector
        const host = ctx?.querySelector(hop as string) as HTMLElement;
        // @ts-ignore
        ctx = host?.shadowRoot ?? null;
      }
    }

    return ctx?.querySelector(map.selector) ?? null;
  }

  private static _isFillable(el: Element): boolean {
    if (el instanceof HTMLInputElement) {
      const type = el.type?.toLowerCase?.() ?? '';
      if (['hidden', 'submit', 'reset', 'button', 'image', 'file'].includes(type)) return false;
      return true;
    }
    return (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      (el as HTMLElement).isContentEditable
    );
  }

  /*********************************************************
   * HELPERS
   *********************************************************/

  private static _dispatchEvents(el: Element, events: string[]): void {
    events.forEach((name) => {
      const evt = new Event(name, { bubbles: true });
      el.dispatchEvent(evt);
    });
  }

  private static _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private static _rand(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Builds a unique selector using element id, class and nth-child fallbacks.
   */
  private static _getUniqueSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts: string[] = [];
    let node: Element | null = el;

    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let selector = node.nodeName.toLowerCase();
      if (node.className) {
        const cls = node.className
          .split(/\s+/)
          .filter((c) => !!c)
          .map((c) => `.${CSS.escape(c)}`)
          .join('');
        selector += cls;
      }

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (n) => n.nodeName.toLowerCase() === node!.nodeName.toLowerCase(),
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(selector);
      node = parent;
    }

    return parts.join(' > ');
  }

  private static _getNodeIndex(node: Element): number {
    const parent = node.parentElement;
    if (!parent) return 0;
    return Array.from(parent.children).indexOf(node);
  }
}

/*********************************************************
 * GLOBAL SHIM (optional) ? expose to window for debugging.
 *********************************************************/
try {
  // @ts-ignore
  if (typeof window !== 'undefined') window.FormFiller = FormFiller;
} catch {
  /* ignore */
}