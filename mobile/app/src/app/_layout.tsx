import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Figtree_400Regular, Figtree_400Regular_Italic, Figtree_500Medium, Figtree_600SemiBold } from '@expo-google-fonts/figtree';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono';

import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';

import { CLERK_PUBLISHABLE_KEY } from '@/account/config';
import { useAccountHostsFeed, useAccountLive, useRegisterPhone } from '@/account/session';
import { goOffline } from '@/device/identity';
import { NotificationsOffer } from '@/notify/NotificationsOffer';
import { usePushToken } from '@/notify/switch';
import { currentRelays, useUpdateRequired } from '@/network/network';
import { UpdateRequired } from '@/screens/UpdateRequired';
import { useColors } from '@/ui/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colors = useColors();
  const [loaded, failed] = useFonts({
    Figtree_400Regular,
    Figtree_400Regular_Italic,
    Figtree_500Medium,
    Figtree_600SemiBold,
    JetBrainsMono_400Regular,
  });

  const required = useUpdateRequired();

  useEffect(() => {
    if (loaded || failed) SplashScreen.hideAsync();
  }, [loaded, failed]);

  useEffect(() => {
    currentRelays().catch(() => {});
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') currentRelays().catch(() => {});
    });
    return () => listener.remove();
  }, []);

  useEffect(() => {
    if (required) goOffline().catch(() => {});
  }, [required]);

  if (!loaded && !failed) return null;
  if (required)
    return (
      <>
        <StatusBar style="light" />
        <UpdateRequired required={required} />
      </>
    );
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <PhoneOnAccount />
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }} />
      <NotificationsOffer />
    </ClerkProvider>
  );
}

function PhoneOnAccount() {
  useRegisterPhone();
  useAccountLive();
  useAccountHostsFeed();
  usePushToken();
  return null;
}
