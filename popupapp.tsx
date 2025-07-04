import React, { useState, useEffect, useRef, useCallback, MutableRefObject } from 'react';
import ReactDOM from 'react-dom/client';

// Define reusable types
type WizardStep = 'scan' | 'map' | 'run';
interface StepProps {
  onNext?: () => void;
  onPrev?: () => void;
}

/**
 * Custom hook to track whether the component is still mounted.
 * This prevents React state updates on unmounted components.
 */
function useIsMounted(): MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

/**
 * Global keyboard navigation handler for ?/?, Enter, Backspace, Esc.
 */
function useKeyboardNavigation(
  next?: () => void,
  prev?: () => void,
  enabled: boolean = true,
): void {
  const nextRef = useRef(next);
  const prevRef = useRef(prev);

  // Keep latest callbacks without re-registering listener each render
  useEffect(() => {
    nextRef.current = next;
    prevRef.current = prev;
  }, [next, prev]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;

      // Ignore when focus is on an input control or content-editable element
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag ?? '') ||
        target?.isContentEditable
      )
        return;

      switch (e.key) {
        case 'ArrowRight':
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          nextRef.current?.();
          break;
        case 'ArrowLeft':
        case 'Backspace':
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          prevRef.current?.();
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled]);
}

/* -------------------------------------------------------------------------- */
/* UI ? Step Components                           */
/* -------------------------------------------------------------------------- */

const ScanStep: React.FC<StepProps> = ({ onNext }) => {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const startScan = async () => {
    try {
      setIsScanning(true);
      // TODO: actual scanning logic (message to content script, etc.)
      await new Promise((r) => setTimeout(r, 1000));
      if (!isMounted.current) return;
      onNext?.();
    } catch (err) {
      if (!isMounted.current) return;
      setError(String(err));
    } finally {
      if (isMounted.current) setIsScanning(false);
    }
  };

  useKeyboardNavigation(onNext, undefined);

  return (
    <section className="step scan-step">
      <h2>1. Scan Page</h2>
      <p>
        This will analyse the current tab, traverse DOM & shadow DOM, and
        extract all fillable elements.
      </p>
      {error && (
        <div className="alert alert-error">
          <strong>Error:</strong> {error}
        </div>
      )}
      <button disabled={isScanning} onClick={startScan} className="btn primary">
        {isScanning ? 'Scanning?' : 'Start Scan'}
      </button>
    </section>
  );
};

const MapStep: React.FC<StepProps> = ({ onNext, onPrev }) => {
  const [mappings, setMappings] = useState<Record<string, string>>({});

  useKeyboardNavigation(onNext, onPrev);

  return (
    <section className="step map-step">
      <h2>2. Map Columns</h2>
      <p>
        Map each detected input to a column in your Google Sheet. Use keyboard
        ?/? to navigate.
      </p>

      {/* Placeholder mapping UI */}
      <pre className="mapping-preview">{JSON.stringify(mappings, null, 2)}</pre>

      <div className="actions">
        <button onClick={onPrev} className="btn secondary">
          ? Back
        </button>
        <button
          onClick={onNext}
          className="btn primary"
          disabled={Object.keys(mappings).length === 0}
        >
          Continue ?
        </button>
      </div>
    </section>
  );
};

const RunStep: React.FC<StepProps> = ({ onPrev }) => {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const isMounted = useIsMounted();

  const startRun = async () => {
    try {
      setRunning(true);
      setStatus('Filling forms?');
      // TODO: actual fill logic
      await new Promise((r) => setTimeout(r, 1500));
      if (!isMounted.current) return;
      setStatus('Completed successfully ?');
    } catch (err) {
      if (!isMounted.current) return;
      setStatus(`Failed: ${err}`);
    } finally {
      if (isMounted.current) setRunning(false);
    }
  };

  useKeyboardNavigation(undefined, onPrev);

  return (
    <section className="step run-step">
      <h2>3. Run</h2>
      <p>Execute the mapped filling procedure on the active tab.</p>

      {status && <div className="status">{status}</div>}

      <div className="actions">
        <button onClick={onPrev} className="btn secondary" disabled={running}>
          ? Back
        </button>
        <button onClick={startRun} className="btn success" disabled={running}>
          {running ? 'Running?' : 'Start'}
        </button>
      </div>
    </section>
  );
};

/* -------------------------------------------------------------------------- */
/* Root App                                   */
/* -------------------------------------------------------------------------- */

const App: React.FC = () => {
  const [step, setStep] = useState<WizardStep>('scan');

  const next = useCallback(() => {
    setStep((prev) => (prev === 'scan' ? 'map' : prev === 'map' ? 'run' : 'run'));
  }, [setStep]);

  const prev = useCallback(() => {
    setStep((prev) => (prev === 'run' ? 'map' : prev === 'map' ? 'scan' : 'scan'));
  }, [setStep]);

  return (
    <div className="popup-app">
      {step === 'scan' && <ScanStep onNext={next} />}
      {step === 'map' && <MapStep onNext={next} onPrev={prev} />}
      {step === 'run' && <RunStep onPrev={prev} />}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Bootstrapping                                */
/* -------------------------------------------------------------------------- */

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(<App />);
}