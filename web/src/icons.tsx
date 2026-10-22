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
export const ChartIcon = () => <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
export const UsersIcon = () => <Svg><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .8 3.2 2.6 3.5 5.5" /></Svg>;
export const AdjustIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></Svg>;
export const FlagIcon = () => <Svg><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></Svg>;
export const SparkIcon = () => <Svg><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></Svg>;
export const GearIcon = () => <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>;
export const BadgeIcon = () => <Svg><rect x="4" y="3" width="16" height="18" rx="3" /><circle cx="12" cy="10" r="3" /><path d="M8 17c.8-1.6 2.2-2.5 4-2.5s3.2.9 4 2.5" /></Svg>;
export const BranchIcon = () => <Svg><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-11.5 7" /></Svg>;
export const GridIcon = () => <Svg><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Svg>;
export const LogoutIcon = () => <Svg><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" /></Svg>;
export const BoxIcon = () => <Svg><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></Svg>;
export const TableIcon = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14.5h18M9 9v11" /></Svg>;
