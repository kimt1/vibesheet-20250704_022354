import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { EventEmitter } from 'events';

// --- Type Definitions for context ---
type Config = Record<string, any>;
type Primitive = string | number | boolean | null;
type WatchCallback = (config: Config) => void;


const state: {
  config: Config;
  emitter: EventEmitter;
  watchers: Map<string, fs.FSWatcher>;
} = {
  config: {},
  emitter: new EventEmitter(),
  watchers: new Map(),
};

/**
 * Strip C-style and // comments from JSON strings.
 */
function stripJsonComments(data: string): string {
  return data.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim();
}

/**
 * Deep-merge helper ? merges `source` into `target` (mutates target) and returns it.
 * Cyclic structures are guarded against via a WeakMap.
 */
function deepMerge<T extends Config, U extends Config>(
  target: T,
  source: U,
  seen: WeakMap<object, any> = new WeakMap()
): T & U {
  // Primitive or functions ? just override
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    source instanceof Date
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.assign(target as any, source) as T & U;
  }

  // Prevent cyclic references
  if (seen.has(source)) {
    return seen.get(source);
  }
  seen.set(source, target);

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (target as Config)[key];

    if (
      srcVal &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      !(srcVal instanceof Date)
    ) {
      (target as Config)[key] = deepMerge(
        (tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
          ? { ...tgtVal }
          : {}) as Config,
        srcVal as Config,
        seen
      );
    } else {
      (target as Config)[key] = srcVal;
    }
  }

  return target as T & U;
}

/**
 * Safely access nested values via dot-notation.
 */
function getNested(obj: Config, keyPath: string): any {
  return keyPath.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

/**
 * Parse file contents based on extension.
 */
function parseConfigFile(filePath: string, data: string): Config {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yml' || ext === '.yaml') {
    return (yaml.load(data) as Config) || {};
  }
  // Default to JSON / JSONC
  return JSON.parse(stripJsonComments(data) || '{}');
}

/**
 * Validate basic shape of the configuration (object, not null).
 * Placeholder for more advanced schema validation.
 */
export function validate(config: Config): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Configuration must be a non-null object.');
  }
}

/**
 * Load a configuration file and merge into current state.
 */
export function load(filePath: string): Config {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseConfigFile(filePath, raw);
  validate(parsed);
  state.config = deepMerge({ ...state.config }, parsed);
  return state.config;
}

/**
 * Merge helper exposed publicly.
 */
export function merge<T extends Config, U extends Config>(base: T, overrides: U): T & U {
  return deepMerge({ ...base }, overrides);
}

/* -------------------------------------------------------------------------- */
/* Watch                                    */
/* -------------------------------------------------------------------------- */

/**
 * Watch a configuration file for changes. Each change reloads the file,
 * merges into the active config, and invokes provided callback.
 * Returns an unsubscribe handle with a close() method.
 */
export function watch(filePath: string, callback?: WatchCallback): { close: () => void } {
  if (state.watchers.has(filePath)) {
    return {
      close: () => unwatch(filePath),
    };
  }

  const reload = () => {
    try {
      const updated = load(filePath);
      callback?.(updated);
      state.emitter.emit('update', updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to reload config "${filePath}":`, err);
    }
  };

  const watcher = fs.watch(
    filePath,
    { persistent: false },
    (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        reload();
      }
    }
  );
  // Initial load to ensure config is populated and callback fired
  reload();

  state.watchers.set(filePath, watcher);
  return {
    close: () => unwatch(filePath),
  };
}

/**
 * Stop watching a specific file or all files.
 */
export function unwatch(filePath?: string): void {
  if (filePath) {
    const watcher = state.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      state.watchers.delete(filePath);
    }
  } else {
    for (const [key, watcher] of state.watchers) {
      watcher.close();
      state.watchers.delete(key);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Accessors                                   */
/* -------------------------------------------------------------------------- */

/**
 * Retrieve a configuration value using dot notation.
 * Returns undefined if key is absent.
 */
export function get<T = Primitive | Config>(key: string): T | undefined {
  return getNested(state.config, key) as T | undefined;
}

/**
 * Public event emitter for external listeners.
 * Example: events.on('update', (cfg) => {...})
 */
export const events = state.emitter;