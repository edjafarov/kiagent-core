import { createRoot } from 'react-dom/client';
import '@shared/web-ui/tokens.css';
import '@shared/web-ui/components.css';
import '@shared/web-ui/Spark.css';
import './App.css';
import App from './App';

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);

// The preload exposes the IPC bridge as window.kiagent. On a normal launch
// it's present before this script runs, but during an Electron dev
// hot-restart the sandboxed preload can intermittently fail to run, leaving
// the bridge absent — every IPC call would then throw and the renderer
// white-screens with a raw stack. Gate the boot on the bridge: wait briefly
// for it to appear, then start; if it never does, render an actionable
// reconnect screen rather than a blank window.
const BRIDGE_WAIT_MS = 3000;
const BRIDGE_POLL_MS = 100;

function boot(): void {
  root.render(<App />);
}

function renderBridgeUnavailable(): void {
  root.render(
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
        background: '#2e1065',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 600 }}>
        Couldn’t connect to KIAgent
      </div>
      <div style={{ opacity: 0.8, maxWidth: 360, fontSize: 13 }}>
        The app’s background bridge didn’t load for this window. Reopening the
        window usually fixes it.
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: 8,
          padding: '8px 16px',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.4)',
          background: 'transparent',
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        Reload
      </button>
    </div>,
  );
}

if (window.kiagent) {
  boot();
} else {
  const start = Date.now();
  const timer = setInterval(() => {
    if (window.kiagent) {
      clearInterval(timer);
      boot();
    } else if (Date.now() - start > BRIDGE_WAIT_MS) {
      clearInterval(timer);
      renderBridgeUnavailable();
    }
  }, BRIDGE_POLL_MS);
}
