import { EventEmitter } from 'events';
import { chromium, Browser, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return false;
  const str = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(str);
}

/* ?????????????????????????????????????????????????????????????????????????? */
/* FormFillerRunner                                                         */
/* ?????????????????????????????????????????????????????????????????????????? */

export class FormFillerRunner extends EventEmitter {
  private readonly mapping: Record<string, MappingEntry>;
  private readonly rows: Row[];
  private readonly options: RunnerOptions;

  private browser!: Browser;
  private page!: Page;
  private aborted = false;

  constructor(
    mapping: Record<string, MappingEntry>,
    rows: Row[],
    options: RunnerOptions = {},
  ) {
    super();
    this.mapping = mapping;
    this.rows = rows;
    this.options = options;
  }

  /* Entry point */
  public async run(): Promise<void> {
    try {
      this.browser = await chromium.launch(
        this.options.browserLaunchOptions ?? {},
      );

      for (const row of this.rows) {
        if (this.aborted) break;

        this.emit('row-start', row);
        try {
          if (this.options.freshPagePerRow || !this.page) {
            if (this.page) await this.page.close();
            this.page = await this.browser.newPage();
          }

          await this.navigate(row);
          const result = await this.fillRow(row);

          if (!this.aborted) {
            result.artifacts = await this.captureArtifacts(row.id);
            await this.writeBackResult(row.id, result);
            this.emit('row-done', row, result);
          }
        } catch (err) {
          /* Capture fatal row-level errors */
          const result: FillResult = {
            success: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
          if (!this.aborted) {
            result.artifacts = await this.captureArtifacts(row.id);
            await this.writeBackResult(row.id, result);
            this.emit('row-done', row, result);
          }
        }
      }
    } finally {
      await this.dispose();
    }
  }

  /* ????????????????????????? Private helpers ???????????????????????????? */

  /** Throws if abort requested */
  private ensureNotAborted(): void {
    if (this.aborted) throw new Error('Aborted');
  }

  /** Fills a single row and returns success / error info */
  private async fillRow(row: Row): Promise<FillResult> {
    const errors: string[] = [];
    for (const key of Object.keys(this.mapping)) {
      this.ensureNotAborted();

      const entry = this.mapping[key];
      const value = row.data[entry.valueColumn];

      try {
        await this.page.waitForSelector(entry.selector, {
          timeout: 5000,
        });
        const el = await this.page.$(entry.selector);
        if (!el)
          throw new Error(`Element not found for selector ${entry.selector}`);

        switch (entry.type) {
          case 'checkbox':
          case 'radio': {
            const isChecked = await el.isChecked();
            const shouldBeChecked = parseBoolean(value);
            if (shouldBeChecked !== isChecked) {
              await el.click({ delay: this.humanDelay() });
            }
            break;
          }
          case 'select': {
            await el.selectOption(String(value));
            break;
          }
          default: {
            await el.fill(String(value ?? ''), { timeout: 5000 });
          }
        }
      } catch (err: any) {
        errors.push(`Field "${key}" -> ${err.message ?? String(err)}`);
      }
    }

    return {
      success: errors.length === 0,
      errors: errors.length ? errors : undefined,
    };
  }

  /** Takes screenshot & html snapshot, returns map rowId -> artifactPath */
  private async captureArtifacts(
    rowId: string | number,
  ): Promise<Record<string, string>> {
    const artifacts: Record<string, string> = {};
    if (!this.options.artifactsDir) return artifacts;

    const base = path.join(this.options.artifactsDir, String(rowId));
    try {
      await fs.promises.mkdir(path.dirname(base), { recursive: true });
    } catch {
      /* ignore dir creation errors */
    }

    try {
      const screenshotPath = `${base}.png`;
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      artifacts.screenshot = screenshotPath;
    } catch {
      /* no-op */
    }

    try {
      const htmlPath = `${base}.html`;
      const content = await this.page.content();
      await fs.promises.writeFile(htmlPath, content, 'utf8');
      artifacts.html = htmlPath;
    } catch {
      /* no-op */
    }

    return artifacts;
  }

  /** Writes result back (stub ? extend with Sheets/DB integration) */
  private async writeBackResult(
    rowId: string | number,
    result: FillResult,
  ): Promise<void> {
    const logFile = path.resolve('fill-results.log');
    const logLine = JSON.stringify({ rowId, ...result });

    try {
      await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
      await fs.promises.appendFile(logFile, logLine + '\n', 'utf8');
    } catch (err) {
      /* Log I/O failure to console but do not crash the runner */
      console.error('Failed to write result:', err);
    }
  }

  /** Allows external caller to abort current processing queue */
  public abort(): void {
    this.aborted = true;
    this.emit('abort');
  }

  /** Gracefully closes playwright resources */
  private async dispose(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
      if (this.browser && this.browser.isConnected()) await this.browser.close();
    } catch {
      /* ignore */
    }
  }

  /** Internal helper to navigate to correct URL */
  private async navigate(row: Row): Promise<void> {
    this.ensureNotAborted();
    const targetUrl = row.url ?? this.options.defaultUrl;
    if (!targetUrl) {
      throw new Error('No target URL specified');
    }

    if (this.page.url() === targetUrl) return;

    const timeout = this.options.navigationTimeoutMs ?? 30000;
    // Attempt navigation in shorter chunks to allow early aborts
    const step = Math.min(timeout, 5000);
    let elapsed = 0;
    while (!this.aborted) {
      try {
        await this.page.goto(targetUrl, { timeout: step });
        break; // success
      } catch (err) {
        elapsed += step;
        if (elapsed >= timeout) throw err; // propagate original error
      }
    }

    this.ensureNotAborted();
    await this.page.waitForLoadState('networkidle');
  }

  /** Returns a pseudo-random human-like typing delay */
  private humanDelay(): number {
    return 50 + Math.floor(Math.random() * 150);
  }
}