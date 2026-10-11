import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import App from './App.tsx';
import MaintenancePage from './MaintenancePage.tsx';
import './index.css';

// Set to true for maintenance mode.
// Set to false to restore the booking website.
const MAINTENANCE_MODE = false;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {MAINTENANCE_MODE ?(
      <MaintenancePage/>
    ):(
    <BrowserRouter>
      <App />
    </BrowserRouter>
    )}
  </StrictMode>,
);



