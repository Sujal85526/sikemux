import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';

import { thisDevice } from '@/device/identity';
import { pairedMacs, shortKey, type PairedMac } from '@/macs/paired';
import { colors, common } from '@/theme';

export default function Home() {
  const [deviceId, setDeviceId] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [macs, setMacs] = useState<PairedMac[]>([]);

  useEffect(() => {
    thisDevice()
      .then((device) => setDeviceId(device.id()))
      .catch((error: unknown) => setProblem(String(error)));
  }, []);

  useFocusEffect(
    useCallback(() => {
      pairedMacs().then(setMacs);
    }, []),
  );

  return (
    <SafeAreaView style={common.screen}>
      <View style={common.body}>
        <Text style={common.title}>Sikemux</Text>
        <Text style={common.label}>Macs</Text>
        {macs.length === 0 && <Text style={common.text}>No Mac yet.</Text>}
        {macs.map((mac) => (
          <View key={mac.core} style={styles.mac}>
            <Text style={common.key}>Mac {shortKey(mac.core)}</Text>
            <Text style={styles.access}>{mac.access === 'full' ? 'Full access' : 'Watch only'}</Text>
          </View>
        ))}
        <Pressable style={common.button} onPress={() => router.push('/pair')}>
          <Text style={common.buttonText}>Pair with a Mac</Text>
        </Pressable>
        <Text style={common.label}>This phone</Text>
        <Text style={common.key} selectable>
          {problem ?? (deviceId ? shortKey(deviceId) : 'Coming online…')}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = {
  mac: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    gap: 4,
  },
  access: { color: colors.muted, fontSize: 13 },
} as const;
