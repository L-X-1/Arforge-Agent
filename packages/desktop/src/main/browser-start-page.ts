import { browserStartCopy, browserStartLanguage, browserStartLocales } from "./browser-start-page-copy"
import type { WorkbenchBrowserAppearance } from "./browser-appearance"
import { normalizeWorkbenchBrowserUrl } from "@arforge-ai/app/browser-workbench"

function escapeHTML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function scriptValue(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

export function workbenchBrowserStartPage(
  nonce: string,
  appearance: WorkbenchBrowserAppearance = { mode: "light", locale: "en" },
): string {
  if (!/^[a-zA-Z0-9]+$/.test(nonce)) throw new TypeError("Invalid browser start-page nonce")
  const mode = appearance.mode === "dark" ? "dark" : "light"
  const locale = browserStartLocales.includes(appearance.locale) ? appearance.locale : "en"
  const copy = browserStartCopy[locale]
  const languages = Object.fromEntries(browserStartLocales.map((value) => [value, browserStartLanguage(value)]))
  return `<!doctype html>
<html lang="${browserStartLanguage(locale)}" dir="${locale === "ar" ? "rtl" : "ltr"}" data-color-scheme="${mode}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Arforge Browser</title><style>
:root{color-scheme:light;--bg:#FAFAF7;--panel:#FFFFFF;--ink:#292B2B;--muted:#6F726A;--line:#DEDED8;--accent:#292B2B;--on-accent:#FFFFFF;--error:#A93838;--wash:#FFFFFF}
:root[data-color-scheme=dark]{color-scheme:dark;--bg:#1D1F1D;--panel:#252723;--ink:#F3F3ED;--muted:#B2B5AB;--line:#41443C;--accent:#F3F3ED;--on-accent:#252723;--error:#E7A3A0;--wash:#252723}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:clamp(24px,6vh,64px) 24px;color:var(--ink);font:17px/1.8 "Noto Sans SC","PingFang SC","Microsoft YaHei UI",sans-serif;background:radial-gradient(ellipse at 50% 0%,var(--wash),transparent 70%),var(--bg)}
main{width:min(720px,100%);padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 8px 32px #181A1808}
.eyebrow{font-size:12px;letter-spacing:.12em;color:var(--muted)}h1{font-size:28px;line-height:1.5;font-weight:500;margin:12px 0}p{color:var(--muted);margin:0 0 24px}label{display:block;font-size:14px;font-weight:500;margin-bottom:8px}.row{display:flex;gap:12px}
input{min-width:0;flex:1;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;min-height:46px}input::placeholder{color:var(--muted)}button{min-height:46px;padding:10px 20px;border:1px solid transparent;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:500;cursor:pointer}button:hover{opacity:.88}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
#error{min-height:26px;color:var(--error);font-size:14px;margin:8px 0 0}.notes{margin:16px 0 0;padding:16px 0 0;border-top:1px solid var(--line);font-size:14px;line-height:1.7}.notes p{margin:0 0 8px}.notes p:last-child{margin-bottom:0}
@media(max-width:500px){body{padding:16px}main{padding:22px}.row{flex-direction:column}h1{font-size:24px}}
@media(forced-colors:active){main,input,button{border:1px solid CanvasText}}
</style></head><body><main>
<div class="eyebrow" id="eyebrow">${escapeHTML(copy.eyebrow)}</div><h1 id="browser-title">${escapeHTML(copy.title)}</h1>
<p id="intro">${escapeHTML(copy.intro)}</p>
<form id="address-form"><label for="address" id="address-label">${escapeHTML(copy.address)}</label><div class="row"><input id="address" type="text" inputmode="url" dir="ltr" required maxlength="8192" placeholder="https://example.com" autocomplete="off" spellcheck="false" aria-describedby="error scope"><button type="submit" id="open-label">${escapeHTML(copy.open)}</button></div><p id="error" role="alert"></p></form>
<div class="notes" id="scope"><p id="controls">${escapeHTML(copy.controls)}</p><p id="security">${escapeHTML(copy.security)}</p></div>
</main><script nonce="${nonce}">
const copies=${scriptValue(browserStartCopy)};
const languages=${scriptValue(languages)};
let currentLocale=${scriptValue(locale)};
let invalid=false;
function applyAppearance(next){
  currentLocale=Object.prototype.hasOwnProperty.call(copies,next.locale)?next.locale:'en';
  const copy=copies[currentLocale];
  document.documentElement.lang=languages[currentLocale];
  document.documentElement.dir=currentLocale==='ar'?'rtl':'ltr';
  document.documentElement.dataset.colorScheme=next.mode==='dark'?'dark':'light';
  for(const [id,key] of [['eyebrow','eyebrow'],['browser-title','title'],['intro','intro'],['address-label','address'],['open-label','open'],['controls','controls'],['security','security']])document.getElementById(id).textContent=copy[key];
  document.getElementById('error').textContent=invalid?copy.invalid:'';
}
globalThis.__arforgeBrowserAppearance=applyAppearance;
const form=document.getElementById('address-form');
const normalizeAddress=(${normalizeWorkbenchBrowserUrl.toString()});
form.addEventListener('submit',event=>{event.preventDefault();try{const url=normalizeAddress(document.getElementById('address').value);invalid=false;document.getElementById('error').textContent='';location.assign(url)}catch{invalid=true;document.getElementById('error').textContent=copies[currentLocale].invalid}});
document.getElementById('address').focus();
</script></body></html>`
}
