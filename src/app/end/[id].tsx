import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { Btn, ui } from '../../components/ui';
import { useGame, usePlayers, useUserId } from '../../lib/hooks';

export default function End() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const userId = useUserId();
  if (!game) return <View style={ui.screen} />;

  const me = players.find((p) => p.user_id === userId);
  const mrx = players.find((p) => p.role === 'mrx');
  const catcher = players.find((p) => p.id === game.caught_by);
  const iWon = me && (game.winner === 'mrx') === (me.role === 'mrx');
  const minutes =
    game.started_at && game.finished_at
      ? Math.round((new Date(game.finished_at).getTime() - new Date(game.started_at).getTime()) / 60000)
      : null;

  return (
    <View style={[ui.screen, { justifyContent: 'center' }]}>
      <Text style={[ui.h1, { fontSize: 32, textAlign: 'center' }]}>{iWon ? 'Nyertél!' : 'Vesztettél'}</Text>
      <Text style={[ui.p, { textAlign: 'center' }]}>
        {game.winner === 'mrx'
          ? `${mrx?.name ?? 'Mr. X'} (Mr. X) kibírta a játékidő végéig.`
          : `${catcher?.name ?? 'Egy detektív'} elkapta Mr. X-et (${mrx?.name ?? '?'}).`}
      </Text>
      {minutes != null ? <Text style={[ui.p, { textAlign: 'center' }]}>Játékidő: {minutes} perc</Text> : null}
      <View style={{ height: 24 }} />
      <Btn title="Vissza a főoldalra" onPress={() => router.replace('/')} />
    </View>
  );
}
