# Agent Note: In-Browser Read-Aloud for Assistant Responses (Vendored sanotts Runtime)

Status: proposed

English | [中文](2026-09-18-in-browser-readaloud-sanotts.zh.md)

## Problem

Users who keep a session open for long answers — or who read in noisy places, on a phone, or with low vision — want assistant responses read aloud. The dsh web client had no audio surface at all.

The obvious rungs each fail the product's requirements. The Web Speech API depends on whatever voice the operating system and browser happen to install: quality varies, availability varies, and the output cannot be pinned or verified across machines. A server-side synthesizer (a sanotts Python process behind the host, or a remote TTS API) turns an offline, self-hosted product into one with a per-utterance network dependency, an API key to manage, or a Python runtime to ship — and the product requirement is explicitly the opposite: no server, no Python, synthesis on the machine that owns the speaker.

What was missing was a way to carry a fixed, self-hosted speech model into the browser, load it only when someone actually reads something, and keep that code outside the license boundary of the shipped bundle.

## Proposal

Add `@deepseek-ai/dsh-client-ui-readaloud`, a web client plugin with two entries: a speaker/stop action on every assistant message in the `conversation.chat.assistant-actions` strip, and an **Auto-read responses** row in the General settings section (`ui-readaloud` settings namespace, `autoRead` boolean, default off, registered by the package's Node half through the standard settings service).

The synthesis engine is the vendored **sanotts** runtime (npm `sanotts-web@0.3.0`), the GPL-licensed wasm text-to-speech engine from the same model lineage as the repo's own speech work. The assets — the runtime, the G2P and voice wasm modules, and the `heart` and `heartnano` voice weights — are vendored into `assets/sanotts/` with a sha256 manifest, copied byte-identical by the web build into `dist/sanotts/`, and loaded by URL at first use:

- **First use, never at boot.** The client bundle statically imports nothing from the runtime. On the first synthesis the engine performs a dynamic `import()` of `<document base>sanotts/index.js`; the module's `assetBase` and `voiceBase` both resolve to the same self-hosted directory. Because the voice base is passed explicitly, the runtime's Hugging Face CDN fallback — its default when no base is given — is never consulted. No fetch in the feature leaves the page's origin.
- **One engine, one director, one context.** A page-global engine caches the module import, the wasm loads, and each voice's weights (a failed load is evicted and retried on the next call; synthesis output is capped at 300 seconds). A page-global director owns one lazily created shared `AudioContext` and at most one live playback; starting any read stops the previous one, whatever Session it belongs to, so audio never overlaps. Playback is a native `AudioBufferSourceNode` — the runtime's own `playAudio` is deliberately never called, so the GPL code path that touches audio stays on the synthesis side of the boundary. A generation token discards synthesis results whose request was superseded before they land.
- **Speakable text only.** Each message's text blocks are joined, stripped of fenced code with GFM fence rules, and projected through the shared GFM-to-plain-text projection. Reasoning, tool calls, trajectories, and system text are never synthesized; fenced code is skipped entirely; images read as alt text; raw HTML passes through verbatim.
- **Auto-read semantics.** With the preference on, a message is spoken once, at the moment it becomes speakable — the finalized node arriving, the same settled signal the transcript uses for inline images — and a newer turn starting in the Session stops whatever is playing. A preference flipped on while already-readable rows are mounted deliberately does not re-read them, and the per-Session spoken set keeps the guarantee at most once per message across remounts.

## GPL boundary and asset pinning

The GPL runtime is a *served asset*, not a dependency: it is absent from every `package.json`, from the tsdown bundle graph, and from the Vite module graph, and it arrives as static files the dsh host serves. The copyleft material therefore stays outside the product's compiled code; the boundary is load-time, and it is enforced by construction (the only reference is a URL string) rather than by review. The GPL notice ships inside `assets/sanotts/` beside the code it licenses, the voice weights carry their MIT notice, and `MANIFEST.md` records the npm tarball's sha256 and npm sha512, the voice-weight source commit, and a per-file sha256 table that `tests/asset-manifest.spec.ts` re-verifies against the directory on every run. The npm tarball itself ships inside `files` as the pinning record — never fetched, never executed.

## Voice choice

`heart` (2.27M parameters, f32, ~9.1 MB of weights) is the default voice; `heartnano` (294k parameters, int8, ~337 KB) is registered in the same voice registry as the low-resource fallback. The registry is a key union plus a default constant — structured for more voices later, but per the product decision there is no picker in this release: choosing a different default is a code change.

## Alternatives considered

- **Web Speech API (`speechSynthesis`).** Loses on every axis that mattered: the voice is whatever the OS and browser ship, so quality, availability, and even basic coverage vary by machine; the output cannot be pinned, snapshotted, or tested; and some platforms have no usable voice at all.
- **Server-side TTS (host-spawned sanotts Python process, or a remote TTS API).** Either direction breaks the self-hosted/no-server requirement: the Python process is a runtime the product does not ship, and the API is a per-utterance network dependency with a key to manage, exactly what the requirement rules out.
- **Bundling the npm `sanotts-web` runtime into the client bundle.** The GPL code would then sit inside the product's compiled module graph — in every consumer's build — instead of beside it as a served, versioned asset. The URL-based dynamic import keeps the module graph GPL-free while the assets stay pinned and same-origin.
- **CDN or Hugging Face-hosted voice weights (the runtime's default behavior).** The runtime only consults the CDN when no `voiceBase` is given; passing the self-hosted directory explicitly is the mechanism that makes "no network" true, so relying on the default would defeat the pinning.
- **`heartnano` as the default.** It is 27× smaller, but the product decision favors the higher-fidelity `heart` for the default experience; `heartnano` remains available in the registry for callers that need the low-resource option.
- **A voice picker in Settings.** Explicitly out of scope for this release; the voice registry exists so adding one later is a data change, not a re-architecture.

## Acceptance criteria

- With auto-read off (the default), nothing is ever spoken.
- The speaker button on an assistant message reads that one message; while synthesizing or playing it shows the stop control; starting any other read stops it, and no two reads overlap, across Sessions.
- With auto-read on, the final assistant message of each turn is spoken exactly once, after the turn settles; a new turn stops the previous playback; the preference survives a page reload (durably on loopback hosts, in process memory otherwise).
- Only user-visible text is spoken: no reasoning, tool calls, trajectories, or system text; fenced code is skipped; markdown is projected to plain text.
- Every asset fetch is same-origin against the served `sanotts/` directory; no CDN is contacted; the manifest hashes verify on every test run.
- The browser bench boots the assembled web app with the plugin and asserts the entry, the preference, and the playback lifecycle without audio; unit suites cover the engine seams, the director's state machine, the speakable-text policy, the settings store, and the Node half's registration and disposal.

## Risks

- **Autoplay policy.** On a page with no prior user gesture, browsers may keep the shared AudioContext suspended, so a first auto-read can be silent until the next gesture unlocks it. Mitigation: the context is created inside `speak()`, so manual reads are born inside their click; the limitation is documented in the package README.
- **Five-minute truncation.** The runtime's 300-second output cap silently truncates longer messages; this is documented as a known limitation rather than hidden.
- **Indented code is spoken.** GFM four-space-indented code is not a fence, so it is read as trimmed source; fenced code is the skipped case.
- **GPL adjacency.** The copyleft runtime is a served asset the product's code references by URL; the load-time boundary, the shipped license notices, and the pinned manifest are the standing answer to that adjacency, and any re-vendor must re-record the manifest in the same change.
- **Asset weight.** The vendored directory is dominated by `heart` (~9.1 MB) and the tarball (~1 MB), copied into every web build's `dist/`; `heartnano` exists as the small fallback if the footprint ever becomes a problem.
- **Version drift.** The runtime is pinned at 0.3.0; an upstream upgrade is a re-vendor with new hashes, not a dependency bump, and the asset-manifest test is the guard that catches an unrecorded change.
