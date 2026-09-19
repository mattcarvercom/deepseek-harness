# sanoTTS asset manifest

Pinned, self-hosted copy of the [sanoTTS](https://github.com/Ampixa/sanoTTS) web runtime and the
`heart` / `heartnano` voices. Nothing in this directory is fetched from a CDN or any other network
source at runtime: the `apps/web` build copies it to `dist/sanotts/`, the local `dsh web` server
serves it, and the browser half dynamically imports `<origin>/sanotts/index.js` on first use with
both the asset base and the voice base pinned to that served directory. The explicit voice base is
what disables the runtime's Hugging Face fallback, so synthesis is fully local.

## Provenance

| Item | Source | Pin |
|---|---|---|
| Runtime files | npm `sanotts-web@0.3.0` (the `dist/` of the sanoTTS repository) | tarball kept as `sanotts-web-0.3.0.tgz`; sha256 `f8869738f76cd35b7e1cede8d3bb2db667fcfd752270bcf4e5d712e9343eef6d`; npm integrity `sha512-1npJ+nptbU4+byTFLIRy81XsvSKVDj1FOGHiyCjeO2PM+/Y3mIKb1FheYjenfyrNqQ6uuN36ODBCFfFzHvmBtA==` |
| Voice weights (`voices/heart/`, `voices/heartnano/`) | sanoTTS repository, tag `voices-v2` (commit `1cd82e6d960e382afef0618684dc5151709f7fcb`) | per-file sha256 table below |
| Licenses | `LICENSE-GPL` — sanoTTS (GPL-3.0); `LICENSE-MIT` — web runtime core (MIT, Ampixa 2026) | per-file sha256 table below |

The voice weight files keep the upstream file names (`heart_meta.json` → `voices/heart/meta.json`);
the voice metadata's `module`, `front`, and `dec` fields name the sibling files this layout uses.

## Per-file sha256

| File | sha256 | Bytes |
|---|---|---|
| `sanotts-web-0.3.0.tgz` | `f8869738f76cd35b7e1cede8d3bb2db667fcfd752270bcf4e5d712e9343eef6d` | 1,004,847 |
| `index.js` | `0f52b0e87337f5fbcc075b30f2ffb7130b1f319d35995f5ac01d2003c2d9a3e6` | 21,528 |
| `snt_g2p.js` | `16c09da27d88404fc312fa84ed2b1e1b2584f24fd41337f34a8293a25146b7ab` | 70,136 |
| `snt_g2p.wasm` | `31da95f157c942c17078f9fa87a0f981cc8d199669b28f8f0d4b61f9e8a9301e` | 322,974 |
| `snt_g2p.data` | `7f999dfd6efa655018fa19a7c32a1ed889a7576751fbdbec61053f6b8a0cc827` | 2,132,172 |
| `snt_voice.js` | `73745db50516d6052802994a02dd8d0e3e27fcd26efa8cbe7e849d7ee5634266` | 10,406 |
| `snt_voice.wasm` | `cdcfa5bf3ec162797d8556be7b90ce334f88666141956a1650846bdff9517d1c` | 40,787 |
| `snt_nano_heart.js` | `c52d8377eaeda2adf57a12db8e179e326886bdf8081ac066a9de6a1e743ac31f` | 11,137 |
| `snt_nano_heart.wasm` | `aeadfe62d09ab41a1e9e021bb39316318d6d465ef3b81abb16ff4a8daeb92812` | 42,552 |
| `snt_nano_heartnano.js` | `45e9c01f7e1bc661f22875961fa824c2eb503a4e13783c0b035ae7210403b5ec` | 11,157 |
| `snt_nano_heartnano.wasm` | `d61eb078bc10334d5cb07d36e4eeb58b879d776cd87ceebaf888f43f84053497` | 50,349 |
| `trellis_frontend.js` | `1d8523bab2e96f03ea98131a3d575d92851d3870899435ba3a306804238e49b3` | 20,026 |
| `voices/heart/meta.json` | `9a19af32725f503a4237339ab91cee66c6cfc7fb9aadbef38322d1dafadd7f87` | 1,186 |
| `voices/heart/front_f32.bin` | `02e8086ebedf70216efa7beae274351d7ee916579277e83161748a08325d0b49` | 3,273,696 |
| `voices/heart/model_f32.bin` | `2d685fc751bc096b956d76a9e6ad105ed6da33c61faaa43c7423d935eeb7481b` | 5,864,224 |
| `voices/heartnano/meta.json` | `873c9264c16c99cf10f2b65f73eb388b4935c4f46e3f529d2b89b13f8f9e5659` | 1,185 |
| `voices/heartnano/front_q8.bin` | `5553ae5abf37c18d31c0b64ea791785b30e7a08cc32c07bff8bb2ab4aae0b94b` | 109,296 |
| `voices/heartnano/model_q8.bin` | `4a6cdf0d0bf1996aa2c056298265ea8dd0c200c9025cba4a9b04e0e987bea88c` | 235,936 |
| `LICENSE-GPL` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | 35,147 |
| `LICENSE-MIT` | `2f544ceb6a679cf706652c9df3bf8a6753197ee36456ba61665d97fbed43210e` | 4,113 |

`pnpm run test` verifies every file in this directory against the table (`tests/asset-manifest.spec.ts`).

## Notes

- `index.js` and the `snt_*.js` files contain NUL bytes inside string literals (upstream build
  artifacts); they are valid ES modules.
- The GPL-3.0 runtime is deliberately kept out of the package's module graph: the browser half
  loads it by URL at first use, so dsh source and bundles carry no GPL code.
- `heart` is the default voice (2.27M parameters, 24 kHz, ~9.1 MB total). `heartnano`
  (294k parameters, int8, 337 KB) is the low-resource fallback registered in
  `src/client/voices.ts`; neither ships a picker.
