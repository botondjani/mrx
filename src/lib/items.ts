import type { ItemKind } from './supabase';

export const ITEMS: Record<ItemKind, { label: string; help: string; role: 'detective' | 'mrx' }> = {
  radar: { label: 'Radar', help: 'Mr. X azonnal felfedődik.', role: 'detective' },
  tracker: { label: 'Nyomkövető', help: 'Mr. X 60 másodpercig élőben látszik.', role: 'detective' },
  compass: { label: 'Iránytű', help: 'Megmutatja, merre és nagyjából milyen messze van Mr. X.', role: 'detective' },
  decoy: { label: 'Csali', help: 'A következő felfedés egy általad kijelölt hamis pontot mutat (300 m-en belül).', role: 'mrx' },
  fog: { label: 'Köd', help: 'A következő időzített felfedés kimarad.', role: 'mrx' },
  hide: { label: 'Rejtőzködés', help: '2 percig a radar, a nyomkövető és az iránytű hatástalan rád.', role: 'mrx' },
  jam: { label: 'Zavarás', help: '1 percig a detektívek nem látják egymást a térképen.', role: 'mrx' },
};

export const ITEM_KINDS = Object.keys(ITEMS) as ItemKind[];
