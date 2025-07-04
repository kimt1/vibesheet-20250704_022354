export interface AuditLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: unknown;
}

export interface AuditLoggerOptions {
  /**
   * Maximum number of log entries to keep in memory.
   * Older entries are discarded once the limit is exceeded.
   * `undefined` ? unlimited.
   */
  maxEntries?: number;
  /**
   * Where log lines should be written.
   * - "console" (default)  ? forward to `console.*`
   * - "silent"            ? keep in memory only
   */
  output?: 'console' | 'silent';
  /**
   * Optional callback invoked for every log entry.
   */
  onLog?(entry: AuditLogEntry): void;
}

/**
 * Simple in-memory audit logger.
 *
 * Provides very lightweight logging that can be shared across the project
 * without pulling in a full-blown logging dependency.
 */
export class AuditLogger {
  private readonly entries: AuditLogEntry[] = [];
  constructor(private readonly opts: AuditLoggerOptions = {}) {}

  info(message: unknown, meta?: unknown): void {
    this.write('info', message, meta);
  }

  warn(message: unknown, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  error(message: unknown, meta?: unknown): void {
    this.write('error', message, meta);
  }

  /**
   * Returns a shallow copy of the currently buffered log entries.
   */
  getLogs(): AuditLogEntry[] {
    return [...this.entries];
  }

  /**
   * Clears the in-memory log buffer.
   */
  clear(): void {
    this.entries.length = 0;
  }

  private write(level: AuditLogEntry['level'], message: unknown, meta?: unknown): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: typeof message === 'string' ? message : String(message),
      meta,
    };

    /* istanbul ignore next -- trivial console passthrough */
    if (this.opts.output !== 'silent') {
      const parts: unknown[] = [`[${level.toUpperCase()}]`, entry.timestamp, entry.message];
      if (meta !== undefined) parts.push(meta);
      // eslint-disable-next-line no-console
      (console as Record<string, (...args: unknown[]) => void>)[level](...parts);
    }

    if (this.opts.onLog) {
      try {
        this.opts.onLog(entry);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[AuditLogger] onLog callback failed:', err);
      }
    }

    this.entries.push(entry);

    if (this.opts.maxEntries && this.entries.length > this.opts.maxEntries) {
      this.entries.splice(0, this.entries.length - this.opts.maxEntries);
    }
  }
}

/**
 * A convenient shared singleton.
 * Import via:
 * import auditLogger from './auditlogger';
 */
const defaultAuditLogger = new AuditLogger();
export default defaultAuditLogger;