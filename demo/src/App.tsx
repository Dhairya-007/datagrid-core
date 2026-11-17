import { useEffect, useState } from 'react';
import { OrdersView } from './views/OrdersView';
import { ServerView } from './views/ServerView';
import { TreeView } from './views/TreeView';

const TABS = [
  {
    id: 'orders',
    label: 'In memory',
    blurb: 'Up to 100,000 rows, every local feature',
  },
  {
    id: 'server',
    label: 'Server-backed',
    blurb: 'Debounce, cancellation, paging, optimistic writes',
  },
  { id: 'tree', label: 'Tree rows', blurb: 'A flat list with a parent reference' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** If the engine saved you a week, this is where to say thank you. */
function Support() {
  const [copied, setCopied] = useState(false);
  const upi = 'ozadhairya73@oksbi';
  return (
    <span className="support">
      Support this work · UPI
      <button
        className="support-id"
        title="Copy the UPI ID"
        onClick={() => {
          void navigator.clipboard?.writeText(upi);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <code>{upi}</code>
        <i>{copied ? 'copied' : 'copy'}</i>
      </button>
    </span>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>('orders');
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('datagrid-core-demo.theme') as 'dark' | 'light') ?? 'dark',
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('datagrid-core-demo.theme', theme);
  }, [theme]);

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>datagrid-core</h1>
            <p>
              A headless data grid engine. Everything on this page is rendered by
              about 1,200 lines of plain React — the grid itself draws nothing.
            </p>
          </div>
        </div>

        <div className="masthead-right">
          <a
            className="link"
            href="https://github.com/Dhairya-007/datagrid-core"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a
            className="link"
            href="https://www.npmjs.com/package/datagrid-core"
            target="_blank"
            rel="noreferrer"
          >
            npm
          </a>
          <a
            className="link"
            href="https://github.com/Dhairya-007/datagrid-core/tree/main/demo"
            target="_blank"
            rel="noreferrer"
          >
            This demo's source
          </a>
          <button
            className="theme"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="Switch theme"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            className={tab === candidate.id ? 'on' : ''}
            onClick={() => setTab(candidate.id)}
          >
            <b>{candidate.label}</b>
            <span>{candidate.blurb}</span>
          </button>
        ))}
        <code className="install">npm install datagrid-core</code>
      </nav>

      {tab === 'orders' ? <OrdersView /> : null}
      {tab === 'server' ? <ServerView /> : null}
      {tab === 'tree' ? <TreeView /> : null}

      <footer className="footer">
        <span>
          MIT · no runtime dependencies · a TypeScript port of{' '}
          <a href="https://github.com/Dhairya-007/lattice" target="_blank" rel="noreferrer">
            lattice_core
          </a>
        </span>
        <span>The data is generated in the browser from a fixed seed.</span>
        <Support />
      </footer>
    </div>
  );
}
