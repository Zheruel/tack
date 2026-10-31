import { createRoot } from 'react-dom/client';
import { App } from '../../../web/src/App';
import { startSync, useApp } from '../../../web/src/store';
import { items, projects, threads, models, threadId } from './fixture';
import './styles.css';
localStorage.setItem('tack.sidebarWidth', '224');
useApp.setState({ ready: true, projects, threads: Object.fromEntries(threads.map(t => [t.id, t])), models, activeThreadId: threadId, sidebar: true, details: false, detailsPeek: false, browserOpen: false, transcripts: { [threadId]: { order: items.map(i => i.id), byId: Object.fromEntries(items.map(i => [i.id, i])) } }, clis: {} });
startSync();
createRoot(document.getElementById('root')!).render(<App />);
