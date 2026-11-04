import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { ITEM_KINDS, ITEMS } from '../../lib/items';
import { Btn, C, FONT, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePlayers, usePoints, useUserId } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';

const ROLE_LABEL = { mrx: 'Mr. X', detective: 'detektív' } as const;

export default function Lobby() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const points = usePoints(id);
  const userId = useUserId();
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const isHost = !!game && game.host_user_id === userId;

  useEffect(() => {
    if (game?.status === 'running') router.replace(`/game/${id}`);
  }, [game?.status, id]);

  async function call(fn: string, args: Record<string, unknown>) {
    setError(null);
    const { error } = await supabase.rpc(fn, args);
    if (error) setError(huError(error));
  }

  if (!game) return <View style={ui.screen} />;
  const minPlayers = game.config.min_players as number;

  const set = (options: Record<string, unknown>) => call('set_options', { p_game: id, p_options: options });
  const chip = (label: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      style={{ paddingVertical: 4, paddingHorizontal: 8, borderRadius: 5, borderWidth: 1, borderColor: C.gold, backgroundColor: active ? C.gold : 'transparent' }}
    >
      <Text style={{ color: active ? C.bg : C.gold, fontFamily: FONT, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  const row = (label: string, children: ReactNode[]) => (
    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Text style={[ui.muted, { width: 82, fontSize: 13 }]}>{label}</Text>
      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{children}</View>
    </View>
  );
  const zonePct = (game.config.zone_final_pct as number | undefined) ?? 100;
  const enabled = (game.config.items ?? {}) as Record<'detective' | 'mrx', string[]>;
  const toggleItem = (kind: (typeof ITEM_KINDS)[number]) => {
    const role = ITEMS[kind].role;
    const list = enabled[role] ?? [];
    const next = list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind];
    set({ items: { ...enabled, [role]: next } });
  };
  const itemSummary = (role: 'detective' | 'mrx') =>
    (enabled[role] ?? []).map((k) => ITEMS[k as keyof typeof ITEMS]?.label ?? k).join(', ') || 'nincs';
  const summary =
    `${game.config.duration_min}′ · kör ${zonePct < 100 ? `${zonePct}%-ra szűkül` : 'fix'} · ${game.config.points_max} pont · ` +
    `${Math.round((game.config.point_cooldown_s ?? 600) / 60)}′ újratöltés · tömegközl. ${game.config.transit_allowed ? 'igen' : 'nem'}`;

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={ui.screen}>
      <Text style={[ui.stamp, { color: C.muted }]}>Ügyszám – ezzel csatlakoznak a többiek</Text>
      <Text selectable style={{ fontSize: 44, fontFamily: FONT, letterSpacing: 8, color: C.gold }}>{game.code}</Text>
      <Text style={ui.p}>
        Játékosok ({players.length}/{game.config.max_players as number})
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
      {game.center_lat != null && game.center_lng != null ? (
        <Pressable
          disabled={!isHost}
          onPress={() => router.push(`/area/${id}`)}
          style={{ height: 220, borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: C.line }}
        >
          <View pointerEvents="none" style={{ flex: 1 }}>
            <GameMap
              center={{ lat: game.center_lat, lng: game.center_lng }}
              radiusM={game.radius_m}
              zoneRadiusM={game.radius_m ? (game.radius_m * zonePct) / 100 : null}
              points={points.map((p) => ({ id: p.id, label: '', lat: p.lat, lng: p.lng }))}
            />
          </View>
        </Pressable>
      ) : null}
      {isHost ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn title="Pálya" variant="secondary" onPress={() => router.push(`/area/${id}`)} />
            </View>
            <View style={{ flex: 1 }}>
              <Btn
                title={`Pontok (${points.length})`}
                variant="secondary"
                disabled={game.center_lat == null}
                onPress={() => router.push(`/points/${id}`)}
              />
            </View>
          </View>
          <View style={{ borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 10, gap: 8 }}>
            <Pressable onPress={() => setShowSettings((v) => !v)} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[ui.stamp, { color: C.gold }]}>Beállítások</Text>
              <Text style={{ color: C.gold, fontFamily: FONT }}>{showSettings ? '▴' : '▾'}</Text>
            </Pressable>
            {!showSettings ? (
              <Text style={ui.muted}>{summary}</Text>
            ) : (
              <>
                {row('Játékidő', (game.config.duration_options_min as number[]).map((m) =>
                  chip(`${m}′`, game.config.duration_min === m, () => set({ duration_min: m })),
                ))}
                {row('Kör szűkül', [100, 75, 50, 25].map((pct) =>
                  chip(pct === 100 ? 'nem' : `${pct}%`, zonePct === pct, () => set({ zone_final_pct: pct })),
                ))}
                {row('Pontok', [6, 9, 12, 16].map((n) =>
                  chip(String(n), game.config.points_max === n, () => set({ points_max: n })),
                ))}
                {row('Újratöltés', [5, 10, 15].map((m) =>
                  chip(`${m}′`, game.config.point_cooldown_s === m * 60, () => set({ point_cooldown_s: m * 60 })),
                ))}
                {(['detective', 'mrx'] as const).map((role) =>
                  row(role === 'mrx' ? 'Mr. X' : 'Detektív', ITEM_KINDS.filter((k) => ITEMS[k].role === role).map((k) =>
                    chip(ITEMS[k].label, (enabled[role] ?? []).includes(k), () => toggleItem(k)),
                  )),
                )}
                {row('Tömegközl.', [
                  <Switch
                    key="transit"
                    value={game.config.transit_allowed as boolean}
                    onValueChange={(v) => set({ transit_allowed: v })}
                    trackColor={{ true: C.gold, false: C.line }}
                    thumbColor={C.ink}
                  />,
                ])}
                <Text style={ui.muted}>A pontok száma újrasorsoláskor lép életbe.</Text>
              </>
            )}
          </View>
          <Btn title="Mr. X sorsolása" variant="secondary" onPress={() => call('assign_roles', { p_game: id, p_mrx_player: null })} />
          <Btn
            title={players.length < minPlayers ? `Indítás (min. ${minPlayers} játékos)` : 'Játék indítása'}
            onPress={() => call('start_game', { p_game: id })}
          />
        </>
      ) : (
        <Text style={ui.p}>
          Játékidő: {game.config.duration_min as number} perc · Tömegközlekedés: {game.config.transit_allowed ? 'engedélyezve' : 'tilos'}
          {zonePct < 100 ? ` · a kör ${zonePct}%-ra szűkül` : ''}
          {`\nDetektív tárgyak: ${itemSummary('detective')}\nMr. X tárgyai: ${itemSummary('mrx')}`}
          {'\n'}Várakozás a házigazdára…
        </Text>
      )}
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </ScrollView>
  );
}
