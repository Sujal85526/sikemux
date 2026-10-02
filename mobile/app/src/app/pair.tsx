import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { failure, pair, type Failure } from '@/devices/pairing';
import { Button, CodeTiles, Nav, Screen, useBottomGap, Working } from '@/ui/parts';
import { colors, fonts, radius, type } from '@/ui/theme';

/** How long the Mac keeps a pairing request open (sikemux_core::pairing::APPROVAL_TIMEOUT). */
const APPROVAL_SECONDS = 120;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function Pair() {
  const { core, code } = useLocalSearchParams<{ core: string; code: string }>();
  const [failed, setFailed] = useState<Failure>();
  const [left, setLeft] = useState(APPROVAL_SECONDS);
  const started = useRef<string>(undefined);

  useEffect(() => {
    const attempt = `${core}/${code}`;
    if (started.current === attempt) return;
    started.current = attempt;
    pair({ core, code })
      .then(() => router.replace(`/device/${core}`))
      .catch((error: unknown) => setFailed(failure(error)));
  }, [core, code]);

  useEffect(() => {
    if (failed) return;
    const tick = setInterval(() => setLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(tick);
  }, [failed]);

  const bottom = useBottomGap();
  return (
    <Screen>
      <Nav back={failed ? 'Back' : 'Cancel'} />
      <View style={styles.block}>
        <Text style={styles.title}>{failed ? failed.title : 'Approve on your Mac'}</Text>
        <Text style={styles.detail}>
          {failed ? failed.detail : 'Check the Mac shows this code, then choose what this phone may do.'}
        </Text>
        <View style={styles.tiles}>
          <CodeTiles code={code} state={failed ? 'failed' : 'locked'} />
        </View>
      </View>
      <View style={[styles.footer, { paddingBottom: bottom }]}>
        {failed ? (
          <Button kind="primary" title="Scan again" onPress={() => router.replace('/scan')} />
        ) : (
          <View style={styles.waiting}>
            <Working />
            <Text style={styles.waitingText}>Waiting for your Mac</Text>
            <Text style={type.mono}>{clock(left)}</Text>
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { flex: 1, paddingTop: 40, paddingHorizontal: 28, alignItems: 'center' },
  title: { ...type.title, fontSize: 22, textAlign: 'center' },
  detail: { ...type.body, textAlign: 'center', marginTop: 8, minHeight: 44 },
  tiles: { marginTop: 32 },
  footer: { paddingHorizontal: 16, paddingTop: 12 },
  waiting: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  waitingText: { flex: 1, fontFamily: fonts.ui, fontSize: 15, color: colors.secondary },
});
