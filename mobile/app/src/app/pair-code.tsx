import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { openFoundLink } from '@/devices/foundLinks';
import { CodeEntry } from '@/ui/CodeEntry';
import { Nav, Screen } from '@/ui/parts';
import { type Palette, typeFor, useStyles } from '@/ui/theme';

/** The code for a host this phone already knows the key of, as one on the same account. */
export default function PairCode() {
  const styles = useStyles(makeStyles);
  const { core = '', name = 'your host' } = useLocalSearchParams<{ core?: string; name?: string }>();
  const [code, setCode] = useState('');

  const type = (typed: string) => {
    setCode(typed);
    if (typed.length === 6 && core) openFoundLink({ core, code: typed });
  };

  return (
    <Screen>
      <Nav back="Back" />
      <View style={styles.block}>
        <Text style={styles.title}>Enter the code from {name}</Text>
        <Text style={styles.detail}>On that host, open Settings → Devices and choose Pair a device.</Text>
        <View style={styles.tiles}>
          <CodeEntry code={code} onChange={type} />
        </View>
      </View>
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    block: { paddingTop: 40, paddingHorizontal: 28, alignItems: 'center' },
    title: { ...type.title, fontSize: 22, textAlign: 'center' },
    detail: { ...type.body, textAlign: 'center', marginTop: 8, minHeight: 44 },
    tiles: { marginTop: 32 },
  });
};
