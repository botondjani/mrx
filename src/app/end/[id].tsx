import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Battery from 'expo-battery';
import { File, Paths } from 'expo-file-system';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Image, ScrollView, Share, Switch, Text, View } from 'react-native';
import { ShareCard } from '../../components/ShareCard';
import { Btn, C, FONT, ui } from '../../components/ui';
import { replayUrl, SITE_URL } from '../../lib/env';
import { huError } from '../../lib/errors';
import { useGame, usePlayers, useUserId } from '../../lib/hooks';
import { storyLines, storyText, type CardTrack, type Story } from '../../lib/story';
import { supabase } from '../../lib/supabase';
import { BATTERY_START_KEY } from '../../lib/tracking';

type Replay = { tracks: [string, number, number, number][] };

export default function End() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const userId = useUserId();
  const [story, setStory] = useState<Story | null>(null);
  const [tracks, setTracks] = useState<CardTrack[]>([]);
  const [card, setCard] = useState<string | null>(null);
  const [battery, setBattery] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const isHost = !!game && game.host_user_id === userId;

  // Story + tracks for the case-file card (finished games only).
  useEffect(() => {
    if (game?.status !== 'finished' || !players.length) return;
    supabase.rpc('game_story', { p_game: id }).then(({ data, error }) => (error ? setMsg(huError(error)) : setStory(data as Story)));
    supabase.rpc('game_replay', { p_game: id }).then(({ data }) => {
      const byPlayer = new Map<string, CardTrack>();
      for (const [pid, , lat, lng] of (data as Replay | null)?.tracks ?? []) {
        const role = players.find((p) => p.id === pid)?.role === 'mrx' ? 'mrx' : 'detective';
        if (!byPlayer.has(pid)) byPlayer.set(pid, { role, points: [] });
        byPlayer.get(pid)!.points.push([lat, lng]);
      }
      setTracks([...byPlayer.values()]);
    });
  }, [game?.status, players.length, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everyone follows the host into the rematch lobby.
  useEffect(() => {
    if (game?.rematch_game_id) router.replace(`/lobby/${game.rematch_game_id}`);
  }, [game?.rematch_game_id]);

  // Battery used on this phone during the game (measured from tracking start).
  useEffect(() => {
    (async () => {
      const start = JSON.parse((await AsyncStorage.getItem(BATTERY_START_KEY)) ?? 'null');
      if (!start) return;
      const used = Math.round((start.level - (await Battery.getBatteryLevelAsync())) * 100);
      setBattery(`${used}% / ${Math.round((Date.now() - start.at) / 60000)} perc`);
    })();
  }, []);

  async function shareImage() {
    if (!card || !story) return;
    try {
      const file = new File(Paths.cache, `mrx-${story.code}.png`);
      if (file.exists) file.delete();
      file.create();
      await file.write(card.split(',')[1], { encoding: 'base64' });
      await Sharing.shareAsync(file.uri, { mimeType: 'image/png', dialogTitle: story.case_name });
    } catch (e) {
      setMsg(huError(e));
    }
  }

  async function shareText() {
    if (!story) return;
    await Share.share({ message: storyText(story, game?.replay_public ? replayUrl(story.code) : undefined) });
  }

  async function setPublic(v: boolean) {
    const { error } = await supabase.rpc('set_replay_public', { p_game: id, p_public: v });
    if (error) setMsg(huError(error));
    else if (v && story) await Share.share({ message: `🕵️ ${story.case_name} – nézd vissza a hajszát: ${replayUrl(story.code)}` });
  }

  async function rematch() {
    const { data, error } = await supabase.rpc('rematch', { p_game: id });
    if (error) setMsg(huError(error));
    else router.replace(`/lobby/${data}`);
  }

  if (!game) return <View style={ui.screen} />;
  const me = players.find((p) => p.user_id === userId);
  const iWon = me && (game.winner === 'mrx') === (me.role === 'mrx');
  const myTitle = story?.players.find((p) => p.name === me?.name)?.title;

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={ui.screen}>
      <Text style={[ui.stamp, { textAlign: 'center', color: game.winner === 'mrx' ? C.crimson : C.gold }]}>
        {game.winner === 'mrx' ? 'Az ügy lezárva – a tettes megszökött' : 'Az ügy lezárva – tettes elfogva'}
      </Text>
      <Text style={{ fontFamily: FONT, fontSize: 40, textAlign: 'center', color: iWon ? C.gold : C.crimson }}>
        {iWon ? 'Nyertél!' : 'Vesztettél'}
      </Text>
      {myTitle ? <Text style={[ui.p, { textAlign: 'center' }]}>A címed: <Text style={{ color: C.gold, fontFamily: FONT }}>{myTitle}</Text></Text> : null}

      {story ? (
        <ShareCard
          story={story}
          tracks={tracks}
          lines={storyLines(story)}
          footer={`Játszd te is: ${SITE_URL.replace('https://', '')}`}
          onImage={setCard}
        />
      ) : null}
      {card ? (
        <Image source={{ uri: card }} style={{ width: '100%', aspectRatio: 1080 / 1350, borderRadius: 6 }} resizeMode="contain" />
      ) : (
        <Text style={ui.muted}>{story ? 'Ügyirat készül…' : 'Történet betöltése…'}</Text>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Btn title="Kép megosztása" onPress={shareImage} disabled={!card} />
        </View>
        <View style={{ flex: 1 }}>
          <Btn title="Szövegként" variant="secondary" onPress={shareText} disabled={!story} />
        </View>
      </View>

      {isHost ? (
        <>
          <Btn title="Visszavágó (szerepcserével)" onPress={rematch} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[ui.p, { flex: 1 }]}>Nyilvános visszajátszás-link (bárki megnézheti a hajszát)</Text>
            <Switch value={game.replay_public} onValueChange={setPublic} trackColor={{ true: C.gold, false: C.line }} thumbColor={C.ink} />
          </View>
        </>
      ) : (
        <Text style={ui.muted}>Ha a házigazda visszavágót indít, automatikusan átkerülsz.</Text>
      )}
      {battery ? <Text style={ui.muted}>Akkumulátor ezen a telefonon: {battery}</Text> : null}
      {msg ? <Text style={ui.error}>{msg}</Text> : null}
      <Btn title="Visszajátszás" variant="secondary" onPress={() => router.push(`/replay/${id}`)} />
      <Btn title="Főoldal" variant="secondary" onPress={() => router.replace('/')} />
    </ScrollView>
  );
}
