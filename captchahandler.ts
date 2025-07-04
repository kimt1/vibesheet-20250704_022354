// --- Type Definitions for context ---
type CaptchaType = 'none' | 'recaptcha_v2' | 'hcaptcha' | 'text';
interface CaptchaInfo {
  type: CaptchaType;
  element?: HTMLElement;
  iframe?: HTMLIFrameElement | null;
  sitekey?: string | null;
}
interface CaptchaSolution {
  type: Exclude<CaptchaType, 'none'>;
  token?: string;
  text?: string;
}


const CAPTCHA_SELECTORS = {
  recaptcha: 'div.g-recaptcha, div.recaptcha-checkbox-border',
  hcaptcha: 'div.h-captcha',
  textInput:
    'input[aria-label*="captcha" i], input[name*="captcha" i], input[id*="captcha" i]',
};
const CONFIG_KEY = 'omniForm.captchaSolver';

class CaptchaHandler {
  /* Detect presence of captcha elements on current document */
  static detect(root: Document | ShadowRoot = document): CaptchaInfo {
    // reCAPTCHA v2
    let el = root.querySelector(CAPTCHA_SELECTORS.recaptcha);
    if (el) {
      const iframe = root.querySelector<HTMLIFrameElement>(
        'iframe[src*="recaptcha"]',
      );
      const sitekeyAttribute =
        (el as HTMLElement).getAttribute('data-sitekey') ?? null;
      const sitekeyFromQuery = (() => {
        if (!iframe?.src) return null;
        try {
          const query = iframe.src.split('?')[1] ?? '';
          const param = query
            .split('&')
            .find((p) => p.startsWith('k=') || p.startsWith('sitekey='));
          return param?.split('=')[1] ?? null;
        } catch {
          return null;
        }
      })();
      return {
        type: 'recaptcha_v2',
        sitekey: sitekeyAttribute ?? sitekeyFromQuery,
        element: el as HTMLElement,
        iframe,
      };
    }

    // hCaptcha
    el = root.querySelector(CAPTCHA_SELECTORS.hcaptcha);
    if (el) {
      const sitekey =
        (el as HTMLElement).getAttribute('data-sitekey') ??
        (el as HTMLElement).getAttribute('data-hcaptcha-sitekey') ??
        null;
      return { type: 'hcaptcha', sitekey, element: el as HTMLElement };
    }

    // simple text captcha input
    el = root.querySelector(CAPTCHA_SELECTORS.textInput);
    if (el) {
      return { type: 'text', element: el as HTMLElement };
    }

    return { type: 'none' };
  }

  /* Solve a detected captcha using external or internal service */
  static async solve(info: CaptchaInfo): Promise<CaptchaSolution | null> {
    if (info.type === 'none') return null;
    switch (info.type) {
      case 'recaptcha_v2':
      case 'hcaptcha': {
        const apiKey = await CaptchaHandler.getSolverApiKey();
        if (!apiKey) return CaptchaHandler.useFallback(info);

        try {
          const payload = {
            method: info.type === 'recaptcha_v2' ? 'userrecaptcha' : 'hcaptcha',
            sitekey: info.sitekey,
            pageurl: location.href,
            key: apiKey,
            json: 1,
          };
          const idResponse = await fetch(
            'https://2captcha.com/in.php',
            CaptchaHandler.buildFormPayload(payload),
          ).then((r) => r.json());
          if (idResponse.status !== 1) return CaptchaHandler.useFallback(info);
          const requestId = idResponse.request;
          for (let i = 0; i < 24; i++) {
            await CaptchaHandler.delay(5000);
            const res = await fetch(
              `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`,
            ).then((r) => r.json());
            if (res.status === 1) {
              return { type: info.type, token: res.request };
            }
            if (res.request !== 'CAPCHA_NOT_READY') break;
          }
        } catch {
          // fall through to fallback
        }
        return CaptchaHandler.useFallback(info);
      }

      case 'text': {
        const src = CaptchaHandler.extractImageSrc(info.element);
        if (!src) return CaptchaHandler.useFallback(info);

        const apiKey = await CaptchaHandler.getSolverApiKey();
        if (!apiKey) return CaptchaHandler.useFallback(info);
        try {
          const idResponse = await fetch(
            'https://2captcha.com/in.php',
            CaptchaHandler.buildFormPayload({
              key: apiKey,
              method: 'base64',
              body: await CaptchaHandler.imageToBase64(src),
              json: 1,
            }),
          ).then((r) => r.json());
          if (idResponse.status !== 1) return CaptchaHandler.useFallback(info);
          const requestId = idResponse.request;
          for (let i = 0; i < 20; i++) {
            await CaptchaHandler.delay(4000);
            const res = await fetch(
              `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`,
            ).then((r) => r.json());
            if (res.status === 1) {
              return { type: 'text', text: res.request };
            }
            if (res.request !== 'CAPCHA_NOT_READY') break;
          }
        } catch {
          // fall through
        }
        return CaptchaHandler.useFallback(info);
      }
      default:
        return null;
    }
  }

  /* Inject obtained solution into page's captcha widget/input */
  static async injectSolution(
    info: CaptchaInfo,
    solution: CaptchaSolution | null,
  ): Promise<void> {
    if (!solution) return;
    switch (info.type) {
      case 'recaptcha_v2': {
        const token = solution.token;
        if (!token) return;
        const responseInput =
          document.querySelector<HTMLTextAreaElement>(
            'textarea[name="g-recaptcha-response"]',
          ) ||
          CaptchaHandler.createHiddenInput('g-recaptcha-response');
        responseInput.value = token;

        // Restrict message to same origin (avoid leaking tokens)
        try {
          window.postMessage(
            { event: 'captchaSolved', response: token },
            location.origin,
          );
        } catch {
          // ignore
        }
        break;
      }
      case 'hcaptcha': {
        const token = solution.token;
        if (!token) return;
        const input =
          document.querySelector<HTMLTextAreaElement>(
            'textarea[name="h-captcha-response"]',
          ) ||
          CaptchaHandler.createHiddenInput('h-captcha-response');
        input.value = token;
        break;
      }
      case 'text': {
        if (info.element && solution.text) {
          (info.element as HTMLInputElement).value = solution.text;
        }
        break;
      }
      default:
        break;
    }
  }

  /* Orchestrator: detects, solves and injects */
  static async handleChallenge(): Promise<boolean> {
    try {
      const captchaInfo = CaptchaHandler.detect();
      if (captchaInfo.type === 'none') return false;

      const solution = await CaptchaHandler.solve(captchaInfo);
      await CaptchaHandler.injectSolution(captchaInfo, solution);

      return !!solution;
    } catch {
      return false;
    }
  }

  /* Fallback manual solution prompt */
  private static async useFallback(
    info: CaptchaInfo,
  ): Promise<CaptchaSolution | null> {
    const userInput = window.prompt(
      'CAPTCHA detected but automatic solving failed. Please enter the solution manually:',
    );
    if (!userInput) return null;

    if (info.type === 'text') return { type: 'text', text: userInput };
    return { type: info.type, token: userInput };
  }

  /* Helpers */
  private static delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  private static buildFormPayload(data: Record<string, any>): RequestInit {
    const body = Object.entries(data)
      .map(
        ([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join('&');
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    };
  }

  private static async getSolverApiKey(): Promise<string | null> {
    try {
      if (
        typeof browser !== 'undefined' &&
        browser.storage?.local?.get instanceof Function
      ) {
        const result = await browser.storage.local.get(CONFIG_KEY);
        if (result?.[CONFIG_KEY]) return result[CONFIG_KEY];
      } else if (
        typeof chrome !== 'undefined' &&
        chrome.storage?.local?.get instanceof Function
      ) {
        const key = await new Promise<string | null>((resolve) => {
          chrome.storage.local.get([CONFIG_KEY], (res) =>
            resolve(res?.[CONFIG_KEY] ?? null),
          );
        });
        if (key) return key;
      }
    } catch {
      // ignore
    }
    return localStorage.getItem(CONFIG_KEY);
  }

  private static createHiddenInput(name: string): HTMLTextAreaElement {
    const textarea = document.createElement('textarea');
    textarea.name = name;
    textarea.style.display = 'none';
    document.body.appendChild(textarea);
    return textarea;
  }

  private static extractImageSrc(
    el: HTMLElement | null | undefined,
  ): string | null {
    if (!el) return null;
    const img = el.closest('form')?.querySelector('img');
    return img?.src ?? null;
  }

  private static async imageToBase64(url: string): Promise<string> {
    try {
      const blob = await fetch(url).then((r) => r.blob());
      return new Promise<string>((res, rej) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          res(result.split(',')[1]);
        };
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
    } catch {
      return '';
    }
  }
}

export default CaptchaHandler;