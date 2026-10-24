import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PlayerApp } from './player/PlayerApp';
import { AdminApp } from './admin/AdminApp';
import './styles.css';
import './bank.css';

// The site opens straight into the player's bank; game masters use their own address, /admin.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/play/*" element={<PlayerApp />} />
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="*" element={<Navigate to="/play" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
