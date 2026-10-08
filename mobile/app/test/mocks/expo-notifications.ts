export const getPermissionsAsync = async () => ({ granted: false });
export const requestPermissionsAsync = async () => ({ granted: false });
export const getDevicePushTokenAsync = async () => ({ type: 'android', data: 'fcm-token' });
export const addPushTokenListener = () => ({ remove() {} });
export const unregisterForNotificationsAsync = async () => {};
export const setNotificationHandler = () => {};
export const getLastNotificationResponse = () => null;
export const clearLastNotificationResponse = () => {};
export const addNotificationResponseReceivedListener = () => ({ remove() {} });
