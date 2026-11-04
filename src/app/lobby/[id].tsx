import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, C, FONT, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePlayers, usePoints, useUserId } from '../../lib/hooks';
import { ITEM_KINDS, ITEMS } from '../../lib/items';
import { generatePoints } from '../../lib/points';
import { supabase } from '../../lib/supabase';

const ROLE_LABEL = { mrx: 'Mr. X', detective: 'detektív' } as const;

const chip = (label: string, active: boolean, onPress: () => void) => (
  <Pressable
    key={label}
    onPress={onPress}
    hitSlop={4}
    style={{ paddingVertical: 5, paddingHorizontal: 9, borderRadius: 5, borderWidth: 1, borderColor: C.gold, backgroundColor: active ? C.gold : 'transparent' }}
  >
    <Text style={{ color: active ? C.bg : C.gold, fontFamily: FONT, fontSize: 13 }}>{label}</Text>
  </Pressable>
);

const row = (label: string, children: ReactNode) => (
  <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <Text style={[ui.muted, { width: 86, fontSize: 13 }]}>{label}</Text>
    <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{children}</View>
  </View>
);

export default function Lobby() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const points = usePoints(id);
  const userId = useUserId();
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isHost = !!game && game.host_user_id === userId;

  useEffect(() => {
    if (game?.status === 'running') router.replace(`/game/${id}`);
  }, [game?.status, id]);

  async function call(fn: string, args: Record<string, unknown>) {
    setError(null);
    const { error } = await supabase.rpc(fn, args);
    if (error) setError(huError(error));
    return !error;
  }
  const set = (options: Record<string, unknown>) => call('set_options', { p_game: id, p_options: options });

  if (!game) return <View style={ui.screen} />;
  const cfg = game.config;
  const minPlayers = cfg.min_players as number;
  const zonePct = (cfg.zone_final_pct as number | undefined) ?? 100;
  const powerups = cfg.powerups_enabled !== false;
  const enabled = (cfg.items ?? {}) as Record<'detective' | 'mrx', string[]>;
  const hasArea = game.center_lat != null && game.center_lng != null;

  // Points live on the area: changing their count or switching power-ups re-draws them at once.
  async function setAndRedraw(options: Record<string, unknown>) {
    if ((await set(options)) && hasArea) await generatePoints(id).catch((e) => setError(huError(e)));
  }
  const toggleItem = (kind: (typeof ITEM_KINDS)[number]) => {
    const role = ITEMS[kind].role;
    const list = enabled[role] ?? [];
    set({ items: { ...enabled, [role]: list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind] } });
  };
  const itemSummary = (role: 'detective' | 'mrx') =>
    (enabled[role] ?? []).map((k) => ITEMS[k as keyof typeof ITEMS]?.label ?? k).join(', ') || 'nincs';
  const summary = [
    `${cfg.duration_min}′ játék`,
    zonePct < 100 ? `kör ${zonePct}%-ra szűkül` : 'fix kör',
    powerups ? `${cfg.points_max} pont, ${Math.round((cfg.point_cooldown_s ?? 600) / 60)}′ újratöltés` : 'power-upok nélkül',
    `tömegközl. ${cfg.transit_allowed ? 'igen' : 'nem'}`,
  ].join(' · ');

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={ui.screen}>
      <Text style={[ui.stamp, { color: C.muted }]}>Ügyszám – ezzel csatlakoznak a többiek</Text>
      <Text selectable style={{ fontSize: 44, fontFamily: FONT, letterSpacing: 8, color: C.gold }}>{game.code}</Text>
      <Text style={ui.p}>
        Játékosok ({players.length}/{cfg.max_players as number})
        {isHost ? ' – koppints valakire, hogy ő legyen Mr. X' : ''}
      </Text>
      {players.map((item) => (
        <Pressable
          key={item.id}
          disabled={!isHost}
          onPress={() => call('assign_roles', { p_game: id, p_mrx_player: item.id })}
          style={ui.row}
        >
          <Text style={[ui.p, { flex: 1, fontWeight: item.user_id === userId ? '700' : '400' }]}>
            {item.name}
            {item.is_host ? ' (házigazda)' : ''}
          </Text>
          <Text style={[ui.stamp, { color: item.role === 'mrx' ? C.crimson : C.gold }]}>
            {item.role ? ROLE_LABEL[item.role] : '–'}
          </Text>
        </Pressable>
      ))}
      {hasArea ? (
        <Pressable
          disabled={!isHost}
          onPress={() => router.push(`/area/${id}`)}
          style={{ height: 220, borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: C.line }}
        >
          <View pointerEvents="none" style={{ flex: 1 }}>
            <GameMap
              center={{ lat: game.center_lat!, lng: game.center_lng! }}
              radiusM={game.radius_m}
              zoneRadiusM={game.radius_m ? (game.radius_m * zonePct) / 100 : null}
              points={powerups ? points.map((p) => ({ id: p.id, label: '', lat: p.lat, lng: p.lng })) : []}
            />
          </View>
        </Pressable>
      ) : null}
      <Text style={ui.muted}>{summary}</Text>
      {isHost ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn title={hasArea ? 'Pálya' : 'Pálya kijelölése'} variant="secondary" onPress={() => router.push(`/area/${id}`)} />
            </View>
            <View style={{ flex: 1 }}>
              <Btn title="Beállítások" variant="secondary" onPress={() => setSettingsOpen(true)} />
            </View>
          </View>
          <Btn title="Mr. X sorsolása" variant="secondary" onPress={() => call('assign_roles', { p_game: id, p_mrx_player: null })} />
          <Btn
            title={players.length < minPlayers ? `Indítás (min. ${minPlayers} játékos)` : 'Játék indítása'}
            onPress={() => call('start_game', { p_game: id })}
          />
        </>
      ) : (
        <Text style={ui.muted}>
          {powerups ? `Detektív tárgyak: ${itemSummary('detective')}\nMr. X tárgyai: ${itemSummary('mrx')}\n` : ''}
          Várakozás a házigazdára…
        </Text>
      )}
      {error ? <Text style={ui.error}>{error}</Text> : null}

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'center', padding: 16 }} onPress={() => setSettingsOpen(false)}>
          {/* Inner Pressable swallows taps so they don't close the popup. */}
          <Pressable style={{ backgroundColor: C.panel, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 16, gap: 10 }}>
            <Text style={[ui.stamp, { color: C.gold }]}>Beállítások</Text>
            {row('Játékidő', (cfg.duration_options_min as number[]).map((m) => chip(`${m}′`, cfg.duration_min === m, () => set({ duration_min: m }))))}
            {row('Kör szűkül', [100, 75, 50, 25].map((pct) => chip(pct === 100 ? 'nem' : `${pct}%`, zonePct === pct, () => set({ zone_final_pct: pct }))))}
            {row('Tömegközl.', (
              <Switch
                value={cfg.transit_allowed as boolean}
                onValueChange={(v) => void set({ transit_allowed: v })}
                trackColor={{ true: C.gold, false: C.line }}
                thumbColor={C.ink}
              />
            ))}
            {row('Power-upok', (
              <Switch
                value={powerups}
                onValueChange={(v) => setAndRedraw({ powerups_enabled: v })}
                trackColor={{ true: C.gold, false: C.line }}
                thumbColor={C.ink}
              />
            ))}
            {powerups ? (
              <>
                {row('Pontok', [6, 9, 12, 16].map((n) => chip(String(n), cfg.points_max === n, () => setAndRedraw({ points_max: n }))))}
                {row('Újratöltés', [5, 10, 15].map((m) => chip(`${m}′`, cfg.point_cooldown_s === m * 60, () => set({ point_cooldown_s: m * 60 }))))}
                {(['detective', 'mrx'] as const).map((role) =>
                  row(role === 'mrx' ? 'Mr. X' : 'Detektív', ITEM_KINDS.filter((k) => ITEMS[k].role === role).map((k) =>
                    chip(ITEMS[k].label, (enabled[role] ?? []).includes(k), () => toggleItem(k)),
                  )),
                )}
              </>
            ) : null}
            {error ? <Text style={ui.error}>{error}</Text> : null}
            <Btn title="Kész" onPress={() => setSettingsOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}
