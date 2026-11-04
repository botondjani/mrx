import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const PERMISSION_STEPS = ['foreground', 'background', 'notifications', 'battery'] as const;
export type PermissionStep = (typeof PERMISSION_STEPS)[number] | 'done';

/** Granted state of every step of the permission flow. */
export async function permissionStatus(): Promise<Record<(typeof PERMISSION_STEPS)[number], boolean>> {
  return {
    foreground: (await Location.getForegroundPermissionsAsync()).granted,
    background: (await Location.getBackgroundPermissionsAsync()).granted,
    notifications: (await Notifications.getPermissionsAsync()).granted,
    battery: Platform.OS !== 'android' || !(await Battery.isBatteryOptimizationEnabledAsync()),
  };
}

/** First missing step of the permission flow. */
export async function nextPermissionStep(): Promise<PermissionStep> {
  const s = await permissionStatus();
  return PERMISSION_STEPS.find((k) => !s[k]) ?? 'done';
}
