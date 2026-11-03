import { Pressable, StyleSheet, Text, type PressableProps } from 'react-native';

export function Btn({ title, variant = 'primary', disabled, ...rest }: PressableProps & { title: string; variant?: 'primary' | 'secondary' | 'danger' }) {
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      style={({ pressed }) => [s.btn, s[variant], (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[s.txt, variant === 'secondary' && { color: '#1e6bd6' }]}>{title}</Text>
    </Pressable>
  );
}

export const ui = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 12, backgroundColor: '#fff' },
  h1: { fontSize: 24, fontWeight: '700' },
  p: { fontSize: 16, lineHeight: 22, color: '#333' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  error: { color: '#c0392b', fontSize: 15 },
});

const s = StyleSheet.create({
  btn: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center' },
  primary: { backgroundColor: '#1e6bd6' },
  secondary: { backgroundColor: '#e8f0fc' },
  danger: { backgroundColor: '#c0392b' },
  txt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
