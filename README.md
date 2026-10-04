# webbox

Playground for web apps. Each app lives in its own folder and is published as it is, with no build step,
to GitHub Pages at https://ref12labs.github.io/webbox/ by the workflow in `.github/workflows/pages.yml` on every
push to `main`.

| App | Folder | What it is |
| --- | --- | --- |
| hexad remote | `/hexad/` (source: `web/remote` in Ref12/hexad) | The phone side of hexad's remote access: pairs with a hexad from a QR code, rings it through a Web Push doorbell to open its dev tunnel, shows hexad framed and its notifications, and takes shares. The workflow checks it out from the hexad repository with a read-only deploy key (secret `HEXAD_DEPLOY_KEY`; branch from the repository variable `HEXAD_REF`, default `main`). After a change there, run `gh workflow run pages.yml -R ref12labs/webbox`. |
| Qwen chat | `/qwen-chat/` | Chat with a Qwen model running fully in the browser, with a selectable engine: GPU (WebGPU, WebLLM 0.2.85) or CPU (WebAssembly, transformers.js 4.3.0 with int8 ONNX Qwen builds; single-threaded here because GitHub Pages cannot set the cross-origin-isolation headers threads need). Token meter, automatic trimming of old turns, context-size (GPU: 4K–32K, reload) and reply-length settings. Streaming, stop, system prompt, model picker with sizes, weights cached by the browser. |
| Speech keep-alive | `/speech-test/` | Installable test page for hands-free speech on a phone: browser voice, `<audio>` + Media Session, voice + silent loop, voice + Wake Lock, Web Audio and microphone (SpeechRecognition, getUserMedia level meter), with a persistent timestamped log and a "what happened while hidden" summary, to show what survives screen-off, in a tab vs installed. |
| Key Vault | `/keyvault/` | Browse and edit Azure Key Vault secrets in one window: MSAL sign-in, subscription and vault picker with recent vaults, inline show / copy / edit / new secret. Lists and writes through ARM; reading values needs the optional Cloudflare Worker CORS proxy in `keyvault/proxy/`. Setup in `keyvault/README.md`; `?mock=1` runs it on fake data. |

Line endings are left alone (`.gitattributes` has `* -text`).
