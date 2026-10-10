//! The base, table and math libraries in OpenRA's sandbox (string is in strlib.rs).

use super::{fmt_number, strlib, BinOp, Builtin, Host, Lua, LuaError, Value, NO_TABLE};

/// Results `unpack` and `select` may produce at most.
const MAX_RESULTS: usize = 8000;

pub fn open(lua: &mut Lua) {
    use Builtin::*;
    let g = lua.globals_table();
    let set = |lua: &mut Lua, t: u32, name: &str, v: Value| lua.raw_set(t, Value::str(name), v).expect("string key");
    for (name, b) in [
        ("ipairs", Ipairs),
        ("next", Next),
        ("pairs", Pairs),
        ("pcall", Pcall),
        ("select", Select),
        ("tonumber", Tonumber),
        ("tostring", Tostring),
        ("type", Type),
        ("unpack", Unpack),
        ("xpcall", Xpcall),
        ("print", Print),
    ] {
        set(lua, g, name, Value::Builtin(b, NO_TABLE));
    }
    let table = lua.heap.new_table();
    for (name, b) in [
        ("concat", TConcat),
        ("insert", TInsert),
        ("maxn", TMaxn),
        ("remove", TRemove),
        ("sort", TSort),
        ("getn", TGetn),
        ("foreach", TForeach),
        ("foreachi", TForeachi),
    ] {
        set(lua, table, name, Value::Builtin(b, NO_TABLE));
    }
    set(lua, g, "table", Value::Table(table));
    let math = lua.heap.new_table();
    for (name, b) in [
        ("abs", MAbs),
        ("acos", MAcos),
        ("asin", MAsin),
        ("atan", MAtan),
        ("atan2", MAtan2),
        ("ceil", MCeil),
        ("cos", MCos),
        ("cosh", MCosh),
        ("deg", MDeg),
        ("exp", MExp),
        ("floor", MFloor),
        ("fmod", MFmod),
        ("frexp", MFrexp),
        ("ldexp", MLdexp),
        ("log", MLog),
        ("log10", MLog10),
        ("max", MMax),
        ("min", MMin),
        ("modf", MModf),
        ("pow", MPow),
        ("rad", MRad),
        ("sin", MSin),
        ("sinh", MSinh),
        ("sqrt", MSqrt),
        ("tan", MTan),
        ("tanh", MTanh),
    ] {
        set(lua, math, name, Value::Builtin(b, NO_TABLE));
    }
    set(lua, math, "pi", Value::Num(std::f64::consts::PI));
    set(lua, math, "huge", Value::Num(f64::INFINITY));
    set(lua, g, "math", Value::Table(math));
    let string = lua.string_table();
    strlib::open(lua, string);
    set(lua, g, "string", Value::Table(string));
}

pub fn name(b: Builtin) -> &'static str {
    use Builtin::*;
    match b {
        Ipairs => "ipairs",
        IpairsIter => "ipairs_iterator",
        Pairs => "pairs",
        Next => "next",
        Pcall => "pcall",
        Xpcall => "xpcall",
        Select => "select",
        Tonumber => "tonumber",
        Tostring => "tostring",
        Type => "type",
        Unpack => "unpack",
        Print => "print",
        SByte => "byte",
        SChar => "char",
        SFind => "find",
        SFormat => "format",
        SGmatch => "gmatch",
        SGmatchIter => "gmatch_iterator",
        SGsub => "gsub",
        SLen => "len",
        SLower => "lower",
        SMatch => "match",
        SRep => "rep",
        SReverse => "reverse",
        SSub => "sub",
        SUpper => "upper",
        TConcat => "concat",
        TInsert => "insert",
        TMaxn => "maxn",
        TRemove => "remove",
        TSort => "sort",
        TGetn => "getn",
        TForeach => "foreach",
        TForeachi => "foreachi",
        MAbs => "abs",
        MAcos => "acos",
        MAsin => "asin",
        MAtan => "atan",
        MAtan2 => "atan2",
        MCeil => "ceil",
        MCos => "cos",
        MCosh => "cosh",
        MDeg => "deg",
        MExp => "exp",
        MFloor => "floor",
        MFmod => "fmod",
        MFrexp => "frexp",
        MLdexp => "ldexp",
        MLog => "log",
        MLog10 => "log10",
        MMax => "max",
        MMin => "min",
        MModf => "modf",
        MPow => "pow",
        MRad => "rad",
        MSin => "sin",
        MSinh => "sinh",
        MSqrt => "sqrt",
        MTan => "tan",
        MTanh => "tanh",
    }
}

/// Argument helpers with Lua's messages ("bad argument #1 to 'insert' (table expected, got nil)").
pub struct Args<'a> {
    pub name: &'static str,
    pub v: &'a [Value],
}

impl Args<'_> {
    pub fn get(&self, i: usize) -> Value {
        self.v.get(i).cloned().unwrap_or(Value::Nil)
    }

    pub fn bad(&self, i: usize, msg: &str) -> LuaError {
        LuaError::runtime(format!("bad argument #{} to '{}' ({msg})", i + 1, self.name))
    }

    fn expected(&self, i: usize, what: &str) -> LuaError {
        let got = self.v.get(i).map_or("no value", Value::type_name);
        self.bad(i, &format!("{what} expected, got {got}"))
    }

    pub fn num(&self, i: usize) -> Result<f64, LuaError> {
        self.v.get(i).and_then(Value::to_num).ok_or_else(|| self.expected(i, "number"))
    }

    /// An integer argument (truncated toward zero, as lua_tointeger does).
    pub fn int(&self, i: usize) -> Result<i64, LuaError> {
        let n = self.num(i)?;
        Ok(if n.is_finite() { n.trunc().clamp(i64::MIN as f64, i64::MAX as f64) as i64 } else { 0 })
    }

    pub fn opt_int(&self, i: usize, default: i64) -> Result<i64, LuaError> {
        match self.v.get(i) {
            None | Some(Value::Nil) => Ok(default),
            Some(_) => self.int(i),
        }
    }

    pub fn table(&self, i: usize) -> Result<u32, LuaError> {
        match self.v.get(i) {
            Some(Value::Table(t)) => Ok(*t),
            _ => Err(self.expected(i, "table")),
        }
    }

    /// Bytes of a string (numbers are converted, as Lua does).
    pub fn bytes(&self, i: usize) -> Result<Vec<u8>, LuaError> {
        match self.v.get(i) {
            Some(Value::Str(s)) => Ok(s.to_vec()),
            Some(Value::Num(n)) => Ok(fmt_number(*n).into_bytes()),
            _ => Err(self.expected(i, "string")),
        }
    }

    pub fn any(&self, i: usize) -> Result<Value, LuaError> {
        self.v.get(i).cloned().ok_or_else(|| self.bad(i, "value expected"))
    }

    pub fn func(&self, i: usize) -> Result<Value, LuaError> {
        match self.v.get(i) {
            Some(f @ (Value::Func(_) | Value::Builtin(..) | Value::Host(..))) => Ok(f.clone()),
            _ => Err(self.expected(i, "function")),
        }
    }
}

/// `tostring` with Lua's formats; heap objects print their arena index.
pub fn tostring(lua: &Lua, host: &mut dyn Host, v: &Value) -> String {
    match v {
        Value::Nil => "nil".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => fmt_number(*n),
        Value::Str(s) => String::from_utf8_lossy(s).into_owned(),
        Value::Table(t) => format!("table: 0x{t:08x}"),
        Value::Func(f) => format!("function: 0x{f:08x}"),
        Value::Builtin(b, _) => format!("function: builtin: {}", name(*b)),
        Value::Host(id, _) => format!("function: {}", host.function_name(*id)),
        Value::UserData(u) => host.tostring(lua, *u),
        Value::Cell(_) => "cell".into(),
    }
}

/// Lua's `<` for sorting: numbers and strings.
fn sort_less(lua: &mut Lua, host: &mut dyn Host, cmp: &Value, a: &Value, b: &Value) -> Result<bool, LuaError> {
    if cmp.is_nil() {
        Ok(lua.binary(host, BinOp::Lt, a, b)?.truthy())
    } else {
        Ok(lua.call_value(host, cmp, vec![a.clone(), b.clone()])?.first().is_some_and(Value::truthy))
    }
}

/// Stable merge sort with the script's comparison (deterministic for any
/// comparator, also an inconsistent one).
fn merge_sort(lua: &mut Lua, host: &mut dyn Host, cmp: &Value, items: Vec<Value>) -> Result<Vec<Value>, LuaError> {
    if items.len() <= 1 {
        return Ok(items);
    }
    let mut right = items;
    let left = right.drain(..right.len() / 2).collect();
    let left = merge_sort(lua, host, cmp, left)?;
    let right = merge_sort(lua, host, cmp, right)?;
    let mut out = Vec::with_capacity(left.len() + right.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        lua.charge(1)?;
        if sort_less(lua, host, cmp, &right[j], &left[i])? {
            out.push(right[j].clone());
            j += 1;
        } else {
            out.push(left[i].clone());
            i += 1;
        }
    }
    out.extend_from_slice(&left[i..]);
    out.extend_from_slice(&right[j..]);
    Ok(out)
}

fn one(v: Value) -> Result<Vec<Value>, LuaError> {
    Ok(vec![v])
}

pub fn call(lua: &mut Lua, host: &mut dyn Host, b: Builtin, bound: u32, args: Vec<Value>) -> Result<Vec<Value>, LuaError> {
    use Builtin::*;
    let a = Args { name: name(b), v: &args };
    let math1 = |f: fn(f64) -> f64| -> Result<Vec<Value>, LuaError> { one(Value::Num(f(a.num(0)?))) };
    match b {
        Ipairs => {
            let t = a.table(0)?;
            Ok(vec![Value::Builtin(IpairsIter, NO_TABLE), Value::Table(t), Value::Num(0.0)])
        }
        IpairsIter => {
            let t = a.table(0)?;
            let i = a.num(1)? + 1.0;
            let v = lua.raw_get(t, &Value::Num(i));
            Ok(if v.is_nil() { vec![Value::Nil] } else { vec![Value::Num(i), v] })
        }
        Pairs => {
            let t = a.table(0)?;
            Ok(vec![Value::Builtin(Next, NO_TABLE), Value::Table(t), Value::Nil])
        }
        Next => {
            let t = a.table(0)?;
            match lua.heap.tables.get(t).next(&a.get(1)).map_err(LuaError::runtime)? {
                Some((k, v)) => Ok(vec![k, v]),
                None => one(Value::Nil),
            }
        }
        Pcall => {
            let f = a.any(0)?;
            match lua.call_value(host, &f, args[1..].to_vec()) {
                Ok(mut r) => {
                    r.insert(0, Value::Bool(true));
                    Ok(r)
                }
                Err(e) if e.catchable() => Ok(vec![Value::Bool(false), e.value]),
                Err(e) => Err(e),
            }
        }
        Xpcall => {
            let f = a.any(0)?;
            let handler = a.get(1);
            match lua.call_value(host, &f, Vec::new()) {
                Ok(mut r) => {
                    r.insert(0, Value::Bool(true));
                    Ok(r)
                }
                Err(e) if e.catchable() => {
                    let mut r = lua.call_value(host, &handler, vec![e.value])?;
                    r.insert(0, Value::Bool(false));
                    Ok(r)
                }
                Err(e) => Err(e),
            }
        }
        Select => {
            let rest = &args[1.min(args.len())..];
            if matches!(a.get(0), Value::Str(ref s) if &**s == b"#") {
                return one(Value::Num(rest.len() as f64));
            }
            let n = a.int(0)?;
            let start = if n < 0 {
                if -n > rest.len() as i64 {
                    return Err(a.bad(0, "index out of range"));
                }
                rest.len() as i64 + n
            } else if n == 0 {
                return Err(a.bad(0, "index out of range"));
            } else {
                n - 1
            };
            Ok(rest.iter().skip(start as usize).cloned().collect())
        }
        Tonumber => {
            let base = a.opt_int(1, 10)?;
            if base == 10 {
                return one(a.get(0).to_num().map_or(Value::Nil, Value::Num));
            }
            if !(2..=36).contains(&base) {
                return Err(a.bad(1, "base out of range"));
            }
            let s = a.bytes(0)?;
            let text = String::from_utf8_lossy(&s);
            let t = text.trim_matches(|c: char| c == ' ' || ('\t'..='\r').contains(&c));
            let (neg, digits) = match t.strip_prefix('-') {
                Some(d) => (true, d),
                None => (false, t),
            };
            let mut v = 0.0f64;
            for c in digits.chars() {
                match c.to_digit(base as u32) {
                    Some(d) => v = v * base as f64 + d as f64,
                    None => return one(Value::Nil),
                }
            }
            one(if digits.is_empty() { Value::Nil } else { Value::Num(if neg { -v } else { v }) })
        }
        Tostring => {
            let v = a.any(0)?;
            let s = tostring(lua, host, &v);
            one(Value::str(&s))
        }
        Type => one(Value::str(a.any(0)?.type_name())),
        Unpack => {
            let t = a.table(0)?;
            let i = a.opt_int(1, 1)?;
            let j = match a.get(2) {
                Value::Nil => lua.length(t) as i64,
                _ => a.int(2)?,
            };
            if i > j {
                return Ok(Vec::new());
            }
            if j - i >= MAX_RESULTS as i64 {
                return Err(LuaError::runtime("too many results to unpack"));
            }
            lua.charge((j - i) as usize)?;
            Ok((i..=j).map(|k| lua.raw_get(t, &Value::Num(k as f64))).collect())
        }
        Print => {
            let parts: Vec<String> = args.iter().map(|v| tostring(lua, host, v)).collect();
            host.print(&parts.join("\t"));
            Ok(Vec::new())
        }
        // ---- table ----
        TInsert => {
            let t = a.table(0)?;
            let n = lua.length(t);
            let added = match args.len() {
                2 => lua.heap.tables.get_mut(t).set(Value::Num((n + 1) as f64), a.get(1)).map_err(LuaError::runtime)?,
                3 => {
                    let pos = a.int(1)?;
                    if pos < 1 || pos > n as i64 + 1 {
                        return Err(a.bad(1, "position out of bounds"));
                    }
                    lua.charge(n)?;
                    lua.heap.tables.get_mut(t).insert_at(pos as usize, a.get(2))
                }
                _ => return Err(LuaError::runtime("wrong number of arguments to 'insert'")),
            };
            lua.heap.slots += added;
            lua.heap.allocated += added;
            lua.check_memory()?;
            Ok(Vec::new())
        }
        TRemove => {
            let t = a.table(0)?;
            let n = lua.length(t);
            if n == 0 {
                return Ok(Vec::new());
            }
            let pos = a.opt_int(1, n as i64)?;
            if pos < 1 || pos > n as i64 {
                return Ok(Vec::new());
            }
            lua.charge(n)?;
            one(lua.heap.tables.get_mut(t).remove_at(pos as usize, n))
        }
        TConcat => {
            let t = a.table(0)?;
            let sep = match a.get(1) {
                Value::Nil => Vec::new(),
                _ => a.bytes(1)?,
            };
            let i = a.opt_int(2, 1)?;
            let j = match a.get(3) {
                Value::Nil => lua.length(t) as i64,
                _ => a.int(3)?,
            };
            let mut out = Vec::new();
            let mut k = i;
            while k <= j {
                lua.charge(1)?;
                match lua.raw_get(t, &Value::Num(k as f64)) {
                    Value::Str(s) => out.extend_from_slice(&s),
                    Value::Num(n) => out.extend(fmt_number(n).into_bytes()),
                    v => {
                        return Err(LuaError::runtime(format!(
                            "invalid value (at index {k}) in table for 'concat' ({} expected, got {})",
                            "string",
                            v.type_name()
                        )))
                    }
                }
                if k < j {
                    out.extend_from_slice(&sep);
                }
                if out.len() > super::MAX_STRING {
                    return Err(LuaError::runtime("string length overflow"));
                }
                k += 1;
            }
            Ok(vec![lua.make_str(out)?])
        }
        TSort => {
            let t = a.table(0)?;
            let cmp = a.get(1);
            if !cmp.is_nil() {
                a.func(1)?;
            }
            let items = lua.sequence(t);
            let sorted = merge_sort(lua, host, &cmp, items)?;
            for (i, v) in sorted.into_iter().enumerate() {
                lua.raw_set(t, Value::Num((i + 1) as f64), v)?;
            }
            Ok(Vec::new())
        }
        TMaxn => {
            let t = a.table(0)?;
            let mut max = 0.0f64;
            lua.heap.tables.get(t).for_each(|k, _| {
                if let Value::Num(n) = k {
                    if *n > max {
                        max = *n;
                    }
                }
            });
            one(Value::Num(max))
        }
        TGetn => one(Value::Num(lua.length(a.table(0)?) as f64)),
        TForeach => {
            let t = a.table(0)?;
            let f = a.func(1)?;
            for (k, v) in lua.pairs(t) {
                let r = lua.call_value(host, &f, vec![k, v])?;
                if let Some(x) = r.into_iter().next().filter(|x| !x.is_nil()) {
                    return one(x);
                }
            }
            Ok(Vec::new())
        }
        TForeachi => {
            let t = a.table(0)?;
            let f = a.func(1)?;
            let n = lua.length(t);
            for i in 1..=n {
                let v = lua.raw_get(t, &Value::Num(i as f64));
                let r = lua.call_value(host, &f, vec![Value::Num(i as f64), v])?;
                if let Some(x) = r.into_iter().next().filter(|x| !x.is_nil()) {
                    return one(x);
                }
            }
            Ok(Vec::new())
        }
        // ---- math ----
        MAbs => math1(f64::abs),
        MAcos => math1(libm::acos),
        MAsin => math1(libm::asin),
        MAtan => math1(libm::atan),
        MAtan2 => one(Value::Num(libm::atan2(a.num(0)?, a.num(1)?))),
        MCeil => math1(f64::ceil),
        MCos => math1(libm::cos),
        MCosh => math1(libm::cosh),
        MDeg => math1(|x| x * (180.0 / std::f64::consts::PI)),
        MExp => math1(libm::exp),
        MFloor => math1(f64::floor),
        MFmod => one(Value::Num(libm::fmod(a.num(0)?, a.num(1)?))),
        MFrexp => {
            let (m, e) = libm::frexp(a.num(0)?);
            Ok(vec![Value::Num(m), Value::Num(e as f64)])
        }
        MLdexp => one(Value::Num(libm::ldexp(a.num(0)?, a.int(1)?.clamp(i32::MIN as i64, i32::MAX as i64) as i32))),
        MLog => math1(libm::log),
        MLog10 => math1(libm::log10),
        MMax | MMin => {
            let mut best = a.num(0)?;
            for i in 1..args.len() {
                let x = a.num(i)?;
                if (b == MMax && x > best) || (b == MMin && x < best) {
                    best = x;
                }
            }
            one(Value::Num(best))
        }
        MModf => {
            let x = a.num(0)?;
            let ip = x.trunc();
            let frac = if x.is_infinite() { 0.0 } else { x - ip };
            Ok(vec![Value::Num(ip), Value::Num(frac)])
        }
        MPow => one(Value::Num(libm::pow(a.num(0)?, a.num(1)?))),
        MRad => math1(|x| x * (std::f64::consts::PI / 180.0)),
        MSin => math1(libm::sin),
        MSinh => math1(libm::sinh),
        MSqrt => math1(f64::sqrt),
        MTan => math1(libm::tan),
        MTanh => math1(libm::tanh),
        _ => strlib::call(lua, host, b, bound, &a),
    }
}
