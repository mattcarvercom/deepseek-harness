---
description: "In-browser read-aloud for dsh web assistant responses: the per-message speaker/stop action and the auto-read setting, synthesized on-device by the self-hosted sanotts wasm runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-readaloud

English | [中文](README.zh.md)

## Summary

Use this package to have the dsh web client speak assistant responses aloud. Every settled assistant message — the turn's closing reply and its working steps — gains a speaker action that flips to a stop control while it reads; starting one read stops any other. The General Settings **Auto-read responses** row (off by default) reads messages as they settle, narrating a running turn step by step. Speech is synthesized on-device by the vendored sanotts runtime and streamed sentence by sentence; no server, no Python, no network beyond the page's origin. The default voice is `heart`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The speaker action sits in the assistant message's action row, between copy and branch, and beside the text of every settled working step. Its tooltip reads **Read aloud** (Chinese: 朗读); while the message is synthesizing, playing, or paused it becomes a filled stop glyph with the tooltip **Stop reading** (停止朗读). Pressing it again — or starting any other read, in any Session on the page — stops it. A message with no speakable text (no text at all, or fenced code only) renders the action-row button as unavailable: it cannot be pressed, and a localized note explains why; a working step with no speakable text shows no control at all. If synthesis fails, a localized status notice appears under the row until the user tries again. While a message reads, the sentence-sized chunk being spoken is highlighted in place; the highlight clears the moment the read stops, fails, or finishes, and a pause keeps it where it was. The sidebar marks the speaking session with a small pulsing speaker beside its title, so switching sessions to read while the voice keeps playing never loses where the voice is coming from.

The preference has two homes: the **Auto-read responses** row in General Settings (title, description, switch; default off) and a compact **Auto-read** toggle chip in the composer tool row beside the model selector. A pause/resume chip and a stop chip appear in that same row while this Session speaks — streaming reads included, which have no message row to stop from — and the sidebar's session speaker stops the read when clicked without opening the session. Pause keeps the place: the audio stops where it is, and resume continues from the next word boundary inside the remaining text, so a long read survives a session switch — leaving a session pauses its read, and returning offers the resume chip after flushing any tail that settled while away. With it on, a *generating* reply is narrated as it streams: every complete sentence starts playing while the model is still writing, and a sentence that runs past the 120-character streaming budget is cut at its last clause break — a word boundary only when it has none — so one sentence cannot delay the first audio and each piece still ends where the voice pauses naturally. The tail is read when the step settles, and a settled step the narrator never streamed (an interruption, or a projection a retry rewrote) is read then, once, at the moment the message's finalized node arrives. Auto-read fires only for generations the open Session watched run: mounting a session's existing messages — switching sessions — never reads them. The sentence being spoken is highlighted in place throughout, including while the reply is still generating. Starting a read never silences what is already playing: a streaming read lets the previous voice run until its own first chunk is scheduled, then hands over. No message is re-read when the preference is flipped on later or the message remounts. The preference persists through the standard user-settings mechanism: durably on loopback hosts, and in process memory otherwise, so it survives a page reload either way.

The package speaks only user-visible text. It projects the message's markdown to plain text and skips fenced code blocks entirely; reasoning, tool calls, trajectories, and system text are never synthesized. Image blocks are read as their alt text, links as their label, tables as plain cells, and raw HTML is passed through verbatim.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Two page-global singletons serve every Session, each per-Session surface rides on top of them.

### The GPL boundary

The sanotts runtime is GPL-licensed and is deliberately kept out of the bundle's module graph: a dedicated Blob worker dynamically imports `<document base>sanotts/index.js` on first use, and `assetBase` and `voiceBase` both point at that same self-hosted directory. A worker has no `document`, and the runtime injects its Emscripten modules as script tags, so the worker body installs a minimal shim whose `appendChild` maps to `importScripts`; the runtime's own global checks then resolve as they do in the page. Passing the voice base explicitly is the no-network guarantee — the runtime's CDN fallback is only consulted when no base is given. The Vite build copies `assets/sanotts/` byte-identical into `dist/sanotts/`, and `frontend-static` serves `.wasm` as `application/wasm`, so every fetch is same-origin. Playback uses a native `AudioBufferSourceNode`; the runtime's own `playAudio` is never called. The GPL and MIT notices ship inside `assets/sanotts/` beside the code and voice weights they license.

### The engine and director

The worker loads the runtime once and caches the wasm modules and each voice's weights; a failed load is evicted so the next request retries. The engine splits the utterance into chunks of at most 120 characters — the nano voice's 62-symbol frontend accepts at most 207 phoneme tokens per call, and text phonemizes at roughly 1.1 tokens per character — and `stream` yields each chunk's waveform as it lands, so playback starts with the first chunk while the worker synthesizes the rest. Each line the projection emitted (a heading, a list item, a paragraph row) chunks on its own, so a structural boundary stays a chunk boundary; sentences pack greedily up to the budget, and a sentence over the budget splits at its last clause punctuation (kept with the clause) before falling back to word boundaries, so pieces end where the voice can pause. Every synthesis also carries roughly 300 ms of leading and 400-500 ms of trailing dead air; the engine trims the lead to a short onset guard and the tail to a 400 ms sentence pause, or 150 ms when the sentence continues into the next chunk, so consecutive chunks join without an unnatural gap. A chunk whose tokens still overflow the cap (character count alone cannot bound phonemes for path-like tokens and symbol runs) is split at its midpoint and the pieces retried before that chunk is yielded. Each chunk carries the span it covers in the block's speakable text, and the director maps that span through the projection back to Markdown source ranges and publishes them with the playback state, which ui-chat renders as the in-place highlight. The director owns one lazily created shared `AudioContext` — created inside `speak()`, so a manual click is born inside a user gesture, and resumed on every play — and at most one live read; it schedules each chunk behind the previous one and caps the scheduled audio at 300 seconds. A generation token discards a chunk whose request was superseded before it landed, and `stop()` cancels the in-flight synthesis (terminating the worker, which the next read replaces in tens of milliseconds) and publishes the resting state for both playing and still-synthesizing requests. A `pause()` stops the scheduled sources where they are and keeps the position — the unplayed remainder of the currently sounding chunk, snapped to its next word boundary, returns to the front of the queue — while `resume()` re-queues from there; leaving a Session pauses its read instead of ending it, and the narrator keeps its projection progress per Session, so a reply that settles while away flushes its tail into the paused read.

### Per-session surfaces and the preference

Each Session owns the set of messages it has already spoken (a failed read still counts, keeping auto-read at most once per message across remounts) and a playback snapshot store its message entries subscribe to. The auto-read preference is one page-global snapshot store fed by a settings-scope binding: writes go live first and durable second, adoption on subscribe never writes back, and the Node half registers the `ui-readaloud` namespace (`autoRead` boolean, default `false`) with the settings service.

### The speakable text

`speakableText` takes the message's text blocks, joins them, strips fenced code with GFM fence rules (three or more matching backticks or tildes, zero to three leading spaces, a closer of at least equal length; a trailing unclosed fence cuts to the end of the message), and projects the remainder with the shared GFM-to-plain-text projection. Four-space-indented code is not a fence and is spoken as trimmed source; the projection trims lines and collapses blank runs, which is why the strip step's leftover blank lines never reach the speaker.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-chat](../ui-chat/README.md) — the conversation layer whose `conversation.chat.assistant-actions` strip hosts the speaker entry.
- [ui-settings](../ui-settings/README.md) — the settings scope service the preference binds to.
- [ui-settings-general](../ui-settings-general/README.md) — the General section shell hosting the auto-read row.
- [ui-primitives](../ui-primitives/README.md) — the speaker and stop glyphs, the switch, and the GFM-to-plain-text projection.
- [settings](../../settings/README.md) — the durable user-settings seam the namespace registers with.
- [sanotts](https://github.com/Parakeid/sanotts) — the upstream text-to-speech runtime this package vendors.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, each documented at the place that carries it.

- **Browser autoplay policy** — on a page where the user has not made a gesture, some browsers hold the shared AudioContext suspended, so the first auto-read can be silent until the next gesture unlocks it; manual reads are born inside their click and are unaffected.
- **Five-minute synthesis cap** — a read longer than 300 seconds is truncated; the director stops scheduling chunks once the cap is reached, dropping a chunk's tail if it lands across the boundary.
- **Indented code is spoken** — GFM four-space-indented code is not a fence, so it is read as trimmed source text; only fenced blocks are skipped.
- **Highlight granularity** — the in-place highlight covers the sentence-sized chunk being spoken, mapped to its Markdown source; it is not word-synced, because the runtime reports no word timings.
- **Non-loopback persistence** — outside a loopback host the settings seam persists in process memory, so the preference resets when the host process restarts, though it always survives a page reload.
- **No voice picker** — `heart` is the default and `heartnano` the registered low-resource fallback; selecting between them is a code change, not a setting.
- **Raw HTML is passed verbatim** — HTML in a message is forwarded to the speech engine as text rather than rendered or interpreted.
- **The provenance tarball ships in the package** — `assets/sanotts/sanotts-web-0.3.0.tgz` is included in `files` as the pinning record; it is never fetched or executed by the browser.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **Asset pinning.** `assets/sanotts/MANIFEST.md` records the npm tarball (sha256 and npm sha512) and the voice-weight source commit, plus a per-file sha256 table; `tests/asset-manifest.spec.ts` re-verifies the table against the directory on every test run. Re-vendoring means re-recording that table.
- **CSP verdict.** No CSP change is required: the main document carries no CSP, and the only sandboxed iframes (media previews on `/api/file`) never host the runtime.
- **Test seams.** The worker body takes its module and script loaders as parameters, the runtime takes a Worker factory, and the engine takes a synthesis-runtime seam, so the specs drive the protocol, the worker caching, and the streaming schedule with fakes and stub the WebAudio globals: no test synthesizes real audio, imports the wasm, or touches the network; the browser bench boots the assembled web app and asserts the entry, the preference, and the playback lifecycle without audio.
- **Upgrade path.** The runtime is pinned to the vendored 0.3.0; a version bump is a re-vendor (new hashes, new manifest rows), not a dependency change.

</details>

**Runtime invariant:** No companion is published. Playback and the preference are browser-local state over typed snapshot stores covered by the component, store, and bench tests, and no Cordis runtime relationship can diverge between two independent observations.
