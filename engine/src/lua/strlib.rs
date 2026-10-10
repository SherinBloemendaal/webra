//! The string library of Lua 5.1, patterns included (a port of lstrlib.c's
//! matcher). Matching charges the instruction budget, so a pathological
//! pattern stops like any other runaway script.

use super::number::{fmt_e, fmt_f, fmt_g};
use super::stdlib::Args;
use super::{fmt_number, Builtin, ErrorKind, Host, Lua, LuaError, Value, MAX_STRING, NO_TABLE};

pub fn open(lua: &mut Lua, t: u32) {
    use Builtin::*;
    for (name, b) in [
        ("byte", SByte),
        ("char", SChar),
        ("find", SFind),
        ("format", SFormat),
        ("gmatch", SGmatch),
        ("gsub", SGsub),
        ("len", SLen),
        ("lower", SLower),
        ("match", SMatch),
        ("rep", SRep),
        ("reverse", SReverse),
        ("sub", SSub),
        ("upper", SUpper),
    ] {
        lua.raw_set(t, Value::str(name), Value::Builtin(b, NO_TABLE)).expect("string key");
    }
}

/// Lua 5.1 posrelat: negative positions count from the end.
fn posrelat(pos: i64, len: usize) -> i64 {
    if pos >= 0 {
        pos
    } else {
        len as i64 + pos + 1
    }
}

pub fn call(lua: &mut Lua, host: &mut dyn Host, b: Builtin, bound: u32, a: &Args) -> Result<Vec<Value>, LuaError> {
    use Builtin::*;
    match b {
        SLen => Ok(vec![Value::Num(a.bytes(0)?.len() as f64)]),
        SSub => {
            let s = a.bytes(0)?;
            let l = s.len();
            let i = posrelat(a.opt_int(1, 1)?, l).max(1);
            let j = posrelat(a.opt_int(2, -1)?, l).min(l as i64);
            let out = if i <= j { s[(i - 1) as usize..j as usize].to_vec() } else { Vec::new() };
            Ok(vec![lua.make_str(out)?])
        }
        SUpper | SLower => {
            let mut s = a.bytes(0)?;
            lua.charge(s.len() / 16)?;
            if b == SUpper {
                s.make_ascii_uppercase();
            } else {
                s.make_ascii_lowercase();
            }
            Ok(vec![lua.make_str(s)?])
        }
        SRep => {
            let s = a.bytes(0)?;
            let n = a.int(1)?;
            if n <= 0 || s.is_empty() {
                return Ok(vec![Value::str("")]);
            }
            if s.len() as i64 * n > MAX_STRING as i64 {
                return Err(LuaError::runtime("string length overflow"));
            }
            lua.charge(s.len() * n as usize / 16)?;
            Ok(vec![lua.make_str(s.repeat(n as usize))?])
        }
        SReverse => {
            let mut s = a.bytes(0)?;
            s.reverse();
            Ok(vec![lua.make_str(s)?])
        }
        SByte => {
            let s = a.bytes(0)?;
            let l = s.len();
            let i = posrelat(a.opt_int(1, 1)?, l).max(1);
            let j = posrelat(a.opt_int(2, i)?, l).min(l as i64);
            if i > j {
                return Ok(Vec::new());
            }
            Ok(s[(i - 1) as usize..j as usize].iter().map(|&c| Value::Num(c as f64)).collect())
        }
        SChar => {
            let mut out = Vec::with_capacity(a.v.len());
            for i in 0..a.v.len() {
                let c = a.int(i)?;
                if !(0..=255).contains(&c) {
                    return Err(a.bad(i, "invalid value"));
                }
                out.push(c as u8);
            }
            Ok(vec![lua.make_str(out)?])
        }
        SFind => find(lua, a, true),
        SMatch => find(lua, a, false),
        SGmatch => {
            let s = a.bytes(0)?;
            let p = a.bytes(1)?;
            // The iterator keeps its state in a table: subject, pattern, position.
            let state = lua.heap.new_table();
            lua.raw_set(state, Value::Num(1.0), lua_str(s))?;
            lua.raw_set(state, Value::Num(2.0), lua_str(p))?;
            lua.raw_set(state, Value::Num(3.0), Value::Num(0.0))?;
            Ok(vec![Value::Builtin(SGmatchIter, state)])
        }
        SGmatchIter => {
            let get = |lua: &Lua, i: f64| lua.raw_get(bound, &Value::Num(i));
            let (Value::Str(s), Value::Str(p), Value::Num(pos)) = (get(lua, 1.0), get(lua, 2.0), get(lua, 3.0)) else {
                return Err(LuaError::runtime("bad gmatch state"));
            };
            let mut src = pos as usize;
            while src <= s.len() {
                let mut ms = MatchState::new(&s, &p, lua.budget());
                let r = ms.do_match(src, 0);
                lua.charge(ms.steps)?;
                if let Some(e) = r? {
                    let next = if e == src { e + 1 } else { e };
                    lua.raw_set(bound, Value::Num(3.0), Value::Num(next as f64))?;
                    return ms.captures(Some(src), e, true);
                }
                src += 1;
            }
            lua.raw_set(bound, Value::Num(3.0), Value::Num((s.len() + 1) as f64))?;
            Ok(vec![Value::Nil])
        }
        SGsub => gsub(lua, host, a),
        SFormat => format(lua, a),
        _ => unreachable!("not a string function"),
    }
}

fn lua_str(b: Vec<u8>) -> Value {
    Value::Str(b.into())
}

fn has_specials(p: &[u8]) -> bool {
    p.iter().any(|c| b"^$*+?.([%-".contains(c))
}

fn find(lua: &mut Lua, a: &Args, find: bool) -> Result<Vec<Value>, LuaError> {
    let s = a.bytes(0)?;
    let p = a.bytes(1)?;
    let l = s.len() as i64;
    let mut init = posrelat(a.opt_int(2, 1)?, s.len()) - 1;
    if init < 0 {
        init = 0;
    } else if init > l {
        init = l;
    }
    let init = init as usize;
    lua.charge(s.len() / 16)?;
    if find && (a.get(3).truthy() || !has_specials(&p)) {
        // Plain search.
        if p.is_empty() {
            return Ok(vec![Value::Num(init as f64 + 1.0), Value::Num(init as f64)]);
        }
        if let Some(off) = s[init..].windows(p.len()).position(|w| w == p.as_slice()) {
            let start = init + off;
            return Ok(vec![Value::Num(start as f64 + 1.0), Value::Num((start + p.len()) as f64)]);
        }
        return Ok(vec![Value::Nil]);
    }
    let anchor = p.first() == Some(&b'^');
    let pstart = anchor as usize;
    let mut s1 = init;
    loop {
        let mut ms = MatchState::new(&s, &p, lua.budget());
        let r = ms.do_match(s1, pstart);
        lua.charge(ms.steps)?;
        if let Some(e) = r? {
            return if find {
                let mut out = vec![Value::Num(s1 as f64 + 1.0), Value::Num(e as f64)];
                out.extend(ms.captures(None, 0, false)?);
                Ok(out)
            } else {
                ms.captures(Some(s1), e, true)
            };
        }
        s1 += 1;
        if s1 > s.len() || anchor {
            return Ok(vec![Value::Nil]);
        }
    }
}

fn gsub(lua: &mut Lua, host: &mut dyn Host, a: &Args) -> Result<Vec<Value>, LuaError> {
    let s = a.bytes(0)?;
    let p = a.bytes(1)?;
    let repl = a.get(2);
    if !matches!(repl, Value::Str(_) | Value::Num(_) | Value::Table(_) | Value::Func(_) | Value::Builtin(..) | Value::Host(..)) {
        return Err(a.bad(2, &format!("string/function/table expected, got {}", if a.v.len() > 2 { repl.type_name() } else { "no value" })));
    }
    let max_n = a.opt_int(3, s.len() as i64 + 1)?;
    let anchor = p.first() == Some(&b'^');
    let pstart = anchor as usize;
    let mut out = Vec::new();
    let mut src = 0usize;
    let mut n = 0i64;
    while n < max_n {
        let mut ms = MatchState::new(&s, &p, lua.budget());
        let r = ms.do_match(src, pstart);
        lua.charge(ms.steps)?;
        let e = r?;
        if let Some(e) = e {
            n += 1;
            // The replacement for this match.
            let whole = &s[src..e];
            let value = match &repl {
                Value::Str(_) | Value::Num(_) => {
                    let r = a.bytes(2)?;
                    let mut buf = Vec::new();
                    let mut i = 0;
                    while i < r.len() {
                        if r[i] == b'%' && i + 1 < r.len() {
                            i += 1;
                            let d = r[i];
                            if !d.is_ascii_digit() {
                                buf.push(d);
                            } else if d == b'0' {
                                buf.extend_from_slice(whole);
                            } else {
                                let v = ms.one_capture((d - b'1') as usize, src, e)?;
                                match v {
                                    Value::Str(c) => buf.extend_from_slice(&c),
                                    Value::Num(x) => buf.extend(fmt_number(x).into_bytes()),
                                    _ => {}
                                }
                            }
                        } else {
                            buf.push(r[i]);
                        }
                        i += 1;
                    }
                    Some(buf)
                }
                Value::Table(t) => {
                    let k = ms.one_capture(0, src, e)?;
                    to_replacement(lua.raw_get(*t, &k))?
                }
                f => {
                    let caps = ms.captures(Some(src), e, true)?;
                    let r = lua.call_value(host, f, caps)?;
                    to_replacement(r.into_iter().next().unwrap_or(Value::Nil))?
                }
            };
            match value {
                Some(v) => out.extend(v),
                None => out.extend_from_slice(whole),
            }
            if out.len() > MAX_STRING {
                return Err(LuaError::runtime("string length overflow"));
            }
        }
        match e {
            Some(e) if e > src => src = e,
            _ if src < s.len() => {
                out.push(s[src]);
                src += 1;
            }
            _ => break,
        }
        if anchor {
            break;
        }
    }
    out.extend_from_slice(&s[src.min(s.len())..]);
    Ok(vec![lua.make_str(out)?, Value::Num(n as f64)])
}

fn to_replacement(v: Value) -> Result<Option<Vec<u8>>, LuaError> {
    match v {
        Value::Nil | Value::Bool(false) => Ok(None),
        Value::Str(s) => Ok(Some(s.to_vec())),
        Value::Num(n) => Ok(Some(fmt_number(n).into_bytes())),
        other => Err(LuaError::runtime(format!("invalid replacement value (a {})", other.type_name()))),
    }
}

// ---- Pattern matching (lstrlib.c) -------------------------------------------

const MAX_CAPTURES: usize = 32;
const CAP_UNFINISHED: isize = -1;
const CAP_POSITION: isize = -2;
const MAX_MATCH_DEPTH: u32 = 200;

struct MatchState<'a> {
    src: &'a [u8],
    pat: &'a [u8],
    level: usize,
    capture: [(usize, isize); MAX_CAPTURES],
    depth: u32,
    steps: usize,
    limit: usize,
}

fn class_matches(c: u8, cl: u8) -> bool {
    let res = match cl.to_ascii_lowercase() {
        b'a' => c.is_ascii_alphabetic(),
        b'c' => c.is_ascii_control(),
        b'd' => c.is_ascii_digit(),
        b'l' => c.is_ascii_lowercase(),
        b'p' => c.is_ascii_punctuation(),
        b's' => matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'),
        b'u' => c.is_ascii_uppercase(),
        b'w' => c.is_ascii_alphanumeric(),
        b'x' => c.is_ascii_hexdigit(),
        b'z' => c == 0,
        _ => return cl == c,
    };
    if cl.is_ascii_uppercase() {
        !res
    } else {
        res
    }
}

impl<'a> MatchState<'a> {
    fn new(src: &'a [u8], pat: &'a [u8], budget: i64) -> MatchState<'a> {
        MatchState { src, pat, level: 0, capture: [(0, 0); MAX_CAPTURES], depth: 0, steps: 0, limit: budget.max(0) as usize }
    }

    fn pat_at(&self, p: usize) -> u8 {
        self.pat.get(p).copied().unwrap_or(0)
    }

    fn step(&mut self) -> Result<(), LuaError> {
        self.steps += 1;
        if self.steps > self.limit {
            return Err(LuaError { kind: ErrorKind::Budget, ..LuaError::runtime("script exceeded its instruction budget") });
        }
        Ok(())
    }

    fn class_end(&self, mut p: usize) -> Result<usize, LuaError> {
        let c = self.pat_at(p);
        p += 1;
        match c {
            b'%' => {
                if p >= self.pat.len() {
                    return Err(LuaError::runtime("malformed pattern (ends with '%')"));
                }
                Ok(p + 1)
            }
            b'[' => {
                if self.pat_at(p) == b'^' {
                    p += 1;
                }
                loop {
                    if p >= self.pat.len() {
                        return Err(LuaError::runtime("malformed pattern (missing ']')"));
                    }
                    let c = self.pat[p];
                    p += 1;
                    if c == b'%' && p < self.pat.len() {
                        p += 1;
                    }
                    if self.pat_at(p) == b']' && p < self.pat.len() {
                        return Ok(p + 1);
                    }
                }
            }
            _ => Ok(p),
        }
    }

    /// `c` against the class [p, ec] where pat[p] is '[' and pat[ec] is ']'.
    fn bracket_class(&self, c: u8, mut p: usize, ec: usize) -> bool {
        let mut sig = true;
        if self.pat_at(p + 1) == b'^' {
            sig = false;
            p += 1;
        }
        p += 1;
        while p < ec {
            if self.pat[p] == b'%' {
                p += 1;
                if class_matches(c, self.pat_at(p)) {
                    return sig;
                }
            } else if self.pat_at(p + 1) == b'-' && p + 2 < ec {
                if self.pat[p] <= c && c <= self.pat[p + 2] {
                    return sig;
                }
                p += 2;
            } else if self.pat[p] == c {
                return sig;
            }
            p += 1;
        }
        !sig
    }

    fn single_match(&self, c: u8, p: usize, ep: usize) -> bool {
        match self.pat_at(p) {
            b'.' => true,
            b'%' => class_matches(c, self.pat_at(p + 1)),
            b'[' => self.bracket_class(c, p, ep - 1),
            pc => pc == c,
        }
    }

    fn do_match(&mut self, s: usize, p: usize) -> Result<Option<usize>, LuaError> {
        self.depth += 1;
        if self.depth > MAX_MATCH_DEPTH {
            return Err(LuaError::runtime("pattern too complex"));
        }
        let r = self.match_inner(s, p);
        self.depth -= 1;
        r
    }

    fn match_inner(&mut self, mut s: usize, mut p: usize) -> Result<Option<usize>, LuaError> {
        loop {
            self.step()?;
            if p >= self.pat.len() {
                return Ok(Some(s));
            }
            match self.pat[p] {
                b'(' => {
                    return if self.pat_at(p + 1) == b')' {
                        self.start_capture(s, p + 2, CAP_POSITION)
                    } else {
                        self.start_capture(s, p + 1, CAP_UNFINISHED)
                    };
                }
                b')' => return self.end_capture(s, p + 1),
                b'%' if self.pat_at(p + 1) == b'b' => match self.match_balance(s, p + 2)? {
                    Some(ns) => {
                        s = ns;
                        p += 4;
                        continue;
                    }
                    None => return Ok(None),
                },
                b'%' if self.pat_at(p + 1) == b'f' => {
                    p += 2;
                    if self.pat_at(p) != b'[' {
                        return Err(LuaError::runtime("missing '[' after '%f' in pattern"));
                    }
                    let ep = self.class_end(p)?;
                    let prev = if s == 0 { 0 } else { self.src[s - 1] };
                    let cur = self.src.get(s).copied().unwrap_or(0);
                    if self.bracket_class(prev, p, ep - 1) || !self.bracket_class(cur, p, ep - 1) {
                        return Ok(None);
                    }
                    p = ep;
                    continue;
                }
                b'%' if self.pat_at(p + 1).is_ascii_digit() => match self.match_capture(s, self.pat_at(p + 1))? {
                    Some(ns) => {
                        s = ns;
                        p += 2;
                        continue;
                    }
                    None => return Ok(None),
                },
                b'$' if p + 1 == self.pat.len() => return Ok((s == self.src.len()).then_some(s)),
                _ => {}
            }
            let ep = self.class_end(p)?;
            let m = s < self.src.len() && self.single_match(self.src[s], p, ep);
            match self.pat_at(ep) {
                b'?' if ep < self.pat.len() => {
                    if m {
                        if let Some(r) = self.do_match(s + 1, ep + 1)? {
                            return Ok(Some(r));
                        }
                    }
                    p = ep + 1;
                }
                b'*' if ep < self.pat.len() => return self.max_expand(s, p, ep),
                b'+' if ep < self.pat.len() => return if m { self.max_expand(s + 1, p, ep) } else { Ok(None) },
                b'-' if ep < self.pat.len() => return self.min_expand(s, p, ep),
                _ => {
                    if !m {
                        return Ok(None);
                    }
                    s += 1;
                    p = ep;
                }
            }
        }
    }

    fn max_expand(&mut self, s: usize, p: usize, ep: usize) -> Result<Option<usize>, LuaError> {
        let mut i = 0;
        while s + i < self.src.len() && self.single_match(self.src[s + i], p, ep) {
            self.step()?;
            i += 1;
        }
        loop {
            if let Some(r) = self.do_match(s + i, ep + 1)? {
                return Ok(Some(r));
            }
            if i == 0 {
                return Ok(None);
            }
            i -= 1;
        }
    }

    fn min_expand(&mut self, mut s: usize, p: usize, ep: usize) -> Result<Option<usize>, LuaError> {
        loop {
            if let Some(r) = self.do_match(s, ep + 1)? {
                return Ok(Some(r));
            }
            if s < self.src.len() && self.single_match(self.src[s], p, ep) {
                s += 1;
            } else {
                return Ok(None);
            }
        }
    }

    fn start_capture(&mut self, s: usize, p: usize, what: isize) -> Result<Option<usize>, LuaError> {
        if self.level >= MAX_CAPTURES {
            return Err(LuaError::runtime("too many captures"));
        }
        self.capture[self.level] = (s, what);
        self.level += 1;
        let r = self.do_match(s, p)?;
        if r.is_none() {
            self.level -= 1;
        }
        Ok(r)
    }

    fn end_capture(&mut self, s: usize, p: usize) -> Result<Option<usize>, LuaError> {
        let l = (0..self.level)
            .rev()
            .find(|&l| self.capture[l].1 == CAP_UNFINISHED)
            .ok_or_else(|| LuaError::runtime("invalid pattern capture"))?;
        self.capture[l].1 = (s - self.capture[l].0) as isize;
        let r = self.do_match(s, p)?;
        if r.is_none() {
            self.capture[l].1 = CAP_UNFINISHED;
        }
        Ok(r)
    }

    fn match_balance(&mut self, mut s: usize, p: usize) -> Result<Option<usize>, LuaError> {
        if p + 1 >= self.pat.len() {
            return Err(LuaError::runtime("unbalanced pattern"));
        }
        if s >= self.src.len() || self.src[s] != self.pat[p] {
            return Ok(None);
        }
        let (b, e) = (self.pat[p], self.pat[p + 1]);
        let mut cont = 1;
        s += 1;
        while s < self.src.len() {
            self.step()?;
            if self.src[s] == e {
                cont -= 1;
                if cont == 0 {
                    return Ok(Some(s + 1));
                }
            } else if self.src[s] == b {
                cont += 1;
            }
            s += 1;
        }
        Ok(None)
    }

    fn match_capture(&mut self, s: usize, d: u8) -> Result<Option<usize>, LuaError> {
        let l = d as isize - b'1' as isize;
        if l < 0 || l as usize >= self.level || self.capture[l as usize].1 == CAP_UNFINISHED {
            return Err(LuaError::runtime("invalid capture index"));
        }
        let (start, len) = self.capture[l as usize];
        let len = len.max(0) as usize;
        if self.src.len() - s >= len && self.src[start..start + len] == self.src[s..s + len] {
            Ok(Some(s + len))
        } else {
            Ok(None)
        }
    }

    fn one_capture(&self, i: usize, s: usize, e: usize) -> Result<Value, LuaError> {
        if i >= self.level {
            if i == 0 {
                return Ok(Value::Str(self.src[s..e].into()));
            }
            return Err(LuaError::runtime("invalid capture index"));
        }
        let (start, len) = self.capture[i];
        match len {
            CAP_UNFINISHED => Err(LuaError::runtime("unfinished capture")),
            CAP_POSITION => Ok(Value::Num(start as f64 + 1.0)),
            l => Ok(Value::Str(self.src[start..start + l as usize].into())),
        }
    }

    /// Captures of a match (the whole match when the pattern has none and `whole_if_none`).
    fn captures(&self, s: Option<usize>, e: usize, whole_if_none: bool) -> Result<Vec<Value>, LuaError> {
        let n = if self.level == 0 && whole_if_none { 1 } else { self.level };
        (0..n).map(|i| self.one_capture(i, s.unwrap_or(0), e)).collect()
    }
}

// ---- string.format -----------------------------------------------------------

struct Spec {
    minus: bool,
    plus: bool,
    space: bool,
    alt: bool,
    zero: bool,
    width: usize,
    precision: Option<usize>,
}

fn pad(spec: &Spec, sign: &str, body: &str, zero_ok: bool) -> String {
    let len = sign.len() + body.len();
    if len >= spec.width {
        return format!("{sign}{body}");
    }
    let fill = spec.width - len;
    if spec.minus {
        format!("{sign}{body}{}", " ".repeat(fill))
    } else if spec.zero && zero_ok {
        format!("{sign}{}{body}", "0".repeat(fill))
    } else {
        format!("{}{sign}{body}", " ".repeat(fill))
    }
}

fn format(lua: &mut Lua, a: &Args) -> Result<Vec<Value>, LuaError> {
    let f = a.bytes(0)?;
    let mut out: Vec<u8> = Vec::new();
    let mut arg = 0;
    let mut i = 0;
    while i < f.len() {
        let c = f[i];
        i += 1;
        if c != b'%' {
            out.push(c);
            continue;
        }
        if i < f.len() && f[i] == b'%' {
            out.push(b'%');
            i += 1;
            continue;
        }
        // Flags, width and precision as Lua 5.1 accepts them.
        let start = i;
        let mut spec = Spec { minus: false, plus: false, space: false, alt: false, zero: false, width: 0, precision: None };
        while i < f.len() && b"-+ #0".contains(&f[i]) {
            match f[i] {
                b'-' => spec.minus = true,
                b'+' => spec.plus = true,
                b' ' => spec.space = true,
                b'#' => spec.alt = true,
                _ => spec.zero = true,
            }
            i += 1;
        }
        if i - start > 5 {
            return Err(LuaError::runtime("invalid format (repeated flags)"));
        }
        let digits = |i: &mut usize| -> Result<Option<usize>, LuaError> {
            let s = *i;
            while *i < f.len() && f[*i].is_ascii_digit() {
                *i += 1;
            }
            if *i - s > 2 {
                return Err(LuaError::runtime("invalid format (width or precision too long)"));
            }
            Ok((*i > s).then(|| std::str::from_utf8(&f[s..*i]).unwrap().parse().unwrap()))
        };
        spec.width = digits(&mut i)?.unwrap_or(0);
        if i < f.len() && f[i] == b'.' {
            i += 1;
            spec.precision = Some(digits(&mut i)?.unwrap_or(0));
        }
        let Some(&conv) = f.get(i) else {
            return Err(LuaError::runtime("invalid option '%' to 'format'"));
        };
        i += 1;
        arg += 1;
        let need = |arg: usize| -> Result<(), LuaError> {
            if arg >= a.v.len() {
                Err(a.bad(arg, "no value"))
            } else {
                Ok(())
            }
        };
        let piece = match conv {
            b'c' => {
                need(arg)?;
                let ch = (a.num(arg)? as i64) as u8;
                let fill = spec.width.saturating_sub(1);
                if !spec.minus {
                    out.extend(std::iter::repeat_n(b' ', fill));
                }
                out.push(ch);
                if spec.minus {
                    out.extend(std::iter::repeat_n(b' ', fill));
                }
                continue;
            }
            b'd' | b'i' | b'o' | b'u' | b'x' | b'X' => {
                need(arg)?;
                let x = a.num(arg)?;
                let v = if x.is_finite() { x.trunc().clamp(i64::MIN as f64, i64::MAX as f64) as i64 } else { 0 };
                let mut digits = match conv {
                    b'd' | b'i' => v.unsigned_abs().to_string(),
                    b'o' => format!("{:o}", v as u64),
                    b'u' => (v as u64).to_string(),
                    b'x' => format!("{:x}", v as u64),
                    _ => format!("{:X}", v as u64),
                };
                if let Some(p) = spec.precision {
                    if p == 0 && v == 0 {
                        digits.clear();
                    } else if digits.len() < p {
                        digits = format!("{}{digits}", "0".repeat(p - digits.len()));
                    }
                }
                let sign = match conv {
                    b'd' | b'i' if v < 0 => "-",
                    b'd' | b'i' if spec.plus => "+",
                    b'd' | b'i' if spec.space => " ",
                    b'x' if spec.alt && v != 0 => "0x",
                    b'X' if spec.alt && v != 0 => "0X",
                    _ => "",
                };
                if conv == b'o' && spec.alt && !digits.starts_with('0') {
                    digits.insert(0, '0');
                }
                pad(&spec, sign, &digits, spec.precision.is_none())
            }
            b'e' | b'E' | b'f' | b'g' | b'G' => {
                need(arg)?;
                let x = a.num(arg)?;
                let p = spec.precision.unwrap_or(6);
                let body = match conv {
                    b'e' => fmt_e(x, p, false),
                    b'E' => fmt_e(x, p, true),
                    b'f' => fmt_f(x, p),
                    b'g' => fmt_g(x, p, false, spec.alt),
                    _ => fmt_g(x, p, true, spec.alt),
                };
                let (sign, body) = match body.strip_prefix('-') {
                    Some(rest) => ("-", rest.to_string()),
                    None if spec.plus => ("+", body),
                    None if spec.space => (" ", body),
                    None => ("", body),
                };
                pad(&spec, sign, &body, x.is_finite())
            }
            b'q' => {
                need(arg)?;
                let s = a.bytes(arg)?;
                out.push(b'"');
                for &ch in &s {
                    match ch {
                        b'"' | b'\\' | b'\n' => {
                            out.push(b'\\');
                            out.push(ch);
                        }
                        b'\r' => out.extend_from_slice(b"\\r"),
                        0 => out.extend_from_slice(b"\\000"),
                        _ => out.push(ch),
                    }
                }
                out.push(b'"');
                continue;
            }
            b's' => {
                need(arg)?;
                // Lua 5.1 takes strings and numbers only here.
                let mut s = a.bytes(arg)?;
                if let Some(p) = spec.precision {
                    s.truncate(p);
                }
                let s = String::from_utf8_lossy(&s).into_owned();
                pad(&Spec { zero: false, ..spec }, "", &s, false)
            }
            other => return Err(LuaError::runtime(format!("invalid option '%{}' to 'format'", other as char))),
        };
        out.extend(piece.into_bytes());
        if out.len() > MAX_STRING {
            return Err(LuaError::runtime("string length overflow"));
        }
    }
    lua.charge(out.len() / 16)?;
    Ok(vec![lua.make_str(out)?])
}
