import { StyleSheet } from 'react-native';

export const colors = {
  ground: '#0B0B0F',
  raised: '#16161C',
  line: '#26262E',
  ink: '#F2F2F5',
  muted: '#8A8A96',
  accent: '#7C8CFF',
  danger: '#FF7A7A',
};

export const common = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 24, gap: 8 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '600' },
  label: { color: colors.muted, fontSize: 13, marginTop: 24 },
  text: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  key: { color: colors.ink, fontFamily: 'Menlo', fontSize: 15 },
  button: {
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  buttonText: { color: colors.ground, fontSize: 16, fontWeight: '600' },
});
