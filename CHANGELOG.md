# Changelog

## [3.9.0](https://github.com/22-2/obsidian-on-demand-plugins/compare/3.8.0...3.9.0) (2026-10-30)

### ✨ Features

* add a plugin table view for editing loading modes ([acea61d](https://github.com/22-2/obsidian-on-demand-plugins/commit/acea61d837aa132d21cc027963f19231c3a59ba4))
* add an optional uninstall action to the plugin table menu ([d72dcbd](https://github.com/22-2/obsidian-on-demand-plugins/commit/d72dcbd406609d168066c8a69d9818a0d2dfb0c4))
* allow changing plugin load state from the table ([ec79a5d](https://github.com/22-2/obsidian-on-demand-plugins/commit/ec79a5d662006973674cf4c235c77010fe6d06c5))
* filter loaded plugins by whether they are saved or in memory only ([75f3b67](https://github.com/22-2/obsidian-on-demand-plugins/commit/75f3b679f0970d5fddf3473ffde5e515a646db11))
* keep only the loaded state's tooltip in the plugin table ([c9b6722](https://github.com/22-2/obsidian-on-demand-plugins/commit/c9b67222a5083e539e51f270c7f3b60503b9ab57))
* list On-Demand itself in the plugin table ([5e65576](https://github.com/22-2/obsidian-on-demand-plugins/commit/5e65576d92de889fe4e069a882209e63dd6bda35))
* notify when a plugin uninstall starts ([2df1dbe](https://github.com/22-2/obsidian-on-demand-plugins/commit/2df1dbeae33ecfd8ea768e0cb9c128125839088b))
* notify when the plugin list refresh starts and ends ([54571af](https://github.com/22-2/obsidian-on-demand-plugins/commit/54571af6cf9098bdbcf6d6460afbaa8bfe6683c8))
* open the plugin table from plugin management ([f203537](https://github.com/22-2/obsidian-on-demand-plugins/commit/f2035376f6061ace9209c67f366cb6dc784ac1b2))
* place the lazy settings gear after the mode dropdown ([da90f16](https://github.com/22-2/obsidian-on-demand-plugins/commit/da90f16a65611c09ed3350e2b0a2852024654792))
* quiet the plugin table's repeated controls ([5fa4a7e](https://github.com/22-2/obsidian-on-demand-plugins/commit/5fa4a7ea7d6ceae4b15a4be32ea236e9fc4d2cc0))
* show mode counts in the table's mode filter options ([4f6703e](https://github.com/22-2/obsidian-on-demand-plugins/commit/4f6703eede2f9ef3b22d2e2ae26381c248473b1c))
* show the plugin table's cell tooltips with Obsidian's tooltip ([9d2101e](https://github.com/22-2/obsidian-on-demand-plugins/commit/9d2101e1a3a6a8ebecb1b352a98fb1bda6caaabe))
* simplify the plugin table's columns and let it scroll sideways ([fcc8fc7](https://github.com/22-2/obsidian-on-demand-plugins/commit/fcc8fc7f3da7957fdcc89e940eeb3383e759beb6))
* use icon controls on phones ([3daeba8](https://github.com/22-2/obsidian-on-demand-plugins/commit/3daeba8ebff31fa0443a81be074ca663c15c0d80))

### 🎨 Styles

* clarify columns and sort indicators ([f012c88](https://github.com/22-2/obsidian-on-demand-plugins/commit/f012c88881c0123afb6e497f82173df6cc2ff2c2))
* hide author names on phones ([6fba1ce](https://github.com/22-2/obsidian-on-demand-plugins/commit/6fba1ce25de7580ae416b475e3fe7f5a56e8c0d4))

### 🛡 Bug Fixes

* align loaded status controls ([817df34](https://github.com/22-2/obsidian-on-demand-plugins/commit/817df344cf8ea5da79009391a38e6135466c9085))
* always log plugin load and command errors ([1a39ddb](https://github.com/22-2/obsidian-on-demand-plugins/commit/1a39ddb9a874d765cfa8634267e5d41c878ddcd0))
* **ci:** prepare Obsidian before loading Playwright config ([7410218](https://github.com/22-2/obsidian-on-demand-plugins/commit/7410218b208bc9d1b8aa54d9ea1fd525532b6559))
* clean up command readiness waits ([158f8ec](https://github.com/22-2/obsidian-on-demand-plugins/commit/158f8ec5f3e6574789f1e257fd7095621b542c50))
* keep plugin table scroll position on refresh ([2f4ab41](https://github.com/22-2/obsidian-on-demand-plugins/commit/2f4ab410fb9b783e951843a8d3e315116c711722))
* reload view caches along with commands from the per-plugin cache button ([9c37320](https://github.com/22-2/obsidian-on-demand-plugins/commit/9c3732099ce9d195a0e9e3f02911c7744f14cff9))
* replace layout-ready plugin queue ([a20c553](https://github.com/22-2/obsidian-on-demand-plugins/commit/a20c553b279a4a1bd9e1505443a4dc54f79bdc0b))
* rescan the plugins folder when refreshing the plugin list ([abb69f3](https://github.com/22-2/obsidian-on-demand-plugins/commit/abb69f31ff96e742fbc67b93a4f5bde64f4977f7))
* save the plugin table's layout when it closes mid-debounce ([9314f44](https://github.com/22-2/obsidian-on-demand-plugins/commit/9314f4496aa152e78a1f0d5058e8c5980be59126))
* set 22-2 as the author and keep the plugin name as On-Demand ([33536d4](https://github.com/22-2/obsidian-on-demand-plugins/commit/33536d4cfa76d11415f62a780cbaaec214b1d9f9))
* stop listing untouched activation rules when lazy options change ([7976574](https://github.com/22-2/obsidian-on-demand-plugins/commit/7976574447f9741ce3727040546503182d4f7100))
* stop the plugin table's filters and mode dropdowns showing tooltips ([77be8cf](https://github.com/22-2/obsidian-on-demand-plugins/commit/77be8cf86556d14d7a7268d20e5d22a77d10e101))
* wait for saved plugin state before refreshing the table ([f60be2f](https://github.com/22-2/obsidian-on-demand-plugins/commit/f60be2f865ce2483383685e9068364af825f414d))
* write data.json and community-plugins.json through adapter.process ([062fb79](https://github.com/22-2/obsidian-on-demand-plugins/commit/062fb79d0dae24135b1573970342aa1451accb9e))

### 🤖 Build

* align ESLint dependencies and use TypeScript 6 directly ([93dcfc8](https://github.com/22-2/obsidian-on-demand-plugins/commit/93dcfc8c88b7e6ae065e74cf7e5d5e63df861dbf))

## [3.8.0](https://github.com/22-2/obsidian-on-demand-plugins/compare/3.7.0...3.8.0) (2026-10-15)

### ✨ Features

* **drift:** detect community-plugins.json edits made outside On-Demand ([4e03d12](https://github.com/22-2/obsidian-on-demand-plugins/commit/4e03d12e80026ac3cac95405815b640ad5140be3))
* **lazy-engine:** show feedback while a lazy plugin loads ([0a09294](https://github.com/22-2/obsidian-on-demand-plugins/commit/0a092947e1676bae5214a76ca01053137621a6e8))
* **settings:** configure unsaved draft recovery ([5a523db](https://github.com/22-2/obsidian-on-demand-plugins/commit/5a523db17c39a25fd90a0f8e7a417a50b1f4a345))
* **settings:** confirm Sync now before rewriting community-plugins.json ([d9e1365](https://github.com/22-2/obsidian-on-demand-plugins/commit/d9e1365c90ec287069bc87af2ac49a2a41a91989))
* **settings:** offer an unsaved draft back after settings close ([c8b4024](https://github.com/22-2/obsidian-on-demand-plugins/commit/c8b40249f06475ac5d946b10d7492a85bd41dce1))
* **settings:** restart after Sync now writes Obsidian's config ([3ceced4](https://github.com/22-2/obsidian-on-demand-plugins/commit/3ceced45e3f922ee5749f902e16aaddab4ea0ab8))

### 🛡 Bug Fixes

* address community plugin review scan findings ([e08257f](https://github.com/22-2/obsidian-on-demand-plugins/commit/e08257f00f8235833e5d2ad9a9d16ed8cad9fde5))
* **coverage:** handle missing E2E shard reports ([08b2eb4](https://github.com/22-2/obsidian-on-demand-plugins/commit/08b2eb42dd738055146d7f8f336ada8fd933878b))
* **lazy-view:** load lazy plugins when a collapsed sidebar is expanded ([d2a5334](https://github.com/22-2/obsidian-on-demand-plugins/commit/d2a53340784d9d4c9d28447b1e87980f34138846))
* offer draft restore on plugin management page ([0e0ac3d](https://github.com/22-2/obsidian-on-demand-plugins/commit/0e0ac3dca26690d4e556bb06d26272dfd9b43108))
* **settings:** distinguish shared and profile behaviour settings ([6863524](https://github.com/22-2/obsidian-on-demand-plugins/commit/68635246b64988931f8356e7633a92acd5c706be))
* **settings:** ignore repeated clicks on long-running settings buttons ([3bb1cbe](https://github.com/22-2/obsidian-on-demand-plugins/commit/3bb1cbef1c58b1137d78a780a7069ab027a38ec1))
* **settings:** keep the rebuild button responsive while confirming ([a3efb05](https://github.com/22-2/obsidian-on-demand-plugins/commit/a3efb05168444ee7fc8ef64fb546915b5b78f8db))
* **settings:** keep the settings draft out of background saves ([5c63bc8](https://github.com/22-2/obsidian-on-demand-plugins/commit/5c63bc8c4adf30ca1ec45dc8fa988116ccb18b92))
* **settings:** preserve unsaved drafts across page navigation ([3722e41](https://github.com/22-2/obsidian-on-demand-plugins/commit/3722e41df8b0185f73b5a4f9272fad9512da0100))
* **settings:** show what a draft restore changes and announce automatic choices ([d266d08](https://github.com/22-2/obsidian-on-demand-plugins/commit/d266d08eb1ac50f0e8e326d86881c48bd7432146))
* **sync:** keep community-plugins.json entries this device does not manage ([db0f2b9](https://github.com/22-2/obsidian-on-demand-plugins/commit/db0f2b9b76150f78b3ddeda98390a6c080561e9a))

### 🤖 Build

* **test:** pin portable toolkit and Obsidian runtime ([0861ec4](https://github.com/22-2/obsidian-on-demand-plugins/commit/0861ec4b6df1e125aba969af998a6e2cc4ffd2c6))
* **test:** use toolkit 1.7.1 release package ([5d095c2](https://github.com/22-2/obsidian-on-demand-plugins/commit/5d095c28c2ee89fff1ab8116aaf09425394f1271))

## [3.7.0](https://github.com/22-2/obsidian-on-demand-plugins/compare/3.6.3...3.7.0) (2026-10-14)

### ✨ Features

* **settings:** add a compact plugin list that remembers its choice ([65a8609](https://github.com/22-2/obsidian-on-demand-plugins/commit/65a86099edca25d55bcaa0e42c37a6be36826f80))
* **settings:** review pending changes before saving ([3faa678](https://github.com/22-2/obsidian-on-demand-plugins/commit/3faa6787d49a33b8942d3fcea132c7b1fa3c04eb))
* **settings:** review pending changes before saving or discarding ([9c63b59](https://github.com/22-2/obsidian-on-demand-plugins/commit/9c63b59f2c651a8d6eb7e5222a1784a29a390779))

### 🎨 Styles

* **settings:** bring the mode and load badges closer together ([feba6a1](https://github.com/22-2/obsidian-on-demand-plugins/commit/feba6a1d793f0891a8e4c12308c3cef71d964d15))
* **settings:** drop the outline on compact mode badges ([f95686e](https://github.com/22-2/obsidian-on-demand-plugins/commit/f95686e82c9b1dd774e10e861c3173799e31dd71))
* **settings:** give the load state the same outlined badge as the mode ([516fcf4](https://github.com/22-2/obsidian-on-demand-plugins/commit/516fcf427c70f66bfd2393da0ccc64ea717d08a4))
* **settings:** make the phone row menu icon-only and centre the compact row ([3dee62f](https://github.com/22-2/obsidian-on-demand-plugins/commit/3dee62f7f4b30382cec4fff929cb568708979daf))
* **settings:** move the plugin version beside its name ([78d1f0c](https://github.com/22-2/obsidian-on-demand-plugins/commit/78d1f0ceb1e23ad0fc97a6385626c2950c0a7998))
* **settings:** put the compact list label before its toggle ([b346bca](https://github.com/22-2/obsidian-on-demand-plugins/commit/b346bcaa4612afd72b0c41944c04aac397ee307d))
* **settings:** put the desktop version and author on the badge line ([5f0ae92](https://github.com/22-2/obsidian-on-demand-plugins/commit/5f0ae92a6f6892931b6932ec2a33553f52a91f16))
* **settings:** restore the labelled phone Actions button and move refresh to the heading ([b1baa26](https://github.com/22-2/obsidian-on-demand-plugins/commit/b1baa26ea791073b23a31816bda1dc155c81c221))
* **settings:** show the author before the version in the plugin meta line ([e06381d](https://github.com/22-2/obsidian-on-demand-plugins/commit/e06381d850dbe7da6e608db45c3e295696f5056c))

### 🛡 Bug Fixes

* **cache:** keep applying and restoring load state when a rebuild fails ([84f4b25](https://github.com/22-2/obsidian-on-demand-plugins/commit/84f4b250afb43c61122d25744c8e2758df8fc94a))
* **cache:** rebuild command and view caches in one pass ([392e683](https://github.com/22-2/obsidian-on-demand-plugins/commit/392e68396f54d3ed10c1fdec460587098ef427a0))
* **cache:** wait for onLayoutReady work before snapshotting a plugin ([062052a](https://github.com/22-2/obsidian-on-demand-plugins/commit/062052af30f6beed875972dd6287a872993bae18))
* **cache:** wait for onLayoutReady work before snapshotting a plugin ([aa3048f](https://github.com/22-2/obsidian-on-demand-plugins/commit/aa3048f76fe1bf575bb7a37a3c90d812f69f1f9a))
* **ci:** pin toolkit build compatible with Git installs ([e9c962a](https://github.com/22-2/obsidian-on-demand-plugins/commit/e9c962af9cb7b73d0b73d9c2b1079e0fd4e27f95))
* **ci:** pin toolkit macOS coverage fix ([439add2](https://github.com/22-2/obsidian-on-demand-plugins/commit/439add239f529b249c3b9db2dc2be708d447c2e6))
* **ci:** stabilize E2E checks across macOS ([3be7fb6](https://github.com/22-2/obsidian-on-demand-plugins/commit/3be7fb6946f09cb00c3e6e2fbac47e980c41c92c))
* **ci:** update toolkit pin for source setup handling ([78b06ce](https://github.com/22-2/obsidian-on-demand-plugins/commit/78b06cef2a898a922c2c5475a47bec7c280a69cd))
* **lazy-engine:** decide whether a plugin is running by its loaded state ([90fc91a](https://github.com/22-2/obsidian-on-demand-plugins/commit/90fc91a3a09b8f1e762ddbdb4c6cafd93c346d2b)), references [#6](https://github.com/22-2/obsidian-on-demand-plugins/issues/6)
* **lazy-runner:** handle missing readiness events ([6414b65](https://github.com/22-2/obsidian-on-demand-plugins/commit/6414b654fb79557b71169653eb58f06cb8e2e791))
* **lazy-runner:** run lazy commands through Obsidian's command runner ([4886f68](https://github.com/22-2/obsidian-on-demand-plugins/commit/4886f6832d904db6c8132b3753fe9def99a4538b))
* **settings:** add space between the review dialog title and its list ([def1ebd](https://github.com/22-2/obsidian-on-demand-plugins/commit/def1ebdbaf873f20b90ce9db26bc6ad7060d82d2))
* **settings:** centre the pending save bar summary on its buttons ([ffc841a](https://github.com/22-2/obsidian-on-demand-plugins/commit/ffc841aa67c8305b9ebc0abd13b6d495d2712dcf))
* **settings:** close the row actions menu when its control is pressed again ([e3bb278](https://github.com/22-2/obsidian-on-demand-plugins/commit/e3bb278ece3ffaafc471a9aed3b4f81151b4a978))
* **settings:** keep compact rows on one line on phones ([b50bfa1](https://github.com/22-2/obsidian-on-demand-plugins/commit/b50bfa14d98e85f048dc7c90647be2238a8780a6))
* **settings:** keep the review buttons on screen when many changes are listed ([f3fc864](https://github.com/22-2/obsidian-on-demand-plugins/commit/f3fc864023912079ebc9360da56a858152ab9a8a))
* **settings:** keep the review modal and filter readable on phones ([72aab4a](https://github.com/22-2/obsidian-on-demand-plugins/commit/72aab4add40ad56d21ea53e481f92066f6df7142))
* **settings:** make phone plugin rows shorter and easier to tap ([6bcbb94](https://github.com/22-2/obsidian-on-demand-plugins/commit/6bcbb944114091b2160fc4b2eeb1dec94a4bcedd))
* **settings:** make the compact list toggle smaller ([7eb02b5](https://github.com/22-2/obsidian-on-demand-plugins/commit/7eb02b5db03b5cb2ae496315f382989bb3372769))
* **settings:** make the review arrow readable on phones ([ed85ca6](https://github.com/22-2/obsidian-on-demand-plugins/commit/ed85ca6e66e21a314663abd1e0e483a7774ce133))
* **settings:** move the refresh control beside the mode filter ([0a27225](https://github.com/22-2/obsidian-on-demand-plugins/commit/0a27225ec716185fe9ca0cf1418275372baf680a))
* **settings:** outline the pending bar buttons so they show in light themes ([71b8e8a](https://github.com/22-2/obsidian-on-demand-plugins/commit/71b8e8a22481730741e5a4b57313d644ca39d347))
* **settings:** reflect lazy loads in the plugin list status ([cfd2bfc](https://github.com/22-2/obsidian-on-demand-plugins/commit/cfd2bfce36a3fcb48f84f9d9c56615cec69b9a31))
* **settings:** say what discard restores instead of showing it as a change ([aa067cf](https://github.com/22-2/obsidian-on-demand-plugins/commit/aa067cfd16041db62245bff0e7992b967a37cf03))
* **settings:** show badge tooltips with Obsidian's tooltip and put the compact toggle first ([212feda](https://github.com/22-2/obsidian-on-demand-plugins/commit/212fedac7d84b007d83a3b38c7037eaf8e7f76b2))
* **settings:** show the review group name as a quiet label, not a heading ([b166206](https://github.com/22-2/obsidian-on-demand-plugins/commit/b166206e54ec69d96a86dcf52aafe6bc8a11eab8))
* **settings:** stop the review button spinning while the modal is open ([533f546](https://github.com/22-2/obsidian-on-demand-plugins/commit/533f54674a1509dbbbcb80fc75bc3ca4d1704c98))
* **settings:** use the card colour for the pinned save bar ([282e292](https://github.com/22-2/obsidian-on-demand-plugins/commit/282e292cf13089337d964353d9a4586071a83907))
* **settings:** wrap plugin rows on narrow panes ([7b736dd](https://github.com/22-2/obsidian-on-demand-plugins/commit/7b736ddb1a8cd08710c8f0562ec31abc637aa4be))
* **ui:** align revert icons with change descriptions ([fbca637](https://github.com/22-2/obsidian-on-demand-plugins/commit/fbca6374a73250f8999707bd1834dd65eccd4ac4))
* **ui:** align review revert icons with plugin names ([99b172d](https://github.com/22-2/obsidian-on-demand-plugins/commit/99b172de6eb5130ac8b5072542a4f4bcee7c88af))
* **ui:** vertically center compact plugin row badges ([42df519](https://github.com/22-2/obsidian-on-demand-plugins/commit/42df51909e88e9cfa26339978017d0689f78391a))

### 🤖 Build

* **deps:** bump obsidian-e2e-toolkit to 1.4.1 ([b7367ab](https://github.com/22-2/obsidian-on-demand-plugins/commit/b7367ab40d920669ebb7e2d058fc31f64ffe53ff))
* **deps:** bump obsidian-e2e-toolkit to 1.4.2 ([7c5d1e2](https://github.com/22-2/obsidian-on-demand-plugins/commit/7c5d1e2d194b292b16083006b8b48d6580253096))
* **deps:** bump obsidian-e2e-toolkit to 1.4.5 ([4d4bfb1](https://github.com/22-2/obsidian-on-demand-plugins/commit/4d4bfb13522f344014810dfad147079983a0d15c))
* **deps:** update dependencies ([c445bfd](https://github.com/22-2/obsidian-on-demand-plugins/commit/c445bfda5decafbcac88e1ad562bc625d0e53eb6))
* **deps:** update dependencies to latest ([8bd29c2](https://github.com/22-2/obsidian-on-demand-plugins/commit/8bd29c210ee5329b2e7e6f4872eda631bf6a5956))
* **release:** allow dry runs outside main ([13ea7a5](https://github.com/22-2/obsidian-on-demand-plugins/commit/13ea7a5326e6843dd8010d683f48020e70747c2b))
* **screenshots:** add device-specific UI capture commands ([17baa44](https://github.com/22-2/obsidian-on-demand-plugins/commit/17baa44ce6f5bcbddc89325975e5ff39fb52d218))

## [3.6.3](https://github.com/22-2/obsidian-on-demand-plugins/compare/3.6.2...3.6.3) (2026-10-10)

### 🛡 Bug Fixes

* **plugin-row-menu:** shorten the community plugins menu label ([7183d61](https://github.com/22-2/obsidian-on-demand-plugins/commit/7183d61c522776a08dad296eb3cd9989123c008a))
* **plugin-row-menu:** use sentence case for the community plugins label ([f273037](https://github.com/22-2/obsidian-on-demand-plugins/commit/f273037e9d69f4c64ef85d00a9aa7a71ef45e10f))

## [3.6.2](https://github.com/22-2/obsidian-on-demand-plugins/compare/3.6.1...3.6.2) (2026-10-10)

### ✨ Features

* reveal plugins in Obsidian's community plugins tab ([c3adf65](https://github.com/22-2/obsidian-on-demand-plugins/commit/c3adf65fa4e928b8fd79c074d5f267b5c3923ad4))

### 🛡 Bug Fixes

* rename misleading plugin row menu label ([0ae8aa0](https://github.com/22-2/obsidian-on-demand-plugins/commit/0ae8aa0f366f9ef56bd8faf3c180dbce626f782e))
* **settings:** make the in-memory status toggle enable or disable the plugin ([522832a](https://github.com/22-2/obsidian-on-demand-plugins/commit/522832ad25cdc6d834d81a52827b40835e1b0973))

## 3.6.1

### 🛡 Bug Fixes

- Improve mobile plugin actions.
- Trim whitespace from plugin filters.

Earlier releases are listed on [GitHub Releases](https://github.com/22-2/obsidian-on-demand-plugins/releases).
