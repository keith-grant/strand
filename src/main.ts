import {startApp} from './app';
import './style.css';

// Test mode (vite --mode test, used by the acceptance tests) runs in a plain browser with a fake desktop side.
// Neither branch is included in real builds.
if (import.meta.env.MODE === 'test') (await import('./testing/fake-tauri')).installFakeTauri();
const app = startApp(document.querySelector<HTMLDivElement>('#app')!);
if (import.meta.env.MODE === 'test') (await import('./testing/hooks')).installHooks(app);
