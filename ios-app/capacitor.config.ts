import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.chadgpt.app',
  appName: 'ChadGPT',
  webDir: 'www',
  bundledWebRuntime: false,

  // Load the live Cloudflare Pages site in-app. This is why review will
  // flag us for "minimum functionality" — see README. Fine for TestFlight
  // internal testing.
  server: {
    url: 'https://chadgpt-964.pages.dev',
    cleartext: false,
    androidScheme: 'https',
    // allowNavigation lets outbound links (upgrade flows, docs) open inside
    // the webview without triggering Safari. Add your worker domains too.
    allowNavigation: [
      'chadgpt-964.pages.dev',
      '*.chadgpt-964.pages.dev',
      '*.pages.dev',
    ],
  },

  ios: {
    contentInset: 'always',
    scrollEnabled: true,
    // We rely on the site's dark theme; keep status bar readable over it.
    backgroundColor: '#0e0f13',
    preferredContentMode: 'mobile',
    limitsNavigationsToAppBoundDomains: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0e0f13',
      showSpinner: false,
      iosSpinnerStyle: 'small',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0e0f13',
      overlaysWebView: false,
    },
    Keyboard: {
      resize: 'body',
      style: 'DARK',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
