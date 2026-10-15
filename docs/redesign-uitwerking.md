# Redesign: uitwerknotities per scherm

Deze notities vertalen het designcanvas "WebRA texturen" (pagina's Designsysteem, Redesign en de texture packs) naar werk in deze repo. Per scherm staat wat er nu is, welke data er al bestaat, wat ontbreekt en hoe we het bouwen. Alle bestandsnamen zijn relatief aan de repo; `game/` betekent `apps/game/`.

Bronnen: het canvas (claude.ai, artifact "WebRA texturen") en een doorloop van de code op 15 oktober 2026 (versie 0.15.0). De teksten in het canvas zijn voorbeeldcopy: echte labels komen uit de code of uit dit document.

Legenda per scherm:

- **Nu**: welke module en welk element het scherm vandaag bouwt.
- **Data die er is**: bron van elk stuk informatie (engine-call, endpoint, registry-sleutel).
- **Ontbreekt**: wat het ontwerp vraagt en nog niet bestaat, met wat ervoor nodig is.
- **Aanpak**: hoe we het bouwen, in welke bestanden.
- **Let op**: beperkingen, risico's en beslissingen.

---

## 0. Overkoepelend

### 0.1 Designsysteem naar code

- **Tokens.** `game/css/theme.css` is de bron (`--ui-*`). `apps/website/assets/site.css` spiegelt die waarden onder eigen namen (`--accent`, `--primary`). Nieuwe tokens uit het canvas (gloeikleuren van de lampjes, `--ui-led-*`, de tooltip-geel `#f2d64b` die nu `#ffd84a` is in `css/tooltip.css`) komen eerst in `theme.css` en dan in `site.css`. `game/tests/theme-tokens.test.mjs` bewaakt de contrastregels: nieuwe tekstkleuren daar toevoegen.
- **Lettertypen.** Het ontwerp gebruikt Barlow, Barlow Condensed en JetBrains Mono. De CSP is `font-src 'self'` en `/play` draait met COEP `require-corp`, dus Google Fonts kan niet. De woff2-bestanden (OFL-licentie) zelf hosten onder `/lib/fonts/` (gedeeld door site en game via `tools/build-dist.mjs`) met `@font-face` in `theme.css` en `site.css`. `--ui-font`, `--ui-font-display` en `--ui-font-mono` daarnaar laten wijzen. Licentiebestanden meeleveren en noemen in de credits.
- **Geen inline styles op de website.** `style-src 'self'` en er staat nergens een `style=""` in `apps/website`. Alles wat in het canvas inline staat, wordt een klasse in `site.css`; dynamische waarden gaan via CSSOM (`el.style.setProperty`), zoals `game/js/account/ui.js` al doet. In de game gelden dezelfde CSP-regels (zie `docs/security.md`).
- **Controls.** `game/js/ui/controls.js` heeft al switch, segmented (met lampje), checkbox en slider; die blijven en krijgen het nieuwe uiterlijk via `css/controls.css`. Nieuw:
  - `selectPlate()`: de nieuwe select (metalen plaat, lampje, klep met chevron, uitklappaneel met lampje per optie). Bouwen als listbox volgens het ARIA-patroon (pijltjes, Home/End, typeahead, Esc, focus terug naar de knop). Fallback naar de native `<select>` op touch is een optie, maar het ontwerp vraagt hem overal; dan moet het paneel op telefoons als bottom sheet openen.
  - `stepper()`: min, plus, waarde in mono, met discrete stappen (bijvoorbeeld `STARTING_CASH`). Onder water blijft het een keuze uit vaste waarden.
  - Labels/badges (READY, HOST, MODDED, LOCKED): een kleine helper `badge(kind, text)` en klassen in `theme.css`.
- **Tooltips.** `game/js/ui/tooltip.js` (attachTooltip) en `game/js/worldtooltip.js` blijven de basis. Het ontwerp (Red Alert "dialog4"-paneel) is vooral CSS in `css/tooltip.css`. Productie-tooltips met kosten, tijd en stroom in een rechterkolom bestaan al in de logica.
- **Lampjes als toestand.** Elke toestand heeft naast kleur een tweede signaal (woord, lampje, vinkje). Zo blijft het in `forced-colors` en voor kleurenblinden leesbaar. De bestaande `@media (forced-colors)` en `prefers-reduced-motion` regels in `controls.css` uitbreiden voor elke nieuwe animatie.
- **Telefoon en touch.** `game/js/layout.js` (portrait als breedte <= 720 en hoogte >= breedte, landscape als hoogte <= 500) en `css/touch.css` blijven leidend. Elk scherm hieronder moet in die modi werken; doelen minimaal 44 px.

### 0.2 Logo

- **Nu:** een inline SVG `brand-mark` in `apps/website/index.html` en een favicon als data-URI. `docs/banner.svg` wordt alleen door de README gebruikt.
- **Aanpak:** het embleem uit het canvas (bord "Logo") als `/lib/brand/emblem.svg`, `wordmark.svg`, `favicon.svg` en PNG-favicons (16, 32, 180) laten genereren door een script in `tools/` zodat het reproduceerbaar is. Inline SVG blijft mogelijk (geen style-attributen, alleen presentatie-attributen zoals `fill`). Onder 40 px de vereenvoudigde variant zonder plaat.
- **Let op:** het embleem moet origineel blijven: geen logo's of emblemen van Electronic Arts of OpenRA.

### 0.3 Texture packs: 2D minimal, 3D minimal, Red Alert original

- **Nu:** er is één keuze, `game.graphics` = `webra` of `original` (content/index.js `GRAPHICS_SETTING`, segmented in `content/panel.js`), plus door spelers geïnstalleerde `.webrapack`-bestanden (`docs/texture-packs.md`, prioriteit: packs, dan origineel, dan WebRA-art).
- **Mapping:** "2D minimal" is de huidige procedurele WebRA-art (`game/js/art/*`, `sprites.js`); hernoemen in de UI. "Red Alert original" is `original`. "3D minimal" bestaat niet.
- **Ontbreekt, 3D minimal:** de borden in het canvas zijn isometrisch getekend. De game gebruikt de klassieke Red Alert-camera (3/4-aanzicht, cellen recht, `CLASSIC_PITCH_SIN` 654/1024). Een isometrisch pack past niet op het raster. Het pack moet dus opnieuw in de game-projectie worden getekend, met dezelfde vormen, kleuren en blokkige stijl. Beste route: een generator zoals `tools/gen_pixel_art.py` (die al 3D-modellen in de game-projectie rendert) uitbreiden met de Crossy Road-achtige modellen uit het canvas, en het resultaat als ingebouwd pack leveren.
- **Aanpak:** `game.graphics` uitbreiden naar `webra2d | webra3d | original` (registry, `protocol/accounts.js` validatie, migratie van `webra` naar `webra2d`). De keuze toont kaarten (canvas: Opties, tab Graphics) met de installatiestatus.
- **Bouwkunst eerst:** de 2D-gebouwen uit het canvas (feedbackronde: bouwplaats, koeltorens, smeltoven, enzovoort) zijn nieuwe tekeningen voor `game/js/art/buildings.js`. Elk gebouw krijgt dezelfde footprint (`BUILDING_SIZE`) en de bestaande team-mask-conventie (grijs + mask). `game/tests/buildings-art.test.mjs` en `art-audit.test.mjs` bijwerken.

### 0.4 Instellingen en voortgang opslaan

- Instellingen staan in `localStorage` `webra.prefs.v1` en worden gesynchroniseerd door `game/js/account/sync.js`. `mergeSettings` loopt alleen over **gedeclareerde** sleutels in `GROUPS` (`game/js/registry.js`). Losse sleutels in `extra` worden bewaard maar niet samengevoegd bij een conflict. Nieuwe opslag (handleiding, tour, laatste tip) dus als gedeclareerde sleutel toevoegen, met validatie in `protocol/accounts.js` (`validateSettingsDocument` weigert onbekende sleutels buiten `extra`). `extra` heeft een limiet van 8 KB, waarvan `campaignProgress` tot 3 KB gebruikt.

### 0.5 Volgorde

1. Fundament: lettertypen, tokens, controls (`selectPlate`, `stepper`, badges), tooltip-CSS, logo.
2. In-game HUD (sidebar, commandobalk, timers) en de tooltips: de schermen die spelers het meest zien.
3. Startscherm, skirmish, laadscherm, game over.
4. Esc-menu, opties, controls, handleiding en tour.
5. Online (browser, host, lobby), campagne, load game, replays. De serverronde (28, punt 5) met ping/pong, uitnodigingscodes en daarna vrienden (29 tot 31).
6. Website, account, content-dialoog, release notes, inloggen, map editor.
7. Texture packs (2D-gebouwen herzien, daarna 3D minimal als generator).

---

## 1. Website: home

- **Nu:** `apps/website/index.html`, `assets/site.css`, `assets/site.js`, `assets/play-links.js`. Nav: Features, Factions, Maps, Multiplayer, Changelog, GitHub, Account, Play now. Hero is een **canvas** (`canvas.hero-scene`, `drawHeroScene()` in `site.js`) met de echte sprites uit `/play/js/sprites.js`; uitgelogd is `/play` afgeschermd en valt het terug op een CSS-grond.
- **Data die er is:** versie via `dist/version.json` (`tools/build-dist.mjs`), getoond door `siteVersion()` in `[data-build-info]` (nu `0.15.0`; let op: `apps/website/package.json` zegt `0.15.1`). Closed beta: `GET /api/site` `registration.approvalRequired` (`docs/accounts-api.md` sectie 3). Account-link `/account/#signup` opent het aanmeldtabblad.
- **Ontbreekt:**
  - Badge "Closed beta · v0.15" (markup + `site.js` die `approvalRequired` en de versie combineert).
  - Featurekaarten Skirmish, Campaign, Replays, No install (nu andere zes kaarten; kiezen welke blijven).
  - Texture-pack-kiezer (afhankelijk van 0.3; op de site alleen als uitleg met plaatjes, niet als instelling).
  - CTA "Create account" (link naar `/account/#signup`).
- **Aanpak:** de hero wordt het geanimeerde 2D-minimal-slagveld uit het canvas. Twee opties:
  1. **SVG met SMIL** zoals in het canvas: werkt zonder script en zonder sprites, dus ook voor uitgelogde bezoekers. Inline in de HTML (geen style-attributen; `fill`/`stroke` zijn toegestaan). Valt binnen de CSP.
  2. Het bestaande canvas laten animeren met de echte sprites (alleen ingelogd).
  Advies: optie 1, met `prefers-reduced-motion` (animaties stoppen via CSS `animation-play-state`; SMIL stoppen met `svg.pauseAnimations()` in `site.js`).
- **Let op:** alle styling naar `site.css`. Geen externe fonts (0.1). De claims op de kaarten moeten waar zijn: "60 missions" en "2 to 8 players" komen uit de README.

## 2. Website: account

- **Nu:** `apps/website/account/index.html`, `assets/account.js` (`mountAccountPage`, `renderAccount()`), `assets/account.css`, gedeelde `/lib/js/account/replays.js`. Secties: Profile, Email, Password, Passkeys, Discord, Devices, Replays, Your data. Privacy is een link in Your data.
- **Data die er is:**
  - Profiel: `GET /api/account` (`user.username, displayName, avatarColor, createdAt`), opslaan `PATCH /api/account`.
  - Methoden: `GET /api/account` `methods.{password, discord{username, linkedAt}, passkeys}`; passkeys `GET /api/account/passkeys` (`id, name, createdAt, lastUsedAt, backedUp, ...`), hernoemen `PATCH`, verwijderen `DELETE`.
  - Discord koppelen `POST /api/auth/discord/start` (mode `link`), ontkoppelen `DELETE /api/account/discord`.
  - Replays: `GET /api/account/replays` (`replays, usage{count, bytes}, limits{count, bytes, retentionMs}`); tekst via `usageText()`; bekijken `/play/#replay=<id>`.
  - Sessies: `GET /api/account/sessions` (`id, current, deviceLabel, userAgent, createdAt, lastUsedAt, expiresAt`), intrekken per stuk of allemaal.
  - Export `GET /api/account/export`, verwijderen `DELETE /api/account` (`confirm: username`).
- **Ontbreekt:**
  - "Wachtwoord gewijzigd op": de database heeft `password_changed_at`, de API geeft het niet terug. Toevoegen aan `selfUser` in `apps/server/src/accounts/users.js` en aan `docs/accounts-api.md`.
  - Locatie per sessie: bestaat niet (IP alleen als hash). **Niet** toevoegen; uit het ontwerp halen of vervangen door apparaat en laatst gebruikt.
- **Aanpak:** de bestaande secties krijgen de opmaak van het canvas (zijmenu met lampjes, metalen panelen). De zijmenu-labels volgen de echte secties (Profile, Sign-in methods = Password/Passkeys/Discord, Replays, Devices, Your data). Puur `account.css` en markup in `account.js`.
- **Let op:** verwijderen blijft een zachte verwijdering met 30 dagen; de knop in gevaarstijl houdt de bestaande bevestiging.

## 3. Startscherm en menubalk

- **Nu:** `game/index.html` `#start-nav` met `#start-skirmish`, `#online-button`, `#campaign-button`, `#records-entry` (`records.js mountRecordEntries`), `#account-entry`, More-lijst; `game/js/startmenu.js mountStartMenu`; `css/startmenu.css`; aangesloten in `main.js` (~r. 203).
- **Data die er is:** naam en avatar (`account/ui.js mountAccountEntry`: `displayName || username`, `avatarColor`), sync-status, motd.
- **Ontbreekt:** totaal aantal spelers online. Kan via een teller in `apps/server/src/directory.js` (som van spelers in lijstbare sessies) of een nieuw endpoint. Klein, maar wel een serverwijziging en een nieuw veld in `docs/contracts.md`.
- **Aanpak:** CSS-herontwerp van `#start-nav` (gevaarstreep-logo, actief item rood met wit lampje); de More-lijst houdt het bestaande toetsenbordgedrag. Logo uit 0.2.
- **Let op:** items worden dynamisch getoond of verborgen (online, campagne, records); de balk moet met elke combinatie goed staan, ook in de telefoonrijen.

## 4. Skirmish-setup (startscherm met map)

- **Nu:** `#skirmish`, `game/js/lobby.js` (class `Lobby`, `build()`, `buildMapPanel()`, `buildPlayersPanel()`, `buildOptionsPanel()`, `buildBar()`), `lobby-state.js`, `spawnpick.js`, `mappreview.js` (+ worker), `lobby-bulk.js`, `lobby-bulkbar.js`, `modepicker.js`, `modes.js`; `css/lobby.css`, `css/spawns.css`.
- **Data die er is:** alles uit het ontwerp bestaat als data:
  - Startmarkers A, B, ... (`spawnMarkers()`, klikbaar via `SpawnMarkers`).
  - Mapstijl (`MAP_STYLES`), seed (`state.seed`, `randomSeed()`), map laden (1 MiB, `.webra-map.json` of `.oramap`).
  - Slots (`SLOT_TYPES`, `BOT_TYPES`, `FACTION_GROUPS`, `TEAMS`, `HANDICAPS`, kleur `--slot-color`).
  - Bulk: `teams:ffa`, `teams:humans-vs-ai`, `teams:split:n`, `teams:alternate:n`, `colors:shuffle`.
  - Opties: `LOBBY_SELECT_OPTIONS` (gameSpeed, startingCash `[2500, 5000, 7500, 10000, 20000]`), `LOBBY_TOGGLE_OPTIONS` (fog, explored, crates, shortGame, bounty, oreRegrowth, ...), spelmodus via `ModePicker`.
- **Ontbreekt:**
  - YOU-label in de eigen rij (bestaat alleen in `online.js`): klein, client.
  - Teampresets als segmented (FFA, 2v2, Humans v AI): de acties bestaan in de bulkbalk; "2v2" is `teams:split:2`. Een snelkeuze bovenaan de spelerslijst die dezelfde bulkacties aanroept.
  - Startgeld als stepper en spelsnelheid als segmented: nieuwe controls (0.1), zelfde data.
  - "Save setup": er is geen knop; instellingen worden automatisch bewaard (`Lobby.persist()` naar `lobby.lastOptions`). Advies: de knop weglaten of koppelen aan "Save as" van de `ModePicker` (opgeslagen modi). Beslissing nodig.
  - "Add AI" heet nu "Add player" en voegt een AI-slot toe: label aanpassen.
- **Aanpak:** de drie panelen (map, spelers, opties) als metalen kaarten naast elkaar; op smalle schermen onder elkaar (bestaat al in `lobby.css`). Selects in rijen worden `selectPlate` in compacte vorm.
- **Let op:** Enter start de game (`handleEnter`); mapbestanden vergrendelen opties (`optionLockedBy`, `slotLockedBy`): vergrendelde controls moeten zichtbaar uitgeschakeld zijn met een reden in de tooltip.

## 5. Multiplayer: serverlijst

- **Nu:** `game/js/online.js` `showBrowser()`, `renderSessions()`, `refresh()` (elke 10 s); `#online-root`; `css/online.css`.
- **Data die er is:** `GET /api/sessions` (`id, name, host, players, maxPlayers, locked, map{...}, version, state`); bron `apps/server/src/directory.js listSessions()` (D1-tabel `sessions`, heartbeat 60 s, TTL 2 min, max 100). MODDED en wachtwoordbadge bestaan. Watch en Join per rij bestaan (Join uit bij andere versie). Join by ID en Host game bestaan.
- **Ontbreekt:**
  - **Lopende games ("In progress", IN GAME):** de server filtert op `state = 'lobby' AND players < max_players`. Voor "In progress" en "Hide full" moet die filter weg (of een queryparameter), met `state` in het antwoord. Serverwijziging + contracts.md.
  - **Friends:** besloten: bouwen, zie 30. De filter "Friends" komt pas als dat er is.
  - **Ping:** er wordt niets gemeten. In de lijst is één meting per browser genoeg: een kleine `fetch` naar `/api/version` geeft de RTT tot de Worker. Lockstep loopt via de Durable Object, dus de RTT naar de server is de juiste maat. De echte meting per speler zit in de lobby en de game, zie 29.
  - **Detailpaneel** (spelers met teamkleur, optiechips, toeschouwers): de lijst heeft die velden niet. `upsertSession` in de Durable Object moet een samenvatting meesturen (spelersnamen, team, kleur, een paar opties, aantal toeschouwers). Let op privacy: alleen wat in een publieke lobby al zichtbaar is.
  - **Spelmodus-kolom:** niet in de lijst; meesturen als modusnaam.
  - **Zoeken:** client-side filter op de lijst, geen serverwerk.
  - **Online-teller:** zie 3.
- **Aanpak:** eerst client-only (zoeken, opmaak, detailpaneel met wat er is), daarna een serverronde voor `state`, samenvatting en teller in één protocolversie.
- **Let op:** limiet 100 sessies; detailvelden houden de rij klein (de D1-rij wordt elke 60 s geschreven).

## 6. Host game

- **Nu:** `hostDialog()` in `online.js`: naam (max 40), switch "List in the server browser", wachtwoordveld, select max spelers 2 tot 8, Cancel en Create.
- **Data die er is:** `POST /api/sessions` met `name, password, public, maxPlayers, version` (`validateCreateSession`); limiet per uur; account verplicht.
- **Ontbreekt:**
  - Toeschouwersplaatsen en mapkeuze in de dialoog: bestaan alleen in de lobby (`renderSpectators`, `renderMap` met "My maps"). Kunnen in de dialoog als die waarden na het aanmaken als eerste lobbybericht worden gezet, zonder protocolwijziging.
  - Wachtwoord als switch + veld: alleen UI.
- **Aanpak:** de dialoog volgens het canvas (segmented Public/Private, stappers). Na `create` direct `spectators` en eventueel `map` sturen.
- **Let op:** de map wordt pas bij uploaden gedeeld (`POST /api/sessions/:id/map`, 1 MiB, niet openbaar).

## 7. Online lobby

- **Nu:** `buildLobby()`, `renderLobby()`, `renderSlots()`, `renderSpectators()`, `renderMap()`, `renderOptions()` in `online.js`; chat in de lobby is een eigen invoerveld met `chatLine(..., system)`.
- **Data die er is:** naam, publiek of privé, slots met kleur, HOST/YOU, factie, team, handicap, start; Ready/Not ready; toeschouwers; map en opties (alleen host bewerkt); custom-map-aanbod (`mapstate`); reconnect (`webra.rejoin.v1`, 2 min); statusregel "Waiting for N players to be ready".
- **Ontbreekt:**
  - Uitnodigingscode: er is alleen een link met de sessie-id van 64 tekens. Besloten: korte codes bouwen, zie 31.
  - PASSWORD-badge: de lobbyberichten zeggen niet of er een wachtwoord is. Een vlag toevoegen aan `welcome`/`lobby` (klein, protocol).
  - Ping per speler: besloten, zie 29 (kolom Connection, waarschuwingsbalk, startcheck).
  - "I'm ready" als switch: alleen UI (nu een knop).
  - "Waiting for <naam>": de namen staan in de slots; de tekst client-side samenstellen.
- **Aanpak:** drie kolommen (spelers, map en opties, chat) die op smal scherm onder elkaar vallen.
- **Let op:** alleen de host bewerkt map en opties; een speler alleen zijn eigen factie en kleur; bulkwijzigingen zijn atomair. Chatlimiet 1 regel per seconde.

## 8. Campagne

- **Nu:** `#campaign-root`, `game/js/campaign/menu.js` (`CampaignMenu`, `render`, `details`, `drawPreview`), `campaign/progress.js` (`campaignStates`, `nextMission`, `CampaignProgress`), `missions/index.json`, `css/campaign.css`.
- **Data die er is:** tabbladen uit `index.json` (`campaigns[].name`); voortgang in `extra.campaignProgress` (missie naar gewonnen moeilijkheid); missiestatus `won | open | closed`; briefing (`entry.title`, `entry.briefing`); preview uit `missionText(entry)`; moeilijkheid per missie (`entry.options`); snelheid (`GAME_SPEEDS`); "Play mission".
- **Ontbreekt:**
  - Voortgangstekst en balk ("4 / 14 won"): de telling bestaat in de tab-tooltip; tonen in het paneel.
  - Status NEXT: `nextMission()` bestaat maar `menu.js` gebruikt hem niet. Aansluiten.
  - Objectives in het menu: staan niet in `index.json` (alleen in de game, `campaign/view.js`). Opties: uit de missiedata halen bij het bouwen van `index.json` (de Lua-scripts zetten ze pas tijdens het spel), of het blok weglaten. Advies: weglaten tot de data er statisch is.
  - Filmstatus in het menu: de check zit in `campaign/view.js` en `content/movies.js`; die functie in het menu aanroepen voor "Original movie not installed".
- **Aanpak:** links tabbladen en missielijst, rechts de briefing met de segmented moeilijkheid en snelheid.
- **Let op:** "Closed" wordt "Locked" in de UI; de openingsregel van hoofdstukken (`campaignStates`) blijft ongewijzigd.

## 9. Laadscherm (na Start game)

- **Nu:** er is **geen** laadscherm. `Lobby.start()` gaat via `main.js startSkirmish()` naar `launch()` (r. ~994: `content.load()`, `newSimHost()`, `host.start(spec)`) en daarna `start()` (r. ~1289: `#menu` verbergen, `#app` tonen, `rules_json` lezen, `buildGameAtlas`, `buildTerrainAtlas`, textures uploaden). Elke stap zit al in `perfTrace.span` / `spanAsync` (`content.load`, `sim.host`, `sim.start`, `rules.parse`, `atlas.sprites`, `terrain.tiles`, `atlas.terrain`). Alleen saves (records.js `ProgressOverlay`) en online inhalen tonen voortgang.
- **Data die er is:** mapnaam (`renderCaption()`, `mapFile.info.name`), modusnaam (`ModePicker`), spelers met factie, team, kleur, AI en moeilijkheid (`options.players`, `FACTIONS`, vlag-CSS `.lobby-flag`).
- **Ontbreekt:**
  - Het scherm zelf.
  - Fase-informatie voor de gebruiker: de fases bestaan alleen als perfTrace-namen.
  - Laadprocent per speler online: wordt niet verstuurd. Vraagt een `loading`-bericht in het protocol (client stuurt percentage, server verspreidt). Eerst alleen de eigen voortgang en "Waiting for players".
  - Tips: er is geen lijst (alleen losse hints in `hints.js`, `hudtips.js`). De lijst uit het canvasbord "Tips voor het laadscherm" wordt `game/js/tips.js`.
- **Aanpak:** een `LoadingScreen`-module die in `launch()` vóór `content.load()` verschijnt en verdwijnt na de eerste frame. `launch()` en `start()` roepen `loading.stage(name, fraction)` aan op de bestaande span-punten (dezelfde plaatsen als `perfTrace`). Missies gaan ook via `launch()` (`startMission`). Animaties volgens het canvas (entree, strepen, tipwissel) in CSS, uit bij reduce motion (`lobby.reducedMotion` / `game.reduceMotion`).
- **Let op:** een snelle start mag het scherm niet laten flitsen: pas tonen als laden langer dan ~300 ms duurt, of altijd minimaal de entree afspelen. Beslissing nodig.

## 10. In-game HUD: sidebar

- **Nu:** `<aside id="sidebar">`, `game/js/sidebar.js` (`build()` eenmaal, `update(state)` ~10x per seconde), `css/sidebar.css`. Data uit `Game.player_json(player)`: `cash, resources, storage, powerGenerated, powerUsed, lowPower, queues, buildable[...], powers[...], tick, timeLimit, gameOver`.
- **Bovenste rij:** Beacon, Sell, Power down, Repair (modus-knoppen, sneltoetsen B, Z, X, C), Deploy (`setDeployState`), menu-tandwiel (`sb-tool-end`, Esc). **Fullscreen ontbreekt** in de sidebar; `fullscreen.js` heeft `fullscreenAvailable()` en `toggleFullscreen()`. Toevoegen als knop, uitgeschakeld met uitleg als het niet kan.
- **Radar:** `minimap.js` met `RADAR {NONE, ONLINE, JAMMED, LOW_POWER}` uit `Game.radar_state`, statische ruis, cameraframe, pings (`radarpings.js`). Alles bestaat; alleen opmaak.
- **Credits en klok:** `cashcounter.js` (telanimatie), `gametimer.js` ("Paused" knippert), silo-balk. Bestaat; in één rode strook zetten. De tijdlimiet staat in `battlefx.js` boven het slagveld; zo laten.
- **Stroombalk:** verticaal, links van de tabkolom, vulling = gebruikt, markering = opgewekt, `.tight` en `.low`. Bestaat.
- **Productietabs en tegels:** verticale tabkolom met "!" bij klaar, raster van 3 kolommen, overlays Ready, On hold, xN, klok-wipe, uitgeschakeld met "Needs ...", sneltoetslabels F1 tot F12 (`slotKey`, `Production01..12`). Bestaat; alleen opmaak volgens de screenshot-indeling.
- **Selectiepaneel:** naam, HP-balk, detailregel; leeg "No selection", meerdere "N units selected". **Ontbreekt:** cameo van het geselecteerde type, nummer van de controlegroep (alleen op de kaart via `Game.set_control_groups`), een lijst per type bij meervoudige selectie. Data: types en aantallen uit de selectie (input.js), cameo via `cameo.js`; groepsnummer bijhouden in `controlgroups.js`.
- **Let op:** breedte `264 * --ui-px`; telefoon portrait is de sidebar een la onderaan (42% hoogte, grid-areas in `touch.css`), landscape een la rechts van 196 px. De nieuwe indeling moet in beide la-varianten werken.

## 11. In-game HUD: commandobalk, timers, chat

- **Commandobalk:** `game/js/commandbar.js` (`#commandbar` in `#field`), 8 opdrachten + 4 houdingen, `barState()` uit `Game.command_state`. Tooltip `commandTip()`: titel, toets in geel, uitleg, grijze hint "Select units that can do this." Bestaat volledig; opmaak volgens de screenshot (twee groepen met rode bovenrand). Op touch staat de touchbalk eronder (`touch.js TOUCH_BAR`), `--cb-bottom` houdt ruimte.
- **Superwapentimers:** `powertimers.js` uit `Game.power_timers_json(viewer)`; zichtbaarheid bepaalt de engine (`powers.rs`). Eigen steunwapens in `powers.js` (`PowerBar`). Bestaat; opmaak.
- **Chat en meldingen:** `chatlog.js` (`TextLog`, 8 regels, 10 s), `chatpanel.js`, `notifications.js` (3 regels). Teamchat Enter, algemeen Shift+Enter. Bestaat.
- **Weerbadge:** `#weather` in `#hud-stack`, `weather-fx.js weatherInfo()`. Bestaat.
- **Wereldtooltip:** `worldtooltip.js` met `Game.world_tooltip`: naam, vlag, eigenaar in eigen kleur, extra's, verkoopwaarde. Bestaat; alleen CSS.
- **Let op:** de commandobalk stopt mousedown-propagatie (mouse capture); tooltips nooit onder de pointer.

## 12. Esc-gamemenu

- **Nu:** `game/js/gamemenu.js` (`GameMenu`, `renderMain`, `renderSettings`, `renderControls`, `renderMusic`, `renderInfo`), `gameinfo.js` (tabbladen Objectives, Briefing, Options), opties in `main.js` r. ~1935.
- **Data die er is:** alle knoppen uit het ontwerp bestaan behalve Guide: Resume, Game info, Settings, Controls and hotkeys, Music, Original content, Fullscreen, Release notes, Save (online: voorstellen en accepteren), Download replay, Restart, Statistics (als je toekijkt of na het einde), Surrender (met bevestiging), Leave, Exit. Game info uit `Game.observer_stats`, briefing uit `Game.mission_preview`.
- **Ontbreekt:**
  - Guide (zie 15).
  - Tab Network (zie 29).
  - Weerregel in het menu: data via `weatherInfo()` bestaat.
  - AI-label en moeilijkheid in de spelerslijst: botlabels staan in `online.js` (r. ~130); naar een gedeelde module verplaatsen en in `gameinfo.js` gebruiken.
  - PLAYING/DEFEATED: nu " (Won)" / " (Lost)"; uit `observer_stats` de status lezen.
- **Aanpak:** knoppenlijst links, Game info rechts; telefoon onder elkaar.
- **Let op:** singleplayer pauzeert, online niet (regel blijft); het menu vangt toetsen in de capture-fase; focus naar de primaire knop.

## 13. Opties (Settings)

- **Nu:** één scrollende pagina in `gamemenu.js renderSettings` (Display, Scrolling and units, Chat and notifications, Mouse capture, Audio, Performance, Privacy). Graphics en packs in `content/panel.js`; geluid in `audio/panel.js`.
- **Data die er is:** `game.uiScale, gameScale, zoomFactor, pixelRatioCap, lowQuality, reduceMotion (auto/on/off), targetLines, healthBars, playerStanceColors, edgeScrollSpeed, keyScrollSpeed, ...`, `privacy.errorReports, privacy.cloudReplays`, `game.graphics`, `content.packs`. Sync-status in `account/ui.js` (`SYNC_TEXT`).
- **Ontbreekt:**
  - Navigatie per sectie (Game, Graphics, Controls, Hotkeys, Sound, Privacy, Advanced): nu losse dialogen. Advies: één instellingenscherm met tabbladen dat de bestaande renderfuncties hergebruikt (`renderControls`, `mountAudioSettings`, de pack-lijst uit `content/panel.js`).
  - Zoom-schuif: `zoomFactor` heeft geen rij; toevoegen.
  - "Synced to your account": tekst uit `SYNC_TEXT` tonen.
  - Texture-pack-kaarten (0.3).
  - Reduce motion is een keuze uit drie, geen switch: in het ontwerp een segmented (Auto, On, Off).
- **Let op:** de Controls-hint zegt "Settings are saved in this browser" (r. ~829) terwijl sync bestaat: tekst corrigeren. "Defaults" reset alleen `MENU_SETTINGS`, niet privacy.

## 14. Controls en sneltoetsen

- **Nu:** `renderControls` in `gamemenu.js`, `hotkeys.js` (`formatCombo`, `comboFromEvent`, `isReservedCombo`), `openra-hotkeys.js` (`HOTKEY_GROUPS`, `OPENRA_HOTKEYS`), `gamekeys.js` (WebRA-overrides), `css/controls.css`.
- **Data die er is:** 10 groepen, `hotkeys.list()` (name, label, group, keys, defaults, readonly), "Press a key..."-stand, meldingen bij verplaatste toetsen, reset per rij, wissen, "Reset all hotkeys", muisoverzicht (`fixedControls()`), touchgebaren.
- **Ontbreekt:** reset per groep (klein), zoeken/filteren (client-side op label en toets).
- **Aanpak:** groepen links, rijen met toetskapjes rechts, zoekveld bovenaan.
- **Let op:** Esc is gereserveerd; browsersneltoetsen (`Ctrl+W/T/N/Q/Tab`, F11, F12) worden geweigerd met de bestaande tekst.

## 15. Handleiding (Guide) en tour

Volledig nieuw. Ontwerp: canvasborden "Handleiding (Esc, Guide)" en "Tour in de eerste game".

- **Data die er is (engine-events):** de engine zet geluidsevents in een buffer; `main.js` (r. ~2396) haalt ze per frame op met `take_audio_events`; `audio/director.js handleEvents` verwerkt ze (`EV`-codes r. 58 tot 108). Bruikbaar:
  - MCV uitgeklapt: `EV.TRANSFORMED` (15).
  - Gebouw geplaatst van type X: `EV.BUILDING_PLACED` (6, `a` = type).
  - Steunwapen klaar: `EV.POWER_READY` (18).
  - Bliksem: `EV.LIGHTNING_STRIKE` (48).
  - Ook: `UNIT_PRODUCED` (5), `CONSTRUCTION_READY` (10), `LEVEL_UP` (24), `CAPTURED` (33).
- **Ontbreekt (met bron):**
  - Erts geleverd: geen event; afleiden uit een stijging van `resources` in `Game.player_json` of uit `observer_stats` (harvested).
  - Weinig stroom: geen event; `lowPower` in `player_json` (director leest het al in `onPlayerState`).
  - Eerste opdracht, attack move, guard/stop/scatter, wachtrij, houding: client-side uit `input.js` en `commandbar.js` (de orders gaan daar langs).
  - Onweer begonnen: `Game.weather_json` per frame (`weather === 'thunderstorm'`).
  - Teamchat verstuurd: `chatpanel.js`.
- **Aanpak:**
  1. `game/js/guide/steps.js`: hoofdstukken, stappen, teksten en per stap een trigger (`{ kind: 'event', ev: EV.BUILDING_PLACED, type: 'powr' }`, `{ kind: 'state', test: (s) => s.lowPower }`, `{ kind: 'ui', name: 'attackMove' }`, `{ kind: 'read' }`).
  2. `game/js/guide/tracker.js`: luistert naar de events uit de director (een tweede afnemer naast audio; de buffer wordt nu al leeggehaald, dus haken in `handleEvents` of de events vóór de audio doorgeven) en naar de staat per frame; vinkt stappen af.
  3. `game/js/guide/view.js`: het Guide-paneel in het Esc-menu (hoofdstukken, stappen, "Watching: ...", overslaan).
  4. `game/js/guide/tour.js`: de tourkaart boven de commandobalk, markering op de juiste cameo (klasse op de sidebar-tegel), melding "Step done".
  5. Opslag: gedeclareerde registry-sleutels (0.4), bijvoorbeeld groep `guide` met `done` (lijst van stap-id's, klein) en `tour` (`auto | on | off`), plus validatie in `protocol/accounts.js`.
- **Let op:**
  - Events werken alleen als audio-events aanstaan (`game.set_audio_events(true)`, `main.js` r. ~1326) en de buffer (2048) wordt per frame geleegd; een verborgen tab verliest events. Voor stappen die op state kunnen (gebouw bestaat, stroom) liever de state controleren dan het event.
  - Online en replays: de tour alleen voor de lokale speler, nooit voor toeschouwers of replays.
  - De tour start vanzelf in de eerste games en stopt na hoofdstuk 1; uit te zetten in de Guide.
  - Teksten zijn Engels in de game; de feiten (bliksem halveert, voorkeur voor power plants, 15 s stroomuitval, Lightning Rod 6 cellen) komen uit de README en moeten bij een regelwijziging mee.

## 16. Geluid en muziekspeler

- **Nu:** `audio/panel.js` (`mountAudioPanel`, `mountAudioSettings`, `VOLUMES`), `audio/musicplayer.js` (`mountMusicPlayer`), `audio/music.js` (`Jukebox`, `length(i)` uit de AUD-header, "--:--" tot bekend); `#audio-panel`, `#music-panel`, `css/audio.css`.
- **Data die er is:** `audio.enabled, master, effects, voices, music, speech, original, cashTicks, clickSounds, menuMusic, musicOn, musicShuffle, musicRepeat`; transport, herhalen All/One/Off, tracklijst met lengte, Test effects en Test announcer.
- **Ontbreekt:** niets functioneels.
- **Aanpak:** alleen opmaak; de twee dialogen naast elkaar of als tabbladen in Settings (13).

## 17. Debugmenu

- **Nu:** `game/js/debug.js` (`DebugMenu`, `CHEATS`, `formatStats`), `debug-views.js` (`VIEWS`), `perfcapture.js` (`CAPTURE_SECONDS` 10/30/60/120, standaard 30), `css/debug.css`.
- **Data die er is:** 6 cheats (alleen met lobbyoptie "Debug menu"), Give $20,000, Destroy selected, Give experience, 8 weergaven, opname met Alt+P, statistieken (FPS, frame, render, sim per tick, units, structures, ...), Pause en Step.
- **Ontbreekt:** niets. Let op dat het canvas "$ 5.000" en "Kill selected" toont: de echte labels zijn "Give $20,000" en "Destroy selected".
- **Aanpak:** paneel rechts met gele gevaarstreep; weergaven als switches; framegrafiek als overlay.

## 18. Replay bekijken

- **Nu:** `records.js` (replaybalk r. ~347: `.replay-bar`, `replay-play`, `replay-speed`, `replay-seek`, `replay-time`), `replay.js` (`REPLAY_SPEEDS = [0.5, 1, 2, 4, 8]`, keyframes), `observer.js` (weergaven, statistieken per team, `teamGroups`), `css/records.css`.
- **Data die er is:** weergaven All players, No shroud, per speler; snelheden; zoekbalk (stap 25 ticks); tijd; observerpanelen per team.
- **Ontbreekt:**
  - Markeringen op de zoekbalk: geen opgeslagen gebeurtenissen. Kan uit `Game.observer_report().history` (elke 5 s) of door events (doden, verslagen spelers) tijdens het afspelen op te slaan. Advies: na het eerste volledige afspelen tonen, of uit de history afleiden.
  - Download en Exit op de balk: bestaan alleen in het menu; knoppen toevoegen die dezelfde acties aanroepen.
- **Aanpak:** bovenaan weergavekiezer, rechts statistieken, onderaan de transportbalk.

## 19. Victory en defeat

- **Nu:** `game/js/endgame.js` (`EndGameDialog`, `dialogContent`, `#gameover`), `css/endgame.css`; teksten "Mission accomplished", "Mission failed", "Game over"; rematch (online) "Rematch" / "Accept rematch" / "Rematch proposed"; toast "Replay saved to your account." (`main.js` r. ~400).
- **Data die er is:** `Game.observer_report()` (Basic: Score, Status, Cash, Power, Kills, Deaths, Assets destroyed/lost, Experience, APM; Economy; Combat; Army; Support powers; Production; grafieken). Rematch: S2C `rematch {state, by, accepted, waiting, msLeft}` (`protocol messages.js`, `room.js rematchStatus`).
- **Ontbreekt:**
  - Resultaten per team in de dialoog: groepering bestaat alleen in de observer en Game info; `teamGroups` hergebruiken.
  - "Kara proposed it · 2 of 3 accepted" en lampjes per speler: de arrays bestaan; tekst en lampjes client-side.
  - Replay-melding in de dialoog in plaats van (of naast) de toast.
- **Aanpak:** de animaties uit het canvas (flits, schokgolf, stralen bij victory; trillen, scanlijnen, glitch bij defeat; rijen schuiven in, cijfers tellen op) in CSS; tellen via `requestAnimationFrame`. Alles uit bij reduce motion.
- **Let op:** alleen de host stelt een rematch voor; toeschouwers stemmen niet; stemmen duurt 2 minuten.

## 20. Statistieken

- **Nu:** `game/js/stats.js` (`STATS_TABS`, `GRAPHS`, `StatsScreen`), `observer.js` (`PANELS`), data uit `Game.observer_report()`; grafiek-id's `earned`, `income`, `army`; tabellen achter elke grafiek (toegankelijk, max 120 rijen).
- **Data die er is:** alle acht panelen uit het ontwerp.
- **Ontbreekt:** teamkoppen in de Basic-tabel; de markering "AI defeated" in de grafiek (afleiden uit de status in de history); tab Network voor online games (zie 29).
- **Aanpak:** panelen links, grafiek en tabel rechts.

## 21. Load game

- **Nu:** `records.js loadDialog()`, `saves.js SaveStore` (IndexedDB `webra`, store `saves`; rij: `title, createdAt, ticks, engine, mode, online, data`), laden via `main.js loadSave()` met voortgang "Loading the saved game... N%".
- **Ontbreekt:**
  - Thumbnail, mapnaam en spelers in de rij: niet opgeslagen. `SaveStore.add` uitbreiden met `map` (naam) en `players` (naam, kleur, team, AI) uit de replay-header, en een kleine thumbnail (PNG data-URL van de mappreview, max ~8 KB). Oude saves tonen zonder.
  - Tabbladen: "From file" is nu een knop; "Online saves" zijn uitgeschakelde rijen met een notitie. Tabbladen maken met dezelfde data.
  - Detailpaneel: met de nieuwe velden.
- **Let op:** saves van een andere engineversie geven de bestaande waarschuwing "Made with WebRA <versie>"; online saves hervat je via Play online.

## 22. Replays-lijst (account en game)

- **Nu:** `records.js replaysDialog`, `account/replays.js replayLine` (datum, duur, modus, map, spelers, resultaat, grootte, dagen over), Watch, Download, Delete, "Open a file".
- **Aanpak:** zelfde rijopmaak als Load game (21), zodat beide schermen één component delen.

## 23. Map editor

- **Nu:** `apps/game/editor/` (`index.html`, `editor.js`, `js/commands.js`, `js/symmetry.js`, `js/panels.js`). Echte namen:
  - Topbalk: commando's File (New map, Open, Download the map file, Export PNG, Test play, Publish) en Edit (Undo, Redo, Copy, Cut, Paste, Delete, ...), MODDED-badge, `#save-state` ("Draft saved in this browser" e.d.), Publish, Test play.
  - Gereedschap: Select (V), Region (M), Brush (B), Line (L), Rectangle (R), Ellipse (U), Fill (F), Eraser (E), Pick (I), Spawns (S), Actor (A), Paste; verflaag Terrain/Ore/Gems.
  - Symmetrie (Y wisselt): None, Mirror left/right, Mirror top/bottom, Rotate 2, Mirror 4, Rotate 4, Mirror diagonal, Mirror other diagonal, Mirror 8.
  - Tabbladen: Map (met terrein), Actors, Setup, Layers, Check, Rules, History, Stamps, Online.
  - Terreinpalet: Clear, Rough, Rock, Water, Tree, Ford, Road, Beach, River, Wall (+ kustoptie).
  - Lagen: Grid, Actors, Spawns, Ore and gems, Passability, Buildable ground, Spawn zones, Rush paths, Unreachable ground, Fog preview.
  - Fairness (in Check): Rush, Ore, Gems, Build, Zone, plus Spread (vlag boven 1,25).
  - Statusbalk: cel, terrein, erts, zone, zoom, symmetrie (of mapgrootte en symmetrie).
- **Ontbreekt t.o.v. het canvas:** mapnaam in de topbalk (staat waarschijnlijk in Setup; naar de topbalk spiegelen), een aanpassingsmarkering, het aantal waarschuwingen in de badge (de badge telt nu fouten + fixes; waarschuwingen staan in "Valid map, N warnings"), historieteller in de statusbalk.
- **Aanpak:** het canvas versimpelde de tabbladen; de echte negen behouden en de stijl toepassen. Toolkolom met de echte twaalf gereedschappen; sneltoetsen in tooltips via de bestaande, instelbare bindingen.
- **Let op:** de editor moet licht blijven op grote maps (README: kosten per wijziging); geen zware CSS-effecten op de kaartlaag.

## 24. Originele content (installer)

- **Nu:** `game/js/content/panel.js`. Twee tabbladen als one-click mag: "One-click install" en "Other ways to install"; anders alleen de handmatige weg. Onderdelen (`PART_LABELS`): package ("Graphics, sounds, voices and announcer"), music ("Music from the freeware CDs"), movies ("Mission movies", eigen knop). Status none/partial/complete met titels "Not installed", "Partly installed", "Original content installed". Eén voortgangsbalk en een statusregel; per onderdeel een rij met Retry. Graphics- en geluidskeuze WebRA/Original; pack-beheer (Up, Down, Remove).
- **Ontbreekt t.o.v. het canvas:** het canvas had vijf tabbladen en losse onderdelen graphics en sounds. Echte structuur aanhouden: twee tabbladen, drie onderdelen. Een leeslog per archief bestaat niet (één live regel uit `install.js onProgress`); desgewenst de laatste paar regels als lijst tonen (alleen client).
- **Aanpak:** "Install everything" (canvas) = de bestaande one-click-knop met de rijen per onderdeel. De handmatige weg: zip-sleepvak, CD-images, "Choose Red Alert files...", "Choose folder...".
- **Let op:** de juridische teksten (`LEGAL_NOTICE`, `DOWNLOAD_NOTICE`) blijven letterlijk staan.

## 25. Opnieuw inloggen

- **Nu:** geen apart scherm. `account/gate.js probePlayAccess()`: `signin` (401) opent de inlogdialoog (`account/ui.js openSignIn`) met een reden; `forbidden` (403) toont alleen een toast; `offline` en `error` tonen niets. Wachten op goedkeuring, e-mail bevestigen, verbannen en inactief zijn inline statussen in het accountitem (`accountState()` in `session.js`).
- **Ontbreekt:** dialogen voor `forbidden`, `offline` en `error` (de teksten van `accountState` hergebruiken; offline met "Try again" die `probePlayAccess` opnieuw aanroept).
- **Aanpak:** één dialoog met de inlogmethoden die de site aanbiedt (`signInMethods()`: wachtwoord, passkey, Discord), "Forgot your password?" alleen als `login.email` aanstaat.
- **Let op:** wat al draait blijft draaien (gate.js); de dialoog mag de game niet blokkeren in een lopende online game.

## 26. Release notes

- **Nu:** `releasenotes.js` (`whatsNew`, `compareVersions`, `../release-notes.json` uit `CHANGELOG.md` via `build-dist.mjs`), `releasenotes-dialog.js` (8 s time-out), `#release-notes`, `css/releasenotes.css`. Statussen: laden, lijst met "This version" en "New", leeg, fout met "Try again".
- **Ontbreekt:** niets functioneels. De indeling per scope met NEW/FIXED in het canvas volgt de groepen uit `groupByScope` (Features, Bug Fixes).

## 27. Gebouwen en eenheden (art)

- 2D-gebouwen: nieuwe tekeningen in `game/js/art/buildings.js` volgens het canvas (feedbackronde). Per gebouw: footprint gelijk, teamkleur via de mask, schaduw volgens de bestaande richting. Tests: `buildings-art.test.mjs`, `art-audit.test.mjs`.
- Red Alert-stijl pixel art: variant B (canvas, "huidig naast variant B") kan als nieuwe modellen in `tools/gen_pixel_art.py`; de huidige frames blijven tot er gekozen is. Na een wijziging het script draaien en `game/js/art/pixel-data.js` controleren (CI vergelijkt).
- 3D minimal: zie 0.3.

## 28. Besluiten (15 oktober 2026)

De tien open punten zijn besproken. Dit is wat er besloten is en waar het werk staat.

1. **Fonts zelf hosten.** Barlow, Barlow Condensed en JetBrains Mono als `woff2` in de repo (subset Latin), via `font-src 'self'`. Geen Google Fonts: de CSP en COEP op `/play` laten dat niet toe.
2. **Nieuwe select overal**, ook op touch. Op telefoons opent de lijst als sheet onderaan in plaats van als dropdown.
3. **"Save setup" in skirmish:** koppelen aan de opgeslagen spelmodi (`presets.js`), geen tweede opslag.
4. **Laadscherm altijd tonen**, ook bij een snelle start. De minimale tijd is de animatie van de balk (zie 9).
5. **Serverronde nu meenemen:** lopende games, samenvatting voor het detailpaneel, online-teller en wachtwoordvlag in één protocolversie. Ping/pong (29) en uitnodigingscodes (31) gaan in dezelfde ronde, zodat de protocolversie één keer omhoog gaat.
6. **Vrienden en uitnodigingscodes houden we.** Uitwerking in 30 en 31.
7. **Ping per speler met ping/pong**, waarschuwingen in de game, een kolom in de lobby, een tab in het Esc-menu en in de statistieken. Uitwerking in 29.
8. **3D minimal wordt gebouwd**, direct en zonder uitbesteden. Generator in de game-projectie, ingebouwd pack, `game.graphics` = `webra2d | webra3d | original` (zie 0.3). Dit loopt in een eigen sessie.
9. **Campagne-objectives in het menu:** weglaten.
10. **Tourgedrag zoals voorgesteld:** de tour start vanzelf in de eerste skirmish, niet in missies, en stopt zodra alle stappen af zijn of de speler op Skip drukt. De switch "Tour in my games" in de handleiding zet hem weer aan.

## 29. Netwerkkwaliteit: ping, waarschuwingen, menu en statistieken

Canvas: "Netwerk: lobby", "Netwerk: waarschuwingen in de game", "Netwerk: Esc-menu", "Netwerk: statistieken".

- **Nu:** de server meet niets. Wel bestaat de stall-administratie in `apps/server/src/lockstep.js`: per speler `heldMs` binnen een venster en een schuld (`debtMs`, `DEBT_DRAIN` 1/20) boven `HOLD_GRACE_MS` (1 s). `session.js` `alarm()` laat via `lockstep.silent(now, DROP_AFTER_MS)` een speler vallen die het spel langer dan 10 s ophoudt (`DROP_AFTER_MS` in `packages/protocol/src/constants.js`). Die krijgt `ERRORS.DROPPED` en kan terugkomen (`REJOINABLE_REASONS`, `MAX_REJOINS` 10, sleutel `webra.rejoin.v1`, 2 min). De andere spelers zien nu alleen dat de game stilstaat.
- **Data die er is:** wie het spel ophoudt en hoe lang (lockstep-vensters), het moment van droppen, de rejoin-flow.
- **Ontbreekt, protocol:**
  - `C2S.PING { n, at }` elke 2 s, in lobby en game; de Durable Object antwoordt direct met `S2C.PONG { n, at }`. De client rekent zelf de RTT uit (alleen eigen klok, geen kloksynchronisatie).
  - De client stuurt zijn laatste meting mee in de volgende ping (`rtt`, `jitter`, `late`). De server bewaart per client een klein venster en zendt elke 2 s `S2C.NETSTAT { players: [{ client, rtt, jitter, late }] }` naar iedereen in de room. Zo ziet elke speler ook de anderen, zonder peer-to-peer.
  - **"Loss" is "late pings":** WebSocket loopt over TCP, dus berichten raken niet zichtbaar kwijt. We tellen pongs die langer dan 1 s duren of nooit komen. Dat is wat een speler als hapering voelt.
  - `S2C.WAITING { client, heldMs, dropInMs }` zodra lockstep langer dan `HOLD_GRACE_MS` op iemand wacht, en `S2C.WAITING { client: null }` als het weer loopt. `dropInMs` komt uit het venster van `silent()`. Dit voedt het wachtvenster met aftelling.
  - Stalls per game vastleggen voor de statistieken: `{ tick, client, ms }` in de room, aan het eind meesturen met het rapport of los opvragen. Het orderlog (`orderlog.js`) hoeft niet te veranderen.
- **Drempels** (gedeeld in `packages/protocol/src/constants.js`, zodat lobby, game en stats hetzelfde zeggen): goed onder 80 ms, jitter tot 20 ms en geen late pings; matig 80 tot 150 ms of jitter boven 20 ms; slecht boven 150 ms of meer dan 2% late pings. Mediaan over de laatste 10 metingen, zodat één uitschieter geen balk laat springen.
- **Aanpak per plek:**
  - **Lobby** (`online.js` `renderSlots`): kolom Connection met vier balkjes, ms en de detailregel; je eigen status rechtsboven; een waarschuwingsbalk als iemand rood staat, met "Test again" (forceert drie pings) en voor de host "Kick". Start game toont dezelfde waarschuwing in de startcheck, maar blokkeert niet.
  - **In de game:** signaalbalkjes naast de klok in de sidebar (`hud`-module), met tooltip (ping, jitter, late) en klik naar de tab Network. Een eigen waarschuwing bovenaan als je eigen verbinding 10 s slecht is (wegklikbaar, komt pas na herstel en opnieuw slecht terug). Bij `S2C.WAITING` een chatregel en na 2 s het venster "Waiting for X" met aftelling tot de drop; spelers met status per regel.
  - **Esc-menu** (`gamemenu.js`): knop en tab Network: tegels (ping, jitter, late, traagste speler), grafiek van de laatste minuut met stall-markeringen, tabel per speler, wachttijd van deze game en drie switches.
  - **Statistieken** (`stats.js`): tab Network, alleen bij online games: tegels, ping over de hele game per speler met rode kolommen voor stalls, tabel per speler (gemiddeld, slechtst, jitter, late, opgehouden) en een stall-lijst die de replay op dat moment opent. Het verloop komt uit een client-side buffer (één punt per 10 s per speler, 24 min is ~150 punten per speler), niet uit de server.
- **Instellingen:** drie nieuwe gedeclareerde sleutels in `GROUPS` (`game/js/registry.js`) met validatie in `protocol/accounts.js`: `net.warnSelf`, `net.warnOthers`, `net.signalBars` (alle standaard aan). Zie 0.4.
- **Let op:**
  - Pings tellen mee voor de relay-quota (`relayquota.js`): een ping per 2 s is klein, maar moet uitgezonderd of in de limiet verwerkt worden.
  - Durable Objects slapen met hibernation; pings houden de room wakker zolang er spelers zijn. Dat is al zo tijdens een game, in de lobby kost het iets meer.
  - Toeschouwers krijgen `NETSTAT` ook, maar worden zelf niet getoond.
  - Singleplayer en skirmish tonen niets van dit alles.

## 30. Vrienden

Canvas: "Vrienden". Ook in de serverlijst (filter Friends) en de uitnodigingen (31).

- **Nu:** bestaat niet. Wel: accounts met unieke `username` (`username_key` is uniek, NFKC, kleine letters), `avatar_color`, `last_seen_at`, en `game_presence` (sessie, client, gebruiker, tijd). Er is dus geen tag als `Naam#1234` nodig: de gebruikersnaam is al uniek.
- **Data die er is:** wie online is (`last_seen_at` recent), wie in welke sessie zit (`game_presence` met de sessielijst in `sessions`), naam en kleur.
- **Ontbreekt:**
  - Migratie `0009_friends.sql`: `friendships (user_a, user_b, created_at)` met `user_a < user_b` en een unieke sleutel; `friend_requests (from_user, to_user, created_at)`; `user_blocks (user_id, blocked_id, created_at)`.
  - Endpoints onder `/api/account/friends` (in `routes-account.js`): lijst met status, verzoek sturen op gebruikersnaam, accepteren, negeren, verwijderen, blokkeren, deblokkeren. Rate limit op verzoeken via `ratelimit.js`.
  - Status per vriend: offline, online (main menu), weg (geen invoer 10 min, de client meldt dat), in lobby (naam, aantal spelers), in game (modus, map, speeltijd). Lobby en game komen uit `game_presence` + `sessions`; "weg" vraagt een kleine heartbeat-uitbreiding.
  - Acties: Join (lobby met plek, of met een uitnodiging), Spectate (alleen als de host toeschouwers toestaat en de vriend dat ook doet), Invite (zie 31).
  - Privacy-instellingen (gedeclareerde sleutels, zie 0.4): `social.showOnline`, `social.friendsJoin`, `social.allowSpectate`. Deze moeten ook op de server gelden, dus ze gaan mee in de account-instellingen die de server leest.
  - Live bijwerken: pollen elke 30 s in het menu is genoeg; geen eigen WebSocket.
- **Aanpak:** eerst de tabellen en endpoints met tests (`apps/server/tests`), dan het scherm (website-account en in de game vanuit het startscherm), dan Join en Spectate.
- **Let op:** blokkeren werkt overal: geen verzoeken, geen uitnodigingen, niet in dezelfde lobby via Join. Account verwijderen ruimt de rijen op (de bestaande opschoning in `accounts/cron.js` uitbreiden). Alleen ingelogde spelers hebben vrienden.

## 31. Uitnodigingscodes

Canvas: "Uitnodigingscodes" (venster Join with a code en het paneel Invite players in de lobby).

- **Nu:** alleen een link met de sessie-id van 64 tekens en "Join by ID" in de serverlijst.
- **Ontbreekt:**
  - Een code van zes tekens (`K7Q-2MX`) uit een alfabet zonder verwarrende tekens (geen 0/O, 1/I/L). 31^6 is ruim 887 miljoen codes; botsingen controleren bij uitgeven.
  - Opslag: kolommen `invite_code` en `invite_expires` op `sessions` (`0001_init.sql`) met een unieke index, of een eigen tabel. Verloop: zolang de lobby open is, maximaal 2 uur. "New code" vervangt de oude direct.
  - Endpoints: `POST /api/sessions/:id/invite` (alleen de host, geeft code en verloop), `GET /api/invite/:code` (geeft sessie-id, naam, host, map, bezetting; 404 als onbekend, 410 als verlopen). Rate limit op opzoeken om raden te remmen.
  - Route `/join/:code` op de website die de game opent met de code, en plakken van een volledige link in het venster.
  - Uitnodiging aan een vriend: een melding in diens vriendenlijst ("Kara invites you to Friday night 2v2") met dezelfde code. Een privélobby is dan alleen met code of uitnodiging te vinden.
  - Foutmeldingen zoals in het canvas: onbekend, verlopen, vol (dan als toeschouwer).
- **Let op:** een code met wachtwoordlobby slaat het wachtwoord niet over; de code is alleen een korte naam voor de sessie. De lange link blijft werken.
