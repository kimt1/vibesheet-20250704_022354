// --- Type Definitions for context ---
type DOMElement = HTMLElement | Element;
interface Point {
    x: number;
    y: number;
    duration?: number;
}
interface TypingOptions {
    minDelay?: number;
    maxDelay?: number;
    focus?: boolean;
    clearExisting?: boolean;
    jitterMs?: number;
}

const DEFAULT_MIN_DELAY = 50;
const DEFAULT_MAX_DELAY = 150;
const MOUSE_MOVE_STEP_MS = 8;

let currentMousePos: Point = { x: 0, y: 0 };

export async function simulateTyping(
  element: DOMElement,
  text: string,
  options: TypingOptions = {},
): Promise<void> {
  const {
    minDelay = DEFAULT_MIN_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
    focus = true,
    clearExisting = false,
    jitterMs = 0,
  } = options;

  if (!(element as HTMLElement).isConnected) {
    throw new Error('simulateTyping: target element is not connected to the DOM.');
  }

  if (focus) (element as HTMLElement).focus({ preventScroll: true });

  if (clearExisting) {
    setElementValue(element, '');
    dispatchInputEvent(element);
    dispatchChangeEvent(element);
  }

  let currentValue = getElementValue(element) ?? '';

  for (const char of Array.from(text)) {
    await randomPause(
      minDelay,
      maxDelay + (jitterMs ? randInt(0, jitterMs) : 0),
    );
    const keyCode = char.charCodeAt(0);

    dispatchKeyboardEvent(element, 'keydown', char, keyCode);
    dispatchKeyboardEvent(element, 'keypress', char, keyCode);

    currentValue += char;
    setElementValue(element, currentValue);

    dispatchInputEvent(element);
    dispatchKeyboardEvent(element, 'keyup', char, keyCode);
  }

  dispatchChangeEvent(element);
}

export async function simulateClick(element: DOMElement): Promise<void> {
  if (!(element as HTMLElement).isConnected) {
    throw new Error('simulateClick: target element is not connected to the DOM.');
  }

  const rect = element.getBoundingClientRect();
  const clickPoint: Point = {
    x: rect.left + rect.width / 2 + randFloat(-2, 2),
    y: rect.top + rect.height / 2 + randFloat(-2, 2),
  };

  await moveMousePath([
    currentMousePos,
    {
      ...clickPoint,
      duration: randInt(60, 120),
    },
  ]);

  element.dispatchEvent(createMouseEvent('mousedown', clickPoint));
  await randomPause(40, 120);
  element.dispatchEvent(createMouseEvent('mouseup', clickPoint));
  element.dispatchEvent(createMouseEvent('click', clickPoint));

  currentMousePos = clickPoint;
}

export function randomPause(min: number, max: number): Promise<void> {
  const resolvedMin = Math.min(min, max);
  const resolvedMax = Math.max(min, max);
  return new Promise((resolve) => setTimeout(resolve, randInt(resolvedMin, resolvedMax)));
}

export async function moveMousePath(points: Point[]): Promise<void> {
  if (points.length < 2) return;

  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const duration = end.duration ?? randInt(80, 140);
    const steps = Math.max(1, Math.round(duration / MOUSE_MOVE_STEP_MS));
    const deltaX = (end.x - start.x) / steps;
    const deltaY = (end.y - start.y) / steps;

    for (let step = 1; step <= steps; step++) {
      const x = start.x + deltaX * step + randFloat(-0.5, 0.5);
      const y = start.y + deltaY * step + randFloat(-0.5, 0.5);

      document.dispatchEvent(createMouseEvent('mousemove', { x, y }));
      await randomPause(MOUSE_MOVE_STEP_MS, MOUSE_MOVE_STEP_MS + 2);
    }
  }

  currentMousePos = { ...points[points.length - 1] };
}

export async function jitter(radius = 3): Promise<void> {
  const jitterPoint: Point = {
    x: currentMousePos.x + randFloat(-radius, radius),
    y: currentMousePos.y + randFloat(-radius, radius),
  };
  await moveMousePath([
    currentMousePos,
    { ...jitterPoint, duration: randInt(20, 40) },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function dispatchKeyboardEvent(
  target: DOMElement,
  type: 'keydown' | 'keyup' | 'keypress',
  key: string,
  _keyCode?: number,
): void {
  const eventInit: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
  };
  const event = new KeyboardEvent(type, eventInit);
  target.dispatchEvent(event);
}

function dispatchInputEvent(target: DOMElement): void {
  const inputEvent = new Event('input', { bubbles: true, cancelable: false });
  target.dispatchEvent(inputEvent);
}

function dispatchChangeEvent(target: DOMElement): void {
  const changeEvent = new Event('change', { bubbles: true, cancelable: false });
  target.dispatchEvent(changeEvent);
}

function createMouseEvent(
  type: string,
  point: Point,
): MouseEvent {
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    view: window,
  };
  return new MouseEvent(type, eventInit);
}

function setElementValue(el: DOMElement, value: string): void {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const prototype = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      (el as HTMLInputElement).value = value;
    }
  } else {
    el.textContent = value;
  }
}

function getElementValue(el: DOMElement): string | null {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value;
  }
  return el.textContent;
}