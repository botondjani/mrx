import { Pressable, StyleSheet, Text, type PressableProps } from 'react-native';

/** Noir detective theme: night-dark paper, ivory ink, gold for detectives, crimson for Mr. X. */
export const C = {
  bg: '#0e0f13',
  panel: '#171920',
  line: '#2a2d36',
  ink: '#ece4d4',
  muted: '#9a927f',
  gold: '#d4a73c',
  crimson: '#c8323c',
  steel: '#5fa8d3',
} as const;

export const FONT = 'SpecialElite_400Regular';

export function Btn({ title, variant = 'primary', disabled, ...rest }: PressableProps & { title: string; variant?: 'primary' | 'secondary' | 'danger' }) {
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      style={({ pressed }) => [s.btn, s[variant], (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[s.txt, variant === 'primary' && { color: C.bg }, variant === 'secondary' && { color: C.gold }]}>{title}</Text>
    </Pressable>
  );
}

export const ui = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 12, backgroundColor: C.bg },
  h1: { fontSize: 26, color: C.ink, fontFamily: FONT, letterSpacing: 1 },
  p: { fontSize: 16, lineHeight: 22, color: C.ink },
  muted: { fontSize: 14, lineHeight: 20, color: C.muted },
  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 12, fontSize: 18,
    color: C.ink, backgroundColor: C.panel, fontFamily: FONT,
  },
  error: { color: C.crimson, fontSize: 15 },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line, flexDirection: 'row' },
  stamp: { fontFamily: FONT, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' },
});

const s = StyleSheet.create({
  btn: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 6, alignItems: 'center' },
  primary: { backgroundColor: C.gold },
  secondary: { borderWidth: 1, borderColor: C.gold, backgroundColor: 'transparent' },
  danger: { backgroundColor: C.crimson },
  txt: { color: C.ink, fontSize: 16, fontFamily: FONT, letterSpacing: 1, textTransform: 'uppercase' },
});
