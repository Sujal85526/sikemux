import * as ExpoDevice from 'expo-device';

export function phoneName(): string {
  return ExpoDevice.deviceName ?? ExpoDevice.modelName ?? 'Phone';
}
