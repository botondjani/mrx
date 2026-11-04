export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
export const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY!;
/** Public web page for invites and shared replays (EAS Hosting). */
export const SITE_URL = 'https://mrx-ugy.expo.app';
export const inviteUrl = (code: string) => `${SITE_URL}/?join=${code}`;
export const replayUrl = (code: string) => `${SITE_URL}/?replay=${code}`;
