import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Text } from 'react-native';
import { Btn, ui } from '../components/ui';
import { readLog } from '../lib/tracking';

export default function Log() {
  const [lines, setLines] = useState<string[]>([]);
  const load = useCallback(() => {
    readLog().then((l) => setLines([...l].reverse()));
  }, []);
  useFocusEffect(load);

  return (
    <FlatList
      style={{ backgroundColor: '#fff' }}
      contentContainerStyle={{ padding: 16, gap: 4 }}
      ListHeaderComponent={<Btn title="Frissítés" variant="secondary" onPress={load} />}
      data={lines}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item }) => <Text style={[ui.p, { fontFamily: 'monospace', fontSize: 13 }]}>{item}</Text>}
      ListEmptyComponent={<Text style={ui.p}>Még nincs bejegyzés.</Text>}
    />
  );
}
