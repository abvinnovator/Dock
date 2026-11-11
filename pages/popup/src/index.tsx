import '@src/index.css';
import Popup from '@src/Popup';
import { createRoot } from 'react-dom/client';

const init = () => {
  const appContainer = document.querySelector('#app-container');
  if (!appContainer) {
    throw new Error('Can not find #app-container');
  }

  // The same page serves the toolbar popup (fixed size), the side panel and a
  // full tab (fluid); CSS keys off this attribute.
  const isToolbarPopup = chrome.extension.getViews({ type: 'popup' }).includes(window);
  document.documentElement.dataset.surface = isToolbarPopup ? 'popup' : 'page';

  const root = createRoot(appContainer);
  root.render(<Popup />);
};

init();
