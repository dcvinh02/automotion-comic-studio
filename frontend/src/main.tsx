import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useLocaleStore } from './i18n/useLocaleStore';
import { OffscreenRenderWorker } from './renderer/OffscreenRenderWorker';
import './styles/studio.css';

if (typeof document !== 'undefined') {
  document.documentElement.lang = useLocaleStore.getState().locale;
}

const params = new URLSearchParams(window.location.search);
const isRenderWorker = params.get('mode') === 'render-worker';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isRenderWorker ? <OffscreenRenderWorker /> : <App />}
  </React.StrictMode>,
);
