import type { CapacitorConfig } from '@capacitor/cli'

// Used later to wrap the web app for iOS and Android.
const config: CapacitorConfig = {
  appId: 'com.alicena.foodapp',
  appName: 'Homemade Food',
  webDir: 'dist',
}

export default config
