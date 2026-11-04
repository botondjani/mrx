import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { CARD_HTML, type CardTrack, type Story } from '../lib/story';

// See GameMap: the library's prop types collapse to `never`, so the used props are typed here.
const Web = WebView as unknown as ComponentType<{
  ref: Ref<WebView>;
  source: { html: string; baseUrl: string };
  onMessage: (e: WebViewMessageEvent) => void;
  style: object;
}>;

/** Invisible renderer: draws the case-file card on a canvas and returns a PNG data URL. */
export function ShareCard({ story, tracks, lines, footer, onImage }: {
  story: Story;
  tracks: CardTrack[];
  lines: string[];
  footer: string;
  onImage: (dataUrl: string) => void;
}) {
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const payload = JSON.stringify({ story, tracks, lines, footer });

  useEffect(() => {
    if (ready) web.current?.injectJavaScript(`draw(${payload});true;`);
  }, [ready, payload]);

  return (
    <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} pointerEvents="none">
      <Web
        ref={web}
        style={{ width: 1080, height: 1350 }}
        source={{ html: CARD_HTML, baseUrl: 'https://mrx.botondjani.app/' }}
        onMessage={(e) => (e.nativeEvent.data === 'ready' ? setReady(true) : onImage(e.nativeEvent.data))}
      />
    </View>
  );
}
