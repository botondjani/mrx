import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type PermissionStep = 'foreground' | 'background' | 'notifications' | 'battery' | 'done';

/** First missing step of the permission flow. */
export async function nextPermissionStep(): Promise<PermissionStep> {
  if (!(await Location.getForegroundPermissionsAsync()).granted) return 'foreground';
  if (!(await Location.getBackgroundPermissionsAsync()).granted) return 'background';
  if (!(await Notifications.getPermissionsAsync()).granted) return 'notifications';
  if (Platform.OS === 'android' && (await Battery.isBatteryOptimizationEnabledAsync())) return 'battery';
  return 'done';
}
