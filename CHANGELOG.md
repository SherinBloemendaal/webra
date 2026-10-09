# Changelog

## [0.8.0](https://github.com/SherinBloemendaal/webra/compare/v0.7.0...v0.8.0) (2026-10-09)


### Features

* **engine:** add move_hint query for plain moves past visible enemies ([e84a51a](https://github.com/SherinBloemendaal/webra/commit/e84a51a57d0c4a93ea3139250a2869ac7ec8aa56))
* **engine:** control group numbers on selection boxes and rally point lines ([ecd6b1d](https://github.com/SherinBloemendaal/webra/commit/ecd6b1d664df41e07ca5b5a605a76323e831515e))
* **engine:** record end-game statistics and refuse orders of defeated players ([c2d48cf](https://github.com/SherinBloemendaal/webra/commit/c2d48cf708cecec4c3daf7be05333cc5c44a8336))
* **engine:** repair, power down and beacon orders like OpenRA's Red Alert ([4c23bf2](https://github.com/SherinBloemendaal/webra/commit/4c23bf2fa957978ecec89813d83b881234a5c399))
* **engine:** report transforms and refused deploys as sound events ([5316351](https://github.com/SherinBloemendaal/webra/commit/53163517e364f058d3091f00f2326cf82b363342))
* **engine:** spread AI attacks fairly over free-for-all neighbours ([78a1db9](https://github.com/SherinBloemendaal/webra/commit/78a1db9f08ea948b22b88a8d13235cc8048e83ad))
* **game:** a music player like OpenRA's, in the game menu and the Sound dialog ([25bae0d](https://github.com/SherinBloemendaal/webra/commit/25bae0db77cca9812399dbb0143b4756f86117fb))
* **game:** add help tips, game modes and a World group to the lobbies ([f6faffe](https://github.com/SherinBloemendaal/webra/commit/f6faffe77b1368280d7b58dcbcb89aeec6e6bf11))
* **game:** add the defeat and victory dialogs, end-game statistics and restart ([3f02ca5](https://github.com/SherinBloemendaal/webra/commit/3f02ca5b48833dab88c6f507c80fe751fcfa617a))
* **game:** add UI scale, game scale and an Audio section to Settings ([4c42c62](https://github.com/SherinBloemendaal/webra/commit/4c42c620232a15f50822afa5da059a4c3b9a4d4d))
* **game:** capture the mouse with Pointer Lock, like OpenRA's locked cursor ([28d2b53](https://github.com/SherinBloemendaal/webra/commit/28d2b53a92ecce7ca65549c50b0da894d78b5947))
* **game:** cash tick sounds on the credits counter, as in OpenRA ([3bdc0f5](https://github.com/SherinBloemendaal/webra/commit/3bdc0f5657dde55df0b477203d1af46d4cb7dda8))
* **game:** install the music from the freeware Red Alert CDs ([291956c](https://github.com/SherinBloemendaal/webra/commit/291956c849f0580e43aa35fbe728f7d356d7d2c0))
* **game:** layered placement sounds and the MCV deploy sounds, as in OpenRA ([ef5b7c6](https://github.com/SherinBloemendaal/webra/commit/ef5b7c60dc68e26d2dd0a065fcce5501e61171a2))
* **game:** offer to sign in again when the game files are refused ([831e981](https://github.com/SherinBloemendaal/webra/commit/831e9810500c1954a6fdf1500312b6e40b2c5209))
* **game:** OpenRA's Red Alert sidebar buttons and hotkeys ([ade4c16](https://github.com/SherinBloemendaal/webra/commit/ade4c16258ce6ad1e4a81067659ac6dba91780c9))
* **game:** Red Alert style tooltips on every icon button ([98a210f](https://github.com/SherinBloemendaal/webra/commit/98a210f2d975ea6761a6d4310ce1436acbc1961b))
* **game:** report the local player's defeat in online games ([64d170e](https://github.com/SherinBloemendaal/webra/commit/64d170ea68ca5158006fd1bea7405bccff05fa8c))
* **game:** show a one-time attack-move tip ([6dad50c](https://github.com/SherinBloemendaal/webra/commit/6dad50c31ef243aa50555c9cb8834453a730d652))
* **game:** show health bars on damaged units and buildings by default ([104b692](https://github.com/SherinBloemendaal/webra/commit/104b692c53e0a95c0dc7e84869fe0da6e26bdcf4))
* **game:** themed toggle, segmented, checkbox and slider controls ([cc42010](https://github.com/SherinBloemendaal/webra/commit/cc420103dbf57fc0ac9f17f0dcb720a83572c2da))
* **protocol:** accept game.attackMoveTipSeen in settings documents ([42a4aa4](https://github.com/SherinBloemendaal/webra/commit/42a4aa456de3fefe4ab46d520847c9910b505d41))
* **protocol:** accept the mouse capture settings in the settings document ([8821d29](https://github.com/SherinBloemendaal/webra/commit/8821d290a552fe356cf6372fef433e4805b98ca1))
* **protocol:** accept UI scale, game scale and music settings ([5d898bd](https://github.com/SherinBloemendaal/webra/commit/5d898bd0889ee7c1e0b74a813bd4c1c35dd7e2b7))
* **protocol:** add game mode bundles and saved mode validation ([e5c7684](https://github.com/SherinBloemendaal/webra/commit/e5c76842e37b9d42dc6fb49c76cb3bc1821e96e7))
* **protocol:** add the gameRequiresAccount site setting ([58ea81c](https://github.com/SherinBloemendaal/webra/commit/58ea81ca115b263c7e3690bc4b68d7be2b447c0d))
* **protocol:** sidebar button orders, team chat and relationship colours ([985382f](https://github.com/SherinBloemendaal/webra/commit/985382f0b54d2a88bed125634080f579718c7ed4))
* **repo:** vendor OpenRA's Red Alert hotkey definitions with a generator ([91adff8](https://github.com/SherinBloemendaal/webra/commit/91adff8a5f1025042318b94b9749d5fb15df5ab0))
* **server:** deliver team chat to the sender's team only ([68b7c58](https://github.com/SherinBloemendaal/webra/commit/68b7c586ecc08806d18fa13936ad6d742d648e37))
* **server:** drop the orders of seats that report their defeat ([dc332a1](https://github.com/SherinBloemendaal/webra/commit/dc332a10500dcfb6e68a69e16ce06912cc7ed5cf))
* **server:** relay the Red Alert music by range from the freeware CDs ([7293ac0](https://github.com/SherinBloemendaal/webra/commit/7293ac00ce663d3cf1be74d0930c26acd3f4bbe3))
* **server:** serve the game only to accounts that may play ([9fa7f28](https://github.com/SherinBloemendaal/webra/commit/9fa7f284c65925db92da24ebc9839e60c396947d))
* **website:** send players through sign-in to the game ([88756f9](https://github.com/SherinBloemendaal/webra/commit/88756f9d50b784a117767164c594928c41232d3b))
* **website:** use the shared themed controls on the account and admin pages ([70d51a5](https://github.com/SherinBloemendaal/webra/commit/70d51a516bd885ac967aa202a1a9b7c9b4602504))


### Bug Fixes

* **engine:** drive the War Factory door like OpenRA's production door ([504ae17](https://github.com/SherinBloemendaal/webra/commit/504ae17c9366136bd38fbd340b7fd58ab08b42a0))
* **engine:** mirror 6 and 8 player rings top to bottom and equalise ore ([36d0d3e](https://github.com/SherinBloemendaal/webra/commit/36d0d3e4159f21cdaee71afb08860fdfd11a736a))
* **engine:** pose structure layers like the structure and open the factory door ([6a3ea9f](https://github.com/SherinBloemendaal/webra/commit/6a3ea9f7d54f5d6e10bb5b77f990b4de5d78cd2f))
* **engine:** resolve shots of a tick together and match OpenRA targeting ([c08fc8d](https://github.com/SherinBloemendaal/webra/commit/c08fc8d1b03aa5a184f2a2755278becfdc7841d9))
* **game:** cap wanted file sizes and retry a relay 502 once per click ([8e893dd](https://github.com/SherinBloemendaal/webra/commit/8e893dd27287d69bd84dafd396b932fc16340a86))
* **game:** draw original structures, coasts, rocks and water like OpenRA ([46a2cbb](https://github.com/SherinBloemendaal/webra/commit/46a2cbbc7fc80bd01fdebc956a7e28a2333c6cf1))
* **game:** show the War Factory door frame the engine names instead of looping it ([b051bea](https://github.com/SherinBloemendaal/webra/commit/b051bea79cf7d9f9aff6bcdccb165a5bc0049785))
* **game:** tooltips switch at once along a bar, also under mouse capture ([d8f4aeb](https://github.com/SherinBloemendaal/webra/commit/d8f4aebb30d2c7162b2a5702a369a11fb56811f0))
* **server:** accept only the canonical spelling of a play pass MAC ([290f12b](https://github.com/SherinBloemendaal/webra/commit/290f12b1b679447b242e254fb0768222c8909b48))
* **server:** gate every spelling of a game path ([4462db6](https://github.com/SherinBloemendaal/webra/commit/4462db6ac759eb8cf73f4209073cf7ddf102d397))
* **server:** match archive redirects by decoded path and refund failed music bytes ([2229566](https://github.com/SherinBloemendaal/webra/commit/2229566310e740c66edae04edf3087b35891a83d))
* **website:** stop printing "null" for account sections that are left out ([19b53a7](https://github.com/SherinBloemendaal/webra/commit/19b53a7e321abfc196f060aa42e9bf91a2179844))

## [0.7.0](https://github.com/SherinBloemendaal/webra/compare/v0.6.0...v0.7.0) (2026-10-09)


### Features

* **engine:** report sprite poses for pre-rendered art ([be2a333](https://github.com/SherinBloemendaal/webra/commit/be2a333a695082ca7db7f1eabd43ad96b5fe1573))
* **game:** add a versioned texture pack format ([0a6834e](https://github.com/SherinBloemendaal/webra/commit/0a6834eacf750cc0615261436736c56761c46414))
* **game:** answer every selection the player makes, like OpenRA ([74659a1](https://github.com/SherinBloemendaal/webra/commit/74659a1809c7ed45e4c1a13f5b0886a584f6572c))
* **game:** decode original Red Alert graphics with OpenRA's sequences ([2881815](https://github.com/SherinBloemendaal/webra/commit/288181599c75e5e2f4ea51a19745d8f318a08b8d))
* **game:** draw pre-rendered facings, poses and tile terrain ([b229fa9](https://github.com/SherinBloemendaal/webra/commit/b229fa9b7cdd65f96ef6c5372247a150155c8882))
* **game:** install original graphics and sounds in one flow ([d6f28bd](https://github.com/SherinBloemendaal/webra/commit/d6f28bd824910b0842489cefd4a4a206b44bde70))
* **game:** keep every user setting in one settings registry ([285a1d1](https://github.com/SherinBloemendaal/webra/commit/285a1d136cd7714c4e567a67435bbafab5e54ba1))
* **game:** sign in, sync settings and play online with an account ([0098b88](https://github.com/SherinBloemendaal/webra/commit/0098b88638a999f0881035426375e777813841c6))
* **game:** use the protocol's account validators and match the final API ([b58747b](https://github.com/SherinBloemendaal/webra/commit/b58747bd7d9d7e6f6576f26370381bb2339b0823))
* **protocol:** add account validators and protocol 5 for signed-in play ([8c75f3c](https://github.com/SherinBloemendaal/webra/commit/8c75f3cb7ea1c057dd7e5d377d78e0275f4506b7))
* **repo:** add a tool that makes an existing account an admin ([0a02f58](https://github.com/SherinBloemendaal/webra/commit/0a02f58f931961ab57f0f8524c7dbc07c5ffac70))
* **server:** add accounts, sessions, passkeys, Discord sign-in and the admin API ([aac255f](https://github.com/SherinBloemendaal/webra/commit/aac255fca0412a1a545d10eff4cc599963f27eda))
* **server:** relay OpenRA's quick install package for one-click installs ([2b18e19](https://github.com/SherinBloemendaal/webra/commit/2b18e19596a99c4f41c0d5aa911e8378c967945a))
* **website:** add a privacy notice and link it from every footer ([afacdc8](https://github.com/SherinBloemendaal/webra/commit/afacdc879258a38d053734433615825f07de90a1))
* **website:** add the account page and the admin dashboard ([4b381f3](https://github.com/SherinBloemendaal/webra/commit/4b381f3e6e2aedfe1003bd1dfbc7752746b03b12))


### Bug Fixes

* **game:** keep createSettings(null) as a memory-only settings store ([0a76768](https://github.com/SherinBloemendaal/webra/commit/0a7676815448aaf5a2be3b2c94def6f94044fcb9))
* **game:** make installing the original content clear and reliable ([7875334](https://github.com/SherinBloemendaal/webra/commit/7875334a302b6dfc76ae52025d78e2e8d108fdba))
* **game:** send the CSRF header with every API write ([cd3a7df](https://github.com/SherinBloemendaal/webra/commit/cd3a7dfb22c8ad29cacc20b60f610a9fac33f66c))
* **game:** send the CSRF header with session and map requests ([9c5c6ce](https://github.com/SherinBloemendaal/webra/commit/9c5c6ce15190b4dd4f9a86cafb55cd9fc74fddcc))
* **protocol:** refuse prototype keys in settings documents ([fb8fa7c](https://github.com/SherinBloemendaal/webra/commit/fb8fa7c53dd6a7e2a8ce973dd4515d3ef4348176))
* **server:** answer forbidden before account_inactive on staff routes ([a636737](https://github.com/SherinBloemendaal/webra/commit/a636737e32d06aa128e0d529f59f153c0078134e))
* **server:** close the accounts security review findings ([fe7ed6a](https://github.com/SherinBloemendaal/webra/commit/fe7ed6aecfd39969c4e1f735ebea72d6f662ca07))
* **website:** match the account pages to the reviewed API ([fa577df](https://github.com/SherinBloemendaal/webra/commit/fa577dfb3dd47c7276562065b89efd4e213abbd8))

## [0.6.0](https://github.com/SherinBloemendaal/webra/compare/v0.5.0...v0.6.0) (2026-10-08)


### Features

* **engine:** add an actor table for UI lookups from a simulation worker ([e7df3b6](https://github.com/SherinBloemendaal/webra/commit/e7df3b61790ff92731d6ce804ae7add25cbd877c))
* **engine:** build tick-rate instance records for a GPU instance pass ([28ea9ac](https://github.com/SherinBloemendaal/webra/commit/28ea9ac33a8704f3c23e6026c46b7c097ff01ee8))
* **game:** interpolate and cull instances in a WebGPU compute pass ([2ab123d](https://github.com/SherinBloemendaal/webra/commit/2ab123d9c4f3c2d96af2cdfc91393c10ae1b1a77))
* **game:** run the simulation in a web worker ([2804d89](https://github.com/SherinBloemendaal/webra/commit/2804d89259bc62c51c6e74955ec21c11c3614c8b))
* **website:** cross-origin isolate the game for shared memory ([a2383ac](https://github.com/SherinBloemendaal/webra/commit/a2383acfac4571e82d442648e7154b7028cb2da7))


### Bug Fixes

* **engine:** break ore truck ties without scan order so mirrored trucks pick mirrored ore ([5a654c0](https://github.com/SherinBloemendaal/webra/commit/5a654c042fc111cfe0c80a863e1a08f67435c20d))
* **engine:** halve desert heat build-up and bump the protocol version ([b3ef7c5](https://github.com/SherinBloemendaal/webra/commit/b3ef7c52d8d408e9005ad1dfd1a8cfeb675d3eab))
* **engine:** join cut-off land to the bases and guarantee reachable ore ([88dcdf0](https://github.com/SherinBloemendaal/webra/commit/88dcdf0a10597a663c85371ee643e19886c5d3cc))
* **engine:** let AI games end when economies run dry ([d218222](https://github.com/SherinBloemendaal/webra/commit/d218222347b5db416134ffaf12d9b5efb9ce594c))
* **engine:** turn building turrets smoothly between ticks ([46d9f82](https://github.com/SherinBloemendaal/webra/commit/46d9f82c02c4da75500612156ac745156d6a1360))
* **game:** explain replays and saves of other versions instead of failing validation ([b584bd3](https://github.com/SherinBloemendaal/webra/commit/b584bd30142290fb89974bfaf122e6ac36a01bfc))
* **game:** keep the GPU instance pass opt-in until seen in browsers ([a6ce641](https://github.com/SherinBloemendaal/webra/commit/a6ce641e2cb692e1dc898a4f4a2ce18688c63fcf))

## [0.5.0](https://github.com/SherinBloemendaal/webra/compare/v0.4.0...v0.5.0) (2026-10-08)


### Features

* **engine:** draw OpenRA style selection brackets and segmented health bars ([86f5fde](https://github.com/SherinBloemendaal/webra/commit/86f5fde5132a9e91cb2f1d7083d97b183742fce3))
* **engine:** expose planned unit routes for a path overlay ([d9886aa](https://github.com/SherinBloemendaal/webra/commit/d9886aaf0b2e41a036a5476b5fa456c767ed5c4f))
* **game:** acknowledge command bar orders with unit voices ([e70600b](https://github.com/SherinBloemendaal/webra/commit/e70600b2dbba8bd76a9fbdd781eba2ff9b584651))
* **game:** add a show unit paths setting ([2bc7fe2](https://github.com/SherinBloemendaal/webra/commit/2bc7fe25f892d2af46d93f70a55c915d0bf4d1c2))
* **game:** animate building layers on a render clock ([ece4cdd](https://github.com/SherinBloemendaal/webra/commit/ece4cdd3babaf7f07053528936e2b3403b8876ac))
* **game:** record games, add replays, save and load, spectating ([12b82b0](https://github.com/SherinBloemendaal/webra/commit/12b82b029f929094a5d821f5be62f8e8a5e582b1))
* **protocol:** add rejoin, spectator and replay file schemas ([e3584d4](https://github.com/SherinBloemendaal/webra/commit/e3584d4277453c924632b29d8d0f8e156902b366))
* **protocol:** add the synced confirmation for spectator catch-ups ([9bb86b3](https://github.com/SherinBloemendaal/webra/commit/9bb86b34672a1ffbfb089c5c185f2a85b6358aa0))
* **server:** let players rejoin and spectators watch running games ([cf3a85f](https://github.com/SherinBloemendaal/webra/commit/cf3a85fd278f353cc1c2ef9e07b9936ab8431f7f))


### Bug Fixes

* **engine:** build the debug menu tests only in test builds ([74e4b0b](https://github.com/SherinBloemendaal/webra/commit/74e4b0b1f0da5673e7a156798f518b63b7f41d56))
* **engine:** keep big groups moving through chokepoints and detours ([a0968cd](https://github.com/SherinBloemendaal/webra/commit/a0968cdd03dbbe7ae1e0adf471351f6da66d2b20))
* **engine:** keep the hovered actor in world snapshots ([c123e1e](https://github.com/SherinBloemendaal/webra/commit/c123e1ecfe1a60b55326dd25a5bf22a5799a95ab))
* **engine:** let an ai army that stopped growing attack below wave size ([e27965c](https://github.com/SherinBloemendaal/webra/commit/e27965cdbcf7086cc1a44116fc4136be30f56639))
* **game:** confirm a spectator's catch-up to the server ([8104809](https://github.com/SherinBloemendaal/webra/commit/810480936bcf7a3c678eda9cfce36e6345b09482))
* **game:** drop the duplicate game clock from the HUD ([4f81229](https://github.com/SherinBloemendaal/webra/commit/4f8122936ce45f4f667c99a5a3fb73906d296594))
* **game:** hear enemy sounds in cells the player can see ([5e2f0d1](https://github.com/SherinBloemendaal/webra/commit/5e2f0d1892ebc26fcb4a3b4f73b351ce378a4a09))
* **game:** hold the build clock while production stalls ([1abd9df](https://github.com/SherinBloemendaal/webra/commit/1abd9df266ae7692ecce5f03125018953157c290))
* **server:** bound rejoin deadlines, catch-up output and chat ([a2bd80d](https://github.com/SherinBloemendaal/webra/commit/a2bd80d260629ba19d0d5da76f6180deba95622f))

## [0.4.0](https://github.com/SherinBloemendaal/webra/compare/v0.3.0...v0.4.0) (2026-10-08)


### Features

* **engine:** add debug menu cheats and read-only debug views ([7e5b043](https://github.com/SherinBloemendaal/webra/commit/7e5b043b0428f6647c78bd570b9059ce4af8cdac))
* **engine:** add Game.units_center for camera hotkeys ([be9e59e](https://github.com/SherinBloemendaal/webra/commit/be9e59e6fbd90c7d5a4c6653ecd6da7a627c6bd5))
* **engine:** add gems as a second resource type ([b1da671](https://github.com/SherinBloemendaal/webra/commit/b1da671b20e0202480705ad83d9179a688e6e608))
* **engine:** log audio events for the client ([a9b8a57](https://github.com/SherinBloemendaal/webra/commit/a9b8a570dfaac36037c1f96bc4d94596bf012862))
* **engine:** queue structures and cancel items that can no longer be built ([78a0158](https://github.com/SherinBloemendaal/webra/commit/78a01589a0b315b05d5913432387a61cd8bb0f45))
* **game:** add a debug menu with cheats, overlays and stats ([6140d9a](https://github.com/SherinBloemendaal/webra/commit/6140d9a79e2b9bae5318a3c1dc52d521afe76710))
* **game:** add RA style cameos for every building and unit ([0fd7388](https://github.com/SherinBloemendaal/webra/commit/0fd7388ba7fc8fb8947dbd7fc0ffd865f3854bb8))
* **game:** add release notes data with once per version logic ([8feb9e0](https://github.com/SherinBloemendaal/webra/commit/8feb9e09fbf31939d6704b201bb2e38bad7cd4ea))
* **game:** add settings, hotkey registry, control groups and game menu modules ([27fbe84](https://github.com/SherinBloemendaal/webra/commit/27fbe84f77bb5a6ff5cd2db7f34dc97e5fc9444e))
* **game:** add sound with optional original Red Alert content ([df27fc8](https://github.com/SherinBloemendaal/webra/commit/df27fc8163c03560ad5f968735ffca0d2fdd4a81))
* **game:** queue structures from the sidebar with counts ([567b993](https://github.com/SherinBloemendaal/webra/commit/567b993b3297c0d7e9027fe598144aff76ef8ca2))
* **game:** redraw all building art with detailed 3/4 shading and add art tests ([ac7297a](https://github.com/SherinBloemendaal/webra/commit/ac7297af60998b3de3835641b0f23158f62c5e29))
* **game:** redraw all structures as pseudo-3D volumes ([1218c55](https://github.com/SherinBloemendaal/webra/commit/1218c55f4735774f1f000156801ba152f7764fcd))
* **game:** render gems and add a gem brush to the map editor ([c65d612](https://github.com/SherinBloemendaal/webra/commit/c65d6126cf148582030b58993099469fc1b0abab))
* **game:** show release notes in the lobby, the game menu and once after updates ([4857bac](https://github.com/SherinBloemendaal/webra/commit/4857bac3f4aade9861429ff620e4c9d6eb3876cf))
* **game:** touch controls and phone layouts ([17793bd](https://github.com/SherinBloemendaal/webra/commit/17793bd13f23a9c760695bc39dc5e9edfd695399))
* **game:** wire the game menu, hotkeys, control groups and new cursors ([7bc16c4](https://github.com/SherinBloemendaal/webra/commit/7bc16c48fb4b6472447d3515cbcde9cec5cbe55a))
* **protocol:** accept format 2 maps with a gems layer ([8165541](https://github.com/SherinBloemendaal/webra/commit/8165541d9735bce563da40b92df323c07e032f94))
* **protocol:** add the cheats lobby option and cheat order schemas ([7adea42](https://github.com/SherinBloemendaal/webra/commit/7adea42beb5391c57b6e5e8f9b46e52e3c1fa62e))
* **repo:** write dist/release-notes.json from CHANGELOG.md ([880fcb3](https://github.com/SherinBloemendaal/webra/commit/880fcb38638ccdac9dfdd2017254c8617ba22af4))
* **server:** relay cheat orders only in games with cheats enabled ([7767eaa](https://github.com/SherinBloemendaal/webra/commit/7767eaa769610ae5c80ccb15b83ddc67ce6288be))
* **website:** add the /changelog page ([704b7f3](https://github.com/SherinBloemendaal/webra/commit/704b7f327fe327aced046777148f1c36548d5eab))
* **website:** fit phone screens with safe areas and touch-sized menu ([b447bd0](https://github.com/SherinBloemendaal/webra/commit/b447bd0192ac38a3449e31658b8a2f9fdb11074e))


### Bug Fixes

* **repo:** keep workspace installs working across release bumps ([5be2128](https://github.com/SherinBloemendaal/webra/commit/5be2128a9fb86547a424ab1a4ea4b3599ff14e2b))
* **repo:** say release in the singular when the build has one ([c267896](https://github.com/SherinBloemendaal/webra/commit/c2678968794a81bd01aa7a88a811489ccad3df9f))

## [0.3.0](https://github.com/SherinBloemendaal/webra/compare/v0.2.0...v0.3.0) (2026-10-08)


### Features

* **editor:** add map document with undo history, tools and symmetry ([3cb9f51](https://github.com/SherinBloemendaal/webra/commit/3cb9f51f74d6c62aca86f3971ebdbc4b5177f939))
* **editor:** add map format 1 module with validation and rules overrides ([85ccc19](https://github.com/SherinBloemendaal/webra/commit/85ccc19a501fc823090a5c5c651f186cce894fdc))
* **editor:** add map sharing client and game-side map loader ([23ed284](https://github.com/SherinBloemendaal/webra/commit/23ed284819c15552120d7085c2ab24761a5c7679))
* **editor:** add the map editor page ([cafeefa](https://github.com/SherinBloemendaal/webra/commit/cafeefac267c7bf1c4a661f04616189ae3c31f67))
* **engine:** add Chronosphere, Iron Curtain, atom bomb and GPS superweapons ([23b52c4](https://github.com/SherinBloemendaal/webra/commit/23b52c476d5241030e7c6e59d8e1f537cd329341))
* **engine:** add fixed-wing planes and airfield support powers ([2f3f930](https://github.com/SherinBloemendaal/webra/commit/2f3f930885c82541f550f997bb56f5b0b28cd7d1))
* **engine:** add helicopter flight, landing, ammo, rearming and crashes ([17cd425](https://github.com/SherinBloemendaal/webra/commit/17cd4257148860201b4ff4d1d6d5dbb190bfa886))
* **engine:** add map files, teams, 2 to 8 players and lockstep orders ([81d71c9](https://github.com/SherinBloemendaal/webra/commit/81d71c9c025927323c3226a0e8e37eef87740582))
* **engine:** add minelayer, cloak, jammer, gap generators and unit specials ([cc3330b](https://github.com/SherinBloemendaal/webra/commit/cc3330b39f8ff584ce16aae14fd021d56fd5f3c5))
* **engine:** add naval units and a shared transport system ([9e2705d](https://github.com/SherinBloemendaal/webra/commit/9e2705d9d76ca58d26fc9c92b8dd26f926c97c47))
* **engine:** add water and air domains, ships and aircraft data ([54cf592](https://github.com/SherinBloemendaal/webra/commit/54cf5921a441e14a9111557c977d413893fb2ccd))
* **engine:** export cargo, cloak detection, repair and turret data for ships ([cac5035](https://github.com/SherinBloemendaal/webra/commit/cac50350e8940e9f3df9003cad8a7f85cd345ea0))
* **engine:** generate equivalent bases for 3 to 8 players ([efb051d](https://github.com/SherinBloemendaal/webra/commit/efb051d6558d102b88bd0ce47305c97e2a01d1e1))
* **engine:** let the skirmish AI use aircraft, ships, abilities and superweapons ([ec7a8f1](https://github.com/SherinBloemendaal/webra/commit/ec7a8f11aad2a5c570afcf3d66cf44d0295384fd))
* **engine:** let the skirmish AI use its support powers ([166a073](https://github.com/SherinBloemendaal/webra/commit/166a0731014112c33480408824e7916e5869da24))
* **engine:** make the skirmish AI play free for all and team games ([e9eaef7](https://github.com/SherinBloemendaal/webra/commit/e9eaef7589c948083263e96bc3bb2255a84d91ae))
* **engine:** return to base without landing when there is nothing to reload ([40fa0a2](https://github.com/SherinBloemendaal/webra/commit/40fa0a224bb9c8c8c595f12491a68f39f16c5b61))
* **game:** add 2 to 8 player skirmish slots, teams and map files to the lobby ([d8fef60](https://github.com/SherinBloemendaal/webra/commit/d8fef609afe865e13cf3abb69ace6b6d632bad3d))
* **game:** add ability orders, minefield drag, teleport and power targeting, ability art ([275197b](https://github.com/SherinBloemendaal/webra/commit/275197bc4ad3ce021999277446cc01b4fb18b560))
* **game:** add the multiplayer API client and lockstep driver ([1e6427f](https://github.com/SherinBloemendaal/webra/commit/1e6427f971e96dab2fb055c40d45c048adb898d8))
* **game:** add the online server browser, lobby and in-game overlay ([c62d56b](https://github.com/SherinBloemendaal/webra/commit/c62d56bc5e24197de7ddc65920202dada3dae601))
* **game:** add the support power bar with map targeting ([773081c](https://github.com/SherinBloemendaal/webra/commit/773081c7c4e204fc7822675f3cf08ed30bfd5bef))
* **game:** draw the Chinook, Hind, Black Hawk and Longbow with spinning rotors ([2bc5dac](https://github.com/SherinBloemendaal/webra/commit/2bc5daca14d2136ba4b225fd8cec81da8891e6b9))
* **game:** draw the ships and add the load cursor for transports ([f81ffcb](https://github.com/SherinBloemendaal/webra/commit/f81ffcb1ac97c00c7043802b169d7958d3ef53bb))
* **game:** draw the Yak, MiG, spy plane and Badger with paratrooper and bomb sprites ([dacb067](https://github.com/SherinBloemendaal/webra/commit/dacb067aaf6b849e279a4eade5c4f525fe541f92))
* **game:** open editor test maps and published map links in the lobby ([ee6e6c3](https://github.com/SherinBloemendaal/webra/commit/ee6e6c36068ca64c63f46fc0296819b50bfb79bb))
* **game:** open online play from ?join= invite links like the website ([896f08d](https://github.com/SherinBloemendaal/webra/commit/896f08d5a4d986d67d06047ac2e2518edf8f6d74))
* **protocol:** accept support power orders with an optional direction ([62ad7a6](https://github.com/SherinBloemendaal/webra/commit/62ad7a67dae692f97b11df7b813c3e50b33f6916))
* **protocol:** accept the helicopter land and return-to-base orders ([59b2490](https://github.com/SherinBloemendaal/webra/commit/59b24900fb0218e1117cfce2bcb039b78a049dab))
* **protocol:** add message, option and map validators with canonical map hash ([301fbe4](https://github.com/SherinBloemendaal/webra/commit/301fbe4ff9e633c33b9775c37e2bc3727c354faa))
* **server:** add the Worker API, session Durable Object and lockstep relay ([27249c4](https://github.com/SherinBloemendaal/webra/commit/27249c412b6a7036b84ab97bbd52c3b0fa2516f9))
* **sim:** add all ground vehicles and structures, lobby and pause ([116849a](https://github.com/SherinBloemendaal/webra/commit/116849a9419323aeeddaadc0d987507fc794cac2))
* **sim:** add playable milestone 1 skirmish ([b00921a](https://github.com/SherinBloemendaal/webra/commit/b00921a1526ce8e4f48dfe2c390204c0a4bb962c))
* **website:** add landing site with live sprite gallery, maps and lobbies ([c312fdc](https://github.com/SherinBloemendaal/webra/commit/c312fdc2d03ac43ce39dfe717d39b73003e6ad7e))


### Bug Fixes

* **editor:** match engine map validation and canonical form ([37f7286](https://github.com/SherinBloemendaal/webra/commit/37f72865398568a079e15d9a1c9fe2a953b0432a))
* **engine:** check every cell of each wall piece when filling a line ([ea7636e](https://github.com/SherinBloemendaal/webra/commit/ea7636e9f28bb258c3f0f158a3f30ebdc7bb7c62))
* **engine:** check spawns against the map's own Construction Yard ([36d7725](https://github.com/SherinBloemendaal/webra/commit/36d77251ef330835ef11e643fa0c231eef43666a))
* **engine:** keep starts and structures from sharing cells ([7c40d69](https://github.com/SherinBloemendaal/webra/commit/7c40d69e0ae36024b2959b03bd83eb7e046d0c74))
* **engine:** let planes fly straight out of their turning circle before turning back ([57e6c8d](https://github.com/SherinBloemendaal/webra/commit/57e6c8d109308c9b9a935efb5bbb054044fa65cf))
* **engine:** make mirror matches fair for both player slots ([ae47bc2](https://github.com/SherinBloemendaal/webra/commit/ae47bc28dffba77aafca78509b1d3ea4e1540b4b))
* **engine:** make the skirmish AI behave alike on every spawn ([9cec0b0](https://github.com/SherinBloemendaal/webra/commit/9cec0b0b02d9dce81929f421c3b028a3f730c18b))
* **engine:** power-gated detection, uncloak on load and mines under structures ([d888712](https://github.com/SherinBloemendaal/webra/commit/d888712ae696f99b1aad0b6cdff67a15989ad38a))
* **engine:** send idle AI ore trucks to ore beyond their search radius ([163f81a](https://github.com/SherinBloemendaal/webra/commit/163f81a6ffd6569a3b2f32881fa8c614d48d0329))
* **engine:** spawn the deployed form before removing the old one ([8a988fa](https://github.com/SherinBloemendaal/webra/commit/8a988fab8de66ac17e6755b1de783ec13a4f8c0b))
* **engine:** stop the AI rallying to enemies it cannot target ([7d185e6](https://github.com/SherinBloemendaal/webra/commit/7d185e6577b92edee76aab1187f3a2fe7d780226))
* **engine:** validate structure footprints and every nested rules field ([ebbe5f0](https://github.com/SherinBloemendaal/webra/commit/ebbe5f059dafd094448ca7fd815dc73a653b5c31))
* **game:** catch up at once when the server waits for this client ([d438a8e](https://github.com/SherinBloemendaal/webra/commit/d438a8e23e07258fa255159c43860d45fecdeca5))
* **game:** report overlapping spawns as editor errors ([254090d](https://github.com/SherinBloemendaal/webra/commit/254090d4fce8c01d005d81983bc060ba9f0d5983))
* **game:** report structures off the map edge as editor errors ([381f30d](https://github.com/SherinBloemendaal/webra/commit/381f30d1571820b62fa473da60fb522000ae8575))
* **game:** take the mouse position from mouseenter so the view does not drift ([adab649](https://github.com/SherinBloemendaal/webra/commit/adab64991d2bd7a271b2751a3a5017ce693ac9af))
* **protocol:** keep kinds fixed inside replaced rules arrays ([09b6bfb](https://github.com/SherinBloemendaal/webra/commit/09b6bfb98fb76ad81e8f005541dae1da394849b6))
* **repo:** name the sherin.dev zone by id in the deploy token script ([e73ab6a](https://github.com/SherinBloemendaal/webra/commit/e73ab6a2560aa9c019ebb467d539066aa6175b13))
* **security:** close the multiplayer findings of the security review ([a01ce0c](https://github.com/SherinBloemendaal/webra/commit/a01ce0ceda73c89eb8da4adfbb2ee29c61364ad5))
* **server:** blame only a seat's own stalls, through a draining debt ([d56e377](https://github.com/SherinBloemendaal/webra/commit/d56e37751706d5bcd769a866dad75fa4b3d1e36a))
* **server:** drop players who hold the game up without progressing ([9c75f65](https://github.com/SherinBloemendaal/webra/commit/9c75f6513618b8bf6b44d2a03f6c56ca719ea9c4))
* **server:** drop seats that rotate a stall between them ([22f701e](https://github.com/SherinBloemendaal/webra/commit/22f701e9f2206041c3c3847c571ca8eee5a66362))
* **server:** ignore messages from kicked or departing connections ([3f8370f](https://github.com/SherinBloemendaal/webra/commit/3f8370fa278af17a365b43b42e8d5fcbbf0a86de))
* **server:** replace a trapped engine instance and refuse such maps with 422 ([228ee74](https://github.com/SherinBloemendaal/webra/commit/228ee7466b94389db47be8dd6a49ed225ba02af5))
* **server:** stop seats from taking turns at holding the game up ([ec25f8a](https://github.com/SherinBloemendaal/webra/commit/ec25f8a6565bda66f83c59d549837150c1ce505e))
* **server:** validate uploaded maps with the engine and align build ids ([4a7c002](https://github.com/SherinBloemendaal/webra/commit/4a7c002777e1130684631d4c52f455f62ba97291))
