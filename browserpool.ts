import puppeteer, { Browser, LaunchOptions } from 'puppeteer';

export interface BrowserPoolOptions extends LaunchOptions {
  /**
   * If `true`, the pool will pre-launch browsers up to its capacity so the first
   * `acquire()` calls never wait.
   */
  prewarm?: boolean;

  /**
   * When provided, a function that will be called whenever a browser unexpectedly
   * disconnects or closes, giving consumers a chance to act on it.
   */
  onBrowserClosed?: (browser: Browser, hadError: boolean) => void;
}

interface PoolStats {
  total: number;       // all browsers (idle + busy)
  idle: number;        // ready to be acquired
  busy: number;        // currently leased out
  queued: number;      // pending acquire() calls
  capacity: number;    // configured pool size
  shuttingDown: boolean;
}

type Waiter = {
  resolve: (browser: Browser) => void;
  reject: (err: Error) => void;
};

export default class BrowserPool {
  private readonly size: number;
  private readonly opts: BrowserPoolOptions;
  private readonly all = new Set<Browser>();
  private readonly idle: Browser[] = [];
  private readonly queue: Waiter[] = [];
  private shuttingDown = false;

  private constructor(size: number, opts: BrowserPoolOptions = {}) {
    if (size <= 0 || !Number.isInteger(size)) {
      throw new Error('BrowserPool size must be a positive integer.');
    }
    this.size = size;
    this.opts = { ...opts };
  }

  // PUBLIC FACTORY -----------------------------------------------------------

  static async createPool(
    size: number,
    opts: BrowserPoolOptions = {}
  ): Promise<BrowserPool> {
    const pool = new BrowserPool(size, opts);
    if (opts.prewarm) {
      const launches: Promise<void>[] = [];
      while (pool.all.size < pool.size) {
        launches.push(pool.launchAndStore().then(() => undefined));
      }
      await Promise.all(launches);
    }

    return pool;
  }

  // PUBLIC API ---------------------------------------------------------------

  /**
   * Lease a browser from the pool. The returned promise resolves when a
   * browser is available.
   */
  async acquire(): Promise<Browser> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('BrowserPool is shutting down.'));
    }

    // If an idle, connected browser exists, hand it over immediately.
    while (this.idle.length > 0) {
      const candidate = this.idle.pop() as Browser;
      if (candidate.isConnected()) {
        return candidate;
      }
      await this.safeClose(candidate);
    }

    // If capacity allows, launch a new one.
    if (this.all.size < this.size) {
      return this.launchAndStore();
    }

    // Otherwise, enqueue the request.
    return new Promise<Browser>((resolve, reject) =>
      this.queue.push({ resolve, reject })
    );
  }

  /**
   * Release a browser back to the pool.
   */
  release(browser: Browser): void {
    if (!this.all.has(browser)) {
      // Silently ignore unknown browsers.
      return;
    }

    // If pool is shutting down, close immediately.
    if (this.shuttingDown) {
      void this.safeClose(browser);
      return;
    }

    // Browser already dead? Close & replace if someone is waiting.
    if (!browser.isConnected()) {
      void this.safeClose(browser);
      const waiter = this.queue.shift();
      if (waiter) {
        this.launchAndStore().then(waiter.resolve).catch(waiter.reject);
      }
      return;
    }

    // Fulfil next waiter if any; otherwise keep browser idle.
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.resolve(browser);
    } else {
      this.idle.push(browser);
    }
  }

  /**
   * Close all browsers and reject queued acquirers.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Reject waiters.
    while (this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.reject(new Error('BrowserPool shut down'));
    }

    // Close all known browsers.
    const closing: Promise<void>[] = [];
    for (const browser of this.all) {
      closing.push(this.safeClose(browser));
    }
    await Promise.allSettled(closing);
    // Clean state.
    this.all.clear();
    this.idle.length = 0;
  }

  /**
   * Retrieve runtime statistics for introspection/monitoring.
   */
  stats(): PoolStats {
    return {
      total: this.all.size,
      idle: this.idle.length,
      busy: this.all.size - this.idle.length,
      queued: this.queue.length,
      capacity: this.size,
      shuttingDown: this.shuttingDown
    };
  }

  // INTERNALS ----------------------------------------------------------------

  private async launchAndStore(): Promise<Browser> {
    const browser = await puppeteer.launch(this.opts);
    this.all.add(browser);
    // Cleanup raised when browser closes unexpectedly.
    browser.on('disconnected', () => {
      this.all.delete(browser);
      const idx = this.idle.indexOf(browser);
      if (idx !== -1) {
        this.idle.splice(idx, 1);
      }
      const hadError = (browser as any)._process?.exitCode !== 0;
      this.opts.onBrowserClosed?.(browser, hadError);

      // If a waiter exists, try to replace closed browser with a new one.
      if (!this.shuttingDown && this.queue.length) {
        this.launchAndStore()
          .then((b) => {
            const waiter = this.queue.shift();
            waiter?.resolve(b);
          })
          .catch((err) => {
            const waiter = this.queue.shift();
            waiter?.reject(err);
          });
      }
    });

    return browser;
  }

  private async safeClose(browser: Browser): Promise<void> {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    this.all.delete(browser);
    const idx = this.idle.indexOf(browser);
    if (idx !== -1) {
      this.idle.splice(idx, 1);
    }
  }
}