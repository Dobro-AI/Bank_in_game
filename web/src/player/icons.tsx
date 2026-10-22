// Stroke icons, 24×24, inherit currentColor.
import type { ReactNode } from 'react';
const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const HomeIcon = () => <Svg><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /></Svg>;
export const TransferIcon = () => <Svg><path d="M4 8h14l-4-4" /><path d="M20 16H6l4 4" /></Svg>;
export const HistoryIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const MoreIcon = () => <Svg><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Svg>;
export const BackIcon = () => <Svg><path d="M15 5l-7 7 7 7" /></Svg>;
export const SearchIcon = () => <Svg><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const CheckIcon = () => <Svg><path d="m5 12 5 5 9-10" /></Svg>;
export const ChevronIcon = () => <Svg><path d="m9 5 7 7-7 7" /></Svg>;
export const BuildingIcon = () => <Svg><path d="M4 21V5l8-2v18" /><path d="M12 9l8 2v10" /><path d="M2 21h20" /></Svg>;
