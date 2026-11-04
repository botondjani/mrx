import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';

const CHANNEL = 'game';

export type GameEvent = { kind: string; payload: Record<string, any> };

// Hungarian texts per server event kind. vibrate: pattern in ms (Android: wait, buzz, wait, buzz...).
const TEXTS: Record<string, { title: string; body: (p: any) => string; vibrate: number[] }> = {
  reveal: { title: 'Mr. X felfedve!', body: () => 'Nézd meg a térképen, merre jár.', vibrate: [0, 400, 200, 400] },
  proximity: { title: 'Közel vannak!', body: () => 'Egy detektív 50 méteren belül van.', vibrate: [0, 800, 200, 800] },
  game_over: {
    title: 'Vége a játéknak',
    body: (p) => (p.winner === 'mrx' ? 'Mr. X megúszta – ő nyert!' : `Elkapták Mr. X-et${p.caught_by ? ` (${p.caught_by})` : ''}!`),
    vibrate: [0, 1000],
  },
  head_start_over: { title: 'Indul a hajsza!', body: () => 'Letelt az előny, a detektívek indulhatnak.', vibrate: [0, 500] },
  out_of_bounds: { title: 'Kiléptél a pályáról!', body: () => 'Azonnal menj vissza a körön belülre.', vibrate: [0, 300, 150, 300, 150, 300] },
  back_in_bounds: { title: 'Visszatértél a pályára', body: () => 'Rendben, folytathatod.', vibrate: [0, 200] },
  mrx_exposed: { title: 'Mr. X kilépett a pályáról!', body: () => '2 percig élőben látszik a térképen.', vibrate: [0, 400, 200, 400] },
  head_start_violation: { title: 'Maradj a kezdőpontnál!', body: () => 'Az előny alatt 100 méteren belül kell maradnod.', vibrate: [0, 300, 150, 300] },
  reveal_fogged: { title: 'Köd!', body: () => 'Mr. X ködbe burkolózott – ez a felfedés elmaradt.', vibrate: [0, 300] },
  jammed: { title: 'Zavarás!', body: () => 'Mr. X megzavarta a rádiót – 1 percig nem látjátok egymást.', vibrate: [0, 300, 150, 300] },
  tracker_started: { title: 'Nyomkövető aktív', body: () => 'Mr. X 60 másodpercig élőben látszik.', vibrate: [0, 400, 200, 400] },
  speeding: { title: 'Túl gyors vagy!', body: () => 'Ebben a játékban tilos a tömegközlekedés.', vibrate: [0, 300, 150, 300] },
};

export async function setupNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Játékesemények',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 400, 200, 400],
      enableVibrate: true,
    });
  }
}

/** Local notification + vibration; works with the screen locked (called from the location task). */
export async function notifyEvent(e: GameEvent) {
  const t = TEXTS[e.kind];
  if (!t) return;
  Vibration.vibrate(t.vibrate);
  await Notifications.scheduleNotificationAsync({
    content: { title: t.title, body: t.body(e.payload ?? {}), vibrate: t.vibrate },
    trigger: { channelId: CHANNEL },
  });
}
