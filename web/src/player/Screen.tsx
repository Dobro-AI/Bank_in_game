import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackIcon } from './icons';

export function ScreenHeader({ title, back }: { title: ReactNode; back?: string | true }) {
  const nav = useNavigate();
  return (
    <header className="screen-header">
      {back && (
        <button className="icon-btn" aria-label="Назад" onClick={() => (back === true ? nav(-1) : nav(back))}><BackIcon /></button>
      )}
      <h1>{title}</h1>
    </header>
  );
}
