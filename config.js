// Settings for Pigeon Chat. Nothing here is secret.
window.CHAT_CONFIG = {
  // Where the app lives online, used in invite links.
  appUrl: 'https://lamksim.github.io/What/',
  // Where family can download the Android app.
  apkUrl: 'https://github.com/lamksim/What/releases/download/android-latest/PigeonChat.apk',
  // How often the open chat checks for new messages (seconds).
  pollSeconds: 1,
  // Free public servers that carry the (encrypted) messages. Leave as is.
  relays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.mom',
    'wss://relay.snort.social',
  ],
};
