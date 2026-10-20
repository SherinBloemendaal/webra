# Changelog

## [0.20.1](https://github.com/SherinBloemendaal/webra/compare/v0.20.0...v0.20.1) (2026-10-17)


### Bug Fixes

* **game:** draw every original pose, special and muzzle in OpenRA's palette ([bb028b0](https://github.com/SherinBloemendaal/webra/commit/bb028b0ed6b6573ad78c37520e467cc6f2ac1b83))
* **game:** draw ore and gem mines as mines and in OpenRA's palettes ([2e6dbdd](https://github.com/SherinBloemendaal/webra/commit/2e6dbdd594a211402460b4ec25929bae7116ba5f))
* **game:** draw ore and gem mines as real mines in every graphics mode ([928e073](https://github.com/SherinBloemendaal/webra/commit/928e073b006eb3b73595b9714154b4a1a7ef56de))
* **game:** draw original-graphics objects, effects and civilians in the palettes the rules give them, without stray team colour ([928e073](https://github.com/SherinBloemendaal/webra/commit/928e073b006eb3b73595b9714154b4a1a7ef56de))
* **game:** read palette owner flags alone and check the seeded lookups ([1f22d83](https://github.com/SherinBloemendaal/webra/commit/1f22d83927054c083a4612770015ec7ea18a9867))

## [0.20.0](https://github.com/SherinBloemendaal/webra/compare/v0.19.0...v0.20.0) (2026-10-16)


### Features

* **engine:** give placed structures and produced units their producer's faction ([3d8e244](https://github.com/SherinBloemendaal/webra/commit/3d8e244c053ab02f5cb57b1c6a8b2293db376e1b))
* **engine:** give placed structures and produced units their producer's faction, like OpenRA ([762256c](https://github.com/SherinBloemendaal/webra/commit/762256cae1741ba9a3361cd4d77506e896d494be))
* **game:** act on the hub's signed_out event at once ([f4998eb](https://github.com/SherinBloemendaal/webra/commit/f4998ebae730ddd649638a7746a242907a2f50db))
* **game:** follow realtime hints in the friends, account, settings and replays screens ([286593a](https://github.com/SherinBloemendaal/webra/commit/286593a580c067ffd4127068caf1297f7e5ee972))
* **game:** reset guide progress from the Guide page, with a reset epoch that wins the sync ([3cf9d2e](https://github.com/SherinBloemendaal/webra/commit/3cf9d2e4f1c4be8a53bae706cf5667bde41785b6))
* **game:** reset guide progress, and show and change it per player in the admin panel ([762256c](https://github.com/SherinBloemendaal/webra/commit/762256cae1741ba9a3361cd4d77506e896d494be))
* **protocol:** add REALTIME_FRESH_MS, the window in which a realtime channel counts as live ([018299d](https://github.com/SherinBloemendaal/webra/commit/018299d58a3ed72155acc3984d65c57d6eb33139))
* **protocol:** add the realtime channel messages and the realtime site setting ([dde5ddd](https://github.com/SherinBloemendaal/webra/commit/dde5ddd38501dc0e40408415e8d60947461ada09))
* **server:** announce a sign-out on the realtime socket before closing it ([98dacb5](https://github.com/SherinBloemendaal/webra/commit/98dacb58cef62ce40610f010a55dca4fcea0d636))
* **server:** publish realtime hints for admin guide actions ([10c16ff](https://github.com/SherinBloemendaal/webra/commit/10c16ff8a9d9cab992b8afb433042397c5236e60))
* **server:** push live updates for friends, approvals, settings, replays and the admin dashboard ([762256c](https://github.com/SherinBloemendaal/webra/commit/762256cae1741ba9a3361cd4d77506e896d494be))
* **server:** push realtime hints through a per-account UserHub Durable Object ([e974c74](https://github.com/SherinBloemendaal/webra/commit/e974c741f2f340efa2550368bc060ee0fd82ca19))
* **server:** show and change a player's guide progress in the admin API ([c5cbc7e](https://github.com/SherinBloemendaal/webra/commit/c5cbc7e5c5382d519ce32079219e3038e63cc93b))
* **website:** guide progress column, filter and actions in the admin dashboard ([6e55eed](https://github.com/SherinBloemendaal/webra/commit/6e55eed84bf79cce16c4472cc376298c0a78aa24))
* **website:** live friends, approval and admin dashboard updates ([99bdf90](https://github.com/SherinBloemendaal/webra/commit/99bdf90d30bf89088733fe708dec8ca756bb8b9b))


### Bug Fixes

* **engine:** let the bots pick producers in the engine's launch order ([841925e](https://github.com/SherinBloemendaal/webra/commit/841925e8da6a1b91f796dad04355385cab32214e))
* **game:** bound the tile worker with a deadline and never hold the start for it ([54b9ba1](https://github.com/SherinBloemendaal/webra/commit/54b9ba1fbad3e881bd13d52bdd14d24ad51ecbee))
* **game:** draw roads, bridge banks and shores with Red Alert's own templates in the original graphics ([762256c](https://github.com/SherinBloemendaal/webra/commit/762256cae1741ba9a3361cd4d77506e896d494be))
* **game:** fit Red Alert's road templates, bridges and their shores in the original tile terrain ([e7551f1](https://github.com/SherinBloemendaal/webra/commit/e7551f13ca7e6972878a47ba45eede40104ebebb))
* **game:** keep the reset epoch when the tour is taken again ([e512011](https://github.com/SherinBloemendaal/webra/commit/e512011b6df86611150d6ef3eb67299bb517200a))
* **game:** list the road pieces as missing for original content installed before whole roads ([d694a93](https://github.com/SherinBloemendaal/webra/commit/d694a93d6f2dca6773200a2208853fbe4e992f26))
* **game:** reconnect realtime on a new status or role, and poll fast when hints stop ([c42aa13](https://github.com/SherinBloemendaal/webra/commit/c42aa135d11dd53358c25b8185304555b8183a49))
* **game:** warm the synth up before the audio cost gate and widen its margin ([ef444a3](https://github.com/SherinBloemendaal/webra/commit/ef444a3417abab9902143ac4f2f07ead5289a7c2))
* **server:** tell the admin to retry when a player's settings keep changing ([081de4b](https://github.com/SherinBloemendaal/webra/commit/081de4bfc05804487006b779cec184ca343d840d))
* **server:** tighten realtime hints after the security review ([b5c74db](https://github.com/SherinBloemendaal/webra/commit/b5c74db8dcdadbd54cc394698ec07507ddc0e0e5))
* **server:** treat only moderators and admins as staff when closing sockets ([5d36689](https://github.com/SherinBloemendaal/webra/commit/5d366895459981dbd3d00f82628ec5814db00fea))
* **website:** check waiting accounts every minute whatever the realtime socket says ([83fb318](https://github.com/SherinBloemendaal/webra/commit/83fb31857f7efe406c0e803c42772695fb1d41e1))


### Performance Improvements

* **game:** plan the original terrain tiles in a worker for games and map previews ([2636be1](https://github.com/SherinBloemendaal/webra/commit/2636be174aa1b35d1d8c1522650bf1fb642bf46c))
* **game:** plan the original terrain tiles in a worker with a deadline ([762256c](https://github.com/SherinBloemendaal/webra/commit/762256cae1741ba9a3361cd4d77506e896d494be))

## [0.19.0](https://github.com/SherinBloemendaal/webra/compare/v0.18.0...v0.19.0) (2026-10-16)


### Features

* **editor:** show the game's boot screen while the map editor starts ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **editor:** show the game's boot screen while the map editor starts ([30c66c7](https://github.com/SherinBloemendaal/webra/commit/30c66c7a28abcf4f2361f7e03899534f5e9a8ff5))
* **game:** add quick tips that say what a structure or unit does on hover ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** add quick tips that say what a structure or unit does on hover ([d0d9a3e](https://github.com/SherinBloemendaal/webra/commit/d0d9a3e57531ae26335283e26b840958d0e454e6))
* **game:** ask at the end of the tour whether to keep the quick tips ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** declare game.quickTips and guide.quickTipsAsked ([f6caae8](https://github.com/SherinBloemendaal/webra/commit/f6caae85eb7de912343562719befadec6d23f85c))
* **game:** walk the tour through every chapter in order, with an army beside the base and a power check before the radar ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** walk the tour through every chapter, in order, with also steps and a power check ([e78eef5](https://github.com/SherinBloemendaal/webra/commit/e78eef5a1dfa5d00a787ba07ecf7cf588782aee0))


### Bug Fixes

* **editor:** draw the first frame in a hidden tab so the boot finishes ([686e9f8](https://github.com/SherinBloemendaal/webra/commit/686e9f8e90de4cb83a39ef17bc29367a1603a6a7))
* **editor:** keep live drags cheap and cancel them cleanly ([3cd1ecc](https://github.com/SherinBloemendaal/webra/commit/3cd1ecc6da461243cce713894fbe241109ebd19c))
* **editor:** show every drag tool's edit while the pointer is down ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **editor:** show every drag tool's edit while the pointer is down ([82a4c7e](https://github.com/SherinBloemendaal/webra/commit/82a4c7e02960c209e3ddd1550ae043376f245a23))
* **engine:** grant mission prop prerequisites and keep script-only items locked ([013d90c](https://github.com/SherinBloemendaal/webra/commit/013d90c586e939f4cc4028b80cd02e049fada11a))
* **engine:** grant mission prop prerequisites so Intervention's base unlocks ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **engine:** hide the other side's and other countries' items in the build menu ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **engine:** hide the other side's and other countries' items in the build menu ([7a8da02](https://github.com/SherinBloemendaal/webra/commit/7a8da023b071b6e44904b470aadf8ca8905a4831))
* **game:** announce the tour's low power line in its live region ([0039848](https://github.com/SherinBloemendaal/webra/commit/003984871f1a1cdb056e043a89f16791817841b2))
* **game:** centre button labels on their capitals ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** centre the guide's chapter labels on their capitals ([c2e43f4](https://github.com/SherinBloemendaal/webra/commit/c2e43f4461453d4b4f4d7aac695422e308415a0e))
* **game:** centre upper-case labels in buttons, tabs and badges ([08498aa](https://github.com/SherinBloemendaal/webra/commit/08498aa9d3f4a3c7d6c5feb40b6609bdb1c14f34))
* **game:** count a built Radar Dome as the power check done ([b59f6c6](https://github.com/SherinBloemendaal/webra/commit/b59f6c69f3e3440ee34f41e969546c2514f667a6))
* **game:** draw rain, snow and sand in the world instead of over the screen ([3f5d5e9](https://github.com/SherinBloemendaal/webra/commit/3f5d5e95390d7e767890273cf255978a4c2525ff))
* **game:** draw rain, snow and sand in the world, in proportion to the zoom ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** keep the tour switch on when the quick tips question is closed ([0374ddf](https://github.com/SherinBloemendaal/webra/commit/0374ddf2d7a3f3614034896724a73205b9d70b87))
* **game:** make the thief and wall quick tips match the rules ([6857215](https://github.com/SherinBloemendaal/webra/commit/685721524c876546e6b13d59aac959335a2c92dc))
* **game:** nudge the remaining capital labels and find them by test ([5ab43bd](https://github.com/SherinBloemendaal/webra/commit/5ab43bd06dc9c4a60452e601fdd0247d6c10e1a9))
* **game:** read OpenRA's multi-line descriptions ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** read OpenRA's multi-line descriptions and show them without quick tips ([3f99ec6](https://github.com/SherinBloemendaal/webra/commit/3f99ec6c5e67264e6b6d006a4c2edf2c2fd93bf0))
* **game:** smooth weather resume and release HUD tooltips on teardown ([f8b36ce](https://github.com/SherinBloemendaal/webra/commit/f8b36cefe1ec37310103ea359e0f03a4d6266d7a))
* **game:** tick guide steps in order, remembering what was done early ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** treat build items locked for the game as missing in the guide ([f6ece19](https://github.com/SherinBloemendaal/webra/commit/f6ece19fc9419c1ebf1ce2665ef52db3bdf895ba))
* **game:** use the game's tooltip instead of native titles on the HUD ([e361c77](https://github.com/SherinBloemendaal/webra/commit/e361c77775591e67e2a5fd328cfba379411a1741))
* **game:** use the game's tooltip instead of native titles on the HUD ([064ede0](https://github.com/SherinBloemendaal/webra/commit/064ede012ff0b37fc784309a2e6370db41851073))

## [0.18.0](https://github.com/SherinBloemendaal/webra/compare/v0.17.0...v0.18.0) (2026-10-16)


### Features

* **game:** show a boot screen on /play until the start menu is ready ([8a425b0](https://github.com/SherinBloemendaal/webra/commit/8a425b04e68c915a0f499b5ad536da8151f3b234))
* **game:** show a boot screen on /play until the start menu is ready ([ed69e31](https://github.com/SherinBloemendaal/webra/commit/ed69e315e2f24504ee952c26371f59e37ae506cf))
* **game:** show guide steps of later versions to existing players ([8a425b0](https://github.com/SherinBloemendaal/webra/commit/8a425b04e68c915a0f499b5ad536da8151f3b234))
* **game:** show guide steps of later versions to existing players ([5041271](https://github.com/SherinBloemendaal/webra/commit/5041271d26f808f5eb00a8c0ba5392a4bc1cb14a))


### Bug Fixes

* **game:** keep the frame loop going when a part of the screen throws ([3bbd0d6](https://github.com/SherinBloemendaal/webra/commit/3bbd0d60c66f2645b9d85a548bd6cbbb9ba63eff))
* **game:** keep the frame loop going when a part of the screen throws, and stop a game whose every frame fails ([8a425b0](https://github.com/SherinBloemendaal/webra/commit/8a425b04e68c915a0f499b5ad536da8151f3b234))
* **game:** keep the game running when a tour step ticks off ([8a425b0](https://github.com/SherinBloemendaal/webra/commit/8a425b04e68c915a0f499b5ad536da8151f3b234))
* **game:** keep the game running when a tour step ticks off ([bbb7f9b](https://github.com/SherinBloemendaal/webra/commit/bbb7f9b12b3e2acb93c856239dcd09e706cbd04c))
* **game:** keep the tour card above the command bar on touch and narrow screens ([8a425b0](https://github.com/SherinBloemendaal/webra/commit/8a425b04e68c915a0f499b5ad536da8151f3b234))
* **game:** keep the tour switch of 0.17.0 players as stored ([8418682](https://github.com/SherinBloemendaal/webra/commit/841868264815af4b132400117cc20157696f87ac))
* **game:** keep What's new and a resumed mission behind the boot screen ([3c6bcfc](https://github.com/SherinBloemendaal/webra/commit/3c6bcfcdffd1044640a1d0cb173d914b4c6ccfd9))
* **game:** stop a game whose every frame throws, and name each guarded part ([4cb9dd7](https://github.com/SherinBloemendaal/webra/commit/4cb9dd7c93c36ef84bd240dc48b7dc3882ad96eb))

## [0.17.0](https://github.com/SherinBloemendaal/webra/compare/v0.16.0...v0.17.0) (2026-10-15)


### Features

* **editor:** the Map editor board, select plates and the checks verdict in the top bar ([627b010](https://github.com/SherinBloemendaal/webra/commit/627b0106f46ac89134c4452e6bbdbf463fa1628f))
* **engine:** shear turret, rotor and muzzle offsets of sheared art ([ad19396](https://github.com/SherinBloemendaal/webra/commit/ad193963db3feeebd8317b957f3fc87f5d4a70d0))
* **engine:** start support powers charged and check timer relationships ([3f0ca0e](https://github.com/SherinBloemendaal/webra/commit/3f0ca0e1708d2870a4655a09b669b97188746192))
* **game:** a game menu with settings, guide and tour, and a network tab in online games ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** add data modules for connection quality, invite codes and friends ([9c12dc3](https://github.com/SherinBloemendaal/webra/commit/9c12dc3935d80f0e1d797af10456013662f9de5b))
* **game:** add the built-in 3D minimal texture pack ([9a6f232](https://github.com/SherinBloemendaal/webra/commit/9a6f2327ae3329181c7eea75b100547ce1d6dda9))
* **game:** campaign screen in the look of the Campaign board ([65f56b6](https://github.com/SherinBloemendaal/webra/commit/65f56b6256d5312ee8951d95d6a0d9b253c04d8c))
* **game:** debug menu, sound and music dialogs in the design system look ([da294e2](https://github.com/SherinBloemendaal/webra/commit/da294e2d06052ff288b8958e67ad6f57e410dfd7))
* **game:** design tokens from the Foundations board ([c0dc80b](https://github.com/SherinBloemendaal/webra/commit/c0dc80b932a739b423804f8780a545cbd1cf2a30))
* **game:** guide with steps that tick off as you play, and the first game tour ([c15c797](https://github.com/SherinBloemendaal/webra/commit/c15c7973a1390b2d5286720c29aaa5177e8d25f8))
* **game:** hand the game one network object for the HUD and the game menu ([d32f0f6](https://github.com/SherinBloemendaal/webra/commit/d32f0f64dc3bccb29bafb62dddf3f73bda9d8623))
* **game:** list what a modded map changes in its warnings ([38d0753](https://github.com/SherinBloemendaal/webra/commit/38d075365cb2ea97ce53354495e77521e4a10827))
* **game:** Load game, Replays and the replay bar in the new look ([5e99034](https://github.com/SherinBloemendaal/webra/commit/5e99034ed6f946e91ca0600377fb41b503f26f6a))
* **game:** place the 3D minimal pack's turrets and rotors on their mounts ([5143b5f](https://github.com/SherinBloemendaal/webra/commit/5143b5f39e1005f03c378f2444130ece050129ed))
* **game:** recolour 2D minimal world objects from the design canvas ([a8a7fb5](https://github.com/SherinBloemendaal/webra/commit/a8a7fb548adf3919d694488034cd4c375fa451b9))
* **game:** redesign every menu, lobby, loading, end of game and in-game screen from the design canvas ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** redesign the online screens with connection quality, invite codes and friends ([b809193](https://github.com/SherinBloemendaal/webra/commit/b809193e7d32254907636e1dcd374dc2b15add68))
* **game:** redesigned game menu with tabbed settings, hotkey search and a network tab ([b5c9094](https://github.com/SherinBloemendaal/webra/commit/b5c9094ee502bcde11a7fe3f2a32bba7b2859328))
* **game:** redraw 2D minimal terrain in the flat style of the design canvas ([8039d6a](https://github.com/SherinBloemendaal/webra/commit/8039d6a2c5d0a63b8cfe88709db370f83c0cd3a9))
* **game:** redraw the 2D minimal structures from the top-down boards ([17ffdfa](https://github.com/SherinBloemendaal/webra/commit/17ffdfa1f24c4e8c9dd1a898e893fd7c00dcf656))
* **game:** redraw the 2D minimal unit art from the design canvas ([2ef08ae](https://github.com/SherinBloemendaal/webra/commit/2ef08ae3d97cda8d44a7eeee0eb98d258d401365))
* **game:** redraw the 2D pack's buildings, units, terrain and world objects from the design canvas ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** redraw WebRA's pixel art as the owner's variant B ([6df6004](https://github.com/SherinBloemendaal/webra/commit/6df6004d6a100deb39db5d71c5f124bb6eab5929))
* **game:** redraw WebRA's pixel art in the classic Red Alert style ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** regenerate the effect sounds in the classic Red Alert style ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** regenerate the effect sounds in the classic Red Alert style ([5a8c444](https://github.com/SherinBloemendaal/webra/commit/5a8c4444f8c57e6d94b2075bcc1051236650c4f1))
* **game:** restyle the in-game HUD after the InGame and Tooltips boards ([6003572](https://github.com/SherinBloemendaal/webra/commit/600357254acd343747d07361a32082ea67d1abb6))
* **game:** select plate, stepper, tabs, badges and the patterns sheet ([7b16ac1](https://github.com/SherinBloemendaal/webra/commit/7b16ac142250b2b77a489703fa476175cca443df))
* **game:** self-host the fonts and generate the logo ([5a6cb6b](https://github.com/SherinBloemendaal/webra/commit/5a6cb6bd98208a9d047f0103967560b2535c3325))
* **game:** self-hosted fonts, the new logo and shared controls (select plates, steppers, tabs) everywhere ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** signal bars, connection warning and waiting panel in online games ([9f1c061](https://github.com/SherinBloemendaal/webra/commit/9f1c061491674bc89fdd1c47b62373289bbd2308))
* **game:** skirmish setup in the look of the Skirmish board ([c3a4191](https://github.com/SherinBloemendaal/webra/commit/c3a41912f5052ce37e9a72d19558a0358376a112))
* **game:** tell the end of game screen who proposed the rematch and how everyone answered ([6f6d1fa](https://github.com/SherinBloemendaal/webra/commit/6f6d1fac8c0973ade37a7f00670ff6a85555ac10))
* **game:** the animated loading screen with the sides and tips ([f333683](https://github.com/SherinBloemendaal/webra/commit/f3336834bb8310d99526798218c50da559411aff))
* **game:** the Content board in the original content dialog ([81429bf](https://github.com/SherinBloemendaal/webra/commit/81429bfe8f8283f2408a3d333aec41439f268eb7))
* **game:** the ReleaseNotes board in the release notes dialog ([6090eb2](https://github.com/SherinBloemendaal/webra/commit/6090eb2c233e1d1b578def79bd11c37d55ff9397))
* **game:** the SignIn board, and dialogs for a refused or unreachable game ([c025dcf](https://github.com/SherinBloemendaal/webra/commit/c025dcfed95a15109e1e8e7d503bb2d99cf138f3))
* **game:** the start menu as the design system's menu bar ([412b772](https://github.com/SherinBloemendaal/webra/commit/412b772fb405c8ef285f26dadb792443b5ebc8af))
* **game:** tooltips in the look of the Tooltips board ([703e15b](https://github.com/SherinBloemendaal/webra/commit/703e15b6e111e570add9eae1463661c7ac0a0466))
* **game:** victory, defeat and statistics in the look of their boards ([65633a5](https://github.com/SherinBloemendaal/webra/commit/65633a568479ba23663401c9e7dd49add4069e7f))
* **protocol:** add protocol 8 with the start gate, network quality and invite codes ([74165bb](https://github.com/SherinBloemendaal/webra/commit/74165bb6ea03f795d82637d4490ccb11d0f7bb64))
* **protocol:** settings for network warnings, friends privacy and the guide ([41006e8](https://github.com/SherinBloemendaal/webra/commit/41006e871d8793b1918163325211e80b25e757ba))
* **server:** add friends, invite codes and an online counter, and list running games ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **server:** gate the start, measure connections, add invite codes and friends ([03576bf](https://github.com/SherinBloemendaal/webra/commit/03576bf7aadc8a00a6aa0678c3bb7145a50a55ff))
* **server:** show network quality per player with ping, late pings and who the game waits for ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **website:** account page with a side menu, sign-in methods and friends ([92b0c75](https://github.com/SherinBloemendaal/webra/commit/92b0c75eebb06dd0c7c5eaecf1a7ace4d4d23f73))
* **website:** pages in the look of the Website board, with join by code ([41a73b4](https://github.com/SherinBloemendaal/webra/commit/41a73b483c6e0b7e96a8141266984f2bdaf948c9))
* **website:** redesign the website and account pages with friends and invite links ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **website:** select plates for the admin filters, forms and settings editor ([05f6d30](https://github.com/SherinBloemendaal/webra/commit/05f6d3008dae645f5a5913e3ebab3bcd23d42001))


### Bug Fixes

* **editor:** edited follows the saved point, fixes count as warnings ([ea6a1ca](https://github.com/SherinBloemendaal/webra/commit/ea6a1cafd663f20518832ad71c99a2aa04e9f162))
* **editor:** Esc from tabs and steppers still closes the dialog ([c168a74](https://github.com/SherinBloemendaal/webra/commit/c168a74aadf7fc6775319a8df1b25b8cebc4a212))
* **engine:** keep a support power through a prerequisite loss like OpenRA ([850c017](https://github.com/SherinBloemendaal/webra/commit/850c017599e7293a4e9db32750a4336c6ff11fa3))
* **game:** a press that closes a select list is used up ([794464c](https://github.com/SherinBloemendaal/webra/commit/794464c90993d5e484ac6f56302e54c086759336))
* **game:** accept the old graphics value webra in settings documents ([67d03fd](https://github.com/SherinBloemendaal/webra/commit/67d03fd0c8044cc4d1dd0aedfd65abe861cc6ffa))
* **game:** address the online screens review ([b1fc7c7](https://github.com/SherinBloemendaal/webra/commit/b1fc7c7d14d6c58b2bea331112f90955a2f065a1))
* **game:** apply a map's support power charge times, one-shot and start-charged settings ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** apply support power and lobby option rules of imported OpenRA maps ([2da1cbe](https://github.com/SherinBloemendaal/webra/commit/2da1cbe949dc9a459ac9976b41830dea162c756b))
* **game:** bring the Lightning Rod's crown down to its selection box ([d8f2c19](https://github.com/SherinBloemendaal/webra/commit/d8f2c197f4a17df0428b0f0e007493d550e6affc))
* **game:** Esc from tabs closes the screens, safer deletes and replay marks ([cecf3df](https://github.com/SherinBloemendaal/webra/commit/cecf3df70d300282662f297f21238c84a4746fbc))
* **game:** help text quoting and the tests of the new start menu brand and plates ([49191b3](https://github.com/SherinBloemendaal/webra/commit/49191b3dfe024b07d1e2b8715a4bece8e8a557bd))
* **game:** keep 2D or 3D minimal when an older client syncs graphics webra ([77c6c42](https://github.com/SherinBloemendaal/webra/commit/77c6c42884029ab0f45f097d01d91a8c38bef7bc))
* **game:** keep the minimal atlas 2048 wide with smaller building layers ([0f77bab](https://github.com/SherinBloemendaal/webra/commit/0f77babf685c47c7b93b9ca6a4d9e3e8f7ac7d46))
* **game:** keep the skirmish columns' breakpoint at the online lobby's ([45009e8](https://github.com/SherinBloemendaal/webra/commit/45009e86674a71d46f5ad2e7b3bfde901f6a8493))
* **game:** keep the strokes of neutral world art inside their box ([8dd1fc4](https://github.com/SherinBloemendaal/webra/commit/8dd1fc4a61b3e9e0d56a418b74b2333df777aa87))
* **game:** keep turrets and rotors on their models in the 3D pack ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** leave Esc to select lists, steppers and tabs while the chat is open ([e3fe5f3](https://github.com/SherinBloemendaal/webra/commit/e3fe5f32cb061e4ffe127c9ae437d839770a2a38))
* **game:** leave the loading screen's close to its stylesheet ([b3fb39d](https://github.com/SherinBloemendaal/webra/commit/b3fb39d4d84038959d7b481abf24eaedb48352da))
* **game:** leave the war factory ramp clear of a drawn tank ([304c5ce](https://github.com/SherinBloemendaal/webra/commit/304c5cee71aa46f832e580fc5437c5ff37b3ea0d))
* **game:** leave unmappable locked lobby options unlocked and guard rule names ([ca2e2f9](https://github.com/SherinBloemendaal/webra/commit/ca2e2f952bab854aa11d9c8f18dd293b81cde4fb))
* **game:** let Esc from steppers and tabs close the friends screen ([f66dc82](https://github.com/SherinBloemendaal/webra/commit/f66dc82bce07bc325da79218adc987a351ba2571))
* **game:** let Esc from tabs and steppers close the chat, keep it for open select lists ([2393701](https://github.com/SherinBloemendaal/webra/commit/2393701150dce0b0f16d0b69a806e76c45029a66))
* **game:** let radar, cloak, cash and buzzer sounds die away before they end ([f455e1d](https://github.com/SherinBloemendaal/webra/commit/f455e1d70097c589140ed8b39adee0ce910f35e6))
* **game:** name groups and actors in the sidebar on every selection change ([4419054](https://github.com/SherinBloemendaal/webra/commit/4419054e2b8a5585133633821fec7b1ef488d044))
* **game:** never start a game behind a failed loading screen ([8624713](https://github.com/SherinBloemendaal/webra/commit/8624713b1017241ebd643699453f7671bda48fad))
* **game:** pack card arrows, a zoom stop at 1.0x and no guide in editor test play ([1167001](https://github.com/SherinBloemendaal/webra/commit/116700107609e642100f9e9d5ca10397f5628c6b))
* **game:** read the Network tab from the game's one net object ([7d43a3d](https://github.com/SherinBloemendaal/webra/commit/7d43a3d6e51016e7a6f6b97881dac66680892ebf))
* **game:** retry a built-in pack that failed to load and say why ([08ab222](https://github.com/SherinBloemendaal/webra/commit/08ab222cf011f14b7d32d5e610f96c28c01c8aee))
* **game:** retry loading the friends screen and check the phone session list layout ([d5da3c2](https://github.com/SherinBloemendaal/webra/commit/d5da3c29254b1c1dc1e34f99e2ebdedf0d30e805))
* **game:** review fixes for the connection parts and the fullscreen button ([57d63a8](https://github.com/SherinBloemendaal/webra/commit/57d63a8a81c21decf9fe0f9375920661c3ed83ce))
* **game:** review fixes for the foundation controls and settings ([ccb3541](https://github.com/SherinBloemendaal/webra/commit/ccb354105452a3658cd98c9990222fb18740333a))
* **game:** review fixes for the loading, end of game and statistics screens ([0a0b7d3](https://github.com/SherinBloemendaal/webra/commit/0a0b7d3216201500c2745948e5b22bcb9663d841))
* **game:** size the content dialog's new parts in the UI scale ([31a8cf9](https://github.com/SherinBloemendaal/webra/commit/31a8cf904a3e36ed8c05373ac370a9f872890830))
* **game:** start the game and its AI only once the loading screen is gone ([c86699e](https://github.com/SherinBloemendaal/webra/commit/c86699e0776dd7a04fd43ed7fc3e747142c33f7c))
* **game:** start the game only once the loading screen is gone ([c9f4f13](https://github.com/SherinBloemendaal/webra/commit/c9f4f139525542cd9ef7de740b327e0dddaa18f2))
* **server:** close the review findings on friends, presence and invite codes ([a03bd91](https://github.com/SherinBloemendaal/webra/commit/a03bd9123768e27021e39971201c0286eda9ea27))
* **server:** count friend request, block and invite limits before the name lookup ([3c80d16](https://github.com/SherinBloemendaal/webra/commit/3c80d165a7fb26ecc0794dd27ded97a26e1df456))
* **website:** a still hero battle for reduced motion without script ([9286d8f](https://github.com/SherinBloemendaal/webra/commit/9286d8f0282fb8858f9d7e5348e47b4d6d1aeb8c))
* **website:** Esc closes a dialog unless a select list is open ([6c86d12](https://github.com/SherinBloemendaal/webra/commit/6c86d12c53e4bee349987456e122355dc4edacd2))


### Performance Improvements

* **game:** finish effect sounds in one pass and stop crackle filters early ([8094d3a](https://github.com/SherinBloemendaal/webra/commit/8094d3ab5083af514c183f4c7f3f298641d1547b))

## [0.16.0](https://github.com/SherinBloemendaal/webra/compare/v0.15.1...v0.16.0) (2026-10-15)


### Features

* **game:** build menu queues without credits, with shift right click and a right click style setting ([c74a86b](https://github.com/SherinBloemendaal/webra/commit/c74a86bc93e5415179a99cd7f9d56b6db520ab66))
* **game:** restart and next mission without leaving the game, with a loading screen on every start ([c74a86b](https://github.com/SherinBloemendaal/webra/commit/c74a86bc93e5415179a99cd7f9d56b6db520ab66))


### Bug Fixes

* **engine:** ignore a depot repair order for units with nothing to repair ([c74a86b](https://github.com/SherinBloemendaal/webra/commit/c74a86bc93e5415179a99cd7f9d56b6db520ab66))
* **engine:** no lightning while a thunderstorm dies down, strike bots and humans alike ([c74a86b](https://github.com/SherinBloemendaal/webra/commit/c74a86bc93e5415179a99cd7f9d56b6db520ab66))
* **engine:** queue production like OpenRA regardless of credits, cap queues at 2000 items ([c74a86b](https://github.com/SherinBloemendaal/webra/commit/c74a86bc93e5415179a99cd7f9d56b6db520ab66))
* **game:** show the blocked cursor over an own depot for undamaged units ([c74a86b](https://github.com/SherinBloemendaal/webra/commit/c74a86bc93e5415179a99cd7f9d56b6db520ab66))

## [0.15.1](https://github.com/SherinBloemendaal/webra/compare/v0.15.0...v0.15.1) (2026-10-15)


### Bug Fixes

* **game:** record campaign progress when a mission is won ([e8fcf61](https://github.com/SherinBloemendaal/webra/commit/e8fcf61e0484a49b4ee41051cdd3d566b95bca93))

## [0.15.0](https://github.com/SherinBloemendaal/webra/compare/v0.14.0...v0.15.0) (2026-10-14)


### Features

* **engine:** add the factory loss lobby option ([363094d](https://github.com/SherinBloemendaal/webra/commit/363094dc36aad0252667af432f3837232837cdd9))
* **engine:** queue through passes and defer boxed-in route searches ([e7a932d](https://github.com/SherinBloemendaal/webra/commit/e7a932dc7292fe1c26812a441bdbf21c87fd3d58))
* **engine:** selling plays the make animation backwards before the refund like OpenRA ([d278e63](https://github.com/SherinBloemendaal/webra/commit/d278e635304520a3631ed6bd0f5d2be2ac957ac2))
* **engine:** send damaged planes with the bulk repair order ([b2e740f](https://github.com/SherinBloemendaal/webra/commit/b2e740ff238c0325ea5b65b738473a731f3e4928))
* **engine:** the Construction Yard packs up by playing its make animation backwards ([9330054](https://github.com/SherinBloemendaal/webra/commit/933005459110e547bba4ec942e6f42542d8fb35d))
* **game:** make the menu screens full-width cards ([c44aba4](https://github.com/SherinBloemendaal/webra/commit/c44aba4aa32979652e520229d76ffcf8dd108f44))
* **game:** save every game's replay to the signed-in account ([afa784c](https://github.com/SherinBloemendaal/webra/commit/afa784c88b382bc9c6091655153c0e85a1ca79ff))
* **protocol:** bump the protocol version to 7 ([981204f](https://github.com/SherinBloemendaal/webra/commit/981204f2c26d0f32bb136d8c76b0ab7af1d467a3))
* **server:** hash new passwords with 100,000 PBKDF2 iterations on the Paid plan ([1b440e9](https://github.com/SherinBloemendaal/webra/commit/1b440e92771469a4f971186a1a436e7655bc5717))
* **server:** keep replays in accounts in an R2 bucket ([9dda4c2](https://github.com/SherinBloemendaal/webra/commit/9dda4c296a8b8b0757a49ef820be55286ba8b4fd))


### Bug Fixes

* **engine:** a yard unfolding again shows its make animation, paused pack-ups stay silent ([e528978](https://github.com/SherinBloemendaal/webra/commit/e528978ac1d64241e7f653562fd35ef6957340a6))
* **engine:** bound waiting short of weapon range and follow at once ([f1da789](https://github.com/SherinBloemendaal/webra/commit/f1da78970dd249488a8953a05abd500bb0cd509e))
* **engine:** cancel a finished unit that no structure makes ([a1c0406](https://github.com/SherinBloemendaal/webra/commit/a1c0406ac67f27178995bf6b527bc6a373054463))
* **engine:** check placement against the true world state like OpenRA ([44ac35e](https://github.com/SherinBloemendaal/webra/commit/44ac35e8b5be7e14e954f6ce9a388c1f926fead1))
* **engine:** exit production types and measured seed notes ([0a0ae47](https://github.com/SherinBloemendaal/webra/commit/0a0ae475b177a5e120745daab4daa55534064b05))
* **engine:** fair route search budget and keep the cell a unit backs out to ([6cc5bfd](https://github.com/SherinBloemendaal/webra/commit/6cc5bfdaf14fdf4883f14096bc17b18241e98a88))
* **engine:** follow OpenRA closer in placement checks and naval idle test ([317a80a](https://github.com/SherinBloemendaal/webra/commit/317a80a89e3f89a99a22b61f664dbcdc4bec0c7f))
* **engine:** give units that rejoin a depot's line a fresh place ([6f69248](https://github.com/SherinBloemendaal/webra/commit/6f692487646fd78364c7a61af83a22c48daffc7e))
* **engine:** hide the Lightning Rod from mission sidebars and keep bots powered ([30897eb](https://github.com/SherinBloemendaal/webra/commit/30897eb2d089ca288b05c6d59f12fc4f6befcc68))
* **engine:** keep the depot pad held and the line clear of other ways ([a8c09ef](https://github.com/SherinBloemendaal/webra/commit/a8c09ef1697293910449c6826df622456f862e91))
* **engine:** keep the Lightning Rod out of missions and calm bots in blackouts ([b6e8667](https://github.com/SherinBloemendaal/webra/commit/b6e86675eab614ed85ba3513e3021ee05e07f5aa))
* **engine:** let a damaged vehicle on the depot join its line at any tick ([0c569d7](https://github.com/SherinBloemendaal/webra/commit/0c569d713f894efe6722a845d06f5b0be8bbe18f))
* **engine:** let crates and cell triggers follow OpenRA's ActorMap ([fe8c128](https://github.com/SherinBloemendaal/webra/commit/fe8c12829d4cd3b96c3b4e02009e8203a6b8102c))
* **engine:** move into weapon range toward the nearest cell in range ([efff0c9](https://github.com/SherinBloemendaal/webra/commit/efff0c99d947699ef0efb8cade81efd6a7704273))
* **engine:** name only the faction's producers of a missing queue ([95ad50e](https://github.com/SherinBloemendaal/webra/commit/95ad50e45cf179b143765f465b1cb1327091c727))
* **engine:** pick producers by the all tech production type ([5dbcce8](https://github.com/SherinBloemendaal/webra/commit/5dbcce88e1220ae1dbbd26e30cb02d8148f6fdad))
* **engine:** retry crate drops in DropRange and block minefields like OpenRA ([a22b07a](https://github.com/SherinBloemendaal/webra/commit/a22b07a80991617bf81084c5a8c998fbb35c9bf5))
* **engine:** script-created structures play the make animation, naval test seeds explained ([7de7caa](https://github.com/SherinBloemendaal/webra/commit/7de7caa4da631aa2f31e25db7a9bf3b892f8f806))
* **engine:** share one cell occupancy rule and judge idle fleets per squad ([b90e0d2](https://github.com/SherinBloemendaal/webra/commit/b90e0d2cacc222151f0ecb266f3f140cf308961f))
* **engine:** ships leave yards by the production exit rule ([b68a15b](https://github.com/SherinBloemendaal/webra/commit/b68a15b0a31401adca76615ee563fdd0b10cce8d))
* **engine:** skip occupied minefield cells like OpenRA's LayMines ([c32cc30](https://github.com/SherinBloemendaal/webra/commit/c32cc304376ba3ca608e5b8a99250aef6ef8631f))
* **game:** clear the corner buttons on the statistics and Load game cards ([d64eba6](https://github.com/SherinBloemendaal/webra/commit/d64eba6383efae4009b5b03197d2401d4853a170))
* **game:** give the page edge scroll cursor a fallback value ([3af0e67](https://github.com/SherinBloemendaal/webra/commit/3af0e6766ead84d1a8a3f81aaad5f04dbabeeb39))
* **game:** keep finger taps and drags out of window edge scrolling ([c03be45](https://github.com/SherinBloemendaal/webra/commit/c03be450218d300143082eff8a906aeea3e6d8cc))
* **game:** remove the input listeners on dispose and rewrap the edge scroll docs ([70f4aa4](https://github.com/SherinBloemendaal/webra/commit/70f4aa4997e8952cc3bf36b5b507323d5709867e))
* **game:** scroll the map at the window edge, over the sidebar too ([2d059a9](https://github.com/SherinBloemendaal/webra/commit/2d059a9269ea8b2a37b29d193f4a4a2a9db312cc))
* **game:** show the account's Replays list as a screen card like Load game ([d071fd1](https://github.com/SherinBloemendaal/webra/commit/d071fd143f4dcfce27d80f5837ad86378e67215e))
* **protocol:** keep a resumed lobby's save time within the Date range ([02a981a](https://github.com/SherinBloemendaal/webra/commit/02a981a82813b1645d757b1f4b547d93daa3e016))
* **server:** harden replays in accounts after review ([54b0215](https://github.com/SherinBloemendaal/webra/commit/54b0215bf309c41fbd9369ccd06b2e5f56bf1798))

## [0.14.0](https://github.com/SherinBloemendaal/webra/compare/v0.13.0...v0.14.0) (2026-10-13)


### Features

* **engine:** add OpenRA's surrender order to lockstep games ([de74458](https://github.com/SherinBloemendaal/webra/commit/de744582e08de9c819701adfae8d9f81334ed7d7))
* **engine:** announce the victors and expose cameo veterancy overlays ([05d3741](https://github.com/SherinBloemendaal/webra/commit/05d37417c0ea921f89a71360daa46403a5bd6315))
* **game:** add game info and surrender to the game menu like OpenRA ([852f4e7](https://github.com/SherinBloemendaal/webra/commit/852f4e7c2cf46d47999a791f3b71221f0d9245c7))
* **game:** add OpenRA's battlefield tooltip and range circles ([4cafdd8](https://github.com/SherinBloemendaal/webra/commit/4cafdd8aa5c0b05904b673d466c99ada70a24dba))
* **game:** chat history, system lines and HUD status like OpenRA ([918ba20](https://github.com/SherinBloemendaal/webra/commit/918ba20acb3c29853d832577a2e40c13df0de34b))
* **game:** show observer production, powers and army as icons ([d1b2442](https://github.com/SherinBloemendaal/webra/commit/d1b2442fce824428ed2c33b3c24ae90f538eea21))
* **game:** show superweapon timers of every player like OpenRA ([be45ce2](https://github.com/SherinBloemendaal/webra/commit/be45ce27c9d30f4bbe36c7f128af612f8f4c8e45))
* **protocol:** keep online chat in replays and sync the chat settings ([b4adb3f](https://github.com/SherinBloemendaal/webra/commit/b4adb3fb522c0c98fe9d22390cae407b854853bd))


### Bug Fixes

* **engine:** let map rules add or remove any actor's sell value ([ca49cbf](https://github.com/SherinBloemendaal/webra/commit/ca49cbf6035e40b9b8782befb303398d9686b965))
* **engine:** refund sold structures from their sell value like OpenRA ([d8a74d2](https://github.com/SherinBloemendaal/webra/commit/d8a74d281f8be81fe800b589238f9f7532cbd4b5))
* **game:** keep the end-game title inside its dialog ([3430264](https://github.com/SherinBloemendaal/webra/commit/34302642deade5de629899f31687d7d3f397e008))
* **game:** label spectator chat by channel and close the chat on Esc ([6933ff9](https://github.com/SherinBloemendaal/webra/commit/6933ff937e32f73c58304de2fe55394f7d10d9a0))
* **game:** ready support powers need a powered provider, align icon heads ([52d6578](https://github.com/SherinBloemendaal/webra/commit/52d65785cd382f0cf64df714ef747a0f5626af1d))
* **game:** score players by OpenRA player experience and hide unknown countries ([100c270](https://github.com/SherinBloemendaal/webra/commit/100c2703aa21f9a01ea42956ebfaaba297cc41e0))
* **game:** stack the top-left HUD so weather, powers and timers never overlap ([e9333c6](https://github.com/SherinBloemendaal/webra/commit/e9333c6c128876116deec291a5330a57d64ad1c3))
* **server:** send a defeated player's team chat to the spectators ([cf4c7ca](https://github.com/SherinBloemendaal/webra/commit/cf4c7ca7e198f7625ecb231698573401844fb23a))

## [0.13.0](https://github.com/SherinBloemendaal/webra/compare/v0.12.0...v0.13.0) (2026-10-12)


### Features

* **game:** draw the Black Hawk and Mobile Flak as WebRA's own pixel art ([13a160c](https://github.com/SherinBloemendaal/webra/commit/13a160c2ec4f0e096a75b3220a601b2ba46fe4d6))
* **game:** draw the oil derrick as WebRA's own pixel art ([5bcdfbd](https://github.com/SherinBloemendaal/webra/commit/5bcdfbd0d67717e05511ecff063eb496b9e4e15b))


### Bug Fixes

* **engine:** send the bots' fleets after targets they can reach and see ([dc028b5](https://github.com/SherinBloemendaal/webra/commit/dc028b5df748d6bc37b0548e2a34e81d5221adb0))
* **engine:** weather, cloaks, landing craft and cost in the fleets' reach ([1cc2c93](https://github.com/SherinBloemendaal/webra/commit/1cc2c93016d25012ef585ea4f62488ca104a727d))
* **game:** draw original art OpenRA also ships and audit what is left out ([723bb80](https://github.com/SherinBloemendaal/webra/commit/723bb804607f24ccc3a0c5bb61c4a899703bbe63))
* **game:** give the Mobile Flak's cab its roof ([cf4774c](https://github.com/SherinBloemendaal/webra/commit/cf4774cca2b9d45783681b916ae2390e11a1e820))

## [0.12.0](https://github.com/SherinBloemendaal/webra/compare/v0.11.0...v0.12.0) (2026-10-12)


### Features

* **engine:** send aircraft out of ammo back to their target once rearmed ([e0868f7](https://github.com/SherinBloemendaal/webra/commit/e0868f784e7f4dd063927fb9d9d2b45a4e89600c))
* **game:** let one Esc release the mouse and open the menu by default ([c83dee9](https://github.com/SherinBloemendaal/webra/commit/c83dee9f86b159686c0e83c7b5b81ee5592678e1))


### Bug Fixes

* **engine:** end aircraft attacks on resupply like OpenRA ([73186ef](https://github.com/SherinBloemendaal/webra/commit/73186ef1580b36accc2b18afba2f18c00ef49463))
* **engine:** make anti-air defences and rocket soldiers shoot aircraft ([3c0f9ab](https://github.com/SherinBloemendaal/webra/commit/3c0f9ab63dcf270ddd8bc6cecc03572b48382e7f))
* **game:** keep help tips inside the panel that shows them ([a3afdab](https://github.com/SherinBloemendaal/webra/commit/a3afdabd225d86c9c0be93b30c28556cb11a947d))
* **game:** start the map lens at half the game's zoom ([9f24a21](https://github.com/SherinBloemendaal/webra/commit/9f24a2151f1870aff8da9e88222afb2fc85e469f))

## [0.11.0](https://github.com/SherinBloemendaal/webra/compare/v0.10.0...v0.11.0) (2026-10-11)


### Features

* **game:** magnify map previews with a map lens ([f1372c4](https://github.com/SherinBloemendaal/webra/commit/f1372c4cd584bbe8fe380a1a0d006882df573ff7))

## [0.10.0](https://github.com/SherinBloemendaal/webra/compare/v0.9.0...v0.10.0) (2026-10-11)


### Features

* **deploy:** pass the Sentry settings to the Worker and record releases ([a2f01fb](https://github.com/SherinBloemendaal/webra/commit/a2f01fb18f2fc80199d41f403a223ca1783243e3))
* **engine:** add selectable OpenRA and WebRA movement models ([804514c](https://github.com/SherinBloemendaal/webra/commit/804514c0b6f06c80106651de9f82f0e5e39245f8))
* **engine:** editor preview of a map file for the game's renderer ([fd32dac](https://github.com/SherinBloemendaal/webra/commit/fd32dacc81c37f817a97d6ff4963cd60305ed221))
* **engine:** fairness checks of a map for the editor ([8ea214f](https://github.com/SherinBloemendaal/webra/commit/8ea214f64c1b87039804cafd3e2ead5b08a24b99))
* **engine:** keep wasm panic messages for error reports ([094d087](https://github.com/SherinBloemendaal/webra/commit/094d087e309e96093a553028d66511a283b14c52))
* **engine:** report MAD tank charge and detonation and teleports as audio events ([3f36e36](https://github.com/SherinBloemendaal/webra/commit/3f36e363783212396d080ddbb63727a5f376b59b))
* **game:** draw the map editor with the game's art, original graphics included ([aa37cfd](https://github.com/SherinBloemendaal/webra/commit/aa37cfd5ad3ea36258dd9c3672aec0ea5462da3c))
* **game:** editor shapes, regions, symmetry groups and whole-map transforms ([9da8c98](https://github.com/SherinBloemendaal/webra/commit/9da8c9814497c26808820da4c9ccab7525638021))
* **game:** fog preview layer in the map editor ([6d8d483](https://github.com/SherinBloemendaal/webra/commit/6d8d483dfe87ec3b428592ef71704cf0433c9a3e))
* **game:** give orders through the radar like OpenRA's RadarWidget ([4a496c6](https://github.com/SherinBloemendaal/webra/commit/4a496c6aef598ec8ba3c02ee463eeeb8cacdb685))
* **game:** import OpenRA slot colours and transport passengers from .oramap files ([54caca2](https://github.com/SherinBloemendaal/webra/commit/54caca20b93ff745502f5b5fd84cb73c2a3037a2))
* **game:** lobbies honour a map's setup; the editor edits slots, options, tags and actor state ([4c3d6c8](https://github.com/SherinBloemendaal/webra/commit/4c3d6c8b1fcbce303ad3e6e1687c9abc4be35db5))
* **game:** one Install everything button with a clear installed state ([e050d1c](https://github.com/SherinBloemendaal/webra/commit/e050d1c6b41069bb0e2855792e171470ceede9ae))
* **game:** OpenRA box and click selection ([c1852e8](https://github.com/SherinBloemendaal/webra/commit/c1852e8068e836f66cc27003e0de592852e69e89))
* **game:** OpenRA select all, select by type and double click ([1e63cdd](https://github.com/SherinBloemendaal/webra/commit/1e63cdddf0240c41566c4f45f59105877082cf4a))
* **game:** pick the movement model in the lobby and in editor test play ([cf6a4f0](https://github.com/SherinBloemendaal/webra/commit/cf6a4f098529c6dda5cc03474feb288586b9df57))
* **game:** redesign the map editor in the game's chrome with new tools and panels ([c78ee44](https://github.com/SherinBloemendaal/webra/commit/c78ee447c95a54b28a96fcd21ef303f29c800538))
* **game:** report errors to the self-hosted Sentry ([ebdeeab](https://github.com/SherinBloemendaal/webra/commit/ebdeeab34a9d29bfcaa4409a3df7e5cf0ed71943))
* **game:** show OpenRA's target lines from ordered units to their targets ([d294a62](https://github.com/SherinBloemendaal/webra/commit/d294a629a6cb76347e57d32bf657058bfb6ba55d))
* **game:** start editor test play with chosen slots, bots and camera ([1d4f260](https://github.com/SherinBloemendaal/webra/commit/1d4f2607984c48354e8c1985da9bcc2199c26adf))
* **game:** upgrade old map files everywhere and repair incompatible ones in the editor ([df8fca8](https://github.com/SherinBloemendaal/webra/commit/df8fca8545a1c7f7c89e8caff0aa7a0da19c5cd6))
* **game:** use one red accent in every game screen ([909663c](https://github.com/SherinBloemendaal/webra/commit/909663c288a42c3e21779400afc5d3797ff811f2))
* **protocol:** accept the movement model in lobby options, presets and map setups ([87a4658](https://github.com/SherinBloemendaal/webra/commit/87a465896abd283670611d8b6a7e84f5e33204b6))
* **protocol:** give map files a format version with one shared upgrade chain ([8c49499](https://github.com/SherinBloemendaal/webra/commit/8c4949925e7f46c0df18633d0642c65bc2563825))
* **protocol:** map format version 2 with the map's game setup ([93a34e4](https://github.com/SherinBloemendaal/webra/commit/93a34e4c512388c60ffadf31d02019ca19641ad4))
* **protocol:** scrub error reports and add the privacy settings section ([83e09b4](https://github.com/SherinBloemendaal/webra/commit/83e09b41bc72f07279b47fc518ae7590d3ea88a5))
* **repo:** add tools/map-upgrade.mjs to upgrade map files in bulk ([2a83936](https://github.com/SherinBloemendaal/webra/commit/2a839368ec384b459cc9269ad809947918d5bfd8))
* **repo:** bundle the Sentry browser SDK and error report settings into dist ([efa8a45](https://github.com/SherinBloemendaal/webra/commit/efa8a4544e33e3b5a304dad3305689d14a2fbd91))
* **repo:** make error reports opt-in for the operator ([1162ccf](https://github.com/SherinBloemendaal/webra/commit/1162ccf54f58abe4f5b5c1b4d54321d0ce92a113))
* **server:** online rooms apply and enforce a map's setup; map thumbnails and tags ([66ae1ef](https://github.com/SherinBloemendaal/webra/commit/66ae1ef03301b317f93884e465a306bf6a60357d))
* **server:** relay the freeware CDs' mission movies for the one-click install ([9ec22e7](https://github.com/SherinBloemendaal/webra/commit/9ec22e70a355526d68b1a07e513e9ff65e4ba6cb))
* **server:** report Worker errors to the self-hosted Sentry ([67a2c3f](https://github.com/SherinBloemendaal/webra/commit/67a2c3f35afde63cd3b8b59b0bf115ac2bbddbac))
* **server:** require an email address for new accounts and verify it by mail ([1673e2b](https://github.com/SherinBloemendaal/webra/commit/1673e2b4e813442608e732069420b2a59fb8482a))
* **server:** upgrade maps before hashing and upgrade stored maps when read ([ad33446](https://github.com/SherinBloemendaal/webra/commit/ad3344638a013127b6e5d98ea4beb821e5e9329b))
* **website:** ask every signup for an email address and show verification state ([f4f5f98](https://github.com/SherinBloemendaal/webra/commit/f4f5f9867e69f442e6ad226e13d976fdd4edb6e1))
* **website:** error reports and their switch on the privacy notice ([91de248](https://github.com/SherinBloemendaal/webra/commit/91de2485ff57c61738acb054887b3fbd935e6a94))
* **website:** show the daily email budget and the in-use notice to admins ([ce9393d](https://github.com/SherinBloemendaal/webra/commit/ce9393dfa8a4c448fb02673280a6f1163c33c2df))
* **website:** use the game's red accent palette on every page ([25db27d](https://github.com/SherinBloemendaal/webra/commit/25db27de8d9f4eb475beda0f0e7ca6d62d376af2))


### Bug Fixes

* **engine:** close fords to ships and keep every harbour off the roads ([0186d20](https://github.com/SherinBloemendaal/webra/commit/0186d20aa1a1b2ef2462ea0d0de6c4ebfcb32ae7))
* **engine:** end attacks on targets out of reach and bound flow field work ([88f1037](https://github.com/SherinBloemendaal/webra/commit/88f103726e63ef424aa14b4d4f90cbe28e0dd098))
* **engine:** fire the atom bomb and other click-fired support powers again ([1a01685](https://github.com/SherinBloemendaal/webra/commit/1a0168561dc626c28515414b896d833a785a3a45))
* **engine:** give landing craft their own group goal and use the ground speed class ([bf7c916](https://github.com/SherinBloemendaal/webra/commit/bf7c9164a2a31a09619a6ca1564b33ffe7b8bc1c))
* **engine:** launch ships into the open sea, not into a pond ([fb39703](https://github.com/SherinBloemendaal/webra/commit/fb397035807980d199a8d93d8aec4ccf6fa626d5))
* **engine:** moves go on to their destination once a blocker is gone ([0a0a9c7](https://github.com/SherinBloemendaal/webra/commit/0a0a9c7a99e800839e9b2b4aa022d825372883cd))
* **engine:** never leave a ship on a cell its locomotor cannot enter ([9884aa2](https://github.com/SherinBloemendaal/webra/commit/9884aa21330992a2eb50584bb307b12008924413))
* **engine:** ore trucks mine the ore with the shortest drive ([ba5be73](https://github.com/SherinBloemendaal/webra/commit/ba5be738d2aac7cca4eec51365099bbc97130ea5))
* **engine:** return fire skips attackers a unit can never reach ([0e7b192](https://github.com/SherinBloemendaal/webra/commit/0e7b19211cc6dc716e579220c90ca1fc661a7aec))
* **engine:** send ore trucks to the refinery with the shortest drive ([8a71ddb](https://github.com/SherinBloemendaal/webra/commit/8a71ddb6f9c074f9a0bb49c38e382c8982b14806))
* **engine:** service depots repair vehicles in turn and unload onto the mainland ([e0bd776](https://github.com/SherinBloemendaal/webra/commit/e0bd7762c895c0ea17ec6c1b13bb62554beaf2a2))
* **engine:** squads drop members that cannot reach their leader ([12640fd](https://github.com/SherinBloemendaal/webra/commit/12640fdf5fe6189e99ff925126f95a9cfe0f439e))
* **game:** draw original art again when the bridge templates are installed ([b1b3271](https://github.com/SherinBloemendaal/webra/commit/b1b327127870ac4c9487084f36665b55fc84c2c9))
* **game:** draw submarines at the heading they sail on ([dd7f686](https://github.com/SherinBloemendaal/webra/commit/dd7f686923e21f41ce8e613521f5f3166aeeac6c))
* **game:** end the game for the winner instead of offering to play on ([85e723c](https://github.com/SherinBloemendaal/webra/commit/85e723c6c31b005c89fe8dd14462dc7069f5c111))
* **game:** forget every kept download on Remove and check account requests first ([20f8142](https://github.com/SherinBloemendaal/webra/commit/20f8142e9906d1f0b3da78ce7f9eaf7f22e0efab))
* **game:** honour a mission's PlayLowPowerNotification ([dfe88eb](https://github.com/SherinBloemendaal/webra/commit/dfe88eb9af0d81b3480a1ff65421ff922410060f))
* **game:** install the validated canonical form of an upgraded map file ([d572a2b](https://github.com/SherinBloemendaal/webra/commit/d572a2baefa8503ca9bcde4932b4cd856647094a))
* **game:** keep a paused game silent and still ([03ba7cc](https://github.com/SherinBloemendaal/webra/commit/03ba7ccf2035bae474662f5c262516b3c3ac8dc5))
* **game:** keep keyboard focus and held modifiers right; pin the click score ([6b06a28](https://github.com/SherinBloemendaal/webra/commit/6b06a289be9a6c5df3eb0495e7d02e019e32ea95))
* **game:** keep standalone spans and tracing headers out of error reports ([8892c1a](https://github.com/SherinBloemendaal/webra/commit/8892c1a3d7890eaab2899dabe42020d4f968aab6))
* **game:** keep the sidebar and settings readable at every UI scale ([23dd61c](https://github.com/SherinBloemendaal/webra/commit/23dd61c7db1f4bf9bd18874c7d398b2edc377398))
* **game:** let hotkeys through focused switches, lists and clicked buttons ([c451ba7](https://github.com/SherinBloemendaal/webra/commit/c451ba7a76c561dff128ff7c07e9f735f9dd9b43))
* **game:** load the theme in the map editor and draw an icon for every actor ([397b1ab](https://github.com/SherinBloemendaal/webra/commit/397b1abfa1134f3bab99faf1679299c9127a96b0))
* **game:** never draw fords, roads or beaches as open water ([d27ddb8](https://github.com/SherinBloemendaal/webra/commit/d27ddb8a386ebfa90c07bd0791eb31e199d3bfad))
* **game:** place ships and naval yards on water in the map editor ([3436126](https://github.com/SherinBloemendaal/webra/commit/3436126dab15cba59865b4f74588371184dafbb7))
* **game:** play only original sounds when Red Alert content is installed ([5d8f9f9](https://github.com/SherinBloemendaal/webra/commit/5d8f9f927ec1094dfc7dd6ada001d0957b3db9f0))
* **game:** say the end of game lines at once and gate held sounds on the pause ([2143332](https://github.com/SherinBloemendaal/webra/commit/2143332e4c6e25599ec0bbfd2260e3d363a80e4d))
* **game:** show the lobby slot type, difficulty and bot in full ([a76c48b](https://github.com/SherinBloemendaal/webra/commit/a76c48b472a38d540ea8ab4aaef8ade261adf8d8))
* **game:** start the main menu music as soon as the browser allows sound ([dc34981](https://github.com/SherinBloemendaal/webra/commit/dc34981321710e13ac5288e5a3d305a191b6ab35))
* **game:** use the info colour token for the editor's map upgrade notice ([4bf5048](https://github.com/SherinBloemendaal/webra/commit/4bf5048b05895119e8c046d8f65f0eb9d474a69e))
* **protocol:** refuse maps that can never start, null setup fields and format 2 fields in format 1 files ([31a488e](https://github.com/SherinBloemendaal/webra/commit/31a488e22e7b5f69dca79cf2c9feee735e427ffb))
* **protocol:** refuse reserved keys in maps, paths and quick fixes ([f20a0fd](https://github.com/SherinBloemendaal/webra/commit/f20a0fd7161acf66a88cc4341e05a6727b4b69ef))
* **protocol:** require the movement model in live lobby options ([4819312](https://github.com/SherinBloemendaal/webra/commit/481931285d47057f5e985e3faed62c4458aff87e))
* **server:** bound relay refunds with per-account attempt ceilings ([dccfc49](https://github.com/SherinBloemendaal/webra/commit/dccfc49b0302f702d5a538d7f89cc3f5ae9089df))
* **server:** close the gaps the email security review found ([16f92ef](https://github.com/SherinBloemendaal/webra/commit/16f92efe3aba88821fbf9242778e1463c9dece93))
* **server:** count one-click relay downloads per account, not attempts per IP ([a9eb5eb](https://github.com/SherinBloemendaal/webra/commit/a9eb5eb7592716f1197b1c418234de312c4a4ed7))
* **server:** keep map upgrades of stored rows from failing the list or each other ([f6f5cc9](https://github.com/SherinBloemendaal/webra/commit/f6f5cc9f2e87e927d7ad06d2b67b0f4d6cd2c204))
* **server:** seat lobby joiners by the map's slot setup and cache map thumbnails ([c4d6173](https://github.com/SherinBloemendaal/webra/commit/c4d617354c675775e04c0810a3ed68c04175320f))
* **website:** give the country text the whole card when the unit art is not shown ([9b0d0c5](https://github.com/SherinBloemendaal/webra/commit/9b0d0c562b6b62c9b565cd380461a7ae541fff95))

## [0.9.0](https://github.com/SherinBloemendaal/webra/compare/v0.8.0...v0.9.0) (2026-10-10)


### Features

* **engine:** add a deterministic Lua 5.1 interpreter for mission scripts ([acb1be5](https://github.com/SherinBloemendaal/webra/commit/acb1be54079ab856eabb998094fb636553dc41a0))
* **engine:** add the neutral world of OpenRA maps ([5d17353](https://github.com/SherinBloemendaal/webra/commit/5d17353bc9dcf64c5d3a2c1b189122b7d892f308))
* **engine:** add the Red Alert infantry and their abilities ([c360cb2](https://github.com/SherinBloemendaal/webra/commit/c360cb2234f75783ba180dbdca3e4a23432e9026))
* **engine:** announce Tanya's kills and let reusable engineers capture from outside ([ed0ce1e](https://github.com/SherinBloemendaal/webra/commit/ed0ce1e7dd3ac4b1d176a2df1eff7ef1e9c630a8))
* **engine:** co-op missions with several people and a local player per screen ([1bd134f](https://github.com/SherinBloemendaal/webra/commit/1bd134fe2aaa0fb20eb1012083d55b06715ee8c3))
* **engine:** crates, husks, game rule options and warhead effects like OpenRA ([f07f507](https://github.com/SherinBloemendaal/webra/commit/f07f5073a46c593b90f90ba6878f06181eea7c90))
* **engine:** damage smoke loops like OpenRA and every barrel flashes on its own ([d39ddac](https://github.com/SherinBloemendaal/webra/commit/d39ddac0807f8af9aa6fde301051500211a3f577))
* **engine:** draw original art slots the way OpenRA does ([2c17751](https://github.com/SherinBloemendaal/webra/commit/2c17751dd94bc5a99d9e6315243d4e37d3df066a))
* **engine:** explosions per warhead, muzzle flashes, damage smoke and working animations ([33d0be1](https://github.com/SherinBloemendaal/webra/commit/33d0be17577361b5787aade0a21565540c4e8acc))
* **engine:** mission actors name the art they are drawn with ([09635a5](https://github.com/SherinBloemendaal/webra/commit/09635a5d8f774fb0c7938dc6c32228fa93499d13))
* **engine:** mission map actors, conditions and death spawns like OpenRA ([5c214ab](https://github.com/SherinBloemendaal/webra/commit/5c214abf8ae5bc023c6ec44022a31d2b5a5596ae))
* **engine:** pilots bail out of downed aircraft, as OpenRA's EjectOnDeath ([1ab0a57](https://github.com/SherinBloemendaal/webra/commit/1ab0a577f002796958353697a0da17e9d03b6885))
* **engine:** production on hold, build limits and OpenRA notification events ([60a4b76](https://github.com/SherinBloemendaal/webra/commit/60a4b76c6448ab302e5df76f08b57109aa06ab00))
* **engine:** run OpenRA mission scripts in the simulation ([17cb9b2](https://github.com/SherinBloemendaal/webra/commit/17cb9b2c590738fbb8087fbbbe6045873a9cd988))
* **engine:** run OpenRA's Rush, Normal, Turtle and Naval bots with their module configs ([0a95be0](https://github.com/SherinBloemendaal/webra/commit/0a95be0d2d2e0018672e676fac865baa5277344a))
* **engine:** show control group numbers in the selection box's bottom right corner ([0f2a8e1](https://github.com/SherinBloemendaal/webra/commit/0f2a8e18821a2960aec9d5345cc892dfa5ae11b0))
* **engine:** show disguised spies in their disguise's radar colour and pause what is being captured ([4ad53fa](https://github.com/SherinBloemendaal/webra/commit/4ad53fa9c6ec8d07326f1e80f29c9e8bf51f6a2d))
* **engine:** split generated map spawns by team and place map crates and husks ([60e3eb4](https://github.com/SherinBloemendaal/webra/commit/60e3eb42aee53d6cd142f8cad19eb526ed0be895))
* **engine:** tech buildings and villages on generated maps, panic poses, cash ticks, beaching transports ([8651c50](https://github.com/SherinBloemendaal/webra/commit/8651c50e5b5899333eed6e1d07dab79ad6c5b4ff))
* **engine:** train and use the new infantry in the AI and draw their deaths ([e6229e5](https://github.com/SherinBloemendaal/webra/commit/e6229e5630535f387dde7e5877a576b321830873))
* **engine:** turn husks into vehicles on capture or repair, and uncloak thieves on the move ([b244eb5](https://github.com/SherinBloemendaal/webra/commit/b244eb5702ec7a9c85fadf69e03afe91e52bdea9))
* **engine:** wasm API for missions ([5902fea](https://github.com/SherinBloemendaal/webra/commit/5902fea0e9ec582d9f71514030550570c59da175))
* **game:** art for the campaign's characters, ants and wrecks ([27612d0](https://github.com/SherinBloemendaal/webra/commit/27612d0593cad8e27c3aa50a5e823845d1c90199))
* **game:** audit every actor's original art against OpenRA's sequences ([496e0f3](https://github.com/SherinBloemendaal/webra/commit/496e0f37d0972e8daef6b662c5f100d8f2c727c6))
* **game:** campaign screen, mission games, saves and replays ([7643d22](https://github.com/SherinBloemendaal/webra/commit/7643d22f750e8a92ecfe586b5ca57d756328adf6))
* **game:** draw OpenRA's composed sequences, so Tanya fires both pistols in original art ([12b2ade](https://github.com/SherinBloemendaal/webra/commit/12b2ade9d2a2760d9691435c10aea7cbb4a6514b))
* **game:** draw, import and edit the neutral world of OpenRA maps ([fef5fc6](https://github.com/SherinBloemendaal/webra/commit/fef5fc6a7bfd2be514f7db34d08cdf30e82a0bc0))
* **game:** draw, voice and order the new infantry ([a02bf56](https://github.com/SherinBloemendaal/webra/commit/a02bf56addc2032bffd780c6df8db79b2db3b0a9))
* **game:** every OpenRA notification, actor sound and music track ([c0c8671](https://github.com/SherinBloemendaal/webra/commit/c0c8671580bdbe6ffeb90d21e6e1f12e696a4da2))
* **game:** install shared lobby maps and propose rematches online ([9182126](https://github.com/SherinBloemendaal/webra/commit/9182126af2ff92abe1eb10190fae65fe224df346))
* **game:** lobby options, crates, husks, smudges and battle effects ([f72f8b8](https://github.com/SherinBloemendaal/webra/commit/f72f8b896140a2fc5d3bee0a936f2ec6d4a445f0))
* **game:** original effects, working animations and Red Alert's mouse cursors ([3ad1159](https://github.com/SherinBloemendaal/webra/commit/3ad115938bfc463bf19b73f2b4f527cccb7ad7fb))
* **game:** pick OpenRA's bot type per AI slot in skirmish and online lobbies ([7ec670c](https://github.com/SherinBloemendaal/webra/commit/7ec670cfa5f9b5c5e13c12e21c3933770576bea4))
* **game:** play co-op missions online and wire the movie player ([6ce968f](https://github.com/SherinBloemendaal/webra/commit/6ce968ff3ba407b0b37855a3de8a678f1b7ec4c8))
* **game:** play the missions' original movies from installed content ([2ef2ea9](https://github.com/SherinBloemendaal/webra/commit/2ef2ea90949e7c0ff6f3b8b491775c214bc94923))
* **game:** save online games and resume them from Play online ([41e061b](https://github.com/SherinBloemendaal/webra/commit/41e061b91bf51a1f7bcd20ba2397940c4a601086))
* **game:** sixteen player colours for missions with more players ([6ff0ac9](https://github.com/SherinBloemendaal/webra/commit/6ff0ac919ff0c35fdc490ccc685a6b165c623fdb))
* **game:** tech buildings option and panic art for civilians ([c7edb9b](https://github.com/SherinBloemendaal/webra/commit/c7edb9b825efec10e2fa891440eb6c5ddb5f860e))
* **game:** the chute sound of a pilot bailing out ([0eab03b](https://github.com/SherinBloemendaal/webra/commit/0eab03bdc64eff9a3187f0075f9be92702d07a3e))
* **protocol:** accept OpenRA terrain types and dotted actor ids in maps ([9f76bb0](https://github.com/SherinBloemendaal/webra/commit/9f76bb018461f1348beb3b9007b077529209ceb9))
* **protocol:** accept the interface click and main menu music settings ([77f6f1c](https://github.com/SherinBloemendaal/webra/commit/77f6f1c6413338b4e25086fdcad7cf9ad1cf7153))
* **protocol:** add OpenRA lobby options, handicaps and spawn assignment ([c041de1](https://github.com/SherinBloemendaal/webra/commit/c041de1a22936da74f84822249dbd59390ccd2f5))
* **protocol:** add the reusable engineers lobby option ([426f489](https://github.com/SherinBloemendaal/webra/commit/426f489c7c8a54676534fcdac0d9d6223d7b4528))
* **protocol:** add the techBuildings lobby option ([f00329a](https://github.com/SherinBloemendaal/webra/commit/f00329ad9fd6fa963cfc528c251b0d90646c7486))
* **protocol:** co-op missions in lobbies, starts and online replays ([03414ae](https://github.com/SherinBloemendaal/webra/commit/03414ae750eadc39aa192e069383d159457ed5c2))
* **protocol:** describe lobby maps, map states and rematches (protocol 6) ([b5f1cad](https://github.com/SherinBloemendaal/webra/commit/b5f1cad76495c2fe117e4609bccb9d58836e349f))
* **protocol:** mission replays and saves name their mission file ([d51c35a](https://github.com/SherinBloemendaal/webra/commit/d51c35a5559e187683a59ac584ba534f03f893e2))
* **protocol:** online save messages, resumed starts and online save files ([55750b6](https://github.com/SherinBloemendaal/webra/commit/55750b67fb2f864802aeba80159cf00a59a7fc83))
* **repo:** vendor OpenRA's Red Alert missions and convert them ([9d3f02f](https://github.com/SherinBloemendaal/webra/commit/9d3f02f2e15e3a27161d654da839e66ae715df76))
* **server:** co-op mission lobbies, orders, saves and the directory ([91aa7ac](https://github.com/SherinBloemendaal/webra/commit/91aa7ace643fa7b49b633be950f767f777e9f263))
* **server:** keep player handicaps in rooms and game starts ([88770ee](https://github.com/SherinBloemendaal/webra/commit/88770eeb3a9fc8ebeb1528f5616dfbcfe837eaaa))
* **server:** save online games and resume them with the same players ([c4d0e5e](https://github.com/SherinBloemendaal/webra/commit/c4d0e5e6d15c0435e1a142d3a958d622a189f1b6))
* **server:** share lobby maps with members only and rematch in the lobby ([4aeb7c9](https://github.com/SherinBloemendaal/webra/commit/4aeb7c9a87e10b0d579ea7a62d39270c9f2453c4))


### Bug Fixes

* **engine:** bots finish games and value tech buildings by their traits ([a10d461](https://github.com/SherinBloemendaal/webra/commit/a10d46186500ed54e620ac8ce1abd32aaa9b674b))
* **engine:** keep multi-line power descriptions and let a reloading dog wait before it leaps ([e77f9b9](https://github.com/SherinBloemendaal/webra/commit/e77f9b9f34ecb1648326b506439ee10c4c4795ab))
* **engine:** keep the first refinery while broke, patient attacks and enemy-only flight checks ([a8a6826](https://github.com/SherinBloemendaal/webra/commit/a8a6826f631d26f316ed1c042e03da4ffc5f09ed))
* **engine:** mission structures beyond the map bounds, script kills and dying actors ([889e10f](https://github.com/SherinBloemendaal/webra/commit/889e10feb32f79fff6af59b5ebf904420c65efc4))
* **engine:** overflow-safe script integers and a native stack budget for Lua ([78979ba](https://github.com/SherinBloemendaal/webra/commit/78979bac989c7be9da6bbeea0f123cdb40076e38))
* **engine:** scripted crates are engine crates and flares give off smoke ([3bd3b53](https://github.com/SherinBloemendaal/webra/commit/3bd3b53d05c2411a7ad41550646a06ac4e102233))
* **engine:** size the Lua level budget from wasm32 and native stack measurements ([20f732d](https://github.com/SherinBloemendaal/webra/commit/20f732d1252192a2983cd3f69921d016d1923894))
* **game:** bound a movie's sound track by its length ([4aeadaa](https://github.com/SherinBloemendaal/webra/commit/4aeadaaf19fdfacba6d225fab0a3319b57e308cd))
* **game:** show original helicopter rotors, spinners, silo stages, mines and effects ([833ad2c](https://github.com/SherinBloemendaal/webra/commit/833ad2c43c619daf0ece2fc9a2c138f1a24399ac))
* **protocol:** chain the frames digest per frame, bound save orders ([1893df7](https://github.com/SherinBloemendaal/webra/commit/1893df77cc924bbf831dc6f336215916398a4907))
* **protocol:** count save orders with the order log's own accounting ([8fe5ea6](https://github.com/SherinBloemendaal/webra/commit/8fe5ea6438fc495515a7388f5e658b788dcaecdb))
* **server:** bound resume uploads and stream the online save digest ([aa10e4a](https://github.com/SherinBloemendaal/webra/commit/aa10e4abb42195af7dd70ec877a221cf4a2ba2fb))
* **server:** let a player too slow for a resumed start rejoin it ([66e454e](https://github.com/SherinBloemendaal/webra/commit/66e454ec0efa2a406a835d0f97e67a08a20a0c7b))
* **server:** list co-op lobbies only under a known mission ([d3a44e8](https://github.com/SherinBloemendaal/webra/commit/d3a44e86cfe1b871b3e0cffbe9f27aa60df835fe))

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
