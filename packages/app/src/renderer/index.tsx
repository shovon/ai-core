// Composition root for the page: the one place that reads the bridge. Every
// view below is handed what it calls, so none of them knows about `window`.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App/App.tsx';
// KaTeX ships its own stylesheet and fonts; rendered math is unreadable
// without it. Before index.css, so the app's own rules win.
import 'katex/dist/katex.min.css';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root was not found in index.html');

const { threads } = window.agent;

createRoot(container).render(
  <StrictMode>
    <App threads={threads} />
  </StrictMode>,
);
