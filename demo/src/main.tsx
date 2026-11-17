import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('No #root element to mount into');

// No StrictMode: it mounts twice in development, and a controller is a live
// object with a data source behind it rather than a value to be rebuilt.
createRoot(host).render(<App />);
