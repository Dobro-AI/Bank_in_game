import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { PlayerApp } from './player/PlayerApp';
import { AdminApp } from './admin/AdminApp';
import './styles.css';

function Landing() {
  return (
    <main className="page narrow center-page">
      <h1>Игровой банк</h1>
      <p className="muted">Виртуальные деньги для вашей игры</p>
      <div className="stack">
        <Link className="btn primary block" to="/play">Я игрок</Link>
        <Link className="btn block" to="/admin">Вход для ведущих</Link>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/play/*" element={<PlayerApp />} />
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
