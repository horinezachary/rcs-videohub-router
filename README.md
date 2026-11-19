# Videohub Router

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module that routes sources to
destinations on a Blackmagic Videohub (Smart Videohub, Universal Videohub, Videohub Server) over the
Videohub Ethernet protocol on TCP port 9990.

- **Routes**: tap a destination, then a source. The 1920×440 panel shows 12 of each per page; a 16:9
  touchscreen (1920×1080) gives each section as many rows of 12 as its ports need, up to four, so a 40×40 router
  shows without paging, with larger labels. The web view shows them all.
- **Stream Deck**: keys 1 to 10 are sources (with more than 10 inputs, key 10 pages through them),
  keys 11 and 13 step through destinations and key 12 shows the selected one. Hold key 14 or 15 to
  recall the first two salvos. On a larger deck (an XL, 8×4, or a Stream Deck + XL, 9×4) every row but
  the bottom one holds sources, and the bottom row is the destination keys followed by more salvos
  (needs controller 0.21.0; older ones give every module 15 keys).
- **Take mode** (Setup): a source press arms it, and TAKE (key 15, the last key on a larger deck, or the
  button on screen) routes it.
- **Salvos**: store the router's current routes, for all or some destinations, and recall them in one
  go. Recalling asks first on screen and needs a held key on the Stream Deck.
- **Labels**: shown on the panel (on a 16:9 touchscreen, in columns so every port shows), renamed in the web view.
  Labels live on the router.

## The router is the source of truth

Routes, labels and locks are read from the router on every connect and never saved. The module's
state holds only the selected destination and the salvos; config holds the address, port and take
mode. Starting, restoring a save, resuming after a power cut and reconnecting only listen to the
router, so nothing goes out until someone presses a key or taps the screen. The only thing sent
unprompted is the protocol's `PING`, a keepalive that changes nothing. What the panel shows is always
the router's own broadcast, never a guess at what a command did. Outputs locked by another client
are shown as LOCKED and are not routed.

## Develop

Node.js 22 or later, and a checkout of the main `rack-control-surface` repo, which holds the SDK
until it is published to npm.

```sh
# next to this folder: git clone …/rack-control-surface && cd rack-control-surface && npm install && npm run build
npm install            # links the SDK from ../rack-control-surface when it is there
npm run link-sdk -- C:\src\rack-control-surface    # or point at a checkout somewhere else (or set RCS_REPO)
npm test               # unit tests against a mock Videohub and the SDK's fake controller
npm run mock           # a pretend 20×20 Videohub on 127.0.0.1:9990 (--inputs, --outputs, --locked 3,4, --old-firmware)
npm run dev            # the simulator at http://127.0.0.1:5173/sim with this module
```

In the simulator, open the module, tap Setup and type `127.0.0.1` as the router address.
`npm ci` clears `node_modules`, so run `npm run link-sdk` again after it.

Anything that talks to live show equipment is developed against the mock first. Check with the
owner before pointing a development build at a router in use.

## Releasing

Every merge to `main` is a release (`.github/workflows/release.yml`), versioned from the PR title:
`feat:` is a minor bump, `!:` or `BREAKING CHANGE` a major one, anything else a patch; `[skip release]`
skips it. The workflow tests, stamps the version into `module.json`, packs, signs and publishes
`videohub-router-<version>.zip` and its `.sig` as a GitHub release here, where units find it through
the module index in [horinezachary/rcs-releases](https://github.com/horinezachary/rcs-releases).

It needs two Actions secrets:

- `RCS_SIGNING_KEY`: the module's private signing key. Make one with
  `node node_modules/@rcs/module-sdk/dist/pack-cli.js keygen`, keep `rcs-signing.key` safe (it is
  git-ignored), and add the printed public key to this module's entry in `index.json` in rcs-releases.
- `RCS_SOURCE_TOKEN`: a fine-grained token with Contents read-only on `rack-control-surface`, so the
  workflows can link the SDK from it. CI uses the tag in `package.json` `rcs.sdkRef`.

## Icon

`assets/icon.svg` is the Blackmagic Design mark, taken from [Simple Icons](https://simpleicons.org) 15.0.0
(`blackmagicdesign.svg`; the drawing is CC0). Blackmagic Design and Videohub are trademarks of Blackmagic Design
Pty. Ltd. The mark is used only to show which equipment this module works with. This module is not made or
endorsed by Blackmagic Design.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | The module backend: keys, salvos, config and the messages its UIs send |
| `src/client.ts` | The connection to one Videohub: reconnects, keepalive, ACK/NAK per command |
| `src/protocol.ts` | Block parsing and the router's state |
| `src/mock.ts`, `src/mock-cli.ts` | The mock Videohub |
| `ui/index.html` | The panel UI, 1824×440 or 1824×1080, in four views: Routes, Salvos, Labels, Setup |
| `web/index.html` | The web view's pages of the same names |
| `scripts/link-sdk.mjs` | Links `@rcs/*` from a main repo checkout |
