// Site settings for the owner of this website.
//
// googleApiKey: put your Google Cloud API key here if you want visitors to use the fast
// Google voices without entering their own key. Anyone can see this key in the page source,
// so in Google Cloud Console restrict it to:
//   - Application restriction: "Websites", e.g.  https://mikeade3000.github.io/*
//   - API restriction: "Cloud Text-to-Speech API" only
// and set a budget alert. Leave it empty ('') to make each visitor enter their own key.
//
// Azure keys cannot be restricted to a website, so never put an Azure key in this file.
//
// defaultProvider: which voice is selected when the page opens: 'local', 'google' or 'azure'.

// apiBase: address of your payment/AI server (the Cloudflare Worker in server/), e.g.
// 'https://doc-to-video-api.yourname.workers.dev'. Leave empty to switch payments off
// (downloads become free and the AI narration option is hidden).

export const CONFIG = {
  apiBase: '',
  googleApiKey: '',
  defaultProvider: 'local',
};
