//! OpenRA's Lua API for missions: the globals (`Actor`, `Trigger`, `Map`,
//! `Media`, `Utils`, ...), the coordinate types and the `Host` the
//! interpreter calls for them. Actor and player members are in
//! actor_api.rs and player_api.rs; the per-tick work in runtime.rs.

use super::fluent;
use super::setup::{facing_out, NEUTRAL};
use super::*;
use crate::lua::{lstr, BinOp, Host, Lua, LuaError, UserData, Value};
use crate::math::{facing_of, CELL};

pub(crate) struct Ctx<'a> {
    pub w: &'a mut World,
    pub m: &'a mut Mission,
}

pub(crate) type R<T> = Result<T, LuaError>;

pub(crate) fn err<T>(msg: impl Into<String>) -> R<T> {
    Err(LuaError::runtime(msg))
}

// ---- Script values ---------------------------------------------------------------

pub(crate) fn actor_value(h: u32) -> Value {
    Value::UserData(UserData::new(UD_ACTOR, h as i32, 0, 0))
}

pub(crate) fn player_value(p: u8) -> Value {
    Value::UserData(UserData::new(UD_PLAYER, p as i32, 0, 0))
}

/// The largest cell coordinate a script value holds (CPos, CVec): far beyond
/// any map, and small enough that `cell * CELL` and sums of two stay in i32.
pub(crate) const MAX_SCRIPT_CELL: i32 = 1 << 20;
/// The largest world coordinate or distance a script value holds (WPos, WVec,
/// WDist), likewise.
pub(crate) const MAX_SCRIPT_WORLD: i32 = 1 << 29;

const fn cells(v: i32) -> i32 {
    if v > MAX_SCRIPT_CELL {
        MAX_SCRIPT_CELL
    } else if v < -MAX_SCRIPT_CELL {
        -MAX_SCRIPT_CELL
    } else {
        v
    }
}

const fn world(v: i32) -> i32 {
    if v > MAX_SCRIPT_WORLD {
        MAX_SCRIPT_WORLD
    } else if v < -MAX_SCRIPT_WORLD {
        -MAX_SCRIPT_WORLD
    } else {
        v
    }
}

// Script positions, vectors and distances are clamped to the ranges above, so
// the engine's arithmetic on them (cell centres, map offsets, distances) never
// overflows whatever a script computes.

pub(crate) fn cpos(x: i32, y: i32) -> Value {
    Value::UserData(UserData::new(UD_CPOS, cells(x), cells(y), 0))
}

pub(crate) fn wpos(x: i32, y: i32, z: i32) -> Value {
    Value::UserData(UserData::new(UD_WPOS, world(x), world(y), world(z)))
}

pub(crate) fn cvec(x: i32, y: i32) -> Value {
    Value::UserData(UserData::new(UD_CVEC, cells(x), cells(y), 0))
}

pub(crate) fn wvec(x: i32, y: i32, z: i32) -> Value {
    Value::UserData(UserData::new(UD_WVEC, world(x), world(y), world(z)))
}

pub(crate) fn wdist(l: i32) -> Value {
    Value::UserData(UserData::new(UD_WDIST, world(l), 0, 0))
}

pub(crate) fn angle(a: i32) -> Value {
    Value::UserData(UserData::new(UD_ANGLE, a.rem_euclid(1024), 0, 0))
}

pub(crate) fn color(rgba: u32) -> Value {
    Value::UserData(UserData::new(UD_COLOR, rgba as i32, 0, 0))
}

pub(crate) fn num(n: i64) -> Value {
    Value::Num(n as f64)
}

pub(crate) fn boolean(b: bool) -> Value {
    Value::Bool(b)
}

pub(crate) fn text(s: &str) -> Value {
    Value::Str(lstr(s))
}

/// Lua number to a C# int (OpenRA converts with a truncating cast).
pub(crate) fn to_int(n: f64) -> i64 {
    if n.is_finite() {
        n.trunc().clamp(i32::MIN as f64, i32::MAX as f64) as i64
    } else {
        0
    }
}

/// OpenRA WAngle of a world vector (WVec.Yaw: north is 0, counter-clockwise).
pub(crate) fn yaw(x: i32, y: i32) -> i32 {
    facing_of(x, y).map_or(0, facing_out)
}

// ---- Globals ------------------------------------------------------------------------

/// The API globals (`UD_GLOBAL` objects).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Global {
    Actor,
    Player,
    Map,
    Trigger,
    Reinforcements,
    Media,
    Utils,
    DateTime,
    Camera,
    Beacon,
    Radar,
    UserInterface,
    CPos,
    WPos,
    CVec,
    WVec,
    WDist,
    Angle,
    HSLColor,
}

impl Global {
    pub const ALL: [Global; 19] = [
        Global::Actor,
        Global::Player,
        Global::Map,
        Global::Trigger,
        Global::Reinforcements,
        Global::Media,
        Global::Utils,
        Global::DateTime,
        Global::Camera,
        Global::Beacon,
        Global::Radar,
        Global::UserInterface,
        Global::CPos,
        Global::WPos,
        Global::CVec,
        Global::WVec,
        Global::WDist,
        Global::Angle,
        Global::HSLColor,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Global::Actor => "Actor",
            Global::Player => "Player",
            Global::Map => "Map",
            Global::Trigger => "Trigger",
            Global::Reinforcements => "Reinforcements",
            Global::Media => "Media",
            Global::Utils => "Utils",
            Global::DateTime => "DateTime",
            Global::Camera => "Camera",
            Global::Beacon => "Beacon",
            Global::Radar => "Radar",
            Global::UserInterface => "UserInterface",
            Global::CPos => "CPos",
            Global::WPos => "WPos",
            Global::CVec => "CVec",
            Global::WVec => "WVec",
            Global::WDist => "WDist",
            Global::Angle => "Angle",
            Global::HSLColor => "HSLColor",
        }
    }
}

/// Every host function: globals' methods first, then actor and player members.
macro_rules! functions {
    ($($f:ident = $name:literal,)*) => {
        #[derive(Clone, Copy, PartialEq, Eq, Debug)]
        #[allow(clippy::upper_case_acronyms)]
        pub(crate) enum F { $($f,)* }
        impl F {
            pub const ALL: &'static [F] = &[$(F::$f,)*];
            pub fn name(self) -> &'static str {
                match self { $(F::$f => $name,)* }
            }
            pub fn from_id(id: u32) -> Option<F> {
                F::ALL.get(id as usize).copied()
            }
        }
    };
}

functions! {
    FatalError = "FatalError",
    // Actor
    ActorCreate = "Actor.Create",
    ActorBuildTime = "Actor.BuildTime",
    ActorCruiseAltitude = "Actor.CruiseAltitude",
    ActorCost = "Actor.Cost",
    // Player
    PlayerGetPlayer = "Player.GetPlayer",
    PlayerGetPlayers = "Player.GetPlayers",
    // Map
    MapActorsInCircle = "Map.ActorsInCircle",
    MapActorsInBox = "Map.ActorsInBox",
    MapRandomCell = "Map.RandomCell",
    MapRandomEdgeCell = "Map.RandomEdgeCell",
    MapClosestEdgeCell = "Map.ClosestEdgeCell",
    MapClosestMatchingEdgeCell = "Map.ClosestMatchingEdgeCell",
    MapCenterOfCell = "Map.CenterOfCell",
    MapTerrainType = "Map.TerrainType",
    MapLobbyOption = "Map.LobbyOption",
    MapLobbyOptionOrDefault = "Map.LobbyOptionOrDefault",
    MapNamedActor = "Map.NamedActor",
    MapIsNamedActor = "Map.IsNamedActor",
    MapActorsWithTag = "Map.ActorsWithTag",
    // Trigger
    TriggerAfterDelay = "Trigger.AfterDelay",
    TriggerOnPassengerEntered = "Trigger.OnPassengerEntered",
    TriggerOnPassengerExited = "Trigger.OnPassengerExited",
    TriggerOnIdle = "Trigger.OnIdle",
    TriggerOnDamaged = "Trigger.OnDamaged",
    TriggerOnKilled = "Trigger.OnKilled",
    TriggerOnAllKilled = "Trigger.OnAllKilled",
    TriggerOnAnyKilled = "Trigger.OnAnyKilled",
    TriggerOnProduction = "Trigger.OnProduction",
    TriggerOnAnyProduction = "Trigger.OnAnyProduction",
    TriggerOnPlayerWon = "Trigger.OnPlayerWon",
    TriggerOnPlayerLost = "Trigger.OnPlayerLost",
    TriggerOnObjectiveAdded = "Trigger.OnObjectiveAdded",
    TriggerOnObjectiveCompleted = "Trigger.OnObjectiveCompleted",
    TriggerOnObjectiveFailed = "Trigger.OnObjectiveFailed",
    TriggerOnBuildingPlaced = "Trigger.OnBuildingPlaced",
    TriggerOnAddedToWorld = "Trigger.OnAddedToWorld",
    TriggerOnRemovedFromWorld = "Trigger.OnRemovedFromWorld",
    TriggerOnAllRemovedFromWorld = "Trigger.OnAllRemovedFromWorld",
    TriggerOnCapture = "Trigger.OnCapture",
    TriggerOnKilledOrCaptured = "Trigger.OnKilledOrCaptured",
    TriggerOnAllKilledOrCaptured = "Trigger.OnAllKilledOrCaptured",
    TriggerOnEnteredFootprint = "Trigger.OnEnteredFootprint",
    TriggerOnExitedFootprint = "Trigger.OnExitedFootprint",
    TriggerRemoveFootprintTrigger = "Trigger.RemoveFootprintTrigger",
    TriggerOnEnteredProximityTrigger = "Trigger.OnEnteredProximityTrigger",
    TriggerOnExitedProximityTrigger = "Trigger.OnExitedProximityTrigger",
    TriggerRemoveProximityTrigger = "Trigger.RemoveProximityTrigger",
    TriggerOnInfiltrated = "Trigger.OnInfiltrated",
    TriggerOnDiscovered = "Trigger.OnDiscovered",
    TriggerOnPlayerDiscovered = "Trigger.OnPlayerDiscovered",
    TriggerOnSold = "Trigger.OnSold",
    TriggerOnSupportPowerActivated = "Trigger.OnSupportPowerActivated",
    TriggerOnTimerExpired = "Trigger.OnTimerExpired",
    TriggerClearAll = "Trigger.ClearAll",
    TriggerClear = "Trigger.Clear",
    // Reinforcements
    ReinforcementsReinforce = "Reinforcements.Reinforce",
    ReinforcementsReinforceWithTransport = "Reinforcements.ReinforceWithTransport",
    // Media
    MediaPlaySpeechNotification = "Media.PlaySpeechNotification",
    MediaPlaySoundNotification = "Media.PlaySoundNotification",
    MediaPlaySound = "Media.PlaySound",
    MediaPlayMusic = "Media.PlayMusic",
    MediaSetBackgroundMusic = "Media.SetBackgroundMusic",
    MediaStopMusic = "Media.StopMusic",
    MediaPlayMovieFullscreen = "Media.PlayMovieFullscreen",
    MediaPlayMovieInRadar = "Media.PlayMovieInRadar",
    MediaDisplayMessage = "Media.DisplayMessage",
    MediaDisplayMessageToPlayer = "Media.DisplayMessageToPlayer",
    MediaDisplaySystemMessage = "Media.DisplaySystemMessage",
    MediaDebug = "Media.Debug",
    MediaFloatingText = "Media.FloatingText",
    // Utils
    UtilsDo = "Utils.Do",
    UtilsAny = "Utils.Any",
    UtilsAll = "Utils.All",
    UtilsWhere = "Utils.Where",
    UtilsTake = "Utils.Take",
    UtilsSkip = "Utils.Skip",
    UtilsConcat = "Utils.Concat",
    UtilsRandom = "Utils.Random",
    UtilsShuffle = "Utils.Shuffle",
    UtilsExpandFootprint = "Utils.ExpandFootprint",
    UtilsRandomInteger = "Utils.RandomInteger",
    UtilsFormatTime = "Utils.FormatTime",
    // DateTime
    DateTimeSeconds = "DateTime.Seconds",
    DateTimeMinutes = "DateTime.Minutes",
    // Beacon, Radar, UserInterface
    BeaconNew = "Beacon.New",
    RadarPing = "Radar.Ping",
    UserInterfaceSetMissionText = "UserInterface.SetMissionText",
    UserInterfaceGetFluentMessage = "UserInterface.GetFluentMessage",
    // Coordinates and colors
    CPosNew = "CPos.New",
    CPosNewWithLayer = "CPos.NewWithLayer",
    WPosNew = "WPos.New",
    CVecNew = "CVec.New",
    WVecNew = "WVec.New",
    WDistNew = "WDist.New",
    WDistFromCells = "WDist.FromCells",
    AngleNew = "Angle.New",
    HSLColorNew = "HSLColor.New",
    HSLColorFromRGB = "HSLColor.FromRGB",
    HSLColorFromHex = "HSLColor.FromHex",
    // Actor members (actor_api.rs)
    AHasProperty = "HasProperty",
    AFlash = "Flash",
    ATeleport = "Teleport",
    ACallFunc = "CallFunc",
    AWait = "Wait",
    ADestroy = "Destroy",
    AStop = "Stop",
    AAddTag = "AddTag",
    ARemoveTag = "RemoveTag",
    AHasTag = "HasTag",
    AHunt = "Hunt",
    AAttackMove = "AttackMove",
    APatrol = "Patrol",
    APatrolUntil = "PatrolUntil",
    AAttack = "Attack",
    ACanTarget = "CanTarget",
    AMove = "Move",
    AScriptedMove = "ScriptedMove",
    AMoveIntoWorld = "MoveIntoWorld",
    AScatter = "Scatter",
    AEnterTransport = "EnterTransport",
    AKill = "Kill",
    ALoadPassenger = "LoadPassenger",
    AUnloadPassenger = "UnloadPassenger",
    AUnloadPassengers = "UnloadPassengers",
    AProduce = "Produce",
    ABuild = "Build",
    AIsProducing = "IsProducing",
    ACapture = "Capture",
    ACanCapture = "CanCapture",
    ADeploy = "Deploy",
    ADisguiseAs = "DisguiseAs",
    ADisguiseAsType = "DisguiseAsType",
    AInfiltrate = "Infiltrate",
    ADemolish = "Demolish",
    AInstantlyRepair = "InstantlyRepair",
    ADeliverCash = "DeliverCash",
    AGuard = "Guard",
    AReturnToBase = "ReturnToBase",
    ALand = "Land",
    AResupply = "Resupply",
    AFindResources = "FindResources",
    AParadrop = "Paradrop",
    ATargetParatroopers = "TargetParatroopers",
    ATargetAirstrike = "TargetAirstrike",
    AActivateNukePower = "ActivateNukePower",
    AChronoshift = "Chronoshift",
    AGrantCondition = "GrantCondition",
    ARevokeCondition = "RevokeCondition",
    AAcceptsCondition = "AcceptsCondition",
    AStartBuildingRepairs = "StartBuildingRepairs",
    AStopBuildingRepairs = "StopBuildingRepairs",
    ASell = "Sell",
    APanic = "Panic",
    AAmmoCount = "AmmoCount",
    AMaximumAmmoCount = "MaximumAmmoCount",
    AReload = "Reload",
    // Player members (player_api.rs)
    PGetActors = "GetActors",
    PGetGroundAttackers = "GetGroundAttackers",
    PGetActorsByType = "GetActorsByType",
    PGetActorsByTypes = "GetActorsByTypes",
    PHasPrerequisites = "HasPrerequisites",
    PAddObjective = "AddObjective",
    PAddPrimaryObjective = "AddPrimaryObjective",
    PAddSecondaryObjective = "AddSecondaryObjective",
    PMarkCompletedObjective = "MarkCompletedObjective",
    PMarkFailedObjective = "MarkFailedObjective",
    PIsObjectiveCompleted = "IsObjectiveCompleted",
    PIsObjectiveFailed = "IsObjectiveFailed",
    PGetObjectiveDescription = "GetObjectiveDescription",
    PGetObjectiveType = "GetObjectiveType",
    PHasNoRequiredUnits = "HasNoRequiredUnits",
    PBuild = "Build",
    PIsProducing = "IsProducing",
    PIsAlliedWith = "IsAlliedWith",
    PGrantCondition = "GrantCondition",
    PRevokeCondition = "RevokeCondition",
    PAcceptsCondition = "AcceptsCondition",
    PTriggerPowerOutage = "TriggerPowerOutage",
}

pub(crate) fn host_fn(f: F) -> Value {
    Value::Host(f as u32, None)
}

pub(crate) fn bound_fn(f: F, this: UserData) -> Value {
    Value::Host(f as u32, Some(this))
}

/// Put OpenRA's globals into a fresh interpreter.
pub(crate) fn install(lua: &mut Lua) {
    for (i, g) in Global::ALL.iter().enumerate() {
        lua.set_global(g.name(), Value::UserData(UserData::new(UD_GLOBAL, i as i32, 0, 0)));
    }
    lua.set_global("FatalError", host_fn(F::FatalError));
    // OpenRA: `MaxUserScriptInstructions` and `EngineDir` exist; scripts read neither.
    lua.set_global("MaxUserScriptInstructions", Value::Num(1_000_000.0));
}

// ---- Arguments --------------------------------------------------------------------------

/// Argument access for host functions with OpenRA-like messages.
pub(crate) struct A<'a> {
    pub f: F,
    pub v: &'a [Value],
}

impl A<'_> {
    pub fn get(&self, i: usize) -> Value {
        self.v.get(i).cloned().unwrap_or(Value::Nil)
    }

    pub fn has(&self, i: usize) -> bool {
        self.v.get(i).is_some_and(|v| !v.is_nil())
    }

    fn bad<T>(&self, i: usize, what: &str) -> R<T> {
        let got = self.v.get(i).map_or("nil", Value::type_name);
        err(format!("{}: argument {} must be {what} (got {got})", self.f.name(), i + 1))
    }

    pub fn int(&self, i: usize) -> R<i64> {
        match self.v.get(i).and_then(Value::to_num) {
            Some(n) => Ok(to_int(n)),
            None => self.bad(i, "a number"),
        }
    }

    pub fn opt_int(&self, i: usize, d: i64) -> R<i64> {
        if self.has(i) {
            self.int(i)
        } else {
            Ok(d)
        }
    }

    pub fn boolean(&self, i: usize) -> R<bool> {
        match self.v.get(i) {
            Some(Value::Bool(b)) => Ok(*b),
            _ => self.bad(i, "a boolean"),
        }
    }

    pub fn opt_bool(&self, i: usize, d: bool) -> R<bool> {
        if self.has(i) {
            self.boolean(i)
        } else {
            Ok(d)
        }
    }

    pub fn string(&self, i: usize) -> R<String> {
        match self.v.get(i) {
            Some(v @ (Value::Str(_) | Value::Num(_))) => Ok(v.to_text().unwrap_or_default()),
            _ => self.bad(i, "a string"),
        }
    }

    pub fn opt_string(&self, i: usize) -> R<Option<String>> {
        if self.has(i) {
            self.string(i).map(Some)
        } else {
            Ok(None)
        }
    }

    pub fn func(&self, i: usize) -> R<Value> {
        match self.v.get(i) {
            Some(f @ (Value::Func(_) | Value::Builtin(..) | Value::Host(..))) => Ok(f.clone()),
            _ => self.bad(i, "a function"),
        }
    }

    pub fn opt_func(&self, i: usize) -> R<Option<Value>> {
        if self.has(i) {
            self.func(i).map(Some)
        } else {
            Ok(None)
        }
    }

    pub fn table(&self, i: usize) -> R<u32> {
        match self.v.get(i) {
            Some(Value::Table(t)) => Ok(*t),
            _ => self.bad(i, "a table"),
        }
    }

    fn ud(&self, i: usize, kind: u8, what: &str) -> R<UserData> {
        match self.v.get(i) {
            Some(Value::UserData(u)) if u.kind == kind => Ok(*u),
            _ => self.bad(i, what),
        }
    }

    pub fn actor(&self, i: usize) -> R<u32> {
        self.ud(i, UD_ACTOR, "an actor").map(|u| u.a as u32)
    }

    pub fn player(&self, i: usize) -> R<u8> {
        self.ud(i, UD_PLAYER, "a player").map(|u| u.a as u8)
    }

    pub fn opt_player(&self, i: usize) -> R<Option<u8>> {
        if self.has(i) {
            self.player(i).map(Some)
        } else {
            Ok(None)
        }
    }

    /// An OpenRA cell.
    pub fn cpos(&self, i: usize) -> R<(i32, i32)> {
        self.ud(i, UD_CPOS, "a CPos").map(|u| (u.a, u.b))
    }

    /// An OpenRA world position.
    pub fn wpos(&self, i: usize) -> R<(i32, i32, i32)> {
        self.ud(i, UD_WPOS, "a WPos").map(|u| (u.a, u.b, u.c))
    }

    pub fn wdist(&self, i: usize) -> R<i32> {
        self.ud(i, UD_WDIST, "a WDist").map(|u| u.a)
    }

    pub fn opt_angle(&self, i: usize) -> R<Option<i32>> {
        if self.has(i) {
            self.ud(i, UD_ANGLE, "an Angle").map(|u| Some(u.a))
        } else {
            Ok(None)
        }
    }

    pub fn opt_color(&self, i: usize) -> R<Option<u32>> {
        if self.has(i) {
            self.ud(i, UD_COLOR, "a color").map(|u| Some(u.a as u32))
        } else {
            Ok(None)
        }
    }
}

// ---- The Host ---------------------------------------------------------------------------

impl Host for Ctx<'_> {
    fn call(&mut self, lua: &mut Lua, id: u32, this: Option<UserData>, args: Vec<Value>) -> R<Vec<Value>> {
        let Some(f) = F::from_id(id) else { return err("unknown host function") };
        let a = A { f, v: &args };
        match this {
            Some(u) if u.kind == UD_ACTOR => self.actor_call(lua, f, u.a as u32, &a),
            Some(u) if u.kind == UD_PLAYER => self.player_call(lua, f, u.a as u8, &a),
            _ => self.global_call(lua, f, &a),
        }
    }

    fn index(&mut self, lua: &mut Lua, obj: UserData, key: &Value) -> R<Value> {
        let k = match key {
            Value::Str(s) => String::from_utf8_lossy(s).into_owned(),
            Value::Num(n) => crate::lua::fmt_number(*n),
            _ => return err(format!("cannot index a {} with a {} key", self.type_name(obj), key.type_name())),
        };
        match obj.kind {
            UD_ACTOR => self.actor_get(lua, obj, &k),
            UD_PLAYER => self.player_get(lua, obj, &k),
            UD_GLOBAL => self.global_get(lua, Global::ALL[obj.a as usize], &k),
            UD_CPOS => match k.as_str() {
                "X" => Ok(num(obj.a as i64)),
                "Y" => Ok(num(obj.b as i64)),
                "Layer" => Ok(num(obj.c as i64)),
                _ => err(format!("CPos does not define a member '{k}'")),
            },
            UD_WPOS => match k.as_str() {
                "X" => Ok(num(obj.a as i64)),
                "Y" => Ok(num(obj.b as i64)),
                "Z" => Ok(num(obj.c as i64)),
                _ => err(format!("WPos does not define a member '{k}'")),
            },
            UD_CVEC => match k.as_str() {
                "X" => Ok(num(obj.a as i64)),
                "Y" => Ok(num(obj.b as i64)),
                "Length" => Ok(num(isqrt(obj.a as i64 * obj.a as i64 + obj.b as i64 * obj.b as i64))),
                _ => err(format!("CVec does not define a member '{k}'")),
            },
            UD_WVEC => match k.as_str() {
                "X" => Ok(num(obj.a as i64)),
                "Y" => Ok(num(obj.b as i64)),
                "Z" => Ok(num(obj.c as i64)),
                "Facing" => Ok(angle(yaw(obj.a, obj.b))),
                _ => err(format!("WVec does not define a member '{k}'")),
            },
            UD_WDIST => match k.as_str() {
                "Length" => Ok(num(obj.a as i64)),
                _ => err(format!("WDist does not define a member '{k}'")),
            },
            UD_ANGLE => match k.as_str() {
                "Angle" => Ok(num(obj.a as i64)),
                _ => err(format!("Angle does not define a member '{k}'")),
            },
            _ => err(format!("{} does not define a member '{k}'", self.type_name(obj))),
        }
    }

    fn set_index(&mut self, lua: &mut Lua, obj: UserData, key: &Value, value: Value) -> R<()> {
        let k = key.to_text().unwrap_or_default();
        match obj.kind {
            UD_ACTOR => self.actor_set(lua, obj, &k, value),
            UD_PLAYER => self.player_set(obj, &k, value),
            UD_GLOBAL => self.global_set(Global::ALL[obj.a as usize], &k, value),
            _ => err(format!("{} is read-only", self.type_name(obj))),
        }
    }

    fn tostring(&mut self, _lua: &Lua, obj: UserData) -> String {
        match obj.kind {
            UD_ACTOR => {
                let h = obj.a as u32;
                match self.m.handle(h) {
                    Some(hd) => {
                        let in_world = self.in_world(h);
                        format!("Actor ({} {h}{})", hd.ty.to_ascii_lowercase(), if in_world { "" } else { " (not in world)" })
                    }
                    None => "Actor".into(),
                }
            }
            UD_PLAYER => format!("Player ({})", self.m.players.get(obj.a as usize).map_or("", |p| p.name.as_str())),
            UD_CPOS => {
                if obj.c != 0 {
                    format!("{},{},{}", obj.a, obj.b, obj.c)
                } else {
                    format!("{},{}", obj.a, obj.b)
                }
            }
            UD_WPOS | UD_WVEC => format!("{},{},{}", obj.a, obj.b, obj.c),
            UD_CVEC => format!("{},{}", obj.a, obj.b),
            UD_WDIST => {
                let l = obj.a.unsigned_abs();
                format!("{}{}c{}", if obj.a < 0 { "-" } else { "" }, l / 1024, l % 1024)
            }
            UD_ANGLE => obj.a.to_string(),
            UD_COLOR => hex_color(obj.a as u32),
            UD_GLOBAL => Global::ALL[obj.a as usize].name().to_string(),
            _ => "userdata".into(),
        }
    }

    /// Position, vector and distance arithmetic. OpenRA's are C# ints, which
    /// wrap; so do these (and i32::MIN / -1 never traps).
    fn arith(&mut self, op: BinOp, a: &Value, b: &Value) -> Option<Value> {
        let int = |v: &Value| v.to_num().map(to_int);
        match (a, b) {
            (Value::UserData(x), Value::UserData(y)) => match (x.kind, y.kind, op) {
                (UD_CPOS, UD_CVEC, BinOp::Add) => Some(cpos(x.a.wrapping_add(y.a), x.b.wrapping_add(y.b))),
                (UD_CVEC, UD_CPOS, BinOp::Add) => Some(cpos(x.a.wrapping_add(y.a), x.b.wrapping_add(y.b))),
                (UD_CPOS, UD_CVEC, BinOp::Sub) => Some(cpos(x.a.wrapping_sub(y.a), x.b.wrapping_sub(y.b))),
                (UD_CPOS, UD_CPOS, BinOp::Sub) => Some(cvec(x.a.wrapping_sub(y.a), x.b.wrapping_sub(y.b))),
                (UD_CVEC, UD_CVEC, BinOp::Add) => Some(cvec(x.a.wrapping_add(y.a), x.b.wrapping_add(y.b))),
                (UD_CVEC, UD_CVEC, BinOp::Sub) => Some(cvec(x.a.wrapping_sub(y.a), x.b.wrapping_sub(y.b))),
                (UD_WPOS, UD_WVEC, BinOp::Add) => Some(wpos(x.a.wrapping_add(y.a), x.b.wrapping_add(y.b), x.c.wrapping_add(y.c))),
                (UD_WPOS, UD_WVEC, BinOp::Sub) => Some(wpos(x.a.wrapping_sub(y.a), x.b.wrapping_sub(y.b), x.c.wrapping_sub(y.c))),
                (UD_WPOS, UD_WPOS, BinOp::Sub) => Some(wvec(x.a.wrapping_sub(y.a), x.b.wrapping_sub(y.b), x.c.wrapping_sub(y.c))),
                (UD_WVEC, UD_WVEC, BinOp::Add) => Some(wvec(x.a.wrapping_add(y.a), x.b.wrapping_add(y.b), x.c.wrapping_add(y.c))),
                (UD_WVEC, UD_WVEC, BinOp::Sub) => Some(wvec(x.a.wrapping_sub(y.a), x.b.wrapping_sub(y.b), x.c.wrapping_sub(y.c))),
                (UD_WDIST, UD_WDIST, BinOp::Add) => Some(wdist(x.a.wrapping_add(y.a))),
                (UD_WDIST, UD_WDIST, BinOp::Sub) => Some(wdist(x.a.wrapping_sub(y.a))),
                (UD_WDIST, UD_WDIST, BinOp::Lt) => Some(Value::Bool(x.a < y.a)),
                (UD_WDIST, UD_WDIST, BinOp::Le) => Some(Value::Bool(x.a <= y.a)),
                (UD_ANGLE, UD_ANGLE, BinOp::Add) => Some(angle(x.a.wrapping_add(y.a))),
                (UD_ANGLE, UD_ANGLE, BinOp::Sub) => Some(angle(x.a.wrapping_sub(y.a))),
                _ => None,
            },
            (Value::UserData(x), n) | (n, Value::UserData(x)) if matches!(op, BinOp::Mul) => {
                let k = int(n)? as i32;
                match x.kind {
                    UD_CVEC => Some(cvec(x.a.wrapping_mul(k), x.b.wrapping_mul(k))),
                    UD_WVEC => Some(wvec(x.a.wrapping_mul(k), x.b.wrapping_mul(k), x.c.wrapping_mul(k))),
                    UD_WDIST => Some(wdist(x.a.wrapping_mul(k))),
                    _ => None,
                }
            }
            (Value::UserData(x), n) if matches!(op, BinOp::Div) => {
                let k = int(n)? as i32;
                if k == 0 {
                    return None;
                }
                match x.kind {
                    UD_CVEC => Some(cvec(x.a.wrapping_div(k), x.b.wrapping_div(k))),
                    UD_WVEC => Some(wvec(x.a.wrapping_div(k), x.b.wrapping_div(k), x.c.wrapping_div(k))),
                    UD_WDIST => Some(wdist(x.a.wrapping_div(k))),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn negate(&mut self, obj: UserData) -> Option<Value> {
        match obj.kind {
            UD_CVEC => Some(cvec(obj.a.wrapping_neg(), obj.b.wrapping_neg())),
            UD_WVEC => Some(wvec(obj.a.wrapping_neg(), obj.b.wrapping_neg(), obj.c.wrapping_neg())),
            UD_WDIST => Some(wdist(obj.a.wrapping_neg())),
            _ => None,
        }
    }

    fn function_name(&self, id: u32) -> String {
        F::from_id(id).map_or("host function", F::name).to_string()
    }

    fn print(&mut self, msg: &str) {
        self.m.ui(UiEvent::Debug { text: msg.to_string() });
    }
}

pub(crate) fn isqrt(v: i64) -> i64 {
    if v <= 0 {
        return 0;
    }
    let mut x = (v as f64).sqrt() as i64;
    while x * x > v {
        x -= 1;
    }
    while (x + 1) * (x + 1) <= v {
        x += 1;
    }
    x
}

// ---- Globals: members ---------------------------------------------------------------------

impl Ctx<'_> {
    pub(crate) fn type_name(&self, obj: UserData) -> &'static str {
        match obj.kind {
            UD_ACTOR => "Actor",
            UD_PLAYER => "Player",
            UD_CPOS => "CPos",
            UD_WPOS => "WPos",
            UD_CVEC => "CVec",
            UD_WVEC => "WVec",
            UD_WDIST => "WDist",
            UD_ANGLE => "Angle",
            UD_COLOR => "Color",
            UD_GLOBAL => Global::ALL[obj.a as usize].name(),
            _ => "userdata",
        }
    }

    fn global_get(&mut self, lua: &mut Lua, g: Global, k: &str) -> R<Value> {
        use Global as G;
        let f = match (g, k) {
            (G::Actor, "Create") => F::ActorCreate,
            (G::Actor, "BuildTime") => F::ActorBuildTime,
            (G::Actor, "CruiseAltitude") => F::ActorCruiseAltitude,
            (G::Actor, "Cost") => F::ActorCost,
            (G::Player, "GetPlayer") => F::PlayerGetPlayer,
            (G::Player, "GetPlayers") => F::PlayerGetPlayers,
            (G::Map, "ActorsInCircle") => F::MapActorsInCircle,
            (G::Map, "ActorsInBox") => F::MapActorsInBox,
            (G::Map, "RandomCell") => F::MapRandomCell,
            (G::Map, "RandomEdgeCell") => F::MapRandomEdgeCell,
            (G::Map, "ClosestEdgeCell") => F::MapClosestEdgeCell,
            (G::Map, "ClosestMatchingEdgeCell") => F::MapClosestMatchingEdgeCell,
            (G::Map, "CenterOfCell") => F::MapCenterOfCell,
            (G::Map, "TerrainType") => F::MapTerrainType,
            (G::Map, "LobbyOption") => F::MapLobbyOption,
            (G::Map, "LobbyOptionOrDefault") => F::MapLobbyOptionOrDefault,
            (G::Map, "NamedActor") => F::MapNamedActor,
            (G::Map, "IsNamedActor") => F::MapIsNamedActor,
            (G::Map, "ActorsWithTag") => F::MapActorsWithTag,
            (G::Map, "ActorsInWorld") => return Ok(self.actors_list(lua, |_, _| true)),
            (G::Map, "NamedActors") => {
                let hs: Vec<u32> = self.m.named.iter().map(|&(_, h)| h).filter(|&h| !self.is_dead(h)).collect();
                return Ok(self.actor_list(lua, &hs));
            }
            (G::Map, "IsSinglePlayer") => return Ok(boolean(true)),
            (G::Map, "IsPausedShellmap") => return Ok(boolean(false)),
            (G::Map, "TopLeft") => {
                let (x, y) = self.m.pos_out(0, 0);
                return Ok(wpos(x, y, 0));
            }
            (G::Map, "BottomRight") => {
                let (x, y) = self.m.pos_out(self.w.map.width * CELL, self.w.map.height * CELL);
                return Ok(wpos(x, y, 0));
            }
            (G::Trigger, _) => match k {
                "AfterDelay" => F::TriggerAfterDelay,
                "OnPassengerEntered" => F::TriggerOnPassengerEntered,
                "OnPassengerExited" => F::TriggerOnPassengerExited,
                "OnIdle" => F::TriggerOnIdle,
                "OnDamaged" => F::TriggerOnDamaged,
                "OnKilled" => F::TriggerOnKilled,
                "OnAllKilled" => F::TriggerOnAllKilled,
                "OnAnyKilled" => F::TriggerOnAnyKilled,
                "OnProduction" => F::TriggerOnProduction,
                "OnAnyProduction" => F::TriggerOnAnyProduction,
                "OnPlayerWon" => F::TriggerOnPlayerWon,
                "OnPlayerLost" => F::TriggerOnPlayerLost,
                "OnObjectiveAdded" => F::TriggerOnObjectiveAdded,
                "OnObjectiveCompleted" => F::TriggerOnObjectiveCompleted,
                "OnObjectiveFailed" => F::TriggerOnObjectiveFailed,
                "OnBuildingPlaced" => F::TriggerOnBuildingPlaced,
                "OnAddedToWorld" => F::TriggerOnAddedToWorld,
                "OnRemovedFromWorld" => F::TriggerOnRemovedFromWorld,
                "OnAllRemovedFromWorld" => F::TriggerOnAllRemovedFromWorld,
                "OnCapture" => F::TriggerOnCapture,
                "OnKilledOrCaptured" => F::TriggerOnKilledOrCaptured,
                "OnAllKilledOrCaptured" => F::TriggerOnAllKilledOrCaptured,
                "OnEnteredFootprint" => F::TriggerOnEnteredFootprint,
                "OnExitedFootprint" => F::TriggerOnExitedFootprint,
                "RemoveFootprintTrigger" => F::TriggerRemoveFootprintTrigger,
                "OnEnteredProximityTrigger" => F::TriggerOnEnteredProximityTrigger,
                "OnExitedProximityTrigger" => F::TriggerOnExitedProximityTrigger,
                "RemoveProximityTrigger" => F::TriggerRemoveProximityTrigger,
                "OnInfiltrated" => F::TriggerOnInfiltrated,
                "OnDiscovered" => F::TriggerOnDiscovered,
                "OnPlayerDiscovered" => F::TriggerOnPlayerDiscovered,
                "OnSold" => F::TriggerOnSold,
                "OnSupportPowerActivated" => F::TriggerOnSupportPowerActivated,
                "OnTimerExpired" => F::TriggerOnTimerExpired,
                "ClearAll" => F::TriggerClearAll,
                "Clear" => F::TriggerClear,
                _ => return err(format!("Trigger does not define a member '{k}'")),
            },
            (G::Reinforcements, "Reinforce") => F::ReinforcementsReinforce,
            (G::Reinforcements, "ReinforceWithTransport") => F::ReinforcementsReinforceWithTransport,
            (G::Media, _) => match k {
                "PlaySpeechNotification" => F::MediaPlaySpeechNotification,
                "PlaySoundNotification" => F::MediaPlaySoundNotification,
                "PlaySound" => F::MediaPlaySound,
                "PlayMusic" => F::MediaPlayMusic,
                "SetBackgroundMusic" => F::MediaSetBackgroundMusic,
                "StopMusic" => F::MediaStopMusic,
                "PlayMovieFullscreen" => F::MediaPlayMovieFullscreen,
                "PlayMovieInRadar" => F::MediaPlayMovieInRadar,
                "DisplayMessage" => F::MediaDisplayMessage,
                "DisplayMessageToPlayer" => F::MediaDisplayMessageToPlayer,
                "DisplaySystemMessage" => F::MediaDisplaySystemMessage,
                "Debug" => F::MediaDebug,
                "FloatingText" => F::MediaFloatingText,
                _ => return err(format!("Media does not define a member '{k}'")),
            },
            (G::Utils, _) => match k {
                "Do" => F::UtilsDo,
                "Any" => F::UtilsAny,
                "All" => F::UtilsAll,
                "Where" => F::UtilsWhere,
                "Take" => F::UtilsTake,
                "Skip" => F::UtilsSkip,
                "Concat" => F::UtilsConcat,
                "Random" => F::UtilsRandom,
                "Shuffle" => F::UtilsShuffle,
                "ExpandFootprint" => F::UtilsExpandFootprint,
                "RandomInteger" => F::UtilsRandomInteger,
                "FormatTime" => F::UtilsFormatTime,
                _ => return err(format!("Utils does not define a member '{k}'")),
            },
            (G::DateTime, "Seconds") => F::DateTimeSeconds,
            (G::DateTime, "Minutes") => F::DateTimeMinutes,
            (G::DateTime, "GameTime") => return Ok(num(self.w.tick as i64)),
            (G::DateTime, "TimeLimit") => {
                let left = if self.m.time_limit.end > 0 { self.m.time_limit.end as i64 } else { 0 };
                return Ok(num(left));
            }
            (G::DateTime, "TimeLimitNotification") => {
                return Ok(self.m.data.time_limit.notification.as_deref().map_or(Value::Nil, text));
            }
            // The real date would differ between players: a fixed one keeps lockstep games in sync.
            (G::DateTime, "IsHalloween") => return Ok(boolean(false)),
            (G::DateTime, "CurrentYear") => return Ok(num(2000)),
            (G::DateTime, "CurrentMonth" | "CurrentDay") => return Ok(num(1)),
            (G::DateTime, "CurrentHour" | "CurrentMinute" | "CurrentSecond") => return Ok(num(0)),
            (G::Camera, "Position") => {
                let (x, y) = self.m.camera.unwrap_or_else(|| self.camera_default());
                let (ox, oy) = self.m.pos_out(x, y);
                return Ok(wpos(ox, oy, 0));
            }
            (G::Beacon, "New") => F::BeaconNew,
            (G::Radar, "Ping") => F::RadarPing,
            (G::UserInterface, "SetMissionText") => F::UserInterfaceSetMissionText,
            (G::UserInterface, "GetFluentMessage" | "Translate") => F::UserInterfaceGetFluentMessage,
            (G::CPos, "New") => F::CPosNew,
            (G::CPos, "NewWithLayer") => F::CPosNewWithLayer,
            (G::CPos, "Zero") => return Ok(cpos(0, 0)),
            (G::WPos, "New") => F::WPosNew,
            (G::WPos, "Zero") => return Ok(wpos(0, 0, 0)),
            (G::CVec, "New") => F::CVecNew,
            (G::CVec, "Zero") => return Ok(cvec(0, 0)),
            (G::WVec, "New") => F::WVecNew,
            (G::WVec, "Zero") => return Ok(wvec(0, 0, 0)),
            (G::WDist, "New") => F::WDistNew,
            (G::WDist, "FromCells") => F::WDistFromCells,
            (G::Angle, "New") => F::AngleNew,
            (G::Angle, _) => {
                return match k {
                    "North" => Ok(angle(0)),
                    "NorthWest" => Ok(angle(128)),
                    "West" => Ok(angle(256)),
                    "SouthWest" => Ok(angle(384)),
                    "South" => Ok(angle(512)),
                    "SouthEast" => Ok(angle(640)),
                    "East" => Ok(angle(768)),
                    "NorthEast" => Ok(angle(896)),
                    _ => err(format!("Angle does not define a member '{k}'")),
                }
            }
            (G::HSLColor, "New") => F::HSLColorNew,
            (G::HSLColor, "FromRGB") => F::HSLColorFromRGB,
            (G::HSLColor, "FromHex") => F::HSLColorFromHex,
            (G::HSLColor, name) => {
                return match named_color(name) {
                    Some(c) => Ok(color(c)),
                    None => err(format!("HSLColor does not define a member '{k}'")),
                }
            }
            _ => return err(format!("{} does not define a member '{k}'", g.name())),
        };
        Ok(host_fn(f))
    }

    fn global_set(&mut self, g: Global, k: &str, value: Value) -> R<()> {
        match (g, k) {
            (Global::Camera, "Position") => {
                let Value::UserData(u) = value else { return err("Camera.Position must be a WPos") };
                if u.kind != UD_WPOS {
                    return err("Camera.Position must be a WPos");
                }
                let (x, y) = self.m.pos_in(u.a, u.b);
                self.m.camera = Some((x, y));
                self.m.ui(UiEvent::Camera { x: x as f32 / CELL as f32, y: y as f32 / CELL as f32 });
                Ok(())
            }
            (Global::DateTime, "TimeLimit") => {
                let t = value.to_num().map(to_int).ok_or_else(|| LuaError::runtime("DateTime.TimeLimit must be a number"))?;
                // OpenRA: the time limit counts from now; 0 switches it off.
                self.m.time_limit =
                    TimeLimit { end: if t <= 0 { 0 } else { self.w.tick.saturating_add(t as u32) }, warned: Vec::new(), expired: false };
                Ok(())
            }
            (Global::DateTime, "TimeLimitNotification") => Ok(()),
            _ => err(format!("{}.{k} cannot be set", g.name())),
        }
    }

    /// Where the camera starts: the human player's first actor on the map.
    fn camera_default(&self) -> (i32, i32) {
        self.w
            .actors
            .iter()
            .find(|a| a.alive && a.owner == self.m.local_player)
            .map_or((self.w.map.width * CELL / 2, self.w.map.height * CELL / 2), |a| (a.x, a.y))
    }

    pub(crate) fn global_call(&mut self, lua: &mut Lua, f: F, a: &A) -> R<Vec<Value>> {
        let one = |v: Value| Ok(vec![v]);
        match f {
            F::FatalError => err(a.string(0).unwrap_or_else(|_| "FatalError".into())),
            F::ActorCreate => {
                let ty = a.string(0)?;
                let add = a.opt_bool(1, false)?;
                let inits = a.table(2)?;
                one(self.create_actor(lua, &ty, add, inits)?)
            }
            F::ActorBuildTime => {
                let ty = self.actor_type(&a.string(0)?)?;
                one(num(self.w.build_time_with(0, ty as u16, 1) as i64))
            }
            F::ActorCruiseAltitude => {
                let ty = self.actor_type(&a.string(0)?)?;
                let alt = self.w.rules.actors[ty].unit.as_ref().and_then(|u| u.aircraft.as_ref()).map_or(0, |ac| ac.cruise_altitude);
                one(num(alt as i64))
            }
            F::ActorCost => {
                let ty = self.actor_type(&a.string(0)?)?;
                one(num(self.w.rules.actors[ty].cost as i64))
            }
            F::PlayerGetPlayer => {
                let name = a.string(0)?;
                one(self.m.player_slot(&name).map_or(Value::Nil, player_value))
            }
            F::PlayerGetPlayers => {
                let filter = a.opt_func(0)?;
                let mut out = Vec::new();
                for p in 0..self.m.players.len() as u8 {
                    let keep = match &filter {
                        Some(f) => lua.call(self, f, vec![player_value(p)])?.first().is_some_and(Value::truthy),
                        None => true,
                    };
                    if keep {
                        out.push(player_value(p));
                    }
                }
                one(lua.array(out))
            }
            F::MapActorsInCircle => {
                let (x, y, _) = a.wpos(0)?;
                let r = a.wdist(1)? as i64;
                let (ex, ey) = self.m.pos_in(x, y);
                let filter = a.opt_func(2)?;
                let found = self.actors_matching(|w, i| {
                    let (dx, dy) = (w.actors[i].x as i64 - ex as i64, w.actors[i].y as i64 - ey as i64);
                    dx * dx + dy * dy <= r * r
                });
                self.filtered(lua, found, filter).map(|v| vec![v])
            }
            F::MapActorsInBox => {
                let (x0, y0, _) = a.wpos(0)?;
                let (x1, y1, _) = a.wpos(1)?;
                let (ax, ay) = self.m.pos_in(x0.min(x1), y0.min(y1));
                let (bx, by) = self.m.pos_in(x0.max(x1), y0.max(y1));
                let filter = a.opt_func(2)?;
                let found = self.actors_matching(|w, i| {
                    let (x, y) = (w.actors[i].x, w.actors[i].y);
                    x >= ax && x <= bx && y >= ay && y <= by
                });
                self.filtered(lua, found, filter).map(|v| vec![v])
            }
            F::MapRandomCell => {
                let x = self.w.rng.range(0, self.w.map.width);
                let y = self.w.rng.range(0, self.w.map.height);
                let (ox, oy) = self.m.cell_out(x, y);
                one(cpos(ox, oy))
            }
            F::MapRandomEdgeCell => {
                let edges = self.edge_cells();
                let i = self.w.rng.range(0, edges.len() as i32) as usize;
                let (x, y) = edges[i];
                let (ox, oy) = self.m.cell_out(x, y);
                one(cpos(ox, oy))
            }
            F::MapClosestEdgeCell => {
                let (cx, cy) = a.cpos(0)?;
                let (x, y) = self.m.cell_in(cx, cy);
                let (w, h) = (self.w.map.width, self.w.map.height);
                // OpenRA Map.ChooseClosestEdgeCell: clamp to the bounds, then
                // move to the nearest of the four edges.
                let (x, y) = (x.clamp(0, w - 1), y.clamp(0, h - 1));
                let d = [(x, 0), (w - 1 - x, 1), (y, 2), (h - 1 - y, 3)];
                let (_, side) = d.iter().copied().min().expect("four edges");
                let (ex, ey) = match side {
                    0 => (0, y),
                    1 => (w - 1, y),
                    2 => (x, 0),
                    _ => (x, h - 1),
                };
                let (ox, oy) = self.m.cell_out(ex, ey);
                one(cpos(ox, oy))
            }
            F::MapClosestMatchingEdgeCell => {
                let (cx, cy) = a.cpos(0)?;
                let filter = a.func(1)?;
                let (x, y) = self.m.cell_in(cx, cy);
                let mut edges = self.edge_cells();
                edges.sort_by_key(|&(ex, ey)| ((ex - x) as i64).pow(2) + ((ey - y) as i64).pow(2));
                for (ex, ey) in edges {
                    let (ox, oy) = self.m.cell_out(ex, ey);
                    if lua.call(self, &filter, vec![cpos(ox, oy)])?.first().is_some_and(Value::truthy) {
                        return one(cpos(ox, oy));
                    }
                }
                one(Value::Nil)
            }
            F::MapCenterOfCell => {
                let (x, y) = a.cpos(0)?;
                one(wpos(x * CELL + CELL / 2, y * CELL + CELL / 2, 0))
            }
            F::MapTerrainType => {
                let (cx, cy) = a.cpos(0)?;
                let (x, y) = self.m.cell_in(cx, cy);
                if !self.w.map.contains(x, y) {
                    return err("Map.TerrainType: the cell is outside the map");
                }
                one(text(crate::abilities::terrain_name(self.w.map.terrain[self.w.map.idx(x, y)])))
            }
            F::MapLobbyOption => {
                let id = a.string(0)?;
                one(self.m.options.get(&id).map_or(Value::Nil, |v| text(v)))
            }
            F::MapLobbyOptionOrDefault => {
                let id = a.string(0)?;
                let fallback = a.get(1);
                one(self.m.options.get(&id).map_or(fallback, |v| text(v)))
            }
            F::MapNamedActor => {
                let name = a.string(0)?;
                let h = self.m.named.iter().find(|(n, _)| *n == name).map(|&(_, h)| h);
                one(h
                    .filter(|&h| !self.is_dead(h) || matches!(self.m.handles[h as usize].state, HState::Marker { .. }))
                    .map_or(Value::Nil, actor_value))
            }
            F::MapIsNamedActor => {
                let h = a.actor(0)?;
                one(boolean(self.m.named.iter().any(|&(_, n)| n == h)))
            }
            F::MapActorsWithTag => {
                let tag = a.string(0)?;
                let hs: Vec<u32> = (0..self.m.handles.len() as u32)
                    .filter(|&h| self.m.handles[h as usize].tags.contains(&tag) && !self.is_dead(h))
                    .collect();
                one(self.actor_list(lua, &hs))
            }
            F::ReinforcementsReinforce => self.reinforce(lua, a),
            F::ReinforcementsReinforceWithTransport => self.reinforce_with_transport(lua, a),
            F::MediaPlaySpeechNotification | F::MediaPlaySoundNotification => {
                let player = a.opt_player(0)?;
                let name = a.string(1)?;
                // Notifications to a player only reach that player (OpenRA PlayNotification);
                // nil is everyone.
                let p = player.unwrap_or(super::setup::NEUTRAL);
                let e = if f == F::MediaPlaySpeechNotification {
                    UiEvent::Speech { player: if player.is_some() { p } else { 255 }, name }
                } else {
                    UiEvent::Sound { player: if player.is_some() { p } else { 255 }, name }
                };
                self.m.ui(e);
                Ok(Vec::new())
            }
            F::MediaPlaySound => {
                let file = a.string(0)?;
                self.m.ui(UiEvent::SoundFile { file });
                Ok(Vec::new())
            }
            // Music follows the player's music settings (client side); a
            // completion callback runs at once, as when music is missing.
            F::MediaPlayMusic | F::MediaSetBackgroundMusic | F::MediaStopMusic => {
                if f == F::MediaPlayMusic {
                    if let Some(cb) = a.opt_func(1)? {
                        self.later(cb, 0);
                    }
                }
                Ok(Vec::new())
            }
            F::MediaPlayMovieFullscreen | F::MediaPlayMovieInRadar => {
                let file = a.string(0)?;
                self.m.ui(UiEvent::Movie { file });
                // The client shows the movie (or a card when it is not installed)
                // while the game goes on; the callback runs on the next tick, the
                // same for every player.
                if let Some(cb) = a.opt_func(1)? {
                    self.later(cb, 1);
                }
                Ok(Vec::new())
            }
            F::MediaDisplayMessage => {
                let t = a.string(0)?;
                if t.is_empty() {
                    return Ok(Vec::new());
                }
                let prefix = a.opt_string(1)?.unwrap_or_else(|| "Mission".into());
                let c = a.opt_color(2)?.unwrap_or(0xffff_ffff);
                self.m.ui(UiEvent::Message { prefix, text: t, color: hex_color(c) });
                Ok(Vec::new())
            }
            F::MediaDisplayMessageToPlayer => {
                let p = a.player(0)?;
                let t = a.string(1)?;
                if p != self.m.local_player || t.is_empty() {
                    return Ok(Vec::new());
                }
                let prefix = a.opt_string(2)?.unwrap_or_else(|| "Mission".into());
                let c = a.opt_color(3)?.unwrap_or(0xffff_ffff);
                self.m.ui(UiEvent::Message { prefix, text: t, color: hex_color(c) });
                Ok(Vec::new())
            }
            F::MediaDisplaySystemMessage => {
                let t = a.string(0)?;
                if !t.is_empty() {
                    let prefix = a.opt_string(1)?.unwrap_or_else(|| "Battlefield Control".into());
                    self.m.ui(UiEvent::Message { prefix, text: t, color: "FFFF00".into() });
                }
                Ok(Vec::new())
            }
            F::MediaDebug => {
                let t = a.string(0)?;
                self.m.ui(UiEvent::Debug { text: t });
                Ok(Vec::new())
            }
            F::MediaFloatingText => {
                let t = a.string(0)?;
                let (x, y, _) = a.wpos(1)?;
                let ticks = a.opt_int(2, 30)? as i32;
                let c = a.opt_color(3)?.unwrap_or(0xffff_ffff);
                let (ex, ey) = self.m.pos_in(x, y);
                self.m.ui(UiEvent::FloatingText {
                    text: t,
                    x: ex as f32 / CELL as f32,
                    y: ey as f32 / CELL as f32,
                    color: hex_color(c),
                    ticks,
                });
                Ok(Vec::new())
            }
            F::UtilsDo => {
                let items = self.collection(lua, a, 0)?;
                let func = a.func(1)?;
                for v in items {
                    lua.call(self, &func, vec![v])?;
                }
                Ok(Vec::new())
            }
            F::UtilsAny | F::UtilsAll => {
                let items = self.collection(lua, a, 0)?;
                let func = a.func(1)?;
                for v in items {
                    let r = lua.call(self, &func, vec![v])?.first().is_some_and(Value::truthy);
                    if f == F::UtilsAny && r {
                        return one(boolean(true));
                    }
                    if f == F::UtilsAll && !r {
                        return one(boolean(false));
                    }
                }
                one(boolean(f == F::UtilsAll))
            }
            F::UtilsWhere => {
                let items = self.collection(lua, a, 0)?;
                let func = a.func(1)?;
                let mut out = Vec::new();
                for v in items {
                    if lua.call(self, &func, vec![v.clone()])?.first().is_some_and(Value::truthy) {
                        out.push(v);
                    }
                }
                one(lua.array(out))
            }
            F::UtilsTake => {
                let n = a.int(0)?.max(0) as usize;
                let items = self.collection(lua, a, 1)?;
                one(lua.array(items.into_iter().take(n).collect()))
            }
            F::UtilsSkip => {
                let t = a.table(0)?;
                let n = a.int(1)?;
                // OpenRA's Skip copies from index numElements on (1-based table indices).
                let len = lua.length(t) as i64;
                let out: Vec<Value> = (n.max(1)..=len).map(|i| lua.raw_get(t, &Value::Num(i as f64))).collect();
                one(lua.array(out))
            }
            F::UtilsConcat => {
                let mut items = self.collection(lua, a, 0)?;
                items.extend(self.collection(lua, a, 1)?);
                one(lua.array(items))
            }
            F::UtilsRandom => {
                let items = self.collection(lua, a, 0)?;
                if items.is_empty() {
                    return err("Utils.Random: the collection is empty");
                }
                let i = self.w.rng.range(0, items.len() as i32) as usize;
                one(items[i].clone())
            }
            F::UtilsShuffle => {
                let mut items = self.collection(lua, a, 0)?;
                // OpenRA's Shuffle: Fisher-Yates from the end with the shared random.
                for i in (1..items.len()).rev() {
                    let j = self.w.rng.range(0, i as i32 + 1) as usize;
                    items.swap(i, j);
                }
                one(lua.array(items))
            }
            F::UtilsExpandFootprint => {
                let items = self.collection(lua, a, 0)?;
                let diagonal = a.boolean(1)?;
                let mut cells: Vec<(i32, i32)> = Vec::new();
                for v in &items {
                    match v.as_userdata() {
                        Some(u) if u.kind == UD_CPOS => cells.push((u.a, u.b)),
                        _ => return err("Utils.ExpandFootprint: the footprint must be CPos values"),
                    }
                }
                let mut out: std::collections::BTreeSet<(i32, i32)> = cells.iter().copied().collect();
                for &(x, y) in &cells {
                    for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                        out.insert((x + dx, y + dy));
                    }
                    if diagonal {
                        for (dx, dy) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
                            out.insert((x + dx, y + dy));
                        }
                    }
                }
                // Original cells first, then the new ones (OpenRA keeps the order it found them).
                let mut list: Vec<Value> = cells.iter().map(|&(x, y)| cpos(x, y)).collect();
                for &(x, y) in &out {
                    if !cells.contains(&(x, y)) {
                        list.push(cpos(x, y));
                    }
                }
                one(lua.array(list))
            }
            F::UtilsRandomInteger => {
                let lo = a.int(0)? as i32;
                let hi = a.int(1)? as i32;
                one(num(self.w.rng.range(lo, hi) as i64))
            }
            F::UtilsFormatTime => {
                let t = a.int(0)?;
                let lead = a.opt_bool(1, true)?;
                one(text(&fluent::format_time(t, lead)))
            }
            F::DateTimeSeconds => one(num(a.int(0)? * 25)),
            F::DateTimeMinutes => one(num(a.int(0)? * 60 * 25)),
            F::BeaconNew => {
                let p = a.player(0)?;
                let (x, y, _) = a.wpos(1)?;
                let duration = a.opt_int(2, 750)? as u32;
                let pings = a.opt_bool(3, true)?;
                let (ex, ey) = self.m.pos_in(x, y);
                self.w.place_script_beacon(p, ex, ey, duration);
                if pings {
                    let c = self.m.players.get(p as usize).map_or(0xffff_ffff, |pl| pl.color);
                    self.m.ui(UiEvent::RadarPing {
                        player: p,
                        x: ex as f32 / CELL as f32,
                        y: ey as f32 / CELL as f32,
                        color: hex_color(c),
                        ticks: duration as i32,
                    });
                }
                Ok(Vec::new())
            }
            F::RadarPing => {
                let p = a.player(0)?;
                let (x, y, _) = a.wpos(1)?;
                let c = a.opt_color(2)?.unwrap_or(0xffff_ffff);
                let ticks = a.opt_int(3, 750)? as i32;
                let (ex, ey) = self.m.pos_in(x, y);
                self.m.ui(UiEvent::RadarPing {
                    player: p,
                    x: ex as f32 / CELL as f32,
                    y: ey as f32 / CELL as f32,
                    color: hex_color(c),
                    ticks,
                });
                Ok(Vec::new())
            }
            F::UserInterfaceSetMissionText => {
                let t = a.string(0)?;
                let c = a.opt_color(1)?.unwrap_or(0xffff_ffff);
                self.m.mission_text = (!t.is_empty()).then(|| (t.clone(), hex_color(c)));
                self.m.ui(UiEvent::MissionText { text: t, color: hex_color(c) });
                Ok(Vec::new())
            }
            F::UserInterfaceGetFluentMessage => {
                let key = a.string(0)?;
                let mut args = Vec::new();
                if a.has(1) {
                    let t = a.table(1)?;
                    for (k, v) in lua.pairs(t) {
                        let (Some(k), Some(v)) = (k.to_text(), self.arg_text(lua, &v)) else {
                            return err("String arguments requires a table of [\"string\"]=value pairs");
                        };
                        args.push((k, v));
                    }
                }
                one(text(&fluent::format(&self.m.data.messages, &key, &args)))
            }
            F::CPosNew => one(cpos(a.int(0)? as i32, a.int(1)? as i32)),
            F::CPosNewWithLayer => {
                let layer = a.int(2)?;
                if layer != 0 {
                    return err(format!("Layer {layer} does not exist on this map. Valid layers on this map are: 0 (Ground)"));
                }
                one(cpos(a.int(0)? as i32, a.int(1)? as i32))
            }
            F::WPosNew => one(wpos(a.int(0)? as i32, a.int(1)? as i32, a.int(2)? as i32)),
            F::CVecNew => one(cvec(a.int(0)? as i32, a.int(1)? as i32)),
            F::WVecNew => one(wvec(a.int(0)? as i32, a.int(1)? as i32, a.int(2)? as i32)),
            F::WDistNew => one(wdist(a.int(0)? as i32)),
            F::WDistFromCells => one(wdist((a.int(0)? as i32).saturating_mul(CELL))),
            F::AngleNew => one(angle(a.int(0)? as i32)),
            F::HSLColorNew => {
                let (h, s, l) = (a.int(0)?.clamp(0, 255), a.int(1)?.clamp(0, 255), a.int(2)?.clamp(0, 255));
                one(color(hsl_to_rgba(h as i32, s as i32, l as i32)))
            }
            F::HSLColorFromRGB => {
                let c = |i: usize, d: i64| a.opt_int(i, d).map(|v| v.clamp(0, 255) as u32);
                let (r, g, b, al) = (c(0, 0)?, c(1, 0)?, c(2, 0)?, c(3, 255)?);
                one(color((r << 24) | (g << 16) | (b << 8) | al))
            }
            F::HSLColorFromHex => {
                let s = a.string(0)?;
                match parse_color(&s) {
                    Some(c) => one(color(c)),
                    None => err("Invalid rrggbb[aa] hex string."),
                }
            }
            _ => self.trigger_call(lua, f, a),
        }
    }

    /// A string or number argument as text (GetFluentMessage arguments).
    fn arg_text(&mut self, _lua: &mut Lua, v: &Value) -> Option<String> {
        match v {
            Value::Num(n) => Some(if n.fract() == 0.0 { format!("{}", *n as i64) } else { crate::lua::fmt_number(*n) }),
            Value::Str(_) => v.to_text(),
            Value::Bool(b) => Some(b.to_string()),
            Value::UserData(u) => Some(self.tostring(_lua, *u)),
            _ => None,
        }
    }

    /// The items of a table argument (OpenRA converts a Lua table to an array: 1..n).
    pub(crate) fn collection(&mut self, lua: &mut Lua, a: &A, i: usize) -> R<Vec<Value>> {
        let t = a.table(i)?;
        let items = lua.sequence(t);
        lua.charge(items.len() as u64)?;
        Ok(items)
    }

    /// Run `f` with no arguments `delay` ticks from now (after the current tick's scripts).
    pub(crate) fn later(&mut self, f: Value, delay: i64) {
        let seq = self.m.next_seq();
        let tick = self.w.tick.saturating_add(delay.clamp(0, u32::MAX as i64) as u32);
        self.m.delayed.push(Delayed { tick, seq, func: f });
    }

    /// The cells on the map's edge, in a fixed order.
    fn edge_cells(&self) -> Vec<(i32, i32)> {
        let (w, h) = (self.w.map.width, self.w.map.height);
        let mut out = Vec::new();
        for x in 0..w {
            out.push((x, 0));
            out.push((x, h - 1));
        }
        for y in 1..h - 1 {
            out.push((0, y));
            out.push((w - 1, y));
        }
        out
    }

    /// Actor type index of a script's type name.
    pub(crate) fn actor_type(&self, ty: &str) -> R<usize> {
        self.w.rules.actor_index(ty).ok_or_else(|| LuaError::runtime(format!("Unknown actor type '{ty}'")))
    }

    /// Handles of the engine actors in the world that `pred` accepts (index order).
    pub(crate) fn actors_matching(&mut self, pred: impl Fn(&World, usize) -> bool) -> Vec<u32> {
        let mut out = Vec::new();
        for i in 0..self.w.actors.len() {
            let a = &self.w.actors[i];
            if !a.alive || !a.in_world() || !pred(self.w, i) {
                continue;
            }
            out.push(self.handle_for(i));
        }
        out
    }

    pub(crate) fn actors_list(&mut self, lua: &mut Lua, pred: impl Fn(&World, usize) -> bool) -> Value {
        let hs = self.actors_matching(pred);
        self.actor_list(lua, &hs)
    }

    pub(crate) fn actor_list(&mut self, lua: &mut Lua, hs: &[u32]) -> Value {
        lua.array(hs.iter().map(|&h| actor_value(h)).collect())
    }

    fn filtered(&mut self, lua: &mut Lua, hs: Vec<u32>, filter: Option<Value>) -> R<Value> {
        let mut out = Vec::new();
        for h in hs {
            let keep = match &filter {
                Some(f) => lua.call(self, f, vec![actor_value(h)])?.first().is_some_and(Value::truthy),
                None => true,
            };
            if keep {
                out.push(actor_value(h));
            }
        }
        Ok(lua.array(out))
    }

    /// The handle of engine actor `i` (made the first time scripts see it).
    pub(crate) fn handle_for(&mut self, i: usize) -> u32 {
        let r = self.w.make_ref(i);
        if let Some(&h) = self.m.handle_of.get(&r) {
            return h;
        }
        let a = &self.w.actors[i];
        let ty = self.w.rules.actors[a.ty as usize].id.clone();
        self.m.new_handle(ty, a.owner, HState::Live(r))
    }
}

/// OpenRA's named colors (Color.cs).
fn named_color(name: &str) -> Option<u32> {
    let rgb = match name {
        "Aqua" | "Cyan" => 0x00FFFF,
        "Black" => 0x000000,
        "Blue" => 0x0000FF,
        "Brown" => 0xA52A2A,
        "DarkBlue" => 0x00008B,
        "DarkCyan" => 0x008B8B,
        "DarkGray" => 0xA9A9A9,
        "DarkGreen" => 0x006400,
        "DarkOrange" => 0xFF8C00,
        "DarkRed" => 0x8B0000,
        "Fuchsia" | "Magenta" => 0xFF00FF,
        "Gold" => 0xFFD700,
        "Gray" => 0x808080,
        "Green" => 0x008000,
        "LawnGreen" => 0x7CFC00,
        "LightBlue" => 0xADD8E6,
        "LightCyan" => 0xE0FFFF,
        "LightGray" => 0xD3D3D3,
        "LightGreen" => 0x90EE90,
        "LightYellow" => 0xFFFFE0,
        "Lime" => 0x00FF00,
        "LimeGreen" => 0x32CD32,
        "Maroon" => 0x800000,
        "Navy" => 0x000080,
        "Olive" => 0x808000,
        "Orange" => 0xFFA500,
        "OrangeRed" => 0xFF4500,
        "Purple" => 0x800080,
        "Red" => 0xFF0000,
        "Salmon" => 0xFA8072,
        "SkyBlue" => 0x87CEEB,
        "Teal" => 0x008080,
        "Yellow" => 0xFFFF00,
        "White" => 0xFFFFFF,
        _ => return None,
    };
    Some((rgb << 8) | 0xff)
}

/// HSL (0..255 each) to RGBA with integer math (Color.FromAhsl).
fn hsl_to_rgba(h: i32, s: i32, l: i32) -> u32 {
    // Fixed point with 255 as 1.0.
    let (h, s, l) = (h as i64 * 360 / 255, s as i64, l as i64);
    let c = (255 - (2 * l - 255).abs()) * s / 255;
    let hp = h % 360;
    let x = c * (60 - ((hp % 120) - 60).abs()) / 60;
    let (r1, g1, b1) = match hp / 60 {
        0 => (c, x, 0),
        1 => (x, c, 0),
        2 => (0, c, x),
        3 => (0, x, c),
        4 => (x, 0, c),
        _ => (c, 0, x),
    };
    let m = l - c / 2;
    let ch = |v: i64| (v + m).clamp(0, 255) as u32;
    (ch(r1) << 24) | (ch(g1) << 16) | (ch(b1) << 8) | 0xff
}

/// The neutral player slot or 0 (presentation helpers).
#[allow(dead_code)]
pub(crate) const NO_PLAYER: u8 = NEUTRAL;
