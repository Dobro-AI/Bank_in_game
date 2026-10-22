export interface Me { playerId: number; roleId: number; gameId: number; firstName: string; lastName: string; roleTitle: string; gameTitle: string }
export interface Member { roleId: number; roleTitle: string; playerName: string; member: 'owner' | 'coowner'; pinOk: boolean }
export interface Account { id: number; kind: string; title: string; balance: number; member: 'owner' | 'coowner'; pinOk: boolean; members: Member[] }
export interface Recipient { id: number; kind: string; title: string }
export interface PriceItem { id: number; title: string; price: number }
export interface Operation {
  id: number; created_at: string; tact: number; kind: string; amount: number; comment: string;
  from_account_id: number; from_title: string; to_account_id: number; to_title: string; initiator: string;
}

export const canSpend = (a: Account) => a.member === 'owner' || a.pinOk;
export const memberName = (m: Member) => (m.playerName ? `${m.playerName} (${m.roleTitle})` : m.roleTitle);
export const recipientTitle = (r: Recipient) => (r.kind === 'host' ? 'Игротехник' : r.title);
export const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
