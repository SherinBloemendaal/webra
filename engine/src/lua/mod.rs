//! A deterministic Lua 5.1 interpreter for mission scripts.
//!
//! OpenRA runs map scripts with Lua 5.1 (Eluant). WebRA needs them inside the
//! lockstep simulation, compiled to WebAssembly, so this is a small
//! interpreter written for that (docs/contracts.md section 9 explains the
//! choice):
//!
//! - **Deterministic.** Numbers are IEEE doubles, as in Lua 5.1, but only
//!   operations that are exactly rounded on every platform are used (+, -,
//!   *, /, sqrt, floor; transcendental functions come from `libm`, a pure
//!   Rust port of musl's, never from the platform). Number to string goes
//!   through Rust's exact formatting. Tables iterate in insertion order, and
//!   heap objects live in index arenas, so `tostring(t)`, `pairs` order and
//!   the state hash are the same on every machine.
//! - **Bounded.** Each run gets an instruction budget (statements, loop
//!   iterations and calls; library functions charge for their work), calls
//!   nest at most `MAX_DEPTH` deep and the heap has a size limit. Running out
//!   is an error no `pcall` can catch.
//! - **Sandboxed.** Only OpenRA's allowed globals exist: ipairs, next, pairs,
//!   pcall, select, tonumber, tostring, type, unpack, xpcall, math (without
//!   random and randomseed), string and table, plus print. There is no io,
//!   os, debug, load, require or coroutine.
//! - **Clone and Send**, so the World that owns it can be cloned and moved
//!   between threads like before.
//!
//! The garbage collector runs only between script runs (no script on the
//! stack), from the globals and the roots the host names.

mod ast;
mod heap;
pub(crate) mod interp;
mod lexer;
mod number;
mod parser;
mod stdlib;
mod strlib;

#[cfg(test)]
pub(crate) mod tests;

pub use ast::BinOp;
pub use number::{fmt_number, parse_number};

use heap::Heap;
use std::sync::Arc;

/// Lua strings are byte strings.
pub type LStr = Arc<[u8]>;

pub fn lstr(s: &str) -> LStr {
    Arc::from(s.as_bytes())
}

/// "No table bound" for `Value::Builtin`.
pub const NO_TABLE: u32 = u32::MAX;
/// Deepest call nesting (Lua functions and library calls).
pub const MAX_DEPTH: u32 = 120;
/// Native stack budget of one run, in levels: every recursive evaluation of
/// an expression, block or call nests the interpreter's Rust frames, so each
/// one takes levels and running out is a "stack overflow" error before the
/// real stack (1 MiB in WebAssembly) can run out. Sized from measured frame
/// costs (`tests.rs` `native_stack_per_level`: about 560 to 680 bytes per
/// level in an optimised build) so the deepest run fits in 384 KiB.
pub const MAX_LEVELS: u32 = 540;
/// Levels a call into a Lua function takes (its call and block frames).
pub const CALL_LEVELS: u32 = 3;
/// Levels a call into a library function takes.
pub const BUILTIN_LEVELS: u32 = 2;
/// Levels a call into the host (the mission API) takes: its frames are the
/// largest, and the host may call back into Lua (`Utils.Do`).
pub const HOST_LEVELS: u32 = 8;
/// Default instruction budget of one run.
pub const DEFAULT_BUDGET: i64 = 5_000_000;
/// Heap limit in slots (a table entry, a cell, a closure), roughly 16 bytes each.
pub const MAX_SLOTS: usize = 3_000_000;
/// Longest string a script can make.
pub const MAX_STRING: usize = 1 << 20;

/// A host object (actor, player, position, ...): a kind and three integers.
/// Plain data, so it compares, hashes and copies like a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct UserData {
    pub kind: u8,
    pub a: i32,
    pub b: i32,
    pub c: i32,
}

impl UserData {
    pub fn new(kind: u8, a: i32, b: i32, c: i32) -> UserData {
        UserData { kind, a, b, c }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Builtin {
    // Base library
    Ipairs,
    IpairsIter,
    Pairs,
    Next,
    Pcall,
    Xpcall,
    Select,
    Tonumber,
    Tostring,
    Type,
    Unpack,
    Print,
    // string
    SByte,
    SChar,
    SFind,
    SFormat,
    SGmatch,
    SGmatchIter,
    SGsub,
    SLen,
    SLower,
    SMatch,
    SRep,
    SReverse,
    SSub,
    SUpper,
    // table
    TConcat,
    TInsert,
    TMaxn,
    TRemove,
    TSort,
    TGetn,
    TForeach,
    TForeachi,
    // math
    MAbs,
    MAcos,
    MAsin,
    MAtan,
    MAtan2,
    MCeil,
    MCos,
    MCosh,
    MDeg,
    MExp,
    MFloor,
    MFmod,
    MFrexp,
    MLdexp,
    MLog,
    MLog10,
    MMax,
    MMin,
    MModf,
    MPow,
    MRad,
    MSin,
    MSinh,
    MSqrt,
    MTan,
    MTanh,
}

#[derive(Clone, Debug)]
pub enum Value {
    Nil,
    Bool(bool),
    Num(f64),
    Str(LStr),
    Table(u32),
    /// A Lua function (closure index).
    Func(u32),
    /// A library function; the table holds its state (string.gmatch), or NO_TABLE.
    Builtin(Builtin, u32),
    /// A host function, optionally bound to a host object (`actor.Move`).
    Host(u32, Option<UserData>),
    UserData(UserData),
    /// Internal: a frame slot holding a captured local's cell. Never a script value.
    Cell(u32),
}

impl Value {
    pub fn str(s: &str) -> Value {
        Value::Str(lstr(s))
    }

    pub fn truthy(&self) -> bool {
        !matches!(self, Value::Nil | Value::Bool(false))
    }

    pub fn is_nil(&self) -> bool {
        matches!(self, Value::Nil)
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Nil => "nil",
            Value::Bool(_) => "boolean",
            Value::Num(_) => "number",
            Value::Str(_) => "string",
            Value::Table(_) => "table",
            Value::Func(_) | Value::Builtin(..) | Value::Host(..) => "function",
            Value::UserData(_) => "userdata",
            Value::Cell(_) => "cell",
        }
    }

    /// The number, also from a numeric string (Lua's coercion).
    pub fn to_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            Value::Str(s) => std::str::from_utf8(s).ok().and_then(parse_number),
            _ => None,
        }
    }

    /// Text of a string or number (Lua's coercion), else None.
    pub fn to_text(&self) -> Option<String> {
        match self {
            Value::Str(s) => Some(String::from_utf8_lossy(s).into_owned()),
            Value::Num(n) => Some(fmt_number(*n)),
            _ => None,
        }
    }

    pub fn as_userdata(&self) -> Option<UserData> {
        match self {
            Value::UserData(u) => Some(*u),
            _ => None,
        }
    }
}

/// Raw equality (no metamethods): numbers by value, strings by content,
/// host objects by their data, everything else by identity.
pub fn raw_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Nil, Value::Nil) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Num(x), Value::Num(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Table(x), Value::Table(y)) => x == y,
        (Value::Func(x), Value::Func(y)) => x == y,
        (Value::Builtin(x, s), Value::Builtin(y, t)) => x == y && s == t,
        (Value::Host(x, s), Value::Host(y, t)) => x == y && s == t,
        (Value::UserData(x), Value::UserData(y)) => x == y,
        _ => false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Syntax,
    /// A script error: `pcall` catches it.
    Runtime,
    /// The run used up its instruction budget: never caught.
    Budget,
    /// The heap limit was reached: never caught.
    Memory,
}

#[derive(Clone, Debug)]
pub struct LuaError {
    pub kind: ErrorKind,
    /// The error value (usually a message string).
    pub value: Value,
    /// Whether the message already says where it happened.
    pub located: bool,
    /// "chunk:line: in function 'name'" lines, innermost first.
    pub traceback: Vec<String>,
}

impl LuaError {
    pub fn runtime(msg: impl Into<String>) -> LuaError {
        LuaError { kind: ErrorKind::Runtime, value: Value::str(&msg.into()), located: false, traceback: Vec::new() }
    }

    pub fn syntax(msg: String) -> LuaError {
        LuaError { kind: ErrorKind::Syntax, value: Value::str(&msg), located: true, traceback: Vec::new() }
    }

    fn fatal(kind: ErrorKind, msg: &str) -> LuaError {
        LuaError { kind, value: Value::str(msg), located: false, traceback: Vec::new() }
    }

    pub fn catchable(&self) -> bool {
        matches!(self.kind, ErrorKind::Runtime)
    }

    pub fn message(&self) -> String {
        match &self.value {
            Value::Str(s) => String::from_utf8_lossy(s).into_owned(),
            Value::Num(n) => fmt_number(*n),
            Value::Nil => "nil".into(),
            v => format!("(error object is a {} value)", v.type_name()),
        }
    }

    /// The message and the traceback, for logs and the error screen.
    pub fn report(&self) -> String {
        let mut s = self.message();
        if !self.traceback.is_empty() {
            s.push_str("\nstack traceback:");
            for t in &self.traceback {
                s.push_str("\n\t");
                s.push_str(t);
            }
        }
        s
    }
}

impl std::fmt::Display for LuaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// What the interpreter asks of its embedder: host functions and objects.
pub trait Host {
    /// Call host function `id`, bound to `this` when it came from indexing a host object.
    fn call(&mut self, lua: &mut Lua, id: u32, this: Option<UserData>, args: Vec<Value>) -> Result<Vec<Value>, LuaError>;
    /// `obj[key]` for a host object.
    fn index(&mut self, lua: &mut Lua, obj: UserData, key: &Value) -> Result<Value, LuaError>;
    /// `obj[key] = value` for a host object.
    fn set_index(&mut self, lua: &mut Lua, obj: UserData, key: &Value, value: Value) -> Result<(), LuaError>;
    /// `tostring` of a host object.
    fn tostring(&mut self, lua: &Lua, obj: UserData) -> String;
    /// Arithmetic and comparisons where a host object is involved (`CPos + CVec`,
    /// `WDist < WDist`). None: not supported (an error for the script).
    fn arith(&mut self, op: BinOp, a: &Value, b: &Value) -> Option<Value>;
    /// Unary minus of a host object.
    fn negate(&mut self, _obj: UserData) -> Option<Value> {
        None
    }
    /// Name of a host function, for `tostring` and error messages.
    fn function_name(&self, id: u32) -> String;
    /// `print`: debug output, never simulation state.
    fn print(&mut self, _msg: &str) {}
}

/// A host for scripts that need nothing from outside (tests, tools).
pub struct NoHost;

impl Host for NoHost {
    fn call(&mut self, _: &mut Lua, _: u32, _: Option<UserData>, _: Vec<Value>) -> Result<Vec<Value>, LuaError> {
        Err(LuaError::runtime("no host functions"))
    }
    fn index(&mut self, _: &mut Lua, _: UserData, _: &Value) -> Result<Value, LuaError> {
        Ok(Value::Nil)
    }
    fn set_index(&mut self, _: &mut Lua, _: UserData, _: &Value, _: Value) -> Result<(), LuaError> {
        Err(LuaError::runtime("attempt to index a userdata value"))
    }
    fn tostring(&mut self, _: &Lua, obj: UserData) -> String {
        format!("userdata: {}", obj.kind)
    }
    fn arith(&mut self, _: BinOp, _: &Value, _: &Value) -> Option<Value> {
        None
    }
    fn function_name(&self, id: u32) -> String {
        format!("host function {id}")
    }
}

/// The interpreter state: heap, globals and the limits of the current run.
#[derive(Clone, Debug)]
pub struct Lua {
    pub(crate) heap: Heap,
    globals: u32,
    string_lib: u32,
    budget: i64,
    depth: u32,
    /// Native nesting in levels (`MAX_LEVELS`).
    levels: u32,
}

impl Default for Lua {
    fn default() -> Self {
        Lua::new()
    }
}

impl Lua {
    pub fn new() -> Lua {
        let mut heap = Heap::default();
        let globals = heap.new_table();
        let string_lib = heap.new_table();
        let mut lua = Lua { heap, globals, string_lib, budget: DEFAULT_BUDGET, depth: 0, levels: 0 };
        stdlib::open(&mut lua);
        lua
    }

    pub(crate) fn globals_table(&self) -> u32 {
        self.globals
    }

    pub(crate) fn string_table(&self) -> u32 {
        self.string_lib
    }

    /// Instruction budget for the next runs (each `call` and `exec` uses it up).
    pub fn set_budget(&mut self, budget: i64) {
        self.budget = budget;
    }

    pub fn budget(&self) -> i64 {
        self.budget
    }

    /// Use `n` instructions of the budget (library and host functions charge for their work).
    /// Spend `n` units of the budget (saturating: a huge `n` simply runs it out).
    pub fn charge(&mut self, n: u64) -> Result<(), LuaError> {
        self.budget = self.budget.saturating_sub(n.min(i64::MAX as u64) as i64);
        if self.budget < 0 {
            return Err(LuaError::fatal(ErrorKind::Budget, "script exceeded its instruction budget"));
        }
        Ok(())
    }

    pub(crate) fn check_memory(&self) -> Result<(), LuaError> {
        if self.heap.slots > MAX_SLOTS {
            return Err(LuaError::fatal(ErrorKind::Memory, "not enough memory"));
        }
        Ok(())
    }

    /// Run a chunk (a script file) in the global environment.
    pub fn exec(&mut self, host: &mut dyn Host, chunk: &str, src: &str) -> Result<Vec<Value>, LuaError> {
        let proto = parser::parse_chunk(chunk, src.as_bytes())?;
        let f = self.heap.new_closure(heap::Closure { proto, upvals: Vec::new() });
        self.call(host, &Value::Func(f), Vec::new())
    }

    /// Call a function value.
    pub fn call(&mut self, host: &mut dyn Host, f: &Value, args: Vec<Value>) -> Result<Vec<Value>, LuaError> {
        self.call_value(host, f, args)
    }

    pub fn global(&self, name: &str) -> Value {
        self.heap.tables.get(self.globals).get_str(name)
    }

    pub fn set_global(&mut self, name: &str, v: Value) {
        self.raw_set(self.globals, Value::str(name), v).expect("string keys are valid");
    }

    pub fn new_table(&mut self) -> Value {
        Value::Table(self.heap.new_table())
    }

    /// A table holding `items` at 1..n.
    pub fn array(&mut self, items: Vec<Value>) -> Value {
        let t = self.heap.new_table();
        for (i, v) in items.into_iter().enumerate() {
            self.raw_set(t, Value::Num((i + 1) as f64), v).expect("integer keys are valid");
        }
        Value::Table(t)
    }

    pub fn raw_get(&self, t: u32, k: &Value) -> Value {
        self.heap.tables.get(t).get(k)
    }

    pub fn raw_set(&mut self, t: u32, k: Value, v: Value) -> Result<(), LuaError> {
        let added = self.heap.tables.get_mut(t).set(k, v).map_err(LuaError::runtime)?;
        self.heap.slots += added;
        self.heap.allocated += added;
        Ok(())
    }

    pub fn length(&self, t: u32) -> usize {
        self.heap.tables.get(t).border()
    }

    /// Items 1..#t of a table.
    pub fn sequence(&self, t: u32) -> Vec<Value> {
        let tab = self.heap.tables.get(t);
        (1..=tab.border()).map(|i| tab.get_int(i)).collect()
    }

    /// Every (key, value) of a table, in iteration order.
    pub fn pairs(&self, t: u32) -> Vec<(Value, Value)> {
        let mut out = Vec::new();
        self.heap.tables.get(t).for_each(|k, v| out.push((k.clone(), v.clone())));
        out
    }

    /// Live heap objects (tables, functions, cells), for tests and diagnostics.
    pub fn heap_objects(&self) -> usize {
        self.heap.tables.live() + self.heap.closures.live() + self.heap.cells.live()
    }

    /// Collect garbage. Call only when no script is running; `roots` are the
    /// values the host keeps (trigger callbacks and the like).
    pub fn collect(&mut self, roots: &mut dyn Iterator<Item = Value>) {
        let own = [Value::Table(self.globals), Value::Table(self.string_lib)];
        self.heap.collect(&mut own.into_iter().chain(roots));
    }

    /// Collect when enough was allocated since the last collection.
    pub fn maybe_collect(&mut self, roots: &mut dyn Iterator<Item = Value>) -> bool {
        if self.heap.allocated > 20_000 + self.heap.slots / 2 {
            self.collect(roots);
            return true;
        }
        false
    }

    /// FNV-1a over the whole heap in index order: equal for equal script states.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |bytes: &[u8]| {
            for &b in bytes {
                h ^= b as u64;
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        };
        fn value_bytes(v: &Value, out: &mut Vec<u8>) {
            match v {
                Value::Nil => out.push(0),
                Value::Bool(b) => out.extend([1, *b as u8]),
                Value::Num(n) => {
                    out.push(2);
                    // NaN payloads differ between platforms; one NaN for all.
                    let bits = if n.is_nan() { f64::NAN.to_bits() } else { n.to_bits() };
                    out.extend(bits.to_le_bytes());
                }
                Value::Str(s) => {
                    out.push(3);
                    out.extend((s.len() as u32).to_le_bytes());
                    out.extend(s.iter());
                }
                Value::Table(t) => {
                    out.push(4);
                    out.extend(t.to_le_bytes());
                }
                Value::Func(f) => {
                    out.push(5);
                    out.extend(f.to_le_bytes());
                }
                Value::Builtin(b, t) => {
                    out.push(6);
                    out.extend((*b as u32).to_le_bytes());
                    out.extend(t.to_le_bytes());
                }
                Value::Host(id, ud) => {
                    out.push(7);
                    out.extend(id.to_le_bytes());
                    if let Some(u) = ud {
                        out.extend([u.kind]);
                        out.extend(u.a.to_le_bytes());
                        out.extend(u.b.to_le_bytes());
                        out.extend(u.c.to_le_bytes());
                    }
                }
                Value::UserData(u) => {
                    out.push(8);
                    out.extend([u.kind]);
                    out.extend(u.a.to_le_bytes());
                    out.extend(u.b.to_le_bytes());
                    out.extend(u.c.to_le_bytes());
                }
                Value::Cell(c) => {
                    out.push(9);
                    out.extend(c.to_le_bytes());
                }
            }
        }
        let mut buf = Vec::new();
        for (i, t) in self.heap.tables.items.iter().enumerate() {
            let Some(t) = t else { continue };
            buf.clear();
            buf.extend((i as u32).to_le_bytes());
            t.for_each(|k, v| {
                value_bytes(k, &mut buf);
                value_bytes(v, &mut buf);
            });
            mix(&buf);
        }
        for (i, c) in self.heap.closures.items.iter().enumerate() {
            let Some(c) = c else { continue };
            buf.clear();
            buf.extend((i as u32).to_le_bytes());
            buf.extend(c.proto.chunk.as_bytes());
            buf.extend(c.proto.line.to_le_bytes());
            for u in &c.upvals {
                buf.extend(u.to_le_bytes());
            }
            mix(&buf);
        }
        for (i, c) in self.heap.cells.items.iter().enumerate() {
            let Some(v) = c else { continue };
            buf.clear();
            buf.extend((i as u32).to_le_bytes());
            value_bytes(v, &mut buf);
            mix(&buf);
        }
        h
    }
}
