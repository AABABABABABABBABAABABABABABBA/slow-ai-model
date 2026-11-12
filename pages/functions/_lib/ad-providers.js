// Registry of free-signup ad networks that pay publishers.
// Each provider is activated by setting its env vars (public keys are
// non-sensitive; the client needs them to render the ad).
//
// Approval difficulty rough ranking:
//   instant        -> Adsterra, PropellerAds, A-Ads, PopAds, Infolinks
//   quick review   -> Media.net, Monumetric, Coinzilla
//   strict review  -> AdSense, Ezoic
//
// Payout methods vary — PayPal is universal, crypto for A-Ads/Coinzilla,
// wire for AdSense + Ezoic.

export const AD_PROVIDERS = [
  {
    id: 'adsense',
    name: 'Google AdSense',
    signup: 'https://adsense.google.com/start/',
    approval: 'strict review — needs original content + some traffic',
    envKey: 'ADSENSE_CLIENT_ID',       // ca-pub-XXXX
    scriptSrc: (id) => `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(id)}`,
    scriptAttrs: { async: true, crossorigin: 'anonymous' },
    // Caller inserts an <ins class="adsbygoogle" data-ad-client=... data-ad-slot=...>
    slotHtml: (id, slot) =>
      `<ins class="adsbygoogle" style="display:block" data-ad-client="${id}" data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins>`,
    initHtml: `<script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>`,
    needsSlot: true,
  },
  {
    id: 'medianet',
    name: 'Media.net',
    signup: 'https://www.media.net/publishers/',
    approval: 'quick review — Yahoo/Bing contextual network',
    envKey: 'MEDIANET_CID',
    slotHtml: (id, slot) =>
      `<script src="//contextual.media.net/dmedianet.js?cid=${encodeURIComponent(id)}" async defer></script><div id="${slot || '_mn_slot'}"></div>`,
    needsSlot: true,
  },
  {
    id: 'adsterra',
    name: 'Adsterra',
    signup: 'https://publishers.adsterra.com/referral/t3qPOtVj12',
    approval: 'instant — all formats, high fill rate',
    envKey: 'ADSTERRA_SCRIPT_URL',     // the full script URL Adsterra gives you
    rawScriptSrc: true,
    slotHtml: (src) => `<script src="${src}" async defer></script>`,
    needsSlot: false,
  },
  {
    id: 'propellerads',
    name: 'PropellerAds',
    signup: 'https://partners.propellerads.com/#/auth/signup',
    approval: 'instant — popunder, interstitial, native',
    envKey: 'PROPELLER_ZONE_ID',
    slotHtml: (id) => `<script src="https://inklinkor.com/tag.min.js" data-zone="${encodeURIComponent(id)}" async data-cfasync="false"></script>`,
    needsSlot: false,
  },
  {
    id: 'infolinks',
    name: 'Infolinks',
    signup: 'https://www.infolinks.com/join-us/',
    approval: 'quick — in-text + intent-based ads',
    envKey: 'INFOLINKS_PUB_ID',
    extraKey: 'INFOLINKS_SITE_ID',
    initHtml: (pub, site) =>
      `<script>var infolinks_pid = ${Number(pub)}; var infolinks_wsid = ${Number(site)};</script><script src="//resources.infolinks.com/js/infolinks_main.js" async></script>`,
    needsSlot: false,
  },
  {
    id: 'a_ads',
    name: 'A-Ads (crypto)',
    signup: 'https://a-ads.com/',
    approval: 'instant — anonymous, crypto payouts',
    envKey: 'A_ADS_UNIT_ID',
    slotHtml: (id) => `<iframe data-aa="${encodeURIComponent(id)}" src="//ad.a-ads.com/${encodeURIComponent(id)}?size=320x50" style="width:320px;height:50px;border:0;padding:0;overflow:hidden;background-color:transparent" referrerpolicy="no-referrer"></iframe>`,
    needsSlot: false,
  },
  {
    id: 'popads',
    name: 'PopAds (popunder)',
    signup: 'https://www.popads.net/users/register',
    approval: 'instant — popunder only, aggressive',
    envKey: 'POPADS_SITE_ID',
    slotHtml: (id) => `<script type="text/javascript" data-cfasync="false">var _pop=_pop||[];_pop.push(["siteId",${Number(id)}]);</script><script type="text/javascript" src="//c1.popads.net/pop.js" async></script>`,
    needsSlot: false,
  },
  {
    id: 'coinzilla',
    name: 'Coinzilla (crypto-adjacent)',
    signup: 'https://coinzilla.com/',
    approval: 'quick — crypto niche, higher CPM',
    envKey: 'COINZILLA_ZONE_ID',
    slotHtml: (id) => `<script async src="https://coinzillatag.com/lib/display.js"></script><div class="coinzilla" data-zone="${encodeURIComponent(id)}"></div>`,
    needsSlot: false,
  },
];

// Build the list of providers the admin has actually configured.
export function activeAdProviders(env) {
  const out = [];
  for (const p of AD_PROVIDERS) {
    const primary = env[p.envKey];
    if (!primary) continue;
    const extra = p.extraKey ? env[p.extraKey] : null;
    if (p.extraKey && !extra) continue;
    out.push({
      id: p.id,
      name: p.name,
      primary,
      extra,
      needsSlot: !!p.needsSlot,
      rawScriptSrc: !!p.rawScriptSrc,
    });
  }
  return out;
}
