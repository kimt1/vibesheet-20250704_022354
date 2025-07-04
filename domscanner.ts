export function scanPage(): ScannedElement[] {
  const visitedFrames = new WeakSet<Document>();
  const visitedShadowRoots = new WeakSet<ShadowRoot>();
  const visitedElements = new WeakSet<Element>();
  const results: ScannedElement[] = [];

  try {
    internalScanRoot({
      root: document,
      framePath: [],
      shadowPath: [],
      out: results,
      visitedFrames,
      visitedShadowRoots,
      visitedElements,
    });
  } catch {
    /* noop ? best-effort scan */
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* internals                                   */
/* -------------------------------------------------------------------------- */

type RootLike = Document | ShadowRoot;

interface ScanTask {
  root: RootLike;
  framePath: string[];
  shadowPath: string[];
  out: ScannedElement[];
  visitedFrames: WeakSet<Document>;
  visitedShadowRoots: WeakSet<ShadowRoot>;
  visitedElements: WeakSet<Element>;
}

function internalScanRoot(task: ScanTask): void {
  const { root, out, framePath, shadowPath } = task;

  /* Prevent processing the same shadow root more than once */
  if (root instanceof ShadowRoot) {
    if (task.visitedShadowRoots.has(root)) return;
    task.visitedShadowRoots.add(root);
  }

  /* 1. Scan form-like controls inside current root ------------------------ */
  const selector =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  root.querySelectorAll(selector).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    if (task.visitedElements.has(el)) return;
    task.visitedElements.add(el);

    const tag = el.tagName.toLowerCase();
    const typeAttr = (el as HTMLInputElement).type || null;

    const descriptor: ScannedElement = {
      tag,
      type: typeAttr,
      name: el.getAttribute('name'),
      id: el.id || null,
      label: resolveLabelText(el),
      selector: buildUniqueSelector(el, root),
      framePath: [...framePath],
      shadowPath: [...shadowPath],
      elementRef: el,
    };
    out.push(descriptor);

    /* In case element itself hosts a shadow root (e.g., custom <my-input>) */
    const hostShadow = (el as HTMLElement & { shadowRoot?: ShadowRoot })
      .shadowRoot;
    if (hostShadow && !task.visitedShadowRoots.has(hostShadow)) {
      internalScanRoot({
        root: hostShadow,
        framePath,
        shadowPath: [...shadowPath, descriptor.selector],
        out,
        visitedFrames: task.visitedFrames,
        visitedShadowRoots: task.visitedShadowRoots,
        visitedElements: task.visitedElements,
      });
    }
  });

  /* 2. Recurse through shadow DOMs of any element in this root ------------- */
  root.querySelectorAll('*').forEach((el) => {
    const host = el as HTMLElement & { shadowRoot?: ShadowRoot };
    if (host.shadowRoot && !task.visitedShadowRoots.has(host.shadowRoot)) {
      internalScanRoot({
        root: host.shadowRoot,
        framePath,
        shadowPath: [...shadowPath, buildUniqueSelector(host, root)],
        out,
        visitedFrames: task.visitedFrames,
        visitedShadowRoots: task.visitedShadowRoots,
        visitedElements: task.visitedElements,
      });
    }
  });

  /* 3. Recurse through same-origin iframes --------------------------------- */
  root.querySelectorAll('iframe').forEach((frameEl, index) => {
    const iframe = frameEl as HTMLIFrameElement;
    try {
      const doc = iframe.contentDocument;
      if (!doc || task.visitedFrames.has(doc)) return;
      task.visitedFrames.add(doc);

      const frameId =
        iframe.getAttribute('id') ||
        iframe.getAttribute('name') ||
        `iframe:nth-of-type(${index + 1})`;

      internalScanRoot({
        root: doc,
        framePath: [...framePath, frameId],
        shadowPath: [],
        out,
        visitedFrames: task.visitedFrames,
        visitedShadowRoots: task.visitedShadowRoots,
        visitedElements: task.visitedElements,
      });
    } catch {
      /* inaccessible (cross-origin) ? skip */
    }
  });
}

/* -------------------------------------------------------------------------- */
/* utilities                                   */
/* -------------------------------------------------------------------------- */

function resolveLabelText(el: Element): string | null {
  /* <label for="id"> or <label><input> text ... */
  let labelText: string | null = null;
  if (el.id) {
    const lab = el.ownerDocument?.querySelector(
      `label[for="${cssEscape(el.id)}"]`
    );
    if (lab) labelText = lab.textContent?.trim() || null;
  }

  if (!labelText) {
    // Look up through ancestors until a <label>
    let parent: Element | null = el.parentElement;
    while (parent) {
      if (parent.tagName.toLowerCase() === 'label') {
        labelText = parent.textContent?.trim() || null;
        break;
      }
      parent = parent.parentElement;
    }
  }

  if (labelText) {
    // Collapse whitespace
    labelText = labelText.replace(/\s+/g, ' ');
  }

  return labelText;
}

/**
 * Builds a unique CSS selector for the given element within its root
 * (Document or ShadowRoot). It avoids :nth-child when an ID or name can be
 * used, otherwise falls back to a full path.
 */
function buildUniqueSelector(el: Element, root: RootLike): string {
  if (el.id) return `#${cssEscape(el.id)}`;

  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== root) {
    let part = current.tagName.toLowerCase();
    if (current.classList.length) {
      part +=
        '.' +
        Array.from(current.classList)
          .map((c) => cssEscape(c))
          .join('.');
    }

    // Add nth-of-type for siblings when necessary
    const parent = current.parentElement;
    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter(
        (sib) => sib.tagName === current!.tagName
      );
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(part);
    current = parent;
  }

  return parts.join(' > ');
}

/* Polyfill for CSS.escape (spec-compliant) */
function cssEscape(value: string): string {
  if (typeof (window as any).CSS?.escape === 'function') {
    return (window as any).CSS.escape(value);
  }

  const string = String(value);
  const length = string.length;
  let index = -1;
  let codeUnit: number;
  let result = '';
  const firstCodeUnit = string.charCodeAt(0);

  while (++index < length) {
    codeUnit = string.charCodeAt(index);
    // Replace NULL character
    if (codeUnit === 0x0000) {
      result += '\uFFFD';
      continue;
    }

    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) || // Control characters
      codeUnit === 0x007f || // DELETE
      // First character numeric
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      // Second character numeric if first is '-'
      (index === 1 &&
        codeUnit >= 0x0030 &&
        codeUnit <= 0x0039 &&
        firstCodeUnit === 0x002d)
    ) {
      result += '\\' + codeUnit.toString(16) + ' ';
      continue;
    }

    if (index === 0 && codeUnit === 0x002d && length === 1) {
      // Single hyphen
      result += '\\' + string.charAt(index);
      continue;
    }

    if (
      codeUnit >= 0x0080 || // Non-ASCII
      codeUnit === 0x002d || // Hyphen
      codeUnit === 0x005f || // Underscore
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) || // 0-9
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) || // A-Z
      (codeUnit >= 0x0061 && codeUnit <= 0x007a) // a-z
    ) {
      // Safe character
      result += string.charAt(index);
      continue;
    }

    // Escape all other characters
    result += '\\' + string.charAt(index);
  }

  return result;
}