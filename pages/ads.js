const PROVIDERS = [
  { id: 'adsense',      name: 'Google AdSense',    signup: 'https://adsense.google.com/start/',          approval: 'strict',  env: 'ADSENSE_CLIENT_ID',       hint: 'ca-pub-XXXXXXXXXXXXXXXX' },
  { id: 'medianet',     name: 'Media.net',         signup: 'https://www.media.net/publishers/',          approval: 'quick',   env: 'MEDIANET_CID',            hint: '8-digit CID from Media.net dashboard' },
  { id: 'adsterra',     name: 'Adsterra',          signup: 'https://publishers.adsterra.com',            approval: 'instant', env: 'ADSTERRA_SCRIPT_URL',     hint: 'the full //www.adsterranet.com/.../invoke.js URL from your Direct Link or display tag' },
  { id: 'propellerads', name: 'PropellerAds',      signup: 'https://partners.propellerads.com',          approval: 'instant', env: 'PROPELLER_ZONE_ID',       hint: 'numeric zone id from a configured ad placement' },
  { id: 'infolinks',    name: 'Infolinks',         signup: 'https://www.infolinks.com/join-us/',         approval: 'quick',   env: 'INFOLINKS_PUB_ID',        hint: 'pid number; also set INFOLINKS_SITE_ID (wsid)', extra: 'INFOLINKS_SITE_ID' },
  { id: 'a_ads',        name: 'A-Ads (crypto)',    signup: 'https://a-ads.com/',                         approval: 'instant', env: 'A_ADS_UNIT_ID',           hint: 'numeric unit id from your Ad Units page' },
  { id: 'popads',       name: 'PopAds (popunder)', signup: 'https://www.popads.net/users/register',      approval: 'instant', env: 'POPADS_SITE_ID',          hint: 'numeric site id; note: popunder ads are intrusive' },
  { id: 'coinzilla',    name: 'Coinzilla',         signup: 'https://coinzilla.com/',                     approval: 'quick',   env: 'COINZILLA_ZONE_ID',       hint: 'zone id from your Coinzilla dashboard' },
];

(async function render() {
  let active = [];
  try {
    const r = await fetch('/api/config');
    const j = await r.json();
    active = (j.ad_providers || []).map(p => p.id);
  } catch {}

  const list = document.getElementById('list');
  list.innerHTML = PROVIDERS.map(p => {
    const isOn = active.includes(p.id);
    return `
      <div class="card">
        <h2>
          ${p.name}
          <span class="pill ${p.approval}">${p.approval}</span>
          ${isOn ? '<span class="pill" style="background:#2e7d32;color:#fff">ACTIVE</span>' : ''}
        </h2>
        <p class="sub2">${p.hint}</p>
        <div class="row">
          <a class="btn" href="${p.signup}" target="_blank" rel="noopener">Sign up ↗</a>
          <code>${p.env}${p.extra ? ' + ' + p.extra : ''}</code>
        </div>
      </div>
    `;
  }).join('');
})();
