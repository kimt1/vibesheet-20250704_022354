const STORAGE_KEY = 'omniForm_state';
const ALARM_PREFIX = 'job_';

const runtime = chrome ?? (globalThis as any).browser;

/* -------------  TYPES ------------- */

interface JobConfig {
  id: string;
  runAt?: number; // epoch ms
  cron?: string;
}

interface ExtensionState {
  jobs: Record<string, JobConfig>;
}

/* -------------  MUTEX ------------- */

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(this.release.bind(this));
        } else {
          this.waiters.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const stateMutex = new Mutex();

/* -------------  INITIALISATION ------------- */

initBackground();

function initBackground(): void {
  runtime.runtime.onInstalled.addListener(handleInstalled);
  runtime.runtime.onMessage.addListener(handleMessage);
  runtime.alarms.onAlarm.addListener(onAlarm);

  if (!runtime.contextMenus.onClicked.hasListener(onContextMenuClicked)) {
    runtime.contextMenus.onClicked.addListener(onContextMenuClicked);
  }

  createContextMenus().catch(console.error);
}

/* -------------  LIFECYCLE ------------- */

async function handleInstalled(
  details: chrome.runtime.InstalledDetails
): Promise<void> {
  if (details.reason === 'install') {
    await resetState();
  }
}

/* -------------  MESSAGE HANDLER ------------- */

function handleMessage(
  message: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean | void {
  (async () => {
    switch (message?.type) {
      case 'SCHEDULE_JOB': {
        await scheduleJob(message.payload as JobConfig);
        sendResponse({ ok: true });
        break;
      }
      case 'CANCEL_JOB': {
        await cancelJob(message.payload?.id as string);
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATE': {
        const state = await getState();
        sendResponse({ ok: true, state });
        break;
      }
      case 'RESET_STATE': {
        await resetState();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })().catch((err) => {
    console.error(err);
    sendResponse({ ok: false, error: err?.message ?? String(err) });
  });
  // indicates async response
  return true;
}

/* -------------  ALARM SCHEDULING ------------- */

function validateJobConfig(jobConfig: JobConfig): void {
  if (!jobConfig.id) {
    throw new Error('JobConfig.id is required');
  }

  const hasFutureRunAt =
    jobConfig.runAt !== undefined && jobConfig.runAt > Date.now();

  const hasValidCron =
    jobConfig.cron !== undefined && cronToMinutes(jobConfig.cron) !== undefined;

  if (!hasFutureRunAt && !hasValidCron) {
    throw new Error(
      'JobConfig must provide a runAt timestamp in the future or a supported cron expression'
    );
  }

  if (jobConfig.runAt !== undefined && jobConfig.runAt <= Date.now()) {
    throw new Error('JobConfig.runAt must be a future timestamp');
  }
}

async function scheduleJob(jobConfig: JobConfig): Promise<void> {
  validateJobConfig(jobConfig);

  const release = await stateMutex.acquire();
  try {
    const state = await getState();
    state.jobs[jobConfig.id] = jobConfig;
    await saveState(state);

    const alarmName = ALARM_PREFIX + jobConfig.id;
    await runtime.alarms.clear(alarmName);

    if (jobConfig.runAt) {
      runtime.alarms.create(alarmName, { when: jobConfig.runAt });
    } else if (jobConfig.cron) {
      const periodInMinutes = cronToMinutes(jobConfig.cron);
      if (periodInMinutes) {
        runtime.alarms.create(alarmName, { periodInMinutes });
      }
    }
  } finally {
    release();
  }
}

async function cancelJob(id: string): Promise<void> {
  if (!id) return;

  const release = await stateMutex.acquire();
  try {
    const state = await getState();
    delete state.jobs[id];
    await saveState(state);
    await runtime.alarms.clear(ALARM_PREFIX + id);
  } finally {
    release();
  }
}

function cronToMinutes(cron: string): number | undefined {
  // extremely simplified: if cron is like "*/X * * * *" return X
  const match = cron.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return undefined;
}

/* -------------  ON ALARM ------------- */

async function onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const id = alarm.name.slice(ALARM_PREFIX.length);
  const state = await getState();
  const job = state.jobs[id];
  if (!job) return;

  try {
    // Forward the job to all tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        runtime.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_JOB',
          payload: job,
        });
      }
    }
  } catch (err) {
    console.error('Error executing job', err);
  }

  // If the job was one-shot (runAt) remove it after firing
  if (job.runAt && !job.cron) {
    await cancelJob(id);
  }
}

/* -------------  CONTEXT MENUS ------------- */

async function createContextMenus(): Promise<void> {
  runtime.contextMenus.removeAll(() => {
    runtime.contextMenus.create({
      id: 'reset_state',
      title: 'OmniForm ? Reset State',
      contexts: ['action'],
    });
  });
}

const onContextMenuClicked = async (
  info: chrome.contextMenus.OnClickData
): Promise<void> => {
  if (info.menuItemId === 'reset_state') {
    await resetState();
  }
};

/* -------------  STATE MANAGEMENT ------------- */

async function getState(): Promise<ExtensionState> {
  return new Promise<ExtensionState>((resolve) => {
    runtime.storage.local.get([STORAGE_KEY], (items) => {
      resolve(
        (items[STORAGE_KEY] as ExtensionState) ?? {
          jobs: {},
        }
      );
    });
  });
}

async function saveState(state: ExtensionState): Promise<void> {
  return new Promise<void>((resolve) => {
    runtime.storage.local.set({ [STORAGE_KEY]: state }, () => resolve());
  });
}

async function resetState(): Promise<void> {
  const release = await stateMutex.acquire();
  try {
    await new Promise<void>((resolve) => {
      runtime.storage.local.remove([STORAGE_KEY], () => resolve());
    });
    const alarms = await runtime.alarms.getAll({});
    for (const alarm of alarms) {
      if (alarm.name.startsWith(ALARM_PREFIX)) {
        await runtime.alarms.clear(alarm.name);
      }
    }
  } finally {
    release();
  }
}