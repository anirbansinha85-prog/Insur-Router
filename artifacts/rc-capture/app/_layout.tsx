import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';

// Set API base URL so the mobile bundle can reach the shared API server.
// EXPO_PUBLIC_DOMAIN is injected at dev start time from REPLIT_DEV_DOMAIN.
if (process.env.EXPO_PUBLIC_DOMAIN) {
  setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);
}

// The API now requires a service key, and unlike the two web frontends there is
// no dev proxy in front of this one to inject it — the device talks to the API
// directly. So the key has to travel in the bundle.
//
// That is acceptable for a development build on a trusted device and NOT
// acceptable for anything installed by a real user: an EXPO_PUBLIC_ variable is
// readable by anyone who unpacks the app, which would hand out full API access.
// Shipping this app needs per-user sessions, not a shared key.
if (process.env.EXPO_PUBLIC_API_SERVICE_KEY) {
  setAuthTokenGetter(() => process.env.EXPO_PUBLIC_API_SERVICE_KEY ?? null);
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="review" />
      <Stack.Screen name="success" />
      <Stack.Screen name="history" />
      <Stack.Screen name="history-detail" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
