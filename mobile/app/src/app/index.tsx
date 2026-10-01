import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { thisDevice } from '@/device/identity';

export default function Home() {
  const [deviceId, setDeviceId] = useState<string>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    thisDevice()
      .then((device) => setDeviceId(device.id()))
      .catch((error: unknown) => setProblem(String(error)));
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title}>Sikemux</Text>
        <Text style={styles.label}>This phone</Text>
        <Text style={styles.key} selectable>
          {problem ?? deviceId?.slice(0, 16) ?? 'Coming online…'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0B0B0F' },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 8 },
  title: { color: '#F2F2F5', fontSize: 28, fontWeight: '600' },
  label: { color: '#8A8A96', fontSize: 13, marginTop: 24 },
  key: { color: '#F2F2F5', fontFamily: 'Menlo', fontSize: 15 },
});
