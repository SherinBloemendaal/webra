# Changelog

## [0.22.0](https://github.com/SherinBloemendaal/webra/compare/v0.21.0...v0.22.0) (2026-10-20)


### Features

* **server:** prepare the servers and the repository for a public launch ([ebdef13](https://github.com/SherinBloemendaal/webra/commit/ebdef13579814a7634186373f41df55d0fcab8b1))


### Bug Fixes

* **server:** address the launchprep review ([e27927d](https://github.com/SherinBloemendaal/webra/commit/e27927d286e0bb596e171daf1e82a2da3f1279e5))

## [0.21.0](https://github.com/SherinBloemendaal/webra/compare/v0.20.1...v0.21.0) (2026-10-20)


### Features

* **game:** retexture the 2D and 3D minimal art with fewer, bigger shapes ([25e74ce](https://github.com/SherinBloemendaal/webra/commit/25e74cef1d2e357347e1b7247de84995442168c9))


### Bug Fixes

* **game:** cast the 2D minimal unit shadows in world space ([70a4f5f](https://github.com/SherinBloemendaal/webra/commit/70a4f5fec06203d8bc478c890f5da283d795e29b))
* **game:** crop the editor icons of the tall world structures to what they draw ([826ffd0](https://github.com/SherinBloemendaal/webra/commit/826ffd0a13e1a860bcf0681d462e6a077c5c3e53))
* **game:** draw the minimal water flat, without the diagonal wave ([e9c1013](https://github.com/SherinBloemendaal/webra/commit/e9c101350b8e3995167af7c816d5f461123096ed))
* **game:** fill the whole footprint of the depot, naval yard and sub pen in 3D ([ec6296b](https://github.com/SherinBloemendaal/webra/commit/ec6296b79501b52a9f1e2842ce4f81a37f2198b1))
* **game:** keep the apron under the shadows and fill the depot and yards' full footprint ([7511337](https://github.com/SherinBloemendaal/webra/commit/75113371ae520d7e90df321ba69fa1c1676af1b3))
* **game:** keep the ground shadow under wrecks of 2D minimal vehicles ([4dd5724](https://github.com/SherinBloemendaal/webra/commit/4dd5724360b9fdcb1bb035e8468bbc68d4306857))
* **game:** leave the civilians' shadow to the renderer ([33e2c9a](https://github.com/SherinBloemendaal/webra/commit/33e2c9adaacd7223cda270c02d6654f79c16282e))

## [0.20.1](https://github.com/SherinBloemendaal/webra/compare/v0.20.0...v0.20.1) (2026-10-17)


### Bug Fixes

* **game:** draw every original pose, special and muzzle in OpenRA's palette ([2db8298](https://github.com/SherinBloemendaal/webra/commit/2db8298e903d86b4f1120d31009a3b4ad6e1b74a))
* **game:** draw ore and gem mines as mines and in OpenRA's palettes ([e8752ec](https://github.com/SherinBloemendaal/webra/commit/e8752ec2b7ab914ead97356390416146f9b7478c))
* **game:** draw ore and gem mines as real mines in every graphics mode ([9e9d965](https://github.com/SherinBloemendaal/webra/commit/9e9d965bdb38d606354812c593b73aea03af69d6))
* **game:** draw original-graphics objects, effects and civilians in the palettes the rules give them, without stray team colour ([9e9d965](https://github.com/SherinBloemendaal/webra/commit/9e9d965bdb38d606354812c593b73aea03af69d6))
* **game:** read palette owner flags alone and check the seeded lookups ([f2fcda9](https://github.com/SherinBloemendaal/webra/commit/f2fcda98ab8f1e64a0068b0fe83a64790370f855))

## [0.20.0](https://github.com/SherinBloemendaal/webra/compare/v0.19.0...v0.20.0) (2026-10-16)


### Features

* **engine:** give placed structures and produced units their producer's faction ([bc81a0f](https://github.com/SherinBloemendaal/webra/commit/bc81a0fb80c3af011566b9f1af3da0e5907f073b))
* **engine:** give placed structures and produced units their producer's faction, like OpenRA ([ae8197d](https://github.com/SherinBloemendaal/webra/commit/ae8197de7aa62cd97d9efc74fa74fdefa2c2394b))
* **game:** act on the hub's signed_out event at once ([e7d91fb](https://github.com/SherinBloemendaal/webra/commit/e7d91fb3b7ef5b753367aaf8103210205efe827a))
* **game:** follow realtime hints in the friends, account, settings and replays screens ([20a1a3a](https://github.com/SherinBloemendaal/webra/commit/20a1a3a516ae3580bfa7b3fff71bb33b168072dd))
* **game:** reset guide progress from the Guide page, with a reset epoch that wins the sync ([b3010c1](https://github.com/SherinBloemendaal/webra/commit/b3010c15168339feadb7c0a33f95987b6f4993c9))
* **game:** reset guide progress, and show and change it per player in the admin panel ([ae8197d](https://github.com/SherinBloemendaal/webra/commit/ae8197de7aa62cd97d9efc74fa74fdefa2c2394b))
* **protocol:** add REALTIME_FRESH_MS, the window in which a realtime channel counts as live ([bf9dbc2](https://github.com/SherinBloemendaal/webra/commit/bf9dbc2c93de988cec939b308bc4a646f7bf0272))
* **protocol:** add the realtime channel messages and the realtime site setting ([131b913](https://github.com/SherinBloemendaal/webra/commit/131b9131bbb353bc90c75375d10e9bc573ecdd3b))
* **server:** announce a sign-out on the realtime socket before closing it ([8f368b1](https://github.com/SherinBloemendaal/webra/commit/8f368b17707d0a21c7b827fa5b96c8fcec618af1))
* **server:** publish realtime hints for admin guide actions ([c1644be](https://github.com/SherinBloemendaal/webra/commit/c1644be04e69d72809880706fe9bfb350afd4a7e))
* **server:** push live updates for friends, approvals, settings, replays and the admin dashboard ([ae8197d](https://github.com/SherinBloemendaal/webra/commit/ae8197de7aa62cd97d9efc74fa74fdefa2c2394b))
* **server:** push realtime hints through a per-account UserHub Durable Object ([70395e1](https://github.com/SherinBloemendaal/webra/commit/70395e105be1754c3d135d61810995b09fe70353))
* **server:** show and change a player's guide progress in the admin API ([b474c50](https://github.com/SherinBloemendaal/webra/commit/b474c5069aa953552c3e243a2b5b4ce8dc2bb5bc))
* **website:** guide progress column, filter and actions in the admin dashboard ([b574d18](https://github.com/SherinBloemendaal/webra/commit/b574d18ee2a144ba42526dde897b6c80c765c299))
* **website:** live friends, approval and admin dashboard updates ([b21bddd](https://github.com/SherinBloemendaal/webra/commit/b21bddd0cd5a11a4647586238ec042e8f80dc5c8))


### Bug Fixes

* **engine:** let the bots pick producers in the engine's launch order ([b637bf0](https://github.com/SherinBloemendaal/webra/commit/b637bf0aaf7a9d0bd8e61e9a612d8cc2a977ab0a))
* **game:** bound the tile worker with a deadline and never hold the start for it ([203af9b](https://github.com/SherinBloemendaal/webra/commit/203af9b7fbd2dcc4674e3832c4e2501fdad8a482))
* **game:** draw roads, bridge banks and shores with Red Alert's own templates in the original graphics ([ae8197d](https://github.com/SherinBloemendaal/webra/commit/ae8197de7aa62cd97d9efc74fa74fdefa2c2394b))
* **game:** fit Red Alert's road templates, bridges and their shores in the original tile terrain ([5f792ac](https://github.com/SherinBloemendaal/webra/commit/5f792acd68e26902bbcffc1626dbce72faa68928))
* **game:** keep the reset epoch when the tour is taken again ([2eafa3f](https://github.com/SherinBloemendaal/webra/commit/2eafa3fcc9ee82cb5fd1d2de8a2ab431ea82c9ba))
* **game:** list the road pieces as missing for original content installed before whole roads ([c5473a7](https://github.com/SherinBloemendaal/webra/commit/c5473a7bf7b58088651d8637253f0350e79b4296))
* **game:** reconnect realtime on a new status or role, and poll fast when hints stop ([eac407a](https://github.com/SherinBloemendaal/webra/commit/eac407a3929d83a68945e419cbcf2995f10e7632))
* **game:** warm the synth up before the audio cost gate and widen its margin ([62adbd5](https://github.com/SherinBloemendaal/webra/commit/62adbd5a2feb77a74926b72b6e230a0915304009))
* **server:** tell the admin to retry when a player's settings keep changing ([a94de93](https://github.com/SherinBloemendaal/webra/commit/a94de93bf5aae3cfd24783c28ab30c9348032a7e))
* **server:** tighten realtime hints after the security review ([e77b2a2](https://github.com/SherinBloemendaal/webra/commit/e77b2a2ecd7176a4096d58581db1c1d8b710c3c6))
* **server:** treat only moderators and admins as staff when closing sockets ([8c49946](https://github.com/SherinBloemendaal/webra/commit/8c49946b19727912c9aae4fa76edfbc34474f899))
* **website:** check waiting accounts every minute whatever the realtime socket says ([7e45a9a](https://github.com/SherinBloemendaal/webra/commit/7e45a9a4e8478b0e818138afc6b968fda93983d3))


### Performance Improvements

* **game:** plan the original terrain tiles in a worker for games and map previews ([2c163ec](https://github.com/SherinBloemendaal/webra/commit/2c163ecb38f9afb0cbd4ae9b4ff1ad521b2f92ba))
* **game:** plan the original terrain tiles in a worker with a deadline ([ae8197d](https://github.com/SherinBloemendaal/webra/commit/ae8197de7aa62cd97d9efc74fa74fdefa2c2394b))

## [0.19.0](https://github.com/SherinBloemendaal/webra/compare/v0.18.0...v0.19.0) (2026-10-16)


### Features

* **editor:** show the game's boot screen while the map editor starts ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **editor:** show the game's boot screen while the map editor starts ([d3ee2d4](https://github.com/SherinBloemendaal/webra/commit/d3ee2d4c58b90bdb8640817c74dc0d12436bd163))
* **game:** add quick tips that say what a structure or unit does on hover ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** add quick tips that say what a structure or unit does on hover ([ed7fc65](https://github.com/SherinBloemendaal/webra/commit/ed7fc65a0ae45cf1e2b57c1d82a3cf61d0ee2a15))
* **game:** ask at the end of the tour whether to keep the quick tips ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** declare game.quickTips and guide.quickTipsAsked ([68ef003](https://github.com/SherinBloemendaal/webra/commit/68ef0035d0fc7f48c75bc533cb254b0d93d5227f))
* **game:** walk the tour through every chapter in order, with an army beside the base and a power check before the radar ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** walk the tour through every chapter, in order, with also steps and a power check ([58498c5](https://github.com/SherinBloemendaal/webra/commit/58498c5ac8e9f521d5c10d1dcb8b94aae7182d05))


### Bug Fixes

* **editor:** draw the first frame in a hidden tab so the boot finishes ([6046939](https://github.com/SherinBloemendaal/webra/commit/6046939fed3f6383f0e5350b2aaabf064a5ca55e))
* **editor:** keep live drags cheap and cancel them cleanly ([8bd82de](https://github.com/SherinBloemendaal/webra/commit/8bd82de1cb6507dfc5d2a633845abc8a9ed27283))
* **editor:** show every drag tool's edit while the pointer is down ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **editor:** show every drag tool's edit while the pointer is down ([a8142ed](https://github.com/SherinBloemendaal/webra/commit/a8142ed08d59d4aeafa21ee114b630fa37d6bda2))
* **engine:** grant mission prop prerequisites and keep script-only items locked ([808ddf6](https://github.com/SherinBloemendaal/webra/commit/808ddf6d099da0c5a8ab594d79fd671f6460b01c))
* **engine:** grant mission prop prerequisites so Intervention's base unlocks ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **engine:** hide the other side's and other countries' items in the build menu ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **engine:** hide the other side's and other countries' items in the build menu ([5911046](https://github.com/SherinBloemendaal/webra/commit/5911046c170a12b51d82d1c97e676cd914ccab77))
* **game:** announce the tour's low power line in its live region ([4efdac2](https://github.com/SherinBloemendaal/webra/commit/4efdac2bcc283438cd4fa29e1f7ad75013cacd8a))
* **game:** centre button labels on their capitals ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** centre the guide's chapter labels on their capitals ([f732554](https://github.com/SherinBloemendaal/webra/commit/f7325540341730732321c49f3e590f2e1a1524ab))
* **game:** centre upper-case labels in buttons, tabs and badges ([1950221](https://github.com/SherinBloemendaal/webra/commit/1950221e579f6ae9f5cda6ceae59cc80a048dcd5))
* **game:** count a built Radar Dome as the power check done ([0d1d95e](https://github.com/SherinBloemendaal/webra/commit/0d1d95e3f275c798e27ba1318c2777cb7faaf5d4))
* **game:** draw rain, snow and sand in the world instead of over the screen ([6bf3227](https://github.com/SherinBloemendaal/webra/commit/6bf3227ebd1387524cd4f24731247a316126b9a8))
* **game:** draw rain, snow and sand in the world, in proportion to the zoom ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** keep the tour switch on when the quick tips question is closed ([07e6fe2](https://github.com/SherinBloemendaal/webra/commit/07e6fe289011d4239dddc5cf9a49ee418f89f830))
* **game:** make the thief and wall quick tips match the rules ([50ecd24](https://github.com/SherinBloemendaal/webra/commit/50ecd248f4759612487f53a1d623c7330f05e1b2))
* **game:** nudge the remaining capital labels and find them by test ([ac76064](https://github.com/SherinBloemendaal/webra/commit/ac760647548fd741e095f8497721cfff53eb760f))
* **game:** read OpenRA's multi-line descriptions ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** read OpenRA's multi-line descriptions and show them without quick tips ([7328ec3](https://github.com/SherinBloemendaal/webra/commit/7328ec320c28f48a8e1cdd3ff6380690a251b338))
* **game:** smooth weather resume and release HUD tooltips on teardown ([1f43547](https://github.com/SherinBloemendaal/webra/commit/1f435473f83bb140f58307cca9ba50d6e295336e))
* **game:** tick guide steps in order, remembering what was done early ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** treat build items locked for the game as missing in the guide ([6d4f6f6](https://github.com/SherinBloemendaal/webra/commit/6d4f6f659eda0d0caf2970b1a870fb18bf4eced4))
* **game:** use the game's tooltip instead of native titles on the HUD ([5dc7ebf](https://github.com/SherinBloemendaal/webra/commit/5dc7ebfba51e4eaaf818fc2beec1b753dbf6d15f))
* **game:** use the game's tooltip instead of native titles on the HUD ([c961d9c](https://github.com/SherinBloemendaal/webra/commit/c961d9c650fe0e6f20ee79dbc8c5c0646dc323a8))

## [0.18.0](https://github.com/SherinBloemendaal/webra/compare/v0.17.0...v0.18.0) (2026-10-16)


### Features

* **game:** show a boot screen on /play until the start menu is ready ([32fdf50](https://github.com/SherinBloemendaal/webra/commit/32fdf5005e81ab3f47014bd9c066c8b38d55ddfb))
* **game:** show a boot screen on /play until the start menu is ready ([f68754f](https://github.com/SherinBloemendaal/webra/commit/f68754f1403847c0eea71983f0bcae3e3fbe63f7))
* **game:** show guide steps of later versions to existing players ([32fdf50](https://github.com/SherinBloemendaal/webra/commit/32fdf5005e81ab3f47014bd9c066c8b38d55ddfb))
* **game:** show guide steps of later versions to existing players ([d925a6e](https://github.com/SherinBloemendaal/webra/commit/d925a6e2a9d3af293333e061a6a0f496431e4062))


### Bug Fixes

* **game:** keep the frame loop going when a part of the screen throws ([f21fc3e](https://github.com/SherinBloemendaal/webra/commit/f21fc3eee298554297036f45f1ca627a01f7a4a9))
* **game:** keep the frame loop going when a part of the screen throws, and stop a game whose every frame fails ([32fdf50](https://github.com/SherinBloemendaal/webra/commit/32fdf5005e81ab3f47014bd9c066c8b38d55ddfb))
* **game:** keep the game running when a tour step ticks off ([32fdf50](https://github.com/SherinBloemendaal/webra/commit/32fdf5005e81ab3f47014bd9c066c8b38d55ddfb))
* **game:** keep the game running when a tour step ticks off ([58f0cad](https://github.com/SherinBloemendaal/webra/commit/58f0cadd878947b6afc791da2e4b14f946dfef6f))
* **game:** keep the tour card above the command bar on touch and narrow screens ([32fdf50](https://github.com/SherinBloemendaal/webra/commit/32fdf5005e81ab3f47014bd9c066c8b38d55ddfb))
* **game:** keep the tour switch of 0.17.0 players as stored ([58a91e0](https://github.com/SherinBloemendaal/webra/commit/58a91e09b1be8b1dfb471d801cacdbbc5f5fd373))
* **game:** keep What's new and a resumed mission behind the boot screen ([24b8325](https://github.com/SherinBloemendaal/webra/commit/24b8325a02af1fd49a0fea8ce6dd727e5cd32fa7))
* **game:** stop a game whose every frame throws, and name each guarded part ([996c8c4](https://github.com/SherinBloemendaal/webra/commit/996c8c4fe15652149697b3d8d043d33c37d9ca9a))

## [0.17.0](https://github.com/SherinBloemendaal/webra/compare/v0.16.0...v0.17.0) (2026-10-15)


### Features

* **editor:** the Map editor board, select plates and the checks verdict in the top bar ([7651691](https://github.com/SherinBloemendaal/webra/commit/7651691c3b1ceaeb4e1a51e9a1f6cfa174c07316))
* **engine:** shear turret, rotor and muzzle offsets of sheared art ([919883e](https://github.com/SherinBloemendaal/webra/commit/919883e4ced5c47d785f080be716ac62d82156ea))
* **engine:** start support powers charged and check timer relationships ([61f4143](https://github.com/SherinBloemendaal/webra/commit/61f41433fef86ebb4b40e1c2cc5a706a230c568e))
* **game:** a game menu with settings, guide and tour, and a network tab in online games ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** add data modules for connection quality, invite codes and friends ([19481ca](https://github.com/SherinBloemendaal/webra/commit/19481ca0d3268402f7907cc348ec2ec3857bd052))
* **game:** add the built-in 3D minimal texture pack ([de94faf](https://github.com/SherinBloemendaal/webra/commit/de94faf58cc7644f7d6ee2408a328ef7c887051d))
* **game:** campaign screen in the look of the Campaign board ([1ef21e8](https://github.com/SherinBloemendaal/webra/commit/1ef21e8a522cf6911fe5365e5b232c5a21ca59a2))
* **game:** debug menu, sound and music dialogs in the design system look ([1348e24](https://github.com/SherinBloemendaal/webra/commit/1348e24a221d9c2dbd13263e4348ee0e8af0c6f4))
* **game:** design tokens from the Foundations board ([fbb5e74](https://github.com/SherinBloemendaal/webra/commit/fbb5e74019266055996281de10ff6b5ecdc7517e))
* **game:** guide with steps that tick off as you play, and the first game tour ([b442589](https://github.com/SherinBloemendaal/webra/commit/b4425896a3f53bd92d3474cadab701f36900e7e6))
* **game:** hand the game one network object for the HUD and the game menu ([0016e1f](https://github.com/SherinBloemendaal/webra/commit/0016e1f9a73cb952c6a60f2fe20fa93bde3e758b))
* **game:** list what a modded map changes in its warnings ([91f319b](https://github.com/SherinBloemendaal/webra/commit/91f319b2857a55c74f10552069ea3add3ffc9b5c))
* **game:** Load game, Replays and the replay bar in the new look ([183cade](https://github.com/SherinBloemendaal/webra/commit/183cadef513a15a125b3dd81711ba979d3f824a6))
* **game:** place the 3D minimal pack's turrets and rotors on their mounts ([fea7dc6](https://github.com/SherinBloemendaal/webra/commit/fea7dc632d9f0166e326a8d60035eb26d18fdb80))
* **game:** recolour 2D minimal world objects from the design canvas ([fa527dc](https://github.com/SherinBloemendaal/webra/commit/fa527dc89ed4bb317b1db071b7f721396a7ffa61))
* **game:** redesign every menu, lobby, loading, end of game and in-game screen from the design canvas ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** redesign the online screens with connection quality, invite codes and friends ([a0e058f](https://github.com/SherinBloemendaal/webra/commit/a0e058f730a806a184beed9685fbe5d923ecb2cb))
* **game:** redesigned game menu with tabbed settings, hotkey search and a network tab ([f0e2a8d](https://github.com/SherinBloemendaal/webra/commit/f0e2a8d37e9fd5ef63815551d1e3a9cff2398de3))
* **game:** redraw 2D minimal terrain in the flat style of the design canvas ([a2dc199](https://github.com/SherinBloemendaal/webra/commit/a2dc1992cf8176039b04f015f49bce7a2d33953b))
* **game:** redraw the 2D minimal structures from the top-down boards ([7e8a2ab](https://github.com/SherinBloemendaal/webra/commit/7e8a2abda21256c08ed0ff4c8c1083e305ef07a4))
* **game:** redraw the 2D minimal unit art from the design canvas ([07f054a](https://github.com/SherinBloemendaal/webra/commit/07f054a75723804f7be6cfd59cb582d7c6d6bbad))
* **game:** redraw the 2D pack's buildings, units, terrain and world objects from the design canvas ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** redraw WebRA's pixel art as the owner's variant B ([9a51e97](https://github.com/SherinBloemendaal/webra/commit/9a51e9731c145704d21b28c3c3a22e03ac06a8ca))
* **game:** redraw WebRA's pixel art in the classic Red Alert style ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** regenerate the effect sounds in the classic Red Alert style ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** regenerate the effect sounds in the classic Red Alert style ([549c995](https://github.com/SherinBloemendaal/webra/commit/549c9956e7dae46decc4f3df59e51121113d0236))
* **game:** restyle the in-game HUD after the InGame and Tooltips boards ([8de16ca](https://github.com/SherinBloemendaal/webra/commit/8de16cafbedb0726e679b66e23cfa47deea1d84b))
* **game:** select plate, stepper, tabs, badges and the patterns sheet ([06f88d9](https://github.com/SherinBloemendaal/webra/commit/06f88d970140edad3e1f845c8b5cd698fa1939c3))
* **game:** self-host the fonts and generate the logo ([42aaacd](https://github.com/SherinBloemendaal/webra/commit/42aaacd3d872edbba60d92fbbd364c29471ea3d3))
* **game:** self-hosted fonts, the new logo and shared controls (select plates, steppers, tabs) everywhere ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** signal bars, connection warning and waiting panel in online games ([765f34c](https://github.com/SherinBloemendaal/webra/commit/765f34cab4f7614bd22816713ba0c21505b2dc6d))
* **game:** skirmish setup in the look of the Skirmish board ([2134538](https://github.com/SherinBloemendaal/webra/commit/21345384ccd2f677d0c3ac3e409a8f55d6ff65a4))
* **game:** tell the end of game screen who proposed the rematch and how everyone answered ([ae37f6d](https://github.com/SherinBloemendaal/webra/commit/ae37f6dc54eabcdd15e44242c948458d7b3d5da5))
* **game:** the animated loading screen with the sides and tips ([201ae37](https://github.com/SherinBloemendaal/webra/commit/201ae377d46233b09d56a4bdbd6299aa770abd0e))
* **game:** the Content board in the original content dialog ([276963e](https://github.com/SherinBloemendaal/webra/commit/276963ea0ac8f8a43208275f356ec3a4843201aa))
* **game:** the ReleaseNotes board in the release notes dialog ([926981f](https://github.com/SherinBloemendaal/webra/commit/926981ff5f7e4dd9cf130d7d9407d2cfd73d73c0))
* **game:** the SignIn board, and dialogs for a refused or unreachable game ([d7e2409](https://github.com/SherinBloemendaal/webra/commit/d7e240996bb80efc3f690f17afc1158866d8412d))
* **game:** the start menu as the design system's menu bar ([1820909](https://github.com/SherinBloemendaal/webra/commit/18209090bcc9d90b206e58e609c63e5a5a841eb7))
* **game:** tooltips in the look of the Tooltips board ([f3b6e66](https://github.com/SherinBloemendaal/webra/commit/f3b6e6605410b16363d260885a28e4cfeed7cb25))
* **game:** victory, defeat and statistics in the look of their boards ([0dcfbc3](https://github.com/SherinBloemendaal/webra/commit/0dcfbc3206ae3c58956c3ba84b7fab0671002be2))
* **protocol:** add protocol 8 with the start gate, network quality and invite codes ([cbb911e](https://github.com/SherinBloemendaal/webra/commit/cbb911efd14e3e8ea1221adfba6930d13fc7ddae))
* **protocol:** settings for network warnings, friends privacy and the guide ([77b9aa4](https://github.com/SherinBloemendaal/webra/commit/77b9aa4b83db0efa3aea2848d92dffc430c37fab))
* **server:** add friends, invite codes and an online counter, and list running games ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **server:** gate the start, measure connections, add invite codes and friends ([c2e4bed](https://github.com/SherinBloemendaal/webra/commit/c2e4bedd41c42a48cc762ce6bec89ff5015581ce))
* **server:** show network quality per player with ping, late pings and who the game waits for ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **website:** account page with a side menu, sign-in methods and friends ([aa3052b](https://github.com/SherinBloemendaal/webra/commit/aa3052bc83dc7ed87fea7ab114c7986fdc5147e0))
* **website:** pages in the look of the Website board, with join by code ([6a41761](https://github.com/SherinBloemendaal/webra/commit/6a4176101b151fc03ac68f01202b841a5663c55b))
* **website:** redesign the website and account pages with friends and invite links ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **website:** select plates for the admin filters, forms and settings editor ([ce124f5](https://github.com/SherinBloemendaal/webra/commit/ce124f5eeddd2b4bec72444b75e8f3c166b2b7d8))


### Bug Fixes

* **editor:** edited follows the saved point, fixes count as warnings ([4f22ec0](https://github.com/SherinBloemendaal/webra/commit/4f22ec08e47bd68ac5a2e0e4d504b50cf03fd99c))
* **editor:** Esc from tabs and steppers still closes the dialog ([a374e99](https://github.com/SherinBloemendaal/webra/commit/a374e990d005decce95911a40d94f16b476995fc))
* **engine:** keep a support power through a prerequisite loss like OpenRA ([ab97d84](https://github.com/SherinBloemendaal/webra/commit/ab97d84ccd1301be6dab3a50733b9142f2e4bcbd))
* **game:** a press that closes a select list is used up ([55a57bc](https://github.com/SherinBloemendaal/webra/commit/55a57bc04544a71a9426a88ddbde29b1d1a15c48))
* **game:** accept the old graphics value webra in settings documents ([4e480fb](https://github.com/SherinBloemendaal/webra/commit/4e480fb6961da5fa593ca7dc5b01b8d4cd7355bc))
* **game:** address the online screens review ([ed2c3e6](https://github.com/SherinBloemendaal/webra/commit/ed2c3e66dc2c27c04ab9a84932b97b73f2df74b6))
* **game:** apply a map's support power charge times, one-shot and start-charged settings ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** apply support power and lobby option rules of imported OpenRA maps ([cdefaf2](https://github.com/SherinBloemendaal/webra/commit/cdefaf2c0abfe9525282c3a136befe96e1b95b87))
* **game:** bring the Lightning Rod's crown down to its selection box ([99af11d](https://github.com/SherinBloemendaal/webra/commit/99af11d7fbe8010af03bcd5190e67b10c19768da))
* **game:** Esc from tabs closes the screens, safer deletes and replay marks ([5fdeec4](https://github.com/SherinBloemendaal/webra/commit/5fdeec4d01c4bd54a25bf2a2620e8e5e4e8fe551))
* **game:** help text quoting and the tests of the new start menu brand and plates ([93bb03e](https://github.com/SherinBloemendaal/webra/commit/93bb03e4fa98e1807652af69e868aa6017582faa))
* **game:** keep 2D or 3D minimal when an older client syncs graphics webra ([3ac304f](https://github.com/SherinBloemendaal/webra/commit/3ac304faa791a6fc59bf839edadd28302383e0c0))
* **game:** keep the minimal atlas 2048 wide with smaller building layers ([3e0fa7f](https://github.com/SherinBloemendaal/webra/commit/3e0fa7f0c908900e1dd7f359147fdf9aaf7cf5f6))
* **game:** keep the skirmish columns' breakpoint at the online lobby's ([dfa1e2f](https://github.com/SherinBloemendaal/webra/commit/dfa1e2f4969c301bb5abc12b5a6f0c1a964ba75d))
* **game:** keep the strokes of neutral world art inside their box ([7289c26](https://github.com/SherinBloemendaal/webra/commit/7289c26da44732061ce775edf93af5561ffb0672))
* **game:** keep turrets and rotors on their models in the 3D pack ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** leave Esc to select lists, steppers and tabs while the chat is open ([2932bf7](https://github.com/SherinBloemendaal/webra/commit/2932bf7e4487a758249265aec15735e5c9a86ef8))
* **game:** leave the loading screen's close to its stylesheet ([cefd20c](https://github.com/SherinBloemendaal/webra/commit/cefd20c09238fe1e41fb104928023f92e5875019))
* **game:** leave the war factory ramp clear of a drawn tank ([b3c78a7](https://github.com/SherinBloemendaal/webra/commit/b3c78a7502594ce5230814fae6c5f0759249cbd8))
* **game:** leave unmappable locked lobby options unlocked and guard rule names ([cd78186](https://github.com/SherinBloemendaal/webra/commit/cd7818636ea9c58fa38a4c0fa7430c2990533b85))
* **game:** let Esc from steppers and tabs close the friends screen ([0da883d](https://github.com/SherinBloemendaal/webra/commit/0da883deaf6f4dc28685139a56dfc3fef635e8c4))
* **game:** let Esc from tabs and steppers close the chat, keep it for open select lists ([36ffef3](https://github.com/SherinBloemendaal/webra/commit/36ffef38ee7114a307ec57426e15336a12247ecd))
* **game:** let radar, cloak, cash and buzzer sounds die away before they end ([3899a07](https://github.com/SherinBloemendaal/webra/commit/3899a0709153df38f774f40cf1a048ebb88c149a))
* **game:** name groups and actors in the sidebar on every selection change ([0945772](https://github.com/SherinBloemendaal/webra/commit/0945772a87eff252fcb23be8e2cae3e713bdeb21))
* **game:** never start a game behind a failed loading screen ([49c19c3](https://github.com/SherinBloemendaal/webra/commit/49c19c3f72abd2006822cf392a229b87b349d136))
* **game:** pack card arrows, a zoom stop at 1.0x and no guide in editor test play ([3d052c8](https://github.com/SherinBloemendaal/webra/commit/3d052c8a43d5fba9db2e21c3820d9c78982ecc1d))
* **game:** read the Network tab from the game's one net object ([764e513](https://github.com/SherinBloemendaal/webra/commit/764e51398f6fac67c0a4e1349c27bc8370cf4607))
* **game:** retry a built-in pack that failed to load and say why ([a6e686a](https://github.com/SherinBloemendaal/webra/commit/a6e686a53d65ca9556dcbef491d885c6c234ff8e))
* **game:** retry loading the friends screen and check the phone session list layout ([a522204](https://github.com/SherinBloemendaal/webra/commit/a522204a1e37ec1e9ef570b899ff64f2738d168b))
* **game:** review fixes for the connection parts and the fullscreen button ([b248e58](https://github.com/SherinBloemendaal/webra/commit/b248e580d13f3b76db514da8b8ba780520f5fc65))
* **game:** review fixes for the foundation controls and settings ([b52dd41](https://github.com/SherinBloemendaal/webra/commit/b52dd41c498b9cb2b837cc66d19828270a31b46a))
* **game:** review fixes for the loading, end of game and statistics screens ([55a72ec](https://github.com/SherinBloemendaal/webra/commit/55a72ecec9a3bf063fdacd267aef81f8376059e7))
* **game:** size the content dialog's new parts in the UI scale ([1631739](https://github.com/SherinBloemendaal/webra/commit/16317390446bebcda5a64e17589eec9cd970e8e2))
* **game:** start the game and its AI only once the loading screen is gone ([e798693](https://github.com/SherinBloemendaal/webra/commit/e798693df6043e9c80c52fd52fb391cf1dc14cf5))
* **game:** start the game only once the loading screen is gone ([86af72b](https://github.com/SherinBloemendaal/webra/commit/86af72b0a73e832eb8b6c44620235d11f072d952))
* **server:** close the review findings on friends, presence and invite codes ([fda5ca5](https://github.com/SherinBloemendaal/webra/commit/fda5ca5809e921940c9d431212d1eb9eaebb02fe))
* **server:** count friend request, block and invite limits before the name lookup ([ef03cef](https://github.com/SherinBloemendaal/webra/commit/ef03cef59ae39450e071003e87447d2713fc7a5a))
* **website:** a still hero battle for reduced motion without script ([083b586](https://github.com/SherinBloemendaal/webra/commit/083b586fb0095655c6630544dd3dd868b592e483))
* **website:** Esc closes a dialog unless a select list is open ([7f92bc2](https://github.com/SherinBloemendaal/webra/commit/7f92bc2d0e881a286ae866ab253bb7677692161e))


### Performance Improvements

* **game:** finish effect sounds in one pass and stop crackle filters early ([5a285da](https://github.com/SherinBloemendaal/webra/commit/5a285dac5388cb19c516b5bdaa7527c5085b09bd))

## [0.16.0](https://github.com/SherinBloemendaal/webra/compare/v0.15.1...v0.16.0) (2026-10-15)


### Features

* **game:** build menu queues without credits, with shift right click and a right click style setting ([2a453cf](https://github.com/SherinBloemendaal/webra/commit/2a453cf4760ffb7c0aeca3661d07f1d227e15585))
* **game:** restart and next mission without leaving the game, with a loading screen on every start ([2a453cf](https://github.com/SherinBloemendaal/webra/commit/2a453cf4760ffb7c0aeca3661d07f1d227e15585))


### Bug Fixes

* **engine:** ignore a depot repair order for units with nothing to repair ([2a453cf](https://github.com/SherinBloemendaal/webra/commit/2a453cf4760ffb7c0aeca3661d07f1d227e15585))
* **engine:** no lightning while a thunderstorm dies down, strike bots and humans alike ([2a453cf](https://github.com/SherinBloemendaal/webra/commit/2a453cf4760ffb7c0aeca3661d07f1d227e15585))
* **engine:** queue production like OpenRA regardless of credits, cap queues at 2000 items ([2a453cf](https://github.com/SherinBloemendaal/webra/commit/2a453cf4760ffb7c0aeca3661d07f1d227e15585))
* **game:** show the blocked cursor over an own depot for undamaged units ([2a453cf](https://github.com/SherinBloemendaal/webra/commit/2a453cf4760ffb7c0aeca3661d07f1d227e15585))

## [0.15.1](https://github.com/SherinBloemendaal/webra/compare/v0.15.0...v0.15.1) (2026-10-15)


### Bug Fixes

* **game:** record campaign progress when a mission is won ([ef3005b](https://github.com/SherinBloemendaal/webra/commit/ef3005ba492e954e8467febfbd9058c26315b4bf))

## [0.15.0](https://github.com/SherinBloemendaal/webra/compare/v0.14.0...v0.15.0) (2026-10-14)


### Features

* **engine:** add the factory loss lobby option ([f4401e9](https://github.com/SherinBloemendaal/webra/commit/f4401e9fae61b8b2d6951b6c93b2b4e51c0788aa))
* **engine:** queue through passes and defer boxed-in route searches ([f9a45d0](https://github.com/SherinBloemendaal/webra/commit/f9a45d00b5f8b7bd92cd0ca227d516d0676d0f5a))
* **engine:** selling plays the make animation backwards before the refund like OpenRA ([e28b5bc](https://github.com/SherinBloemendaal/webra/commit/e28b5bcf78fb5dc7f26a6754fd78926eb422c864))
* **engine:** send damaged planes with the bulk repair order ([cd4eb7e](https://github.com/SherinBloemendaal/webra/commit/cd4eb7e18ae03e96ab27518ad382ccfed5804a64))
* **engine:** the Construction Yard packs up by playing its make animation backwards ([74e1322](https://github.com/SherinBloemendaal/webra/commit/74e132204d2d4d54514cdbd0e874ccbf6a93d377))
* **game:** make the menu screens full-width cards ([02a0c98](https://github.com/SherinBloemendaal/webra/commit/02a0c9875cf464481bbacaa748e249bf624cbc2d))
* **game:** save every game's replay to the signed-in account ([08f797d](https://github.com/SherinBloemendaal/webra/commit/08f797d87086afce81d9680cc0febba598dec7b8))
* **protocol:** bump the protocol version to 7 ([42df9d5](https://github.com/SherinBloemendaal/webra/commit/42df9d5538ff16020174a4e6d0412b355f9b6916))
* **server:** hash new passwords with 100,000 PBKDF2 iterations on the Paid plan ([b315125](https://github.com/SherinBloemendaal/webra/commit/b3151258f4f5959bb5689cb244937da19e51a82f))
* **server:** keep replays in accounts in an R2 bucket ([d7b8336](https://github.com/SherinBloemendaal/webra/commit/d7b833640397c26615866f618fcaae5130f8c561))


### Bug Fixes

* **engine:** a yard unfolding again shows its make animation, paused pack-ups stay silent ([15a607f](https://github.com/SherinBloemendaal/webra/commit/15a607f2aafabae4f9dd814404e7e19f21af7580))
* **engine:** bound waiting short of weapon range and follow at once ([7e03ce5](https://github.com/SherinBloemendaal/webra/commit/7e03ce50d676039f604bd6e8b20aa08d4513357c))
* **engine:** cancel a finished unit that no structure makes ([497e414](https://github.com/SherinBloemendaal/webra/commit/497e4145556843cfd9fc4758991b2bb5d25711dd))
* **engine:** check placement against the true world state like OpenRA ([00d1c0a](https://github.com/SherinBloemendaal/webra/commit/00d1c0a1cc0cef05a1d3bade77ea57b2a0cc7ca6))
* **engine:** exit production types and measured seed notes ([f346898](https://github.com/SherinBloemendaal/webra/commit/f3468980c47b0f28e81d19ebb63c6cd9ae04ac1a))
* **engine:** fair route search budget and keep the cell a unit backs out to ([ce96402](https://github.com/SherinBloemendaal/webra/commit/ce964023f4537f71357a44ce8a792815786fbc47))
* **engine:** follow OpenRA closer in placement checks and naval idle test ([be626fb](https://github.com/SherinBloemendaal/webra/commit/be626fb9c1c5239d80d082f38bb1ae10030f264a))
* **engine:** give units that rejoin a depot's line a fresh place ([1e3075d](https://github.com/SherinBloemendaal/webra/commit/1e3075df807e91107470948599c11b58a23218b8))
* **engine:** hide the Lightning Rod from mission sidebars and keep bots powered ([8cc251a](https://github.com/SherinBloemendaal/webra/commit/8cc251a535b0d9a3e2799bbebbda411925febd9d))
* **engine:** keep the depot pad held and the line clear of other ways ([4086082](https://github.com/SherinBloemendaal/webra/commit/40860829b8fa0a5a15398231d22b992c1caea86d))
* **engine:** keep the Lightning Rod out of missions and calm bots in blackouts ([7193e82](https://github.com/SherinBloemendaal/webra/commit/7193e828d9550cea3cfeef444843becab896e5f2))
* **engine:** let a damaged vehicle on the depot join its line at any tick ([e182407](https://github.com/SherinBloemendaal/webra/commit/e1824073a95db7762ad945e60db11e97ba2852c3))
* **engine:** let crates and cell triggers follow OpenRA's ActorMap ([9bbd456](https://github.com/SherinBloemendaal/webra/commit/9bbd456ead01e9eb2a3507e76d69a37e5ad9979e))
* **engine:** move into weapon range toward the nearest cell in range ([02f2126](https://github.com/SherinBloemendaal/webra/commit/02f21266ab0e1df7e0433eaec7837324d21f6ee3))
* **engine:** name only the faction's producers of a missing queue ([e2c08f7](https://github.com/SherinBloemendaal/webra/commit/e2c08f79f69eec1cf222ace1ba024db124e98432))
* **engine:** pick producers by the all tech production type ([baf2871](https://github.com/SherinBloemendaal/webra/commit/baf2871fb90ac2e674fadd6708294d0c76e115ed))
* **engine:** retry crate drops in DropRange and block minefields like OpenRA ([59e6e2a](https://github.com/SherinBloemendaal/webra/commit/59e6e2a39cc97e0d12898ea4149a0ff0ca76f919))
* **engine:** script-created structures play the make animation, naval test seeds explained ([ad463cf](https://github.com/SherinBloemendaal/webra/commit/ad463cf6e378fecf389196248e1e36d1a9f69a2a))
* **engine:** share one cell occupancy rule and judge idle fleets per squad ([f246f5b](https://github.com/SherinBloemendaal/webra/commit/f246f5b3023de6352483d7b2c42ffc6aff0510da))
* **engine:** ships leave yards by the production exit rule ([ae8d380](https://github.com/SherinBloemendaal/webra/commit/ae8d380c32246dca4723412d280013cea9dfabca))
* **engine:** skip occupied minefield cells like OpenRA's LayMines ([7f4bda9](https://github.com/SherinBloemendaal/webra/commit/7f4bda9a709934681aa2e6cdcc9f15ce6c3c1a5f))
* **game:** clear the corner buttons on the statistics and Load game cards ([337b843](https://github.com/SherinBloemendaal/webra/commit/337b84332333eb6899c570a4a28f8d43a8df868f))
* **game:** give the page edge scroll cursor a fallback value ([02a13ac](https://github.com/SherinBloemendaal/webra/commit/02a13ac7a88b31a5e96d0576d3b3afea3efcf26d))
* **game:** keep finger taps and drags out of window edge scrolling ([f932aa3](https://github.com/SherinBloemendaal/webra/commit/f932aa3de5a5f616a4db1f178ffc1159a52b7e27))
* **game:** remove the input listeners on dispose and rewrap the edge scroll docs ([586bd8c](https://github.com/SherinBloemendaal/webra/commit/586bd8cb15a04909292ce2aac4a722a5c51d4f05))
* **game:** scroll the map at the window edge, over the sidebar too ([a59f3fd](https://github.com/SherinBloemendaal/webra/commit/a59f3fde3c960770437a92209940af91ad4b162c))
* **game:** show the account's Replays list as a screen card like Load game ([2ea0fdb](https://github.com/SherinBloemendaal/webra/commit/2ea0fdbda2d2a1ebf8480f764845c30431a3ffbf))
* **protocol:** keep a resumed lobby's save time within the Date range ([64190b2](https://github.com/SherinBloemendaal/webra/commit/64190b25f69e3c3fc116a2471276dde24c526418))
* **server:** harden replays in accounts after review ([b456e4b](https://github.com/SherinBloemendaal/webra/commit/b456e4b3f87ee15a14dbc3f0302ca4335f9f7720))

## [0.14.0](https://github.com/SherinBloemendaal/webra/compare/v0.13.0...v0.14.0) (2026-10-13)


### Features

* **engine:** add OpenRA's surrender order to lockstep games ([e1f52da](https://github.com/SherinBloemendaal/webra/commit/e1f52da9bc200d7c1a33deeba21403ed8cd87689))
* **engine:** announce the victors and expose cameo veterancy overlays ([422b7d8](https://github.com/SherinBloemendaal/webra/commit/422b7d87a43f56389eb8b3f6ef3e314b39ea548b))
* **game:** add game info and surrender to the game menu like OpenRA ([1bf1f14](https://github.com/SherinBloemendaal/webra/commit/1bf1f14b8604c5d22df7c209caabebf6bba80b34))
* **game:** add OpenRA's battlefield tooltip and range circles ([acce30e](https://github.com/SherinBloemendaal/webra/commit/acce30ebbe3b06c91336168a4b596ad7cb4ab18b))
* **game:** chat history, system lines and HUD status like OpenRA ([6d4077f](https://github.com/SherinBloemendaal/webra/commit/6d4077f76eba8a168b8e55e0459a044a404650ae))
* **game:** show observer production, powers and army as icons ([9feba5a](https://github.com/SherinBloemendaal/webra/commit/9feba5a0af4a1decfe8d10d424a9caed9b35df9e))
* **game:** show superweapon timers of every player like OpenRA ([c228586](https://github.com/SherinBloemendaal/webra/commit/c228586b96f63cee99c1671507da031cbf4cd4b1))
* **protocol:** keep online chat in replays and sync the chat settings ([39af8cb](https://github.com/SherinBloemendaal/webra/commit/39af8cb120b9e8bcc4955f6c5ac7d195dbe36388))


### Bug Fixes

* **engine:** let map rules add or remove any actor's sell value ([815f0b2](https://github.com/SherinBloemendaal/webra/commit/815f0b2bce054ca94e86b1713cf2a09c96a6065d))
* **engine:** refund sold structures from their sell value like OpenRA ([0b79ac2](https://github.com/SherinBloemendaal/webra/commit/0b79ac2c99bafa3c3b58d1c3b342b4073b5c1e20))
* **game:** keep the end-game title inside its dialog ([9da71e0](https://github.com/SherinBloemendaal/webra/commit/9da71e06ff32dfbd645939d4e09413ef25d74f83))
* **game:** label spectator chat by channel and close the chat on Esc ([36c64f4](https://github.com/SherinBloemendaal/webra/commit/36c64f4da189767e3a84ae9e36adf02f185db480))
* **game:** ready support powers need a powered provider, align icon heads ([a745bbf](https://github.com/SherinBloemendaal/webra/commit/a745bbf678390a08d957a88675ebb885f526f0e9))
* **game:** score players by OpenRA player experience and hide unknown countries ([adad4a7](https://github.com/SherinBloemendaal/webra/commit/adad4a730e033bbf398e3e06495b31ad0149dca4))
* **game:** stack the top-left HUD so weather, powers and timers never overlap ([d5732be](https://github.com/SherinBloemendaal/webra/commit/d5732be5cfec995f5ac8fdfb37457c0906829d7a))
* **server:** send a defeated player's team chat to the spectators ([bdbfbbd](https://github.com/SherinBloemendaal/webra/commit/bdbfbbd97e04de18d54634ae05911efeabcbd1dd))

## [0.13.0](https://github.com/SherinBloemendaal/webra/compare/v0.12.0...v0.13.0) (2026-10-12)


### Features

* **game:** draw the Black Hawk and Mobile Flak as WebRA's own pixel art ([f593537](https://github.com/SherinBloemendaal/webra/commit/f5935378735fec86869bbbd167c8903c75df8260))
* **game:** draw the oil derrick as WebRA's own pixel art ([719de48](https://github.com/SherinBloemendaal/webra/commit/719de4875dab9444902f6775ed60c709c2a48f0e))


### Bug Fixes

* **engine:** send the bots' fleets after targets they can reach and see ([6e5ec1b](https://github.com/SherinBloemendaal/webra/commit/6e5ec1bfb4e11bc91582761122cb66c5f8cc0fa9))
* **engine:** weather, cloaks, landing craft and cost in the fleets' reach ([bb04f7a](https://github.com/SherinBloemendaal/webra/commit/bb04f7a68ef3469c98e2db58fe2631c073e65744))
* **game:** draw original art OpenRA also ships and audit what is left out ([a31c207](https://github.com/SherinBloemendaal/webra/commit/a31c207bba9a2b40c0980ef3362758a1d3bd7764))
* **game:** give the Mobile Flak's cab its roof ([1083bae](https://github.com/SherinBloemendaal/webra/commit/1083baee948b0ad521a448eeeb9856138da30fd9))

## [0.12.0](https://github.com/SherinBloemendaal/webra/compare/v0.11.0...v0.12.0) (2026-10-12)


### Features

* **engine:** send aircraft out of ammo back to their target once rearmed ([1312611](https://github.com/SherinBloemendaal/webra/commit/13126111af66216d812bc636a6b451f895bba03f))
* **game:** let one Esc release the mouse and open the menu by default ([48c2599](https://github.com/SherinBloemendaal/webra/commit/48c2599c19710bddc76ebd7cc61adff3510dad0d))


### Bug Fixes

* **engine:** end aircraft attacks on resupply like OpenRA ([4b98aae](https://github.com/SherinBloemendaal/webra/commit/4b98aae2074b3aa885309a261cb7fc41fecdf334))
* **engine:** make anti-air defences and rocket soldiers shoot aircraft ([7a74b97](https://github.com/SherinBloemendaal/webra/commit/7a74b97c769bf441bf9c057be404d0504027f8a7))
* **game:** keep help tips inside the panel that shows them ([76e0a34](https://github.com/SherinBloemendaal/webra/commit/76e0a34a1a882501fb802b2e47a0873d98cc53f8))
* **game:** start the map lens at half the game's zoom ([9f19621](https://github.com/SherinBloemendaal/webra/commit/9f19621967fdeacdab766de4d9c96036b33f00e3))

## [0.11.0](https://github.com/SherinBloemendaal/webra/compare/v0.10.0...v0.11.0) (2026-10-11)


### Features

* **game:** magnify map previews with a map lens ([de3f528](https://github.com/SherinBloemendaal/webra/commit/de3f528e86c6684b48c83d24e92136ad9bd5b542))

## [0.10.0](https://github.com/SherinBloemendaal/webra/compare/v0.9.0...v0.10.0) (2026-10-11)


### Features

* **deploy:** pass the Sentry settings to the Worker and record releases ([0d5ce7d](https://github.com/SherinBloemendaal/webra/commit/0d5ce7dda213c8e11ee84283392540838d781489))
* **engine:** add selectable OpenRA and WebRA movement models ([a6bad1c](https://github.com/SherinBloemendaal/webra/commit/a6bad1c360e301a062ff98f17b5c79c4d5a3e675))
* **engine:** editor preview of a map file for the game's renderer ([796fd3e](https://github.com/SherinBloemendaal/webra/commit/796fd3e7bd05d67f83cd23122f5d1f7a717ad0e2))
* **engine:** fairness checks of a map for the editor ([729e977](https://github.com/SherinBloemendaal/webra/commit/729e977102394f7d6315b53893ee4c58d4258bde))
* **engine:** keep wasm panic messages for error reports ([883d114](https://github.com/SherinBloemendaal/webra/commit/883d114851d3f24d06512b1fd6fb82213cbb0b31))
* **engine:** report MAD tank charge and detonation and teleports as audio events ([d4a3d77](https://github.com/SherinBloemendaal/webra/commit/d4a3d779ed85b12e8610624f5d7947b9eb716ee8))
* **game:** draw the map editor with the game's art, original graphics included ([5d3823f](https://github.com/SherinBloemendaal/webra/commit/5d3823ff461bd042c851b7dd876fb4223e7d6aac))
* **game:** editor shapes, regions, symmetry groups and whole-map transforms ([f6d904d](https://github.com/SherinBloemendaal/webra/commit/f6d904df1d9e31adbe543b6c4a3da40a6cdcb2fb))
* **game:** fog preview layer in the map editor ([ebf5b56](https://github.com/SherinBloemendaal/webra/commit/ebf5b56822cae7aeedf715caafc62968994730f2))
* **game:** give orders through the radar like OpenRA's RadarWidget ([fcb9d44](https://github.com/SherinBloemendaal/webra/commit/fcb9d44522884e9df317f373faa8d610649774a0))
* **game:** import OpenRA slot colours and transport passengers from .oramap files ([bfd8bfe](https://github.com/SherinBloemendaal/webra/commit/bfd8bfebeb12c5076532add3500aa09818920b52))
* **game:** lobbies honour a map's setup; the editor edits slots, options, tags and actor state ([096f140](https://github.com/SherinBloemendaal/webra/commit/096f1405007f0bfaff1f6791ee797d12e5d7fcb1))
* **game:** one Install everything button with a clear installed state ([d29c86a](https://github.com/SherinBloemendaal/webra/commit/d29c86a87c71eeeedc61adbd8f8f9dc9cc2c9387))
* **game:** OpenRA box and click selection ([0367f00](https://github.com/SherinBloemendaal/webra/commit/0367f002629a9380cc66c7ffd1dcbd233d7ca7ae))
* **game:** OpenRA select all, select by type and double click ([bb933e8](https://github.com/SherinBloemendaal/webra/commit/bb933e84cf4bc70749cc3af2ff98ce659540d484))
* **game:** pick the movement model in the lobby and in editor test play ([986f924](https://github.com/SherinBloemendaal/webra/commit/986f924936e540966886316d40d246988b4f9d47))
* **game:** redesign the map editor in the game's chrome with new tools and panels ([1321a24](https://github.com/SherinBloemendaal/webra/commit/1321a24792225f9c8c578d8d2807fd7c1aecb371))
* **game:** report errors to the self-hosted Sentry ([ffbd065](https://github.com/SherinBloemendaal/webra/commit/ffbd06540763f0be4b46efad088b4355e3bb2b7b))
* **game:** show OpenRA's target lines from ordered units to their targets ([5d8f75d](https://github.com/SherinBloemendaal/webra/commit/5d8f75d51bb2169967c01259ab897d968eb08dce))
* **game:** start editor test play with chosen slots, bots and camera ([042c99e](https://github.com/SherinBloemendaal/webra/commit/042c99edc50961916abf03adf605a4eec2ad66cf))
* **game:** upgrade old map files everywhere and repair incompatible ones in the editor ([08b8cfa](https://github.com/SherinBloemendaal/webra/commit/08b8cfa373f2de0e5835b0262cb6ad377a474242))
* **game:** use one red accent in every game screen ([78e184d](https://github.com/SherinBloemendaal/webra/commit/78e184d6685b7a475177c352b79ebe8cdb3ce912))
* **protocol:** accept the movement model in lobby options, presets and map setups ([2c92914](https://github.com/SherinBloemendaal/webra/commit/2c92914792f2c68d9478c8265df4f2203d56b146))
* **protocol:** give map files a format version with one shared upgrade chain ([f70b145](https://github.com/SherinBloemendaal/webra/commit/f70b145ff866377cdc7c0e1dce01d45f7cbc44ce))
* **protocol:** map format version 2 with the map's game setup ([926c157](https://github.com/SherinBloemendaal/webra/commit/926c157b623860f870062e2bfbc1944fa10db129))
* **protocol:** scrub error reports and add the privacy settings section ([1bf356b](https://github.com/SherinBloemendaal/webra/commit/1bf356b0f3d139b2874f28265bd0c562ea68e4e6))
* **repo:** add tools/map-upgrade.mjs to upgrade map files in bulk ([7fd282c](https://github.com/SherinBloemendaal/webra/commit/7fd282cc294bb4c84993215439a4c85956f5e573))
* **repo:** bundle the Sentry browser SDK and error report settings into dist ([000aff2](https://github.com/SherinBloemendaal/webra/commit/000aff2468ae9962a8c5a95fecc6ba7c84017772))
* **repo:** make error reports opt-in for the operator ([843b3fe](https://github.com/SherinBloemendaal/webra/commit/843b3fef6a5319b7a91e669828fd62c24ba9a9d8))
* **server:** online rooms apply and enforce a map's setup; map thumbnails and tags ([da4653e](https://github.com/SherinBloemendaal/webra/commit/da4653ece61bcd0a4540facdbaaea207300cb41b))
* **server:** relay the freeware CDs' mission movies for the one-click install ([52b49a1](https://github.com/SherinBloemendaal/webra/commit/52b49a1614b4647600b13404a8e4a7ac00377251))
* **server:** report Worker errors to the self-hosted Sentry ([4361f9b](https://github.com/SherinBloemendaal/webra/commit/4361f9b44e5821254f73a95b0e9e890919799a20))
* **server:** require an email address for new accounts and verify it by mail ([617dd79](https://github.com/SherinBloemendaal/webra/commit/617dd79dab8d40113ef63ddb853f8ed6d51474f6))
* **server:** upgrade maps before hashing and upgrade stored maps when read ([e87f9aa](https://github.com/SherinBloemendaal/webra/commit/e87f9aa86d5768d0b4920e7fda5ee8fb6d09e128))
* **website:** ask every signup for an email address and show verification state ([a84ec51](https://github.com/SherinBloemendaal/webra/commit/a84ec519da3b0f90fa551855aabd8870910bb0d9))
* **website:** error reports and their switch on the privacy notice ([93e5130](https://github.com/SherinBloemendaal/webra/commit/93e5130abcab35433163d740bc4570785e17b078))
* **website:** show the daily email budget and the in-use notice to admins ([c12df06](https://github.com/SherinBloemendaal/webra/commit/c12df0698d8e51d3fe4d32fbf03b1651e93ecc5e))
* **website:** use the game's red accent palette on every page ([797071e](https://github.com/SherinBloemendaal/webra/commit/797071ec0af097588d7ad9bebc4bd0f3e1de8a07))


### Bug Fixes

* **engine:** close fords to ships and keep every harbour off the roads ([09012b3](https://github.com/SherinBloemendaal/webra/commit/09012b3adbf8dfcd168e9c02d5bff977ed4133cb))
* **engine:** end attacks on targets out of reach and bound flow field work ([c563a30](https://github.com/SherinBloemendaal/webra/commit/c563a30131274dc0d157f67f77efcb03577f6226))
* **engine:** fire the atom bomb and other click-fired support powers again ([0b2cdb1](https://github.com/SherinBloemendaal/webra/commit/0b2cdb11db7b93e333cd9bcbe35dd42384148d8f))
* **engine:** give landing craft their own group goal and use the ground speed class ([eed0163](https://github.com/SherinBloemendaal/webra/commit/eed016398091f41f9e27b1a8fb48a236336ba452))
* **engine:** launch ships into the open sea, not into a pond ([a273caa](https://github.com/SherinBloemendaal/webra/commit/a273caa7a4d4f7ea967764a771c620e30e536d47))
* **engine:** moves go on to their destination once a blocker is gone ([c8cb8a3](https://github.com/SherinBloemendaal/webra/commit/c8cb8a3c50df22326e9ea8891e88914037602a1b))
* **engine:** never leave a ship on a cell its locomotor cannot enter ([776f120](https://github.com/SherinBloemendaal/webra/commit/776f1207656ca10279494bed6aade9ba09a40c98))
* **engine:** ore trucks mine the ore with the shortest drive ([2510696](https://github.com/SherinBloemendaal/webra/commit/25106967edfbcfd07db9fd53d109d2073f59f86e))
* **engine:** return fire skips attackers a unit can never reach ([f056e7f](https://github.com/SherinBloemendaal/webra/commit/f056e7f7952a3c1e24263840b5494cfdbdc13325))
* **engine:** send ore trucks to the refinery with the shortest drive ([fae3ae9](https://github.com/SherinBloemendaal/webra/commit/fae3ae9a310e751ecfddd93876e82bd88eed6d8c))
* **engine:** service depots repair vehicles in turn and unload onto the mainland ([c80f6c6](https://github.com/SherinBloemendaal/webra/commit/c80f6c691288fd2a3e3816904ed91692d8fe1912))
* **engine:** squads drop members that cannot reach their leader ([26f4431](https://github.com/SherinBloemendaal/webra/commit/26f4431fc1fb0323a9b52510ab9877c78896541f))
* **game:** draw original art again when the bridge templates are installed ([d05b9f7](https://github.com/SherinBloemendaal/webra/commit/d05b9f7aae738bbbf1854476dece02b2d0541e4c))
* **game:** draw submarines at the heading they sail on ([00a03d2](https://github.com/SherinBloemendaal/webra/commit/00a03d2786804ba434888d2c5672ae35a7fd5c47))
* **game:** end the game for the winner instead of offering to play on ([5419b91](https://github.com/SherinBloemendaal/webra/commit/5419b9148adadd63d6cd82a192a5409195fffdf1))
* **game:** forget every kept download on Remove and check account requests first ([cba058d](https://github.com/SherinBloemendaal/webra/commit/cba058deb3a08ccd048a0960fe00208a8303215a))
* **game:** honour a mission's PlayLowPowerNotification ([639892a](https://github.com/SherinBloemendaal/webra/commit/639892a7684719fbc0ce8077006e5122d2ed61f1))
* **game:** install the validated canonical form of an upgraded map file ([551d902](https://github.com/SherinBloemendaal/webra/commit/551d902eaae341f6b1f458e88353037755736519))
* **game:** keep a paused game silent and still ([c23179c](https://github.com/SherinBloemendaal/webra/commit/c23179cde9bf01570b9fa535880cba325f5c0a47))
* **game:** keep keyboard focus and held modifiers right; pin the click score ([572f69d](https://github.com/SherinBloemendaal/webra/commit/572f69d75e015a27a6e562638f7428e4e5de6551))
* **game:** keep standalone spans and tracing headers out of error reports ([6b2419c](https://github.com/SherinBloemendaal/webra/commit/6b2419c6cb924b8e21cb85c70fde3d1ddc549f6c))
* **game:** keep the sidebar and settings readable at every UI scale ([7b40656](https://github.com/SherinBloemendaal/webra/commit/7b40656af6c09c2f3b5bdc6cc9971e6d0645a701))
* **game:** let hotkeys through focused switches, lists and clicked buttons ([ca54834](https://github.com/SherinBloemendaal/webra/commit/ca5483402099c70df8ed2f40d0a3f4a7dc29f378))
* **game:** load the theme in the map editor and draw an icon for every actor ([b8a2fe4](https://github.com/SherinBloemendaal/webra/commit/b8a2fe415da5317b8fd6f388236b2e2352c06bc4))
* **game:** never draw fords, roads or beaches as open water ([0ddf5f2](https://github.com/SherinBloemendaal/webra/commit/0ddf5f241a5f3fa8238ed4f0be7d772cc48000f8))
* **game:** place ships and naval yards on water in the map editor ([a2d46c5](https://github.com/SherinBloemendaal/webra/commit/a2d46c53afbc92f6a50b19cd86b4fb401b096eef))
* **game:** play only original sounds when Red Alert content is installed ([6afc769](https://github.com/SherinBloemendaal/webra/commit/6afc7693266b3883ebbe4546b33d416129375e6e))
* **game:** say the end of game lines at once and gate held sounds on the pause ([0005c7a](https://github.com/SherinBloemendaal/webra/commit/0005c7ac6c2cb571d051be059efb03c6bd8db29c))
* **game:** show the lobby slot type, difficulty and bot in full ([2997157](https://github.com/SherinBloemendaal/webra/commit/2997157ed0df944565d44a6a67efbeb51c787fe9))
* **game:** start the main menu music as soon as the browser allows sound ([db18be4](https://github.com/SherinBloemendaal/webra/commit/db18be4be2621e54a41045dd2b0229210188b77e))
* **game:** use the info colour token for the editor's map upgrade notice ([6ea20c5](https://github.com/SherinBloemendaal/webra/commit/6ea20c52b016ec620842362fedf4394ad1de4a5d))
* **protocol:** refuse maps that can never start, null setup fields and format 2 fields in format 1 files ([217fcc8](https://github.com/SherinBloemendaal/webra/commit/217fcc898542c9f5773efc249b47816c3d199c0b))
* **protocol:** refuse reserved keys in maps, paths and quick fixes ([13cda23](https://github.com/SherinBloemendaal/webra/commit/13cda23ecd8920f93cd5d2f21b38a06a7f82024c))
* **protocol:** require the movement model in live lobby options ([38853da](https://github.com/SherinBloemendaal/webra/commit/38853da9c857768b9f2751d7197ad60c8294a0ea))
* **server:** bound relay refunds with per-account attempt ceilings ([a722d02](https://github.com/SherinBloemendaal/webra/commit/a722d02797ba982cfc7654ba7685fb77422b79c3))
* **server:** close the gaps the email security review found ([67693e4](https://github.com/SherinBloemendaal/webra/commit/67693e4d64d749c806dfd9fd017110b5ba382261))
* **server:** count one-click relay downloads per account, not attempts per IP ([62a6919](https://github.com/SherinBloemendaal/webra/commit/62a6919b8dc07af8c83f600afc178408f6f78f8f))
* **server:** keep map upgrades of stored rows from failing the list or each other ([163fe34](https://github.com/SherinBloemendaal/webra/commit/163fe34a39445ee3454dc275e6e31a5cbdbd0891))
* **server:** seat lobby joiners by the map's slot setup and cache map thumbnails ([4440730](https://github.com/SherinBloemendaal/webra/commit/444073011c6c2bbbb6c7fd285ae76b53a6bdae43))
* **website:** give the country text the whole card when the unit art is not shown ([a27dd8e](https://github.com/SherinBloemendaal/webra/commit/a27dd8ea68a5efe683eeda264c1d4249b41a7245))

## [0.9.0](https://github.com/SherinBloemendaal/webra/compare/v0.8.0...v0.9.0) (2026-10-10)


### Features

* **engine:** add a deterministic Lua 5.1 interpreter for mission scripts ([f5fca2d](https://github.com/SherinBloemendaal/webra/commit/f5fca2da26f7660c93ac89209967ac78a26c9ed2))
* **engine:** add the neutral world of OpenRA maps ([e7168f7](https://github.com/SherinBloemendaal/webra/commit/e7168f72bd0c6d6d5e068a146cafdc0a691267f5))
* **engine:** add the Red Alert infantry and their abilities ([4bcaa86](https://github.com/SherinBloemendaal/webra/commit/4bcaa86cc5325db13824a6dc05b4bc5e70da5fe3))
* **engine:** announce Tanya's kills and let reusable engineers capture from outside ([5e16509](https://github.com/SherinBloemendaal/webra/commit/5e165095d4bdc27fafe06d323df4729c8f972180))
* **engine:** co-op missions with several people and a local player per screen ([1bbabb1](https://github.com/SherinBloemendaal/webra/commit/1bbabb1d49a85c7d0e5620399db4502f623ebbb8))
* **engine:** crates, husks, game rule options and warhead effects like OpenRA ([57b8cd3](https://github.com/SherinBloemendaal/webra/commit/57b8cd355edc33888315bb70e0a59278c921e5ae))
* **engine:** damage smoke loops like OpenRA and every barrel flashes on its own ([2cda516](https://github.com/SherinBloemendaal/webra/commit/2cda51679374c96689e88d26680f1ba80ddcd64f))
* **engine:** draw original art slots the way OpenRA does ([43f75bd](https://github.com/SherinBloemendaal/webra/commit/43f75bd69ae6853c9cb5e3644e5acbd0599555c1))
* **engine:** explosions per warhead, muzzle flashes, damage smoke and working animations ([2077415](https://github.com/SherinBloemendaal/webra/commit/207741553abbab7e99e638193be7b8cfb8a2b9e4))
* **engine:** mission actors name the art they are drawn with ([af8a42c](https://github.com/SherinBloemendaal/webra/commit/af8a42c903ab78bd9d3f3b7cddbcef317b396c88))
* **engine:** mission map actors, conditions and death spawns like OpenRA ([7f594fe](https://github.com/SherinBloemendaal/webra/commit/7f594fe1cfc6f56eddf717a5ee1bd3e22da39a46))
* **engine:** pilots bail out of downed aircraft, as OpenRA's EjectOnDeath ([91caae0](https://github.com/SherinBloemendaal/webra/commit/91caae0fce314f1f876eee920945cc9b503cb319))
* **engine:** production on hold, build limits and OpenRA notification events ([3396c76](https://github.com/SherinBloemendaal/webra/commit/3396c7691e450d7869eb81edcbea72cbbdbdc3ef))
* **engine:** run OpenRA mission scripts in the simulation ([8d7b938](https://github.com/SherinBloemendaal/webra/commit/8d7b938de0d9e0232e98305da9e696dd8925a2a8))
* **engine:** run OpenRA's Rush, Normal, Turtle and Naval bots with their module configs ([67dbf49](https://github.com/SherinBloemendaal/webra/commit/67dbf496cc2555f2a5fcd000d966398894b0dcd6))
* **engine:** show control group numbers in the selection box's bottom right corner ([b162881](https://github.com/SherinBloemendaal/webra/commit/b162881a7e50aea8c7afc912f4b56cbfbe1b4ab5))
* **engine:** show disguised spies in their disguise's radar colour and pause what is being captured ([13be9e0](https://github.com/SherinBloemendaal/webra/commit/13be9e0297ecc3fba0fa09a99944cb59e113842c))
* **engine:** split generated map spawns by team and place map crates and husks ([6ee3f49](https://github.com/SherinBloemendaal/webra/commit/6ee3f49632949faace99d2a367ba751a9dac04ba))
* **engine:** tech buildings and villages on generated maps, panic poses, cash ticks, beaching transports ([6f71b98](https://github.com/SherinBloemendaal/webra/commit/6f71b986d733845c403e68fe58d7baeec88433c7))
* **engine:** train and use the new infantry in the AI and draw their deaths ([4289a21](https://github.com/SherinBloemendaal/webra/commit/4289a2189d0179fdbccb64c4b508d83fed87a4a0))
* **engine:** turn husks into vehicles on capture or repair, and uncloak thieves on the move ([8ce9782](https://github.com/SherinBloemendaal/webra/commit/8ce9782531abd6107dbee4e5365d11e8b347fb8d))
* **engine:** wasm API for missions ([279fb4c](https://github.com/SherinBloemendaal/webra/commit/279fb4c50d261b54d483833c0733bcae4663c87a))
* **game:** art for the campaign's characters, ants and wrecks ([913b1f2](https://github.com/SherinBloemendaal/webra/commit/913b1f20ce5a46367e9474d96952be167b43a740))
* **game:** audit every actor's original art against OpenRA's sequences ([9ef0dde](https://github.com/SherinBloemendaal/webra/commit/9ef0dde09dd36bd87e3c24cce10cbd15036b8fe8))
* **game:** campaign screen, mission games, saves and replays ([1207763](https://github.com/SherinBloemendaal/webra/commit/1207763e0d793d0a1cd82ecee79ec8b631a4e40d))
* **game:** draw OpenRA's composed sequences, so Tanya fires both pistols in original art ([0a92e56](https://github.com/SherinBloemendaal/webra/commit/0a92e561023119dde5e2c2ed46f5ceaeae93596e))
* **game:** draw, import and edit the neutral world of OpenRA maps ([ff25264](https://github.com/SherinBloemendaal/webra/commit/ff25264d5bca90ab41dbcf5181d756015b58c2f0))
* **game:** draw, voice and order the new infantry ([c0fa0f8](https://github.com/SherinBloemendaal/webra/commit/c0fa0f8d8f10bb9c35277346128e030389eb471d))
* **game:** every OpenRA notification, actor sound and music track ([06545e1](https://github.com/SherinBloemendaal/webra/commit/06545e15da659362ba97f5cee707af2899f9dced))
* **game:** install shared lobby maps and propose rematches online ([cae1851](https://github.com/SherinBloemendaal/webra/commit/cae1851bc7ed00fb43fa5cdb5ad5ccb54d12b493))
* **game:** lobby options, crates, husks, smudges and battle effects ([652d034](https://github.com/SherinBloemendaal/webra/commit/652d034322a8c907f4d646e4b821436f6ec1b333))
* **game:** original effects, working animations and Red Alert's mouse cursors ([7391836](https://github.com/SherinBloemendaal/webra/commit/73918367218f010238e43df976c2a33a73df8b14))
* **game:** pick OpenRA's bot type per AI slot in skirmish and online lobbies ([1c10657](https://github.com/SherinBloemendaal/webra/commit/1c106578bace8fd8d67dbd67f77f38efc8517305))
* **game:** play co-op missions online and wire the movie player ([d83e4dc](https://github.com/SherinBloemendaal/webra/commit/d83e4dc1f3aa2a15691d010729fefa56c185bd41))
* **game:** play the missions' original movies from installed content ([85a7ac5](https://github.com/SherinBloemendaal/webra/commit/85a7ac59377bece29d5a3525d3555a2f650d0a9a))
* **game:** save online games and resume them from Play online ([214f08c](https://github.com/SherinBloemendaal/webra/commit/214f08cd8d6c0eb3edad1bd7a36b23babc6fe2ed))
* **game:** sixteen player colours for missions with more players ([6efe7a9](https://github.com/SherinBloemendaal/webra/commit/6efe7a9bf6b61632d4b6e23d8fb683fc795d8a54))
* **game:** tech buildings option and panic art for civilians ([b061523](https://github.com/SherinBloemendaal/webra/commit/b06152312df60c51da04396539fa534dc6757c60))
* **game:** the chute sound of a pilot bailing out ([27efa8f](https://github.com/SherinBloemendaal/webra/commit/27efa8f24ae97ce30b08576a59bbac2610bba111))
* **protocol:** accept OpenRA terrain types and dotted actor ids in maps ([128dcc8](https://github.com/SherinBloemendaal/webra/commit/128dcc8dd503f4d3e94126adb23af0900909bff3))
* **protocol:** accept the interface click and main menu music settings ([ee40dc9](https://github.com/SherinBloemendaal/webra/commit/ee40dc9652686ba99537934e5c2fb9de6448ef29))
* **protocol:** add OpenRA lobby options, handicaps and spawn assignment ([7b93230](https://github.com/SherinBloemendaal/webra/commit/7b93230ca216c1bb2159148df8469d328bab56b6))
* **protocol:** add the reusable engineers lobby option ([5650ae5](https://github.com/SherinBloemendaal/webra/commit/5650ae53a8c98959f6f1af0f3827605591a9d1be))
* **protocol:** add the techBuildings lobby option ([3583dc6](https://github.com/SherinBloemendaal/webra/commit/3583dc6b1ed52e81c59fecd455f5fcc0299e57eb))
* **protocol:** co-op missions in lobbies, starts and online replays ([33f48a8](https://github.com/SherinBloemendaal/webra/commit/33f48a833a307680ec4445d89559499be115f747))
* **protocol:** describe lobby maps, map states and rematches (protocol 6) ([5509a4e](https://github.com/SherinBloemendaal/webra/commit/5509a4e70d44fdf60419042640274c797a46bd77))
* **protocol:** mission replays and saves name their mission file ([88b9688](https://github.com/SherinBloemendaal/webra/commit/88b9688c3d22dc6db8ebb9375a9abc948d6d820f))
* **protocol:** online save messages, resumed starts and online save files ([70d7f15](https://github.com/SherinBloemendaal/webra/commit/70d7f15df305ebb496e8a8519578dce2d32e4c08))
* **repo:** vendor OpenRA's Red Alert missions and convert them ([3c97bc0](https://github.com/SherinBloemendaal/webra/commit/3c97bc0023bed0c0deab92d171ee9920c78f630b))
* **server:** co-op mission lobbies, orders, saves and the directory ([653c252](https://github.com/SherinBloemendaal/webra/commit/653c252f18187cac70860cba5f4321d251d8956b))
* **server:** keep player handicaps in rooms and game starts ([63518a2](https://github.com/SherinBloemendaal/webra/commit/63518a28674adbc4e4580d7102eff32a535599f9))
* **server:** save online games and resume them with the same players ([8772306](https://github.com/SherinBloemendaal/webra/commit/877230677387ceb29797499aa4a99316e445c1a3))
* **server:** share lobby maps with members only and rematch in the lobby ([9572968](https://github.com/SherinBloemendaal/webra/commit/95729688d5cc32eb6fd06f7b2b442c7645aa0eb2))


### Bug Fixes

* **engine:** bots finish games and value tech buildings by their traits ([a8f5578](https://github.com/SherinBloemendaal/webra/commit/a8f557888c764c5d1a465941df996453d4e4b207))
* **engine:** keep multi-line power descriptions and let a reloading dog wait before it leaps ([4a83125](https://github.com/SherinBloemendaal/webra/commit/4a8312551b63bd24de5b31c34e20ad1a48cd3868))
* **engine:** keep the first refinery while broke, patient attacks and enemy-only flight checks ([30b591d](https://github.com/SherinBloemendaal/webra/commit/30b591df88ff89d4dde62e5aff1df22e645c67a3))
* **engine:** mission structures beyond the map bounds, script kills and dying actors ([a2c2db2](https://github.com/SherinBloemendaal/webra/commit/a2c2db27e6f2e9276e7e0acbaaff99e4cc31778d))
* **engine:** overflow-safe script integers and a native stack budget for Lua ([ed7d410](https://github.com/SherinBloemendaal/webra/commit/ed7d4103a423afd9bd67d5d1adec6312c11eb3c2))
* **engine:** scripted crates are engine crates and flares give off smoke ([20a4d01](https://github.com/SherinBloemendaal/webra/commit/20a4d017f73982187e6c5c3988a07a0773754f3d))
* **engine:** size the Lua level budget from wasm32 and native stack measurements ([176b02c](https://github.com/SherinBloemendaal/webra/commit/176b02cf787988cf00de880418127640e9d506c3))
* **game:** bound a movie's sound track by its length ([5ac98f4](https://github.com/SherinBloemendaal/webra/commit/5ac98f49a5fba7bdb97f9a2180cebeda1fb07e91))
* **game:** show original helicopter rotors, spinners, silo stages, mines and effects ([0cef5f1](https://github.com/SherinBloemendaal/webra/commit/0cef5f108f9003709f0e619be052e77519b5021f))
* **protocol:** chain the frames digest per frame, bound save orders ([1278cd3](https://github.com/SherinBloemendaal/webra/commit/1278cd3f0297ca9db60f62db1911d8f5985130dc))
* **protocol:** count save orders with the order log's own accounting ([0fc8844](https://github.com/SherinBloemendaal/webra/commit/0fc8844a6c3b55750a6cde1abe3c3f413d446116))
* **server:** bound resume uploads and stream the online save digest ([3971c25](https://github.com/SherinBloemendaal/webra/commit/3971c2513f2322d9aef6b5a04e2ec65f910b1a79))
* **server:** let a player too slow for a resumed start rejoin it ([03262d1](https://github.com/SherinBloemendaal/webra/commit/03262d1c1ad38266d49901340a29e046d5996436))
* **server:** list co-op lobbies only under a known mission ([a67cbeb](https://github.com/SherinBloemendaal/webra/commit/a67cbebdfd309765222877371432065d1a58c0ca))

## [0.8.0](https://github.com/SherinBloemendaal/webra/compare/v0.7.0...v0.8.0) (2026-10-09)


### Features

* **engine:** add move_hint query for plain moves past visible enemies ([bb44649](https://github.com/SherinBloemendaal/webra/commit/bb44649c148ed58a19c8c3d580ae33d8ca3dd82a))
* **engine:** control group numbers on selection boxes and rally point lines ([54a026b](https://github.com/SherinBloemendaal/webra/commit/54a026b06c7f905702fc9a6300f4114812ef7de6))
* **engine:** record end-game statistics and refuse orders of defeated players ([58d1910](https://github.com/SherinBloemendaal/webra/commit/58d191029e03a580cc873340042735a9e9d45926))
* **engine:** repair, power down and beacon orders like OpenRA's Red Alert ([7a28f89](https://github.com/SherinBloemendaal/webra/commit/7a28f89c92ff4fd1de822db83ccf9b4b534a8f30))
* **engine:** report transforms and refused deploys as sound events ([59c1952](https://github.com/SherinBloemendaal/webra/commit/59c195232d732a339669e3f473e5116137482728))
* **engine:** spread AI attacks fairly over free-for-all neighbours ([54023e9](https://github.com/SherinBloemendaal/webra/commit/54023e986312917c92e6c9e530b8d7ad7dabe4b9))
* **game:** a music player like OpenRA's, in the game menu and the Sound dialog ([a45f6d0](https://github.com/SherinBloemendaal/webra/commit/a45f6d072364250fd651fdfeab11cc1a74c3e4e7))
* **game:** add help tips, game modes and a World group to the lobbies ([2066221](https://github.com/SherinBloemendaal/webra/commit/206622194623c724e87f11c08236ee4f1a1ef31d))
* **game:** add the defeat and victory dialogs, end-game statistics and restart ([cdf75b3](https://github.com/SherinBloemendaal/webra/commit/cdf75b3e83f6efd6c754d63bc534982aff345701))
* **game:** add UI scale, game scale and an Audio section to Settings ([cfa1b77](https://github.com/SherinBloemendaal/webra/commit/cfa1b77833ba81342f11824da78c30b8d1b280f3))
* **game:** capture the mouse with Pointer Lock, like OpenRA's locked cursor ([a7db855](https://github.com/SherinBloemendaal/webra/commit/a7db8553f5f249be187d313c51a1799714b02657))
* **game:** cash tick sounds on the credits counter, as in OpenRA ([8d31a73](https://github.com/SherinBloemendaal/webra/commit/8d31a735e73f017e2aeb3a22eeda1744afd5c475))
* **game:** install the music from the freeware Red Alert CDs ([224cc37](https://github.com/SherinBloemendaal/webra/commit/224cc37a519ae15cc8beb31a0c13d463dcf5fbf1))
* **game:** layered placement sounds and the MCV deploy sounds, as in OpenRA ([91f65d8](https://github.com/SherinBloemendaal/webra/commit/91f65d8bdeadd30c5fc36aa4136f2c1463585a6f))
* **game:** offer to sign in again when the game files are refused ([48997ed](https://github.com/SherinBloemendaal/webra/commit/48997ed01579e1291941a533fe01f4f7f4808335))
* **game:** OpenRA's Red Alert sidebar buttons and hotkeys ([91e99a9](https://github.com/SherinBloemendaal/webra/commit/91e99a930d707bc1322d9ba28d584c4dc39ee4c2))
* **game:** Red Alert style tooltips on every icon button ([37a0f95](https://github.com/SherinBloemendaal/webra/commit/37a0f95f2d53d2bc95954cfb5345b91946cc7346))
* **game:** report the local player's defeat in online games ([208cbec](https://github.com/SherinBloemendaal/webra/commit/208cbec87df1714113fb02a2f841ddc265cb3654))
* **game:** show a one-time attack-move tip ([738d642](https://github.com/SherinBloemendaal/webra/commit/738d642dd6c9182a31d2c52c72166709783d9f96))
* **game:** show health bars on damaged units and buildings by default ([556752f](https://github.com/SherinBloemendaal/webra/commit/556752f7177614e3a5b047588624f15045133c5f))
* **game:** themed toggle, segmented, checkbox and slider controls ([e2ae480](https://github.com/SherinBloemendaal/webra/commit/e2ae48000c798c136bf01b05f733ea6b2187ab51))
* **protocol:** accept game.attackMoveTipSeen in settings documents ([40c76b2](https://github.com/SherinBloemendaal/webra/commit/40c76b2ca8742306f01f5198c631002e8048a7d2))
* **protocol:** accept the mouse capture settings in the settings document ([e6c0b61](https://github.com/SherinBloemendaal/webra/commit/e6c0b61af9dd0c85ede80d5d983e5f4975a0802a))
* **protocol:** accept UI scale, game scale and music settings ([f0eba22](https://github.com/SherinBloemendaal/webra/commit/f0eba228a7c3d30d1cee520fff580ea1d22fc77f))
* **protocol:** add game mode bundles and saved mode validation ([f547926](https://github.com/SherinBloemendaal/webra/commit/f5479265655bcf6219183b99e861547b76181ccd))
* **protocol:** add the gameRequiresAccount site setting ([b32eea3](https://github.com/SherinBloemendaal/webra/commit/b32eea33d0c83adf58c2502a54028696ca96a413))
* **protocol:** sidebar button orders, team chat and relationship colours ([bf9413c](https://github.com/SherinBloemendaal/webra/commit/bf9413c943e70ddc22ca33d83877a425f968aaec))
* **repo:** vendor OpenRA's Red Alert hotkey definitions with a generator ([a06badf](https://github.com/SherinBloemendaal/webra/commit/a06badff00eb367070da01536190e7f647c37a65))
* **server:** deliver team chat to the sender's team only ([cd929f7](https://github.com/SherinBloemendaal/webra/commit/cd929f70c6a14a2299344edaa4284fc6fc01feb3))
* **server:** drop the orders of seats that report their defeat ([2ffa638](https://github.com/SherinBloemendaal/webra/commit/2ffa638631aa5ed2c301a949679dc1297f40502b))
* **server:** relay the Red Alert music by range from the freeware CDs ([9989d16](https://github.com/SherinBloemendaal/webra/commit/9989d16ca71fdd0fc146323794ef97151ff36c44))
* **server:** serve the game only to accounts that may play ([6803268](https://github.com/SherinBloemendaal/webra/commit/6803268b4d2b10343de9c6a10a1f99ac0720cebc))
* **website:** send players through sign-in to the game ([fafd827](https://github.com/SherinBloemendaal/webra/commit/fafd82770e7d3fb5394b8979945ed57435166184))
* **website:** use the shared themed controls on the account and admin pages ([83997b7](https://github.com/SherinBloemendaal/webra/commit/83997b71c28ee62bb9f90ec7079476b5e2110a34))


### Bug Fixes

* **engine:** drive the War Factory door like OpenRA's production door ([563f0a3](https://github.com/SherinBloemendaal/webra/commit/563f0a34496991ce57d612386f1c4d05532c53e7))
* **engine:** mirror 6 and 8 player rings top to bottom and equalise ore ([9dfd6b9](https://github.com/SherinBloemendaal/webra/commit/9dfd6b9c4a28e5f1ca573febd85299e382df3785))
* **engine:** pose structure layers like the structure and open the factory door ([e3dfa33](https://github.com/SherinBloemendaal/webra/commit/e3dfa335a8f36d71efc63dea70ac3b02d9de0fd8))
* **engine:** resolve shots of a tick together and match OpenRA targeting ([a876d20](https://github.com/SherinBloemendaal/webra/commit/a876d208595ccd254f69f961c35c6f131c6e88fd))
* **game:** cap wanted file sizes and retry a relay 502 once per click ([0088fd6](https://github.com/SherinBloemendaal/webra/commit/0088fd63b0103a9b5471096083af5d5f643912a2))
* **game:** draw original structures, coasts, rocks and water like OpenRA ([f4e3a05](https://github.com/SherinBloemendaal/webra/commit/f4e3a05de8221f412fe507aa19e4c0b3c28ae6ba))
* **game:** show the War Factory door frame the engine names instead of looping it ([90f8da8](https://github.com/SherinBloemendaal/webra/commit/90f8da85fbe57c3cbc94da94481725f6862bcbad))
* **game:** tooltips switch at once along a bar, also under mouse capture ([a14f269](https://github.com/SherinBloemendaal/webra/commit/a14f2698f70012c8a3c737ac790cedbd88144d44))
* **server:** accept only the canonical spelling of a play pass MAC ([864b6e2](https://github.com/SherinBloemendaal/webra/commit/864b6e2b157c1a2a6eb9d0a1760063d3c1a0282c))
* **server:** gate every spelling of a game path ([c4a8e36](https://github.com/SherinBloemendaal/webra/commit/c4a8e36ea6b8bfa09cfc066b49dd54d1cf653683))
* **server:** match archive redirects by decoded path and refund failed music bytes ([2736a2d](https://github.com/SherinBloemendaal/webra/commit/2736a2dce0c24f898672f7989a894528b2dd2d22))
* **website:** stop printing "null" for account sections that are left out ([72f92fe](https://github.com/SherinBloemendaal/webra/commit/72f92fed889a21eb3b47a0b364808bd11849c0e0))

## [0.7.0](https://github.com/SherinBloemendaal/webra/compare/v0.6.0...v0.7.0) (2026-10-09)


### Features

* **engine:** report sprite poses for pre-rendered art ([cbbb99e](https://github.com/SherinBloemendaal/webra/commit/cbbb99ec7d6b1f34e73f718cd9f19f3fd2bdbf2a))
* **game:** add a versioned texture pack format ([c55a7fb](https://github.com/SherinBloemendaal/webra/commit/c55a7fb7cb622a513d503bb71827eb55c19c281c))
* **game:** answer every selection the player makes, like OpenRA ([75911c5](https://github.com/SherinBloemendaal/webra/commit/75911c581b9099a18cded73ef1306199c5cc16ef))
* **game:** decode original Red Alert graphics with OpenRA's sequences ([3d89f7c](https://github.com/SherinBloemendaal/webra/commit/3d89f7c0076dbdde5c710d642856fd9a78787ccd))
* **game:** draw pre-rendered facings, poses and tile terrain ([99cf3e6](https://github.com/SherinBloemendaal/webra/commit/99cf3e69a495e90030efe2f46a30d37a0a87dd7f))
* **game:** install original graphics and sounds in one flow ([1ed85e0](https://github.com/SherinBloemendaal/webra/commit/1ed85e0052ade749ed3b6e43852ea31c8b44f0d1))
* **game:** keep every user setting in one settings registry ([96fd85c](https://github.com/SherinBloemendaal/webra/commit/96fd85ccb74edb11482a9e2c214cfd0fad8c14a1))
* **game:** sign in, sync settings and play online with an account ([10634e5](https://github.com/SherinBloemendaal/webra/commit/10634e5a40a7dcc6e90f2c0922a3e93bba29d495))
* **game:** use the protocol's account validators and match the final API ([c91cfc6](https://github.com/SherinBloemendaal/webra/commit/c91cfc66a3321d0edb5362937edd67df1ce69b2c))
* **protocol:** add account validators and protocol 5 for signed-in play ([6bc53f2](https://github.com/SherinBloemendaal/webra/commit/6bc53f2268bc54596d23d638ca86acd3ce8b17f2))
* **repo:** add a tool that makes an existing account an admin ([9381106](https://github.com/SherinBloemendaal/webra/commit/938110633eb2c73a23f0752e9d2d539fc6454d91))
* **server:** add accounts, sessions, passkeys, Discord sign-in and the admin API ([f03c9ae](https://github.com/SherinBloemendaal/webra/commit/f03c9ae0c8cb870a5f2ee376deacbbf4af25bae1))
* **server:** relay OpenRA's quick install package for one-click installs ([0b41d1b](https://github.com/SherinBloemendaal/webra/commit/0b41d1b31d1f237145df0649b20f92e3bbbcdb0d))
* **website:** add a privacy notice and link it from every footer ([6ab0548](https://github.com/SherinBloemendaal/webra/commit/6ab0548b9a8750fa139134b8bcf711b879116ddd))
* **website:** add the account page and the admin dashboard ([102529b](https://github.com/SherinBloemendaal/webra/commit/102529bb96d0342523e786992161d5de6ef36f14))


### Bug Fixes

* **game:** keep createSettings(null) as a memory-only settings store ([1d97cc9](https://github.com/SherinBloemendaal/webra/commit/1d97cc94246b85977a1a878b4704e60654b2c529))
* **game:** make installing the original content clear and reliable ([0735988](https://github.com/SherinBloemendaal/webra/commit/0735988acad2564a12cf563cfe076ab432af8275))
* **game:** send the CSRF header with every API write ([0f2fc86](https://github.com/SherinBloemendaal/webra/commit/0f2fc86fba1bc8721ef342b43e0d05d37b8b07e6))
* **game:** send the CSRF header with session and map requests ([7afd9b8](https://github.com/SherinBloemendaal/webra/commit/7afd9b8a04ad4aed61101001d4da8d7e5fcd69b3))
* **protocol:** refuse prototype keys in settings documents ([fc70588](https://github.com/SherinBloemendaal/webra/commit/fc705888514a2d7ead9595ec1d59ec27209e9079))
* **server:** answer forbidden before account_inactive on staff routes ([ad4371e](https://github.com/SherinBloemendaal/webra/commit/ad4371ee79b7df3d39d6e880bb97047c5cace8c4))
* **server:** close the accounts security review findings ([e016428](https://github.com/SherinBloemendaal/webra/commit/e0164280304a2c3e7465a62b7a4245e5d01161e6))
* **website:** match the account pages to the reviewed API ([bbf038c](https://github.com/SherinBloemendaal/webra/commit/bbf038c496143db564597b72533447c8ac491a4c))

## [0.6.0](https://github.com/SherinBloemendaal/webra/compare/v0.5.0...v0.6.0) (2026-10-08)


### Features

* **engine:** add an actor table for UI lookups from a simulation worker ([f6344bf](https://github.com/SherinBloemendaal/webra/commit/f6344bfb329edb8e47568d5e33203d211780a925))
* **engine:** build tick-rate instance records for a GPU instance pass ([0828b14](https://github.com/SherinBloemendaal/webra/commit/0828b14a0999e4d946f1470d4b8fe8f3fe29b080))
* **game:** interpolate and cull instances in a WebGPU compute pass ([e3bc87a](https://github.com/SherinBloemendaal/webra/commit/e3bc87ac78f45a7ba8ba9b62165520ac3631cdb2))
* **game:** run the simulation in a web worker ([408caf0](https://github.com/SherinBloemendaal/webra/commit/408caf0eb1283907220f08e7d8eb93d80c516370))
* **website:** cross-origin isolate the game for shared memory ([0d528a7](https://github.com/SherinBloemendaal/webra/commit/0d528a7d8053607653f3ec63170113fcbf7e3c10))


### Bug Fixes

* **engine:** break ore truck ties without scan order so mirrored trucks pick mirrored ore ([e911f65](https://github.com/SherinBloemendaal/webra/commit/e911f650657c6087168df2eb00777f06a7fe02b7))
* **engine:** halve desert heat build-up and bump the protocol version ([e7294b4](https://github.com/SherinBloemendaal/webra/commit/e7294b423d0afd7193da978bdf3754c43ae143e0))
* **engine:** join cut-off land to the bases and guarantee reachable ore ([a3ea89a](https://github.com/SherinBloemendaal/webra/commit/a3ea89a3a1c2b2e4778b7c42ae3f50eb4b1ab2fd))
* **engine:** let AI games end when economies run dry ([8ef0ca0](https://github.com/SherinBloemendaal/webra/commit/8ef0ca06e09aabb9a65f0fa8adffee5a9ff3604f))
* **engine:** turn building turrets smoothly between ticks ([b8a5210](https://github.com/SherinBloemendaal/webra/commit/b8a521043cd93e759335ed0b549fe7e58820774c))
* **game:** explain replays and saves of other versions instead of failing validation ([945abee](https://github.com/SherinBloemendaal/webra/commit/945abeed2cc4d82e03d97eb0834e56deff2e8617))
* **game:** keep the GPU instance pass opt-in until seen in browsers ([d289e19](https://github.com/SherinBloemendaal/webra/commit/d289e19247afcdfdf2803f3f585249a9363d05d8))

## [0.5.0](https://github.com/SherinBloemendaal/webra/compare/v0.4.0...v0.5.0) (2026-10-08)


### Features

* **engine:** draw OpenRA style selection brackets and segmented health bars ([ed2155b](https://github.com/SherinBloemendaal/webra/commit/ed2155b81181000d15528c62d87781815549b80f))
* **engine:** expose planned unit routes for a path overlay ([9af3501](https://github.com/SherinBloemendaal/webra/commit/9af350171d3cf3d8a565eb4a6c98230d55367c39))
* **game:** acknowledge command bar orders with unit voices ([8d37852](https://github.com/SherinBloemendaal/webra/commit/8d37852c9790eb98209e0be3fffdaa873ac134ef))
* **game:** add a show unit paths setting ([14b0e0c](https://github.com/SherinBloemendaal/webra/commit/14b0e0c6306ee00adf6470bd04781fff4b7d2447))
* **game:** animate building layers on a render clock ([b052d96](https://github.com/SherinBloemendaal/webra/commit/b052d96b2edb2eb19b68242944ccc7f645365def))
* **game:** record games, add replays, save and load, spectating ([916fd92](https://github.com/SherinBloemendaal/webra/commit/916fd92432ac7fcbd1ba8378696ab6af9caa840b))
* **protocol:** add rejoin, spectator and replay file schemas ([689fc24](https://github.com/SherinBloemendaal/webra/commit/689fc240afaa9d287d873a2d8fed905610c1f84e))
* **protocol:** add the synced confirmation for spectator catch-ups ([7ae3bf8](https://github.com/SherinBloemendaal/webra/commit/7ae3bf89d148e965fc22c0edf9aa4b83e391ec99))
* **server:** let players rejoin and spectators watch running games ([92dd087](https://github.com/SherinBloemendaal/webra/commit/92dd087f0c7081111cf30cf4d378bf3cb4711154))


### Bug Fixes

* **engine:** build the debug menu tests only in test builds ([89f3f9b](https://github.com/SherinBloemendaal/webra/commit/89f3f9b02538c91b4d2965ae4f8bf0028e2158ff))
* **engine:** keep big groups moving through chokepoints and detours ([7feaebf](https://github.com/SherinBloemendaal/webra/commit/7feaebf3525878282157446222577ab65d71e109))
* **engine:** keep the hovered actor in world snapshots ([38071f6](https://github.com/SherinBloemendaal/webra/commit/38071f63c93aacfe24f98429b7d20f43cb630f2b))
* **engine:** let an ai army that stopped growing attack below wave size ([665b845](https://github.com/SherinBloemendaal/webra/commit/665b84579b9c241ee6a2e093f30a5687f1b92f8b))
* **game:** confirm a spectator's catch-up to the server ([1cffce5](https://github.com/SherinBloemendaal/webra/commit/1cffce5b29e80bdfc98755dbc130a9d7e2a14f49))
* **game:** drop the duplicate game clock from the HUD ([22992d1](https://github.com/SherinBloemendaal/webra/commit/22992d1df0565a0ccecc7af513f76bf49eccd744))
* **game:** hear enemy sounds in cells the player can see ([33794a5](https://github.com/SherinBloemendaal/webra/commit/33794a5a9cb2d53dddb7654dd0f1bd55d42521fa))
* **game:** hold the build clock while production stalls ([69c6f2b](https://github.com/SherinBloemendaal/webra/commit/69c6f2b58c2f1ad9ddd29c825080b8af4ac51803))
* **server:** bound rejoin deadlines, catch-up output and chat ([51aabdb](https://github.com/SherinBloemendaal/webra/commit/51aabdbe538a97343d72480d287d492dda67f456))

## [0.4.0](https://github.com/SherinBloemendaal/webra/compare/v0.3.0...v0.4.0) (2026-10-08)


### Features

* **engine:** add debug menu cheats and read-only debug views ([1b5bf2a](https://github.com/SherinBloemendaal/webra/commit/1b5bf2a20dece7fd3ec03cf790a5077066b49b2f))
* **engine:** add Game.units_center for camera hotkeys ([5efb84b](https://github.com/SherinBloemendaal/webra/commit/5efb84b715a3764d41bc4a30dede33f8bb28d674))
* **engine:** add gems as a second resource type ([18058d2](https://github.com/SherinBloemendaal/webra/commit/18058d2416cf68036a7f57d7fa6427e5e3e4e13d))
* **engine:** log audio events for the client ([f86bcda](https://github.com/SherinBloemendaal/webra/commit/f86bcdaa45a08649833f569a74c33947a4bddc0e))
* **engine:** queue structures and cancel items that can no longer be built ([caefe82](https://github.com/SherinBloemendaal/webra/commit/caefe82517a249460159045f91ec5a43dfc5e6d1))
* **game:** add a debug menu with cheats, overlays and stats ([a19d376](https://github.com/SherinBloemendaal/webra/commit/a19d376e1d49b0591dc03885d741d805e89901bb))
* **game:** add RA style cameos for every building and unit ([b7d95ba](https://github.com/SherinBloemendaal/webra/commit/b7d95ba24376de12524d642c113daf6a6ef7fc99))
* **game:** add release notes data with once per version logic ([d512597](https://github.com/SherinBloemendaal/webra/commit/d512597355711294ee464f96245342374e8dd999))
* **game:** add settings, hotkey registry, control groups and game menu modules ([5ae6623](https://github.com/SherinBloemendaal/webra/commit/5ae6623215040ce7b0d691bb97d178b13c1d7381))
* **game:** add sound with optional original Red Alert content ([a4da8b5](https://github.com/SherinBloemendaal/webra/commit/a4da8b526451884e363c06601e7d98fdb2739a29))
* **game:** queue structures from the sidebar with counts ([3bb3a71](https://github.com/SherinBloemendaal/webra/commit/3bb3a71cfe07a92790b0e8df1aca2a4c71acf4ac))
* **game:** redraw all building art with detailed 3/4 shading and add art tests ([48a7507](https://github.com/SherinBloemendaal/webra/commit/48a75078fa45b9c4e107661f0ee3965a3b1c7b93))
* **game:** redraw all structures as pseudo-3D volumes ([d61edc4](https://github.com/SherinBloemendaal/webra/commit/d61edc4da6990c0b871fe37249079cad54fdb7a5))
* **game:** render gems and add a gem brush to the map editor ([5390304](https://github.com/SherinBloemendaal/webra/commit/5390304a1ee7e89b983a84b90249f16b3453eca0))
* **game:** show release notes in the lobby, the game menu and once after updates ([cb21c27](https://github.com/SherinBloemendaal/webra/commit/cb21c27e61df839b8d4a83803039df3f1cd1d696))
* **game:** touch controls and phone layouts ([ac13e5a](https://github.com/SherinBloemendaal/webra/commit/ac13e5aab92163781fec985f46c24d8162fe6ad3))
* **game:** wire the game menu, hotkeys, control groups and new cursors ([eae88ac](https://github.com/SherinBloemendaal/webra/commit/eae88ac84ab1d3529c7f7601cee5f6a512cd28b6))
* **protocol:** accept format 2 maps with a gems layer ([c80768d](https://github.com/SherinBloemendaal/webra/commit/c80768d3af2287ec7d8828f9ea27d035cb4eea7e))
* **protocol:** add the cheats lobby option and cheat order schemas ([588f430](https://github.com/SherinBloemendaal/webra/commit/588f430076239ca483f18d11d7cd0fa8b4d8f2da))
* **repo:** write dist/release-notes.json from CHANGELOG.md ([82b7194](https://github.com/SherinBloemendaal/webra/commit/82b7194e525c40c3b6abcdb673fb298112be49fd))
* **server:** relay cheat orders only in games with cheats enabled ([83fc3d9](https://github.com/SherinBloemendaal/webra/commit/83fc3d944c7b8239566cecb5550053eba660ae42))
* **website:** add the /changelog page ([5184dd1](https://github.com/SherinBloemendaal/webra/commit/5184dd145c3f003bec7f6a146709f3ee8fa2fd55))
* **website:** fit phone screens with safe areas and touch-sized menu ([428849c](https://github.com/SherinBloemendaal/webra/commit/428849cc7345032214e02ddfc451e8010927dc13))


### Bug Fixes

* **repo:** keep workspace installs working across release bumps ([2f4fb3b](https://github.com/SherinBloemendaal/webra/commit/2f4fb3b157c81c15fbc67173974a9df11355b717))
* **repo:** say release in the singular when the build has one ([ce67df7](https://github.com/SherinBloemendaal/webra/commit/ce67df7a2809e81273299b47d3b7df32989d4358))

## [0.3.0](https://github.com/SherinBloemendaal/webra/compare/v0.2.0...v0.3.0) (2026-10-08)


### Features

* **editor:** add map document with undo history, tools and symmetry ([c82c843](https://github.com/SherinBloemendaal/webra/commit/c82c843e40c53afb04ac815b1f76933f1f3303ab))
* **editor:** add map format 1 module with validation and rules overrides ([94c588a](https://github.com/SherinBloemendaal/webra/commit/94c588abc1a2ecb5da7cc9488c440e2bf0dc7d9b))
* **editor:** add map sharing client and game-side map loader ([bd70b3c](https://github.com/SherinBloemendaal/webra/commit/bd70b3ca15d52c21c68208aa88587c927630e82e))
* **editor:** add the map editor page ([6001305](https://github.com/SherinBloemendaal/webra/commit/6001305424cc5a8aa4029be0c0cdb4ac97cab311))
* **engine:** add Chronosphere, Iron Curtain, atom bomb and GPS superweapons ([d410478](https://github.com/SherinBloemendaal/webra/commit/d410478c0812e3e364a39f8f203c85eae15fcebd))
* **engine:** add fixed-wing planes and airfield support powers ([c503fed](https://github.com/SherinBloemendaal/webra/commit/c503fed1dc924eb7da35812d6016e3efd78d8389))
* **engine:** add helicopter flight, landing, ammo, rearming and crashes ([dc53796](https://github.com/SherinBloemendaal/webra/commit/dc53796a9d121efc1ca45daed945d687a3d535f3))
* **engine:** add map files, teams, 2 to 8 players and lockstep orders ([d9de05d](https://github.com/SherinBloemendaal/webra/commit/d9de05dea7a1b49ed458b2159009c021e55ceb44))
* **engine:** add minelayer, cloak, jammer, gap generators and unit specials ([8d67be0](https://github.com/SherinBloemendaal/webra/commit/8d67be04f1d0570e45fd5ca2ec113825d1005513))
* **engine:** add naval units and a shared transport system ([5767c4f](https://github.com/SherinBloemendaal/webra/commit/5767c4f65affb8e6635f379f8531580ec96e0c93))
* **engine:** add water and air domains, ships and aircraft data ([62733be](https://github.com/SherinBloemendaal/webra/commit/62733be680d3dd46733024f53411eb44629dba18))
* **engine:** export cargo, cloak detection, repair and turret data for ships ([0847d5f](https://github.com/SherinBloemendaal/webra/commit/0847d5fefc0cfa7034740a75cafdb3308d62cc48))
* **engine:** generate equivalent bases for 3 to 8 players ([d18ec88](https://github.com/SherinBloemendaal/webra/commit/d18ec88798a62bdbe6091b8d107e6c5858f9eea7))
* **engine:** let the skirmish AI use aircraft, ships, abilities and superweapons ([4b9b50f](https://github.com/SherinBloemendaal/webra/commit/4b9b50f4bd2e7488372238c5d0fea69da67afff8))
* **engine:** let the skirmish AI use its support powers ([7f9b065](https://github.com/SherinBloemendaal/webra/commit/7f9b0657de6ddbfe7bb8a3b61e83ff0005498ebb))
* **engine:** make the skirmish AI play free for all and team games ([44fceb6](https://github.com/SherinBloemendaal/webra/commit/44fceb6f14ea2b8e30c9612d10771f9921a1ac89))
* **engine:** return to base without landing when there is nothing to reload ([cd79ed1](https://github.com/SherinBloemendaal/webra/commit/cd79ed1746443a7b7e6aec39cfae01e0111388a9))
* **game:** add 2 to 8 player skirmish slots, teams and map files to the lobby ([6c249f1](https://github.com/SherinBloemendaal/webra/commit/6c249f14e503df196294d3d8523425f491703cb2))
* **game:** add ability orders, minefield drag, teleport and power targeting, ability art ([35e2f22](https://github.com/SherinBloemendaal/webra/commit/35e2f2259d4b23ee0d8bde6acffd4c29b156d72d))
* **game:** add the multiplayer API client and lockstep driver ([949f1cb](https://github.com/SherinBloemendaal/webra/commit/949f1cba915b8c669dd95c47123fcb14e66dc6c8))
* **game:** add the online server browser, lobby and in-game overlay ([1969337](https://github.com/SherinBloemendaal/webra/commit/1969337eb2395a0601330b0bcde90d5b61eece4f))
* **game:** add the support power bar with map targeting ([da89429](https://github.com/SherinBloemendaal/webra/commit/da894291f79aff6da6d8f3915618131418436725))
* **game:** draw the Chinook, Hind, Black Hawk and Longbow with spinning rotors ([ddb4045](https://github.com/SherinBloemendaal/webra/commit/ddb404561ad8f02b643f5c66e56b1c68cd930628))
* **game:** draw the ships and add the load cursor for transports ([e475d5c](https://github.com/SherinBloemendaal/webra/commit/e475d5c36a9529dc90c47d5748e4515a7a3636a4))
* **game:** draw the Yak, MiG, spy plane and Badger with paratrooper and bomb sprites ([b67f605](https://github.com/SherinBloemendaal/webra/commit/b67f605121c22292d5fbf399be194eb5e3a02f28))
* **game:** open editor test maps and published map links in the lobby ([a4450ad](https://github.com/SherinBloemendaal/webra/commit/a4450addaf8ebf3c1ac798903d6bb0db2b32ec5d))
* **game:** open online play from ?join= invite links like the website ([056c6b6](https://github.com/SherinBloemendaal/webra/commit/056c6b6a88aa371811596d9a07743a603d7480cc))
* **protocol:** accept support power orders with an optional direction ([230c50c](https://github.com/SherinBloemendaal/webra/commit/230c50c06a6737ddde3f5dc579d5dbbf48b2e3fe))
* **protocol:** accept the helicopter land and return-to-base orders ([b37ce1f](https://github.com/SherinBloemendaal/webra/commit/b37ce1fe053542ae2a68eb736786eb497b190e44))
* **protocol:** add message, option and map validators with canonical map hash ([45ded9f](https://github.com/SherinBloemendaal/webra/commit/45ded9f412f89f025d6d4c0199b4aaa03caf16de))
* **server:** add the Worker API, session Durable Object and lockstep relay ([bf05a3b](https://github.com/SherinBloemendaal/webra/commit/bf05a3b922b68aed874df14fdbdfd632d7999fa0))
* **sim:** add all ground vehicles and structures, lobby and pause ([961689d](https://github.com/SherinBloemendaal/webra/commit/961689da06175250b5e3d1fee1518980923315a6))
* **sim:** add playable milestone 1 skirmish ([8c99a23](https://github.com/SherinBloemendaal/webra/commit/8c99a235269f61d876d0b664ff4a9250bf5abc09))
* **website:** add landing site with live sprite gallery, maps and lobbies ([b033557](https://github.com/SherinBloemendaal/webra/commit/b0335572ef16c58fa7a57dcce910e98fbd455b4e))


### Bug Fixes

* **editor:** match engine map validation and canonical form ([fb40df7](https://github.com/SherinBloemendaal/webra/commit/fb40df76f83811aa224146550a8566b6a16d3ea0))
* **engine:** check every cell of each wall piece when filling a line ([68be5d3](https://github.com/SherinBloemendaal/webra/commit/68be5d39c9763a46d760db276388a6c82a617cd7))
* **engine:** check spawns against the map's own Construction Yard ([d384232](https://github.com/SherinBloemendaal/webra/commit/d38423217946e040af92c41aa75404bb2c4419e9))
* **engine:** keep starts and structures from sharing cells ([b1a1831](https://github.com/SherinBloemendaal/webra/commit/b1a183135d56dddd91a58b392c4d9ee2bbdfdcaa))
* **engine:** let planes fly straight out of their turning circle before turning back ([4609e46](https://github.com/SherinBloemendaal/webra/commit/4609e4677d99f151c77f1216201b97d85309d228))
* **engine:** make mirror matches fair for both player slots ([b4f133d](https://github.com/SherinBloemendaal/webra/commit/b4f133dbc49cbab5d1ff4bbe3ff85d39357249a3))
* **engine:** make the skirmish AI behave alike on every spawn ([026eb49](https://github.com/SherinBloemendaal/webra/commit/026eb497feef93a3cba1e97be7b368a39614eb49))
* **engine:** power-gated detection, uncloak on load and mines under structures ([e8a35ce](https://github.com/SherinBloemendaal/webra/commit/e8a35ce5c75efabd0ec28aa0847addeb1cc94207))
* **engine:** send idle AI ore trucks to ore beyond their search radius ([431210b](https://github.com/SherinBloemendaal/webra/commit/431210b66ad30d691cc0a66afdc305ae7048b8b5))
* **engine:** spawn the deployed form before removing the old one ([c0187de](https://github.com/SherinBloemendaal/webra/commit/c0187defa0833b9575034ad44fc580877ec365d9))
* **engine:** stop the AI rallying to enemies it cannot target ([3b0027c](https://github.com/SherinBloemendaal/webra/commit/3b0027c863f8af7dd7ecc5a412eac3de184f0371))
* **engine:** validate structure footprints and every nested rules field ([2c1abaa](https://github.com/SherinBloemendaal/webra/commit/2c1abaa0f50c982e0b5964a12ff20c768ae1cfd0))
* **game:** catch up at once when the server waits for this client ([319c786](https://github.com/SherinBloemendaal/webra/commit/319c7866eefc84fd6685f2d182997030c608b421))
* **game:** report overlapping spawns as editor errors ([03c9d8f](https://github.com/SherinBloemendaal/webra/commit/03c9d8f20e6360d10a7a5d041785a940c22f3292))
* **game:** report structures off the map edge as editor errors ([7ffc55c](https://github.com/SherinBloemendaal/webra/commit/7ffc55c92ce9f01c0f867177ef717b3c9ceb5fef))
* **game:** take the mouse position from mouseenter so the view does not drift ([e98f2fe](https://github.com/SherinBloemendaal/webra/commit/e98f2fee1d997123cad86f4cd154d64121f13d52))
* **protocol:** keep kinds fixed inside replaced rules arrays ([51fc72e](https://github.com/SherinBloemendaal/webra/commit/51fc72e929a162e034f2556000587f9bfe9f718c))
* **repo:** name the sherin.dev zone by id in the deploy token script ([baf94bd](https://github.com/SherinBloemendaal/webra/commit/baf94bd0f610c44556abeec117ae70a629d0fe2f))
* **security:** close the multiplayer findings of the security review ([f61b166](https://github.com/SherinBloemendaal/webra/commit/f61b1660073d43807f99c1599a46c43105211036))
* **server:** blame only a seat's own stalls, through a draining debt ([983d576](https://github.com/SherinBloemendaal/webra/commit/983d576a8b4192d45b2887064416ab2da8c604e1))
* **server:** drop players who hold the game up without progressing ([509dc82](https://github.com/SherinBloemendaal/webra/commit/509dc821f23e61992c3123c6990f7443c38f66d4))
* **server:** drop seats that rotate a stall between them ([29f664e](https://github.com/SherinBloemendaal/webra/commit/29f664e7b5309b4316276ce37c93620b1f8f6519))
* **server:** ignore messages from kicked or departing connections ([b352e5d](https://github.com/SherinBloemendaal/webra/commit/b352e5d2a6514515931dd807a6f8241e6be33d6c))
* **server:** replace a trapped engine instance and refuse such maps with 422 ([1ab5f7d](https://github.com/SherinBloemendaal/webra/commit/1ab5f7dd1bae753000237d575c23a8b89c1a8645))
* **server:** stop seats from taking turns at holding the game up ([b17083d](https://github.com/SherinBloemendaal/webra/commit/b17083df630811a17a08a88b69c4e7b757a6ce88))
* **server:** validate uploaded maps with the engine and align build ids ([06c8395](https://github.com/SherinBloemendaal/webra/commit/06c8395e0a42b13914523ccc58421db3264d03f7))
