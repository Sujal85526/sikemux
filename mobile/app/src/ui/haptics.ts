import * as Haptics from 'expo-haptics';

/** A device without a haptic engine, or one that refuses, simply stays still. */
const quiet = () => {};

export const haptics = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(quiet),
  select: () => Haptics.selectionAsync().catch(quiet),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(quiet),
  warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(quiet),
  failure: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(quiet),
};
