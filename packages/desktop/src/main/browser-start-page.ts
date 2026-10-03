export function workbenchBrowserStartPage(nonce: string): string {
  if (!/^[a-zA-Z0-9]+$/.test(nonce)) throw new TypeError("Invalid browser start-page nonce")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Arforge Browser</title><style>
:root{color-scheme:light dark;--bg:#f4f5f6;--panel:#fff;--ink:#202328;--muted:#535d68;--line:#ccd2d9;--accent:#1763b5;--error:#aa2537}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font:16px/1.6 "Segoe UI",sans-serif;background:radial-gradient(ellipse at 15% 0%,#e2ebf5,transparent 65%),var(--bg)}
main{width:min(720px,calc(100% - 48px));margin:12vh auto;padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
.eyebrow{font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}h1{font-size:32px;line-height:1.2;font-weight:600;margin:12px 0 16px}p{color:var(--muted);margin:0 0 24px}label{display:block;font-weight:600;margin-bottom:8px}.row{display:flex;gap:10px}
input{min-width:0;flex:1;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:inherit;min-height:46px}button{min-height:46px;padding:10px 20px;border:0;border-radius:8px;background:var(--accent);color:white;font:inherit;font-weight:600;cursor:pointer}button:hover{filter:brightness(1.1)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
#error{min-height:26px;color:var(--error);margin:10px 0 0}.notes{margin:20px 0 0;padding:18px 0 0;border-top:1px solid var(--line);font-size:14px}.notes p{margin:0 0 8px}
@media(max-width:500px){main{width:calc(100% - 24px);padding:22px;margin:5vh auto}.row{flex-direction:column}h1{font-size:27px}}
@media(prefers-color-scheme:dark){:root{--bg:#16191d;--panel:#22262c;--ink:#f2f4f6;--muted:#b7c0ca;--line:#4b555f;--accent:#3279c9;--error:#ff9aab}body{background:radial-gradient(ellipse at 15% 0%,#263441,transparent 65%),var(--bg)}}
</style></head><body><main>
<div class="eyebrow">Arforge / Web workspace</div><h1>Isolated browser</h1>
<p>Browse in a separate, temporary session. Arforge cookies and local files are not shared with this window.</p>
<form id="address-form"><label for="address">Website address</label><div class="row"><input id="address" type="url" required maxlength="8192" placeholder="https://example.com" autocomplete="off" spellcheck="false" aria-describedby="error scope"><button type="submit">Open</button></div><p id="error" role="alert"></p></form>
<div class="notes" id="scope"><p>Use the Browser menu for Address, Back, Forward and Reload. New origins must be entered here explicitly.</p><p>Permissions, popups, downloads and non-HTTP(S) resources are blocked. Manual browsing only; workbench embedding and AI control are not enabled.</p></div>
</main><script nonce="${nonce}">
const form=document.getElementById('address-form');
form.addEventListener('submit',event=>{event.preventDefault();const error=document.getElementById('error');try{const url=new URL(document.getElementById('address').value.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Enter an HTTP(S) address without inline credentials.');error.textContent='';location.assign(url.href)}catch(failure){error.textContent=failure.message||'Invalid website address.'}});
document.getElementById('address').focus();
</script></body></html>`
}
