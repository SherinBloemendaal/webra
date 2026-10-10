//! Tree-walking evaluation of the resolved syntax tree.

use super::ast::*;
use super::heap::Closure;
use super::{fmt_number, raw_equal, stdlib, ErrorKind, Host, Lua, LuaError, Value, MAX_DEPTH, MAX_STRING};
use std::sync::Arc;

enum Flow {
    Normal,
    Break,
    Return(Vec<Value>),
}

struct Frame {
    slots: Vec<Value>,
    varargs: Vec<Value>,
    upvals: Vec<u32>,
    chunk: Arc<str>,
    line: u32,
}

/// How an expression is named in error messages ("global 'Foo'").
fn describe(e: &Expr) -> Option<String> {
    let s = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    match e {
        Expr::Global(n) => Some(format!("global '{}'", s(n))),
        Expr::Upval(_, n) => Some(format!("upvalue '{}'", s(n))),
        Expr::Local(..) | Expr::Cell(..) => Some("local".to_string()),
        Expr::Index(_, k, _) => match &**k {
            Expr::Str(k) => Some(format!("field '{}'", s(k))),
            _ => None,
        },
        Expr::Method(_, k, _, _) => Some(format!("method '{}'", s(k))),
        _ => None,
    }
}

fn with_name(msg: &str, e: &Expr, v: &Value) -> String {
    match describe(e) {
        Some(d) => format!("{msg} {d} (a {} value)", v.type_name()),
        None => format!("{msg} a {} value", v.type_name()),
    }
}

impl Lua {
    fn locate(&self, mut e: LuaError, frame: &Frame, line: u32) -> LuaError {
        if !e.located && e.kind == ErrorKind::Runtime {
            if let Value::Str(s) = &e.value {
                let msg = format!("{}:{line}: {}", frame.chunk, String::from_utf8_lossy(s));
                e.value = Value::str(&msg);
            }
            e.located = true;
        }
        e
    }

    fn enter(&mut self) -> Result<(), LuaError> {
        if self.depth >= MAX_DEPTH {
            return Err(LuaError::runtime("stack overflow"));
        }
        self.charge(1)?;
        self.depth += 1;
        Ok(())
    }

    pub(crate) fn call_value(&mut self, host: &mut dyn Host, f: &Value, args: Vec<Value>) -> Result<Vec<Value>, LuaError> {
        match f {
            Value::Func(id) => self.call_closure(host, *id, args),
            Value::Builtin(b, t) => {
                self.enter()?;
                let r = stdlib::call(self, host, *b, *t, args);
                self.depth -= 1;
                r
            }
            Value::Host(id, this) => {
                self.enter()?;
                let r = host.call(self, *id, *this, args);
                self.depth -= 1;
                r
            }
            other => Err(LuaError::runtime(format!("attempt to call a {} value", other.type_name()))),
        }
    }

    fn call_closure(&mut self, host: &mut dyn Host, id: u32, mut args: Vec<Value>) -> Result<Vec<Value>, LuaError> {
        let (proto, upvals) = {
            let c = self.heap.closures.get(id);
            (c.proto.clone(), c.upvals.clone())
        };
        self.enter()?;
        let mut frame = Frame {
            slots: vec![Value::Nil; proto.nslots.max(1)],
            varargs: Vec::new(),
            upvals,
            chunk: proto.chunk.clone(),
            line: proto.line,
        };
        if proto.is_vararg && args.len() > proto.nparams {
            frame.varargs = args.split_off(proto.nparams);
        }
        for (i, a) in args.into_iter().take(proto.nparams).enumerate() {
            frame.slots[i] = a;
        }
        for i in 0..proto.nparams {
            if proto.param_cells[i] {
                let v = std::mem::replace(&mut frame.slots[i], Value::Nil);
                frame.slots[i] = Value::Cell(self.heap.new_cell(v));
            }
        }
        let r = self.exec_block(host, &mut frame, &proto.body);
        self.depth -= 1;
        match r {
            Ok(Flow::Return(v)) => Ok(v),
            Ok(_) => Ok(Vec::new()),
            Err(mut e) => {
                let name = if proto.name == "main chunk" { "main chunk".to_string() } else { format!("function '{}'", proto.name) };
                e.traceback.push(format!("{}:{}: in {name}", frame.chunk, frame.line));
                Err(e)
            }
        }
    }

    fn exec_block(&mut self, host: &mut dyn Host, frame: &mut Frame, block: &[Stat]) -> Result<Flow, LuaError> {
        for s in block {
            match self.exec_stat(host, frame, s)? {
                Flow::Normal => {}
                f => return Ok(f),
            }
        }
        Ok(Flow::Normal)
    }

    fn declare(&mut self, frame: &mut Frame, local: &Local, v: Value) {
        frame.slots[local.slot as usize] = if local.cell { Value::Cell(self.heap.new_cell(v)) } else { v };
    }

    fn exec_stat(&mut self, host: &mut dyn Host, frame: &mut Frame, s: &Stat) -> Result<Flow, LuaError> {
        self.charge(1)?;
        match s {
            Stat::Call(e, line) => {
                frame.line = *line;
                self.eval_multi(host, frame, e)?;
            }
            Stat::Local(locals, exprs, line) => {
                frame.line = *line;
                let vals = self.eval_list(host, frame, exprs, locals.len())?;
                for (l, v) in locals.iter().zip(vals) {
                    self.declare(frame, l, v);
                }
            }
            Stat::Assign(targets, exprs, line) => {
                frame.line = *line;
                if targets.len() == 1 && exprs.len() == 1 {
                    // The common case: no temporary lists.
                    if let Target::Index(o, k) = &targets[0] {
                        let obj = self.eval(host, frame, o)?;
                        if !matches!(obj, Value::Table(_) | Value::UserData(_)) {
                            return Err(self.locate(LuaError::runtime(with_name("attempt to index", o, &obj)), frame, *line));
                        }
                        let key = self.eval(host, frame, k)?;
                        let v = self.eval(host, frame, &exprs[0])?;
                        self.set_index(host, &obj, key, v).map_err(|e| self.locate(e, frame, *line))?;
                    } else {
                        let v = self.eval(host, frame, &exprs[0])?;
                        self.assign_var(frame, &targets[0], v)?;
                    }
                } else {
                    let mut places = Vec::with_capacity(targets.len());
                    for t in targets {
                        places.push(match t {
                            Target::Index(o, k) => Some((self.eval(host, frame, o)?, self.eval(host, frame, k)?)),
                            _ => None,
                        });
                    }
                    let vals = self.eval_list(host, frame, exprs, targets.len())?;
                    for ((t, place), v) in targets.iter().zip(places).zip(vals) {
                        match place {
                            Some((obj, key)) => self.set_index(host, &obj, key, v).map_err(|e| self.locate(e, frame, *line))?,
                            None => self.assign_var(frame, t, v)?,
                        }
                    }
                }
            }
            Stat::Do(b) => return self.exec_block(host, frame, b),
            Stat::While(cond, body, line) => loop {
                frame.line = *line;
                self.charge(1)?;
                if !self.eval(host, frame, cond)?.truthy() {
                    break;
                }
                match self.exec_block(host, frame, body)? {
                    Flow::Break => break,
                    Flow::Return(v) => return Ok(Flow::Return(v)),
                    Flow::Normal => {}
                }
            },
            Stat::Repeat(body, cond, line) => loop {
                frame.line = *line;
                self.charge(1)?;
                match self.exec_block(host, frame, body)? {
                    Flow::Break => break,
                    Flow::Return(v) => return Ok(Flow::Return(v)),
                    Flow::Normal => {}
                }
                if self.eval(host, frame, cond)?.truthy() {
                    break;
                }
            },
            Stat::If(conds, otherwise, line) => {
                frame.line = *line;
                for (c, b) in conds {
                    if self.eval(host, frame, c)?.truthy() {
                        return self.exec_block(host, frame, b);
                    }
                }
                if let Some(b) = otherwise {
                    return self.exec_block(host, frame, b);
                }
            }
            Stat::NumFor { var, start, limit, step, body, line } => {
                frame.line = *line;
                let v0 = self.eval(host, frame, start)?;
                let start = self.for_number(v0, "initial value", frame, *line)?;
                let v1 = self.eval(host, frame, limit)?;
                let limit = self.for_number(v1, "limit", frame, *line)?;
                let step = match step {
                    Some(s) => {
                        let v = self.eval(host, frame, s)?;
                        self.for_number(v, "step", frame, *line)?
                    }
                    None => 1.0,
                };
                // As Lua 5.1's FORPREP/FORLOOP: the index steps from start - step.
                let mut idx = start - step;
                loop {
                    idx += step;
                    let go = if step > 0.0 { idx <= limit } else { idx >= limit };
                    if !go {
                        break;
                    }
                    self.charge(1)?;
                    self.declare(frame, var, Value::Num(idx));
                    match self.exec_block(host, frame, body)? {
                        Flow::Break => break,
                        Flow::Return(v) => return Ok(Flow::Return(v)),
                        Flow::Normal => {}
                    }
                }
            }
            Stat::GenFor { vars, exprs, body, line } => {
                frame.line = *line;
                let init = self.eval_list(host, frame, exprs, 3)?;
                let (f, s, mut ctrl) = (init[0].clone(), init[1].clone(), init[2].clone());
                loop {
                    self.charge(1)?;
                    frame.line = *line;
                    let mut res = match (&f, &s) {
                        // pairs and ipairs without a call frame each step.
                        (Value::Builtin(super::Builtin::Next, _), Value::Table(t)) => {
                            match self.heap.tables.get(*t).next(&ctrl).map_err(|m| self.locate(LuaError::runtime(m), frame, *line))? {
                                Some((k, v)) => vec![k, v],
                                None => break,
                            }
                        }
                        (Value::Builtin(super::Builtin::IpairsIter, _), Value::Table(t)) => {
                            let i = ctrl.to_num().unwrap_or(0.0) + 1.0;
                            let v = self.heap.tables.get(*t).get(&Value::Num(i));
                            if v.is_nil() {
                                break;
                            }
                            vec![Value::Num(i), v]
                        }
                        _ => {
                            if !matches!(f, Value::Func(_) | Value::Builtin(..) | Value::Host(..)) {
                                return Err(self.locate(
                                    LuaError::runtime(format!("attempt to call a {} value", f.type_name())),
                                    frame,
                                    *line,
                                ));
                            }
                            self.call_value(host, &f, vec![s.clone(), ctrl.clone()]).map_err(|e| self.locate(e, frame, *line))?
                        }
                    };
                    if res.first().is_none_or(Value::is_nil) {
                        break;
                    }
                    res.resize(vars.len().max(1), Value::Nil);
                    ctrl = res[0].clone();
                    for (l, v) in vars.iter().zip(res) {
                        self.declare(frame, l, v);
                    }
                    match self.exec_block(host, frame, body)? {
                        Flow::Break => break,
                        Flow::Return(v) => return Ok(Flow::Return(v)),
                        Flow::Normal => {}
                    }
                }
            }
            Stat::LocalFunction(local, proto, line) => {
                frame.line = *line;
                if local.cell {
                    // The function sees itself through the cell.
                    let cell = self.heap.new_cell(Value::Nil);
                    frame.slots[local.slot as usize] = Value::Cell(cell);
                    let f = self.closure(frame, proto)?;
                    *self.heap.cells.get_mut(cell) = f;
                } else {
                    let f = self.closure(frame, proto)?;
                    frame.slots[local.slot as usize] = f;
                }
            }
            Stat::Return(exprs, line) => {
                frame.line = *line;
                let vals = if exprs.len() == 1 && exprs[0].is_multi() {
                    self.eval_multi(host, frame, &exprs[0])?
                } else {
                    self.eval_all(host, frame, exprs)?
                };
                return Ok(Flow::Return(vals));
            }
            Stat::Break(_) => return Ok(Flow::Break),
        }
        Ok(Flow::Normal)
    }

    fn for_number(&self, v: Value, what: &str, frame: &Frame, line: u32) -> Result<f64, LuaError> {
        v.to_num().ok_or_else(|| self.locate(LuaError::runtime(format!("'for' {what} must be a number")), frame, line))
    }

    fn assign_var(&mut self, frame: &mut Frame, t: &Target, v: Value) -> Result<(), LuaError> {
        match t {
            Target::Local(slot, _) => frame.slots[*slot as usize] = v,
            Target::Cell(slot) => match frame.slots[*slot as usize] {
                Value::Cell(c) => *self.heap.cells.get_mut(c) = v,
                _ => unreachable!("captured local without a cell"),
            },
            Target::Upval(i) => *self.heap.cells.get_mut(frame.upvals[*i as usize]) = v,
            Target::Global(name) => {
                let g = self.globals_table();
                self.raw_set(g, Value::Str(name.clone()), v)?;
                self.check_memory()?;
            }
            Target::Index(..) => unreachable!("index targets are assigned by the caller"),
        }
        Ok(())
    }

    fn closure(&mut self, frame: &Frame, proto: &Arc<FuncProto>) -> Result<Value, LuaError> {
        let upvals = proto
            .upvals
            .iter()
            .map(|s| match s {
                UpvalSource::Local(slot) => match frame.slots[*slot as usize] {
                    Value::Cell(c) => c,
                    _ => unreachable!("captured local without a cell"),
                },
                UpvalSource::Upval(i) => frame.upvals[*i as usize],
            })
            .collect();
        let f = self.heap.new_closure(Closure { proto: proto.clone(), upvals });
        self.check_memory()?;
        Ok(Value::Func(f))
    }

    /// Exactly `want` values from an expression list (missing ones are nil).
    fn eval_list(&mut self, host: &mut dyn Host, frame: &mut Frame, exprs: &[Expr], want: usize) -> Result<Vec<Value>, LuaError> {
        let mut out = Vec::with_capacity(want.max(exprs.len()));
        for (i, e) in exprs.iter().enumerate() {
            if i + 1 == exprs.len() && e.is_multi() && out.len() < want {
                out.extend(self.eval_multi(host, frame, e)?);
            } else {
                out.push(self.eval(host, frame, e)?);
            }
        }
        out.resize(want, Value::Nil);
        Ok(out)
    }

    /// Every value of an expression list (the last one expanded).
    fn eval_all(&mut self, host: &mut dyn Host, frame: &mut Frame, exprs: &[Expr]) -> Result<Vec<Value>, LuaError> {
        let mut out = Vec::with_capacity(exprs.len());
        for (i, e) in exprs.iter().enumerate() {
            if i + 1 == exprs.len() && e.is_multi() {
                out.extend(self.eval_multi(host, frame, e)?);
            } else {
                out.push(self.eval(host, frame, e)?);
            }
        }
        Ok(out)
    }

    /// All values of a call or `...`; one value for anything else.
    fn eval_multi(&mut self, host: &mut dyn Host, frame: &mut Frame, e: &Expr) -> Result<Vec<Value>, LuaError> {
        match e {
            Expr::Vararg => Ok(frame.varargs.clone()),
            Expr::Call(f, args, line) => {
                let fv = self.eval(host, frame, f)?;
                if !matches!(fv, Value::Func(_) | Value::Builtin(..) | Value::Host(..)) {
                    return Err(self.locate(LuaError::runtime(with_name("attempt to call", f, &fv)), frame, *line));
                }
                let argv = self.eval_all(host, frame, args)?;
                frame.line = *line;
                self.call_value(host, &fv, argv).map_err(|e| self.locate(e, frame, *line))
            }
            Expr::Method(o, name, args, line) => {
                let obj = self.eval(host, frame, o)?;
                let fv = self.index(host, &obj, &Value::Str(name.clone())).map_err(|e| self.locate(e, frame, *line))?;
                if !matches!(fv, Value::Func(_) | Value::Builtin(..) | Value::Host(..)) {
                    return Err(self.locate(LuaError::runtime(with_name("attempt to call", e, &fv)), frame, *line));
                }
                let mut argv = Vec::with_capacity(args.len() + 1);
                argv.push(obj);
                argv.extend(self.eval_all(host, frame, args)?);
                self.call_value(host, &fv, argv).map_err(|e| self.locate(e, frame, *line))
            }
            _ => Ok(vec![self.eval(host, frame, e)?]),
        }
    }

    fn eval(&mut self, host: &mut dyn Host, frame: &mut Frame, e: &Expr) -> Result<Value, LuaError> {
        Ok(match e {
            Expr::Nil => Value::Nil,
            Expr::True => Value::Bool(true),
            Expr::False => Value::Bool(false),
            Expr::Num(n) => Value::Num(*n),
            Expr::Str(s) => Value::Str(s.clone()),
            Expr::Vararg => frame.varargs.first().cloned().unwrap_or(Value::Nil),
            Expr::Func(proto) => self.closure(frame, proto)?,
            Expr::Local(slot, _) => frame.slots[*slot as usize].clone(),
            Expr::Cell(slot, _) => match frame.slots[*slot as usize] {
                Value::Cell(c) => self.heap.cells.get(c).clone(),
                _ => unreachable!("captured local without a cell"),
            },
            Expr::Upval(i, _) => self.heap.cells.get(frame.upvals[*i as usize]).clone(),
            Expr::Global(name) => self.heap.tables.get(self.globals_table()).get(&Value::Str(name.clone())),
            Expr::Index(o, k, line) => {
                let obj = self.eval(host, frame, o)?;
                let key = self.eval(host, frame, k)?;
                if !matches!(obj, Value::Table(_) | Value::Str(_) | Value::UserData(_)) {
                    return Err(self.locate(LuaError::runtime(with_name("attempt to index", o, &obj)), frame, *line));
                }
                self.index(host, &obj, &key).map_err(|e| self.locate(e, frame, *line))?
            }
            Expr::Call(..) | Expr::Method(..) => self.eval_multi(host, frame, e)?.into_iter().next().unwrap_or(Value::Nil),
            Expr::And(a, b) => {
                let v = self.eval(host, frame, a)?;
                if v.truthy() {
                    self.eval(host, frame, b)?
                } else {
                    v
                }
            }
            Expr::Or(a, b) => {
                let v = self.eval(host, frame, a)?;
                if v.truthy() {
                    v
                } else {
                    self.eval(host, frame, b)?
                }
            }
            Expr::Bin(op, a, b, line) => {
                let x = self.eval(host, frame, a)?;
                let y = self.eval(host, frame, b)?;
                self.binary(host, *op, &x, &y).map_err(|err| {
                    // Name the operand at fault, as the reference interpreter does.
                    let msg = err.message();
                    let bad = |v: &Value| match op {
                        BinOp::Concat => !matches!(v, Value::Str(_) | Value::Num(_)),
                        _ => v.to_num().is_none(),
                    };
                    let renamed = if !err.located && err.kind == ErrorKind::Runtime && msg.starts_with("attempt to perform") {
                        let (ex, v) = if bad(&x) { (a, &x) } else { (b, &y) };
                        LuaError::runtime(with_name("attempt to perform arithmetic on", ex, v))
                    } else if !err.located && err.kind == ErrorKind::Runtime && msg.starts_with("attempt to concatenate") {
                        let (ex, v) = if bad(&x) { (a, &x) } else { (b, &y) };
                        LuaError::runtime(with_name("attempt to concatenate", ex, v))
                    } else {
                        err
                    };
                    self.locate(renamed, frame, *line)
                })?
            }
            Expr::Un(op, a, line) => {
                let v = self.eval(host, frame, a)?;
                match op {
                    UnOp::Not => Value::Bool(!v.truthy()),
                    UnOp::Neg => match v.to_num() {
                        Some(n) => Value::Num(-n),
                        None => match v.as_userdata().and_then(|u| host.negate(u)) {
                            Some(r) => r,
                            None => {
                                return Err(self.locate(
                                    LuaError::runtime(with_name("attempt to perform arithmetic on", a, &v)),
                                    frame,
                                    *line,
                                ))
                            }
                        },
                    },
                    UnOp::Len => match &v {
                        Value::Str(s) => Value::Num(s.len() as f64),
                        Value::Table(t) => Value::Num(self.length(*t) as f64),
                        _ => return Err(self.locate(LuaError::runtime(with_name("attempt to get length of", a, &v)), frame, *line)),
                    },
                }
            }
            Expr::Table(fields, line) => {
                let t = self.heap.new_table();
                let mut n = 0usize;
                for (i, f) in fields.iter().enumerate() {
                    match f {
                        Field::Item(v) if i + 1 == fields.len() && v.is_multi() => {
                            for v in self.eval_multi(host, frame, v)? {
                                n += 1;
                                self.raw_set(t, Value::Num(n as f64), v)?;
                            }
                        }
                        Field::Item(v) => {
                            let v = self.eval(host, frame, v)?;
                            n += 1;
                            self.raw_set(t, Value::Num(n as f64), v)?;
                        }
                        Field::Pair(k, v) => {
                            let k = self.eval(host, frame, k)?;
                            let v = self.eval(host, frame, v)?;
                            self.raw_set(t, k, v).map_err(|e| self.locate(e, frame, *line))?;
                        }
                    }
                }
                self.check_memory()?;
                Value::Table(t)
            }
            Expr::Paren(e) => self.eval(host, frame, e)?,
        })
    }

    /// `obj[key]` with Lua's rules for tables, strings (the string library)
    /// and host objects.
    pub fn index(&mut self, host: &mut dyn Host, obj: &Value, key: &Value) -> Result<Value, LuaError> {
        match obj {
            Value::Table(t) => Ok(self.heap.tables.get(*t).get(key)),
            Value::Str(_) => Ok(self.heap.tables.get(self.string_table()).get(key)),
            Value::UserData(u) => host.index(self, *u, key),
            other => Err(LuaError::runtime(format!("attempt to index a {} value", other.type_name()))),
        }
    }

    pub fn set_index(&mut self, host: &mut dyn Host, obj: &Value, key: Value, v: Value) -> Result<(), LuaError> {
        match obj {
            Value::Table(t) => {
                self.raw_set(*t, key, v)?;
                self.check_memory()
            }
            Value::UserData(u) => host.set_index(self, *u, &key, v),
            other => Err(LuaError::runtime(format!("attempt to index a {} value", other.type_name()))),
        }
    }

    /// A new string from a script operation (counted against the heap limit).
    pub(crate) fn make_str(&mut self, bytes: Vec<u8>) -> Result<Value, LuaError> {
        if bytes.len() > MAX_STRING {
            return Err(LuaError::runtime("string length overflow"));
        }
        let slots = bytes.len() / 16;
        self.heap.slots += slots;
        self.heap.allocated += slots;
        self.check_memory()?;
        Ok(Value::Str(bytes.into()))
    }

    pub fn binary(&mut self, host: &mut dyn Host, op: BinOp, x: &Value, y: &Value) -> Result<Value, LuaError> {
        let arith = |f: fn(f64, f64) -> f64, host: &mut dyn Host| -> Result<Value, LuaError> {
            match (x.to_num(), y.to_num()) {
                (Some(a), Some(b)) => Ok(Value::Num(f(a, b))),
                _ => host.arith(op, x, y).ok_or_else(|| {
                    let v = if x.to_num().is_none() { x } else { y };
                    LuaError::runtime(format!("attempt to perform arithmetic on a {} value", v.type_name()))
                }),
            }
        };
        match op {
            BinOp::Add => arith(|a, b| a + b, host),
            BinOp::Sub => arith(|a, b| a - b, host),
            BinOp::Mul => arith(|a, b| a * b, host),
            BinOp::Div => arith(|a, b| a / b, host),
            BinOp::Mod => arith(|a, b| a - (a / b).floor() * b, host),
            BinOp::Pow => arith(libm::pow, host),
            BinOp::Concat => {
                let text = |v: &Value| -> Option<Vec<u8>> {
                    match v {
                        Value::Str(s) => Some(s.to_vec()),
                        Value::Num(n) => Some(fmt_number(*n).into_bytes()),
                        _ => None,
                    }
                };
                match (text(x), text(y)) {
                    (Some(mut a), Some(b)) => {
                        a.extend(b);
                        self.make_str(a)
                    }
                    (a, _) => {
                        let v = if a.is_none() { x } else { y };
                        Err(LuaError::runtime(format!("attempt to concatenate a {} value", v.type_name())))
                    }
                }
            }
            BinOp::Eq => Ok(Value::Bool(raw_equal(x, y))),
            BinOp::Ne => Ok(Value::Bool(!raw_equal(x, y))),
            BinOp::Lt => self.less(host, op, x, y, false),
            BinOp::Le => self.less(host, op, x, y, true),
            BinOp::Gt => self.less(host, BinOp::Lt, y, x, false),
            BinOp::Ge => self.less(host, BinOp::Le, y, x, true),
        }
    }

    fn less(&mut self, host: &mut dyn Host, op: BinOp, x: &Value, y: &Value, or_equal: bool) -> Result<Value, LuaError> {
        Ok(Value::Bool(match (x, y) {
            (Value::Num(a), Value::Num(b)) => {
                if or_equal {
                    a <= b
                } else {
                    a < b
                }
            }
            (Value::Str(a), Value::Str(b)) => {
                if or_equal {
                    a <= b
                } else {
                    a < b
                }
            }
            _ => {
                let host_result =
                    if matches!(x, Value::UserData(_)) || matches!(y, Value::UserData(_)) { host.arith(op, x, y) } else { None };
                match host_result {
                    Some(v) => return Ok(v),
                    None if x.type_name() == y.type_name() => {
                        return Err(LuaError::runtime(format!("attempt to compare two {} values", x.type_name())))
                    }
                    None => return Err(LuaError::runtime(format!("attempt to compare {} with {}", x.type_name(), y.type_name()))),
                }
            }
        }))
    }
}
