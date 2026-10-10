//! Lua 5.1 parser. Resolves every name while parsing: locals get frame
//! slots, captured locals are marked so they live in heap cells, and names
//! found in enclosing functions become upvalues.

use super::ast::*;
use super::lexer::{tokenize, Tok};
use super::{lstr, LuaError};
use std::sync::Arc;

/// Deepest nesting of expressions, blocks and functions (LUAI_MAXCCALLS).
const MAX_DEPTH: u32 = 200;
/// Locals alive at once in one function (the reference limit, LUAI_MAXVARS).
const MAX_LOCALS: usize = 200;
const MAX_UPVALS: usize = 60;

pub fn parse_chunk(chunk: &str, src: &[u8]) -> Result<Arc<FuncProto>, LuaError> {
    let toks = tokenize(chunk, src)?;
    let mut p = Parser { toks, pos: 0, chunk: Arc::from(chunk), funcs: Vec::new(), depth: 0 };
    p.open_func(true);
    let body = p.block()?;
    if p.peek() != &Tok::Eof {
        return Err(p.err_near(&format!("'<eof>' expected near {}", p.peek().describe())));
    }
    Ok(Arc::new(p.close_func(body, "main chunk".into(), 0, 0)))
}

struct FuncState {
    /// Active locals: name, slot, declaration id.
    actives: Vec<(String, u16, u32)>,
    blocks: Vec<usize>,
    nslots: usize,
    captured: Vec<bool>,
    upvals: Vec<(String, UpvalSource)>,
    is_vararg: bool,
    loops: u32,
}

enum VarRef {
    Local(u16, u32),
    Upval(u16),
}

struct Parser {
    toks: Vec<(Tok, u32)>,
    pos: usize,
    chunk: Arc<str>,
    funcs: Vec<FuncState>,
    depth: u32,
}

const UNARY_PRIORITY: u8 = 8;

fn binop(t: &Tok) -> Option<(BinOp, u8, u8)> {
    Some(match t {
        Tok::Plus => (BinOp::Add, 6, 6),
        Tok::Minus => (BinOp::Sub, 6, 6),
        Tok::Star => (BinOp::Mul, 7, 7),
        Tok::Slash => (BinOp::Div, 7, 7),
        Tok::Percent => (BinOp::Mod, 7, 7),
        Tok::Caret => (BinOp::Pow, 10, 9),
        Tok::Concat => (BinOp::Concat, 5, 4),
        Tok::Eq => (BinOp::Eq, 3, 3),
        Tok::Ne => (BinOp::Ne, 3, 3),
        Tok::Lt => (BinOp::Lt, 3, 3),
        Tok::Le => (BinOp::Le, 3, 3),
        Tok::Gt => (BinOp::Gt, 3, 3),
        Tok::Ge => (BinOp::Ge, 3, 3),
        _ => return None,
    })
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.pos].0
    }

    fn peek2(&self) -> &Tok {
        &self.toks[(self.pos + 1).min(self.toks.len() - 1)].0
    }

    fn line(&self) -> u32 {
        self.toks[self.pos].1
    }

    fn advance(&mut self) -> Tok {
        let t = self.toks[self.pos].0.clone();
        if self.pos + 1 < self.toks.len() {
            self.pos += 1;
        }
        t
    }

    fn err_near(&self, msg: &str) -> LuaError {
        LuaError::syntax(format!("{}:{}: {msg}", self.chunk, self.line()))
    }

    fn unexpected(&self) -> LuaError {
        self.err_near(&format!("unexpected symbol near {}", self.peek().describe()))
    }

    fn check(&mut self, t: Tok) -> Result<(), LuaError> {
        if self.peek() == &t {
            self.advance();
            Ok(())
        } else {
            Err(self.err_near(&format!("'{}' expected near {}", t.describe().trim_matches('\''), self.peek().describe())))
        }
    }

    /// Closing token of a construct opened at `line` (better messages, like luac).
    fn check_match(&mut self, t: Tok, open: Tok, line: u32) -> Result<(), LuaError> {
        if self.peek() == &t {
            self.advance();
            return Ok(());
        }
        let what = t.describe();
        if line == self.line() {
            Err(self.err_near(&format!("{what} expected near {}", self.peek().describe())))
        } else {
            Err(self.err_near(&format!("{what} expected (to close {} at line {line}) near {}", open.describe(), self.peek().describe())))
        }
    }

    fn name(&mut self) -> Result<String, LuaError> {
        match self.advance() {
            Tok::Name(n) => Ok(n),
            t => {
                self.pos -= 1;
                Err(self.err_near(&format!("<name> expected near {}", t.describe())))
            }
        }
    }

    fn enter(&mut self) -> Result<(), LuaError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err_near("chunk has too many syntax levels"));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    // ---- Scopes -----------------------------------------------------------

    fn fs(&mut self) -> &mut FuncState {
        self.funcs.last_mut().expect("function state")
    }

    fn open_func(&mut self, is_vararg: bool) {
        self.funcs.push(FuncState {
            actives: Vec::new(),
            blocks: Vec::new(),
            nslots: 0,
            captured: Vec::new(),
            upvals: Vec::new(),
            is_vararg,
            loops: 0,
        });
    }

    fn close_func(&mut self, mut body: Block, name: String, line: u32, nparams: usize) -> FuncProto {
        let fs = self.funcs.pop().expect("function state");
        fix_block(&mut body, &fs.captured);
        // Parameters are the first declarations (ids 0..nparams).
        let param_cells = (0..nparams).map(|i| fs.captured[i]).collect();
        FuncProto {
            name,
            chunk: self.chunk.clone(),
            line,
            nparams,
            is_vararg: fs.is_vararg,
            nslots: fs.nslots,
            param_cells,
            upvals: fs.upvals.into_iter().map(|(_, s)| s).collect(),
            body,
        }
    }

    fn open_block(&mut self) {
        let n = self.fs().actives.len();
        self.fs().blocks.push(n);
    }

    fn close_block(&mut self) {
        let fs = self.fs();
        let n = fs.blocks.pop().expect("block");
        fs.actives.truncate(n);
    }

    /// Declare a local (active from now on).
    fn declare(&mut self, name: String) -> Result<Local, LuaError> {
        if self.fs().actives.len() >= MAX_LOCALS {
            return Err(self.err_near("too many local variables"));
        }
        let fs = self.fs();
        let slot = fs.actives.len() as u16;
        let id = fs.captured.len() as u32;
        fs.captured.push(false);
        fs.actives.push((name, slot, id));
        fs.nslots = fs.nslots.max(fs.actives.len());
        Ok(Local { slot, cell: false, id })
    }

    fn find_var(&mut self, level: usize, name: &str) -> Result<Option<VarRef>, LuaError> {
        let fs = &self.funcs[level];
        if let Some(&(_, slot, id)) = fs.actives.iter().rev().find(|(n, _, _)| n == name) {
            return Ok(Some(VarRef::Local(slot, id)));
        }
        if let Some(i) = fs.upvals.iter().position(|(n, _)| n == name) {
            return Ok(Some(VarRef::Upval(i as u16)));
        }
        if level == 0 {
            return Ok(None);
        }
        let source = match self.find_var(level - 1, name)? {
            None => return Ok(None),
            Some(VarRef::Local(slot, id)) => {
                self.funcs[level - 1].captured[id as usize] = true;
                UpvalSource::Local(slot)
            }
            Some(VarRef::Upval(i)) => UpvalSource::Upval(i),
        };
        if self.funcs[level].upvals.len() >= MAX_UPVALS {
            return Err(self.err_near("too many upvalues"));
        }
        self.funcs[level].upvals.push((name.to_string(), source));
        Ok(Some(VarRef::Upval(self.funcs[level].upvals.len() as u16 - 1)))
    }

    fn var_expr(&mut self, name: String) -> Result<Expr, LuaError> {
        let level = self.funcs.len() - 1;
        Ok(match self.find_var(level, &name)? {
            Some(VarRef::Local(slot, id)) => Expr::Local(slot, id),
            Some(VarRef::Upval(i)) => Expr::Upval(i, lstr(&name)),
            None => Expr::Global(lstr(&name)),
        })
    }

    // ---- Statements -------------------------------------------------------

    fn block_follow(&self) -> bool {
        matches!(self.peek(), Tok::Else | Tok::Elseif | Tok::End | Tok::Until | Tok::Eof)
    }

    fn block(&mut self) -> Result<Block, LuaError> {
        self.enter()?;
        let mut out = Vec::new();
        while !self.block_follow() {
            let last = matches!(self.peek(), Tok::Return | Tok::Break);
            out.push(self.statement()?);
            if self.peek() == &Tok::Semi {
                self.advance();
            }
            if last {
                break;
            }
        }
        self.leave();
        Ok(out)
    }

    /// A block in its own scope.
    fn scoped_block(&mut self) -> Result<Block, LuaError> {
        self.open_block();
        let b = self.block();
        self.close_block();
        b
    }

    fn statement(&mut self) -> Result<Stat, LuaError> {
        let line = self.line();
        match self.peek().clone() {
            Tok::If => self.if_stat(line),
            Tok::While => {
                self.advance();
                let cond = self.expr()?;
                self.check(Tok::Do)?;
                self.fs().loops += 1;
                let body = self.scoped_block()?;
                self.fs().loops -= 1;
                self.check_match(Tok::End, Tok::While, line)?;
                Ok(Stat::While(cond, body, line))
            }
            Tok::Do => {
                self.advance();
                let b = self.scoped_block()?;
                self.check_match(Tok::End, Tok::Do, line)?;
                Ok(Stat::Do(b))
            }
            Tok::For => self.for_stat(line),
            Tok::Repeat => {
                self.advance();
                self.fs().loops += 1;
                self.open_block();
                let body = self.block()?;
                self.check_match(Tok::Until, Tok::Repeat, line)?;
                // The condition sees the body's locals.
                let cond = self.expr();
                self.close_block();
                self.fs().loops -= 1;
                Ok(Stat::Repeat(body, cond?, line))
            }
            Tok::Function => {
                self.advance();
                // funcname: Name {'.' Name} [':' Name]
                let first = self.name()?;
                let mut full = first.clone();
                let mut target = self.var_expr(first)?;
                let mut method = false;
                loop {
                    match self.peek() {
                        Tok::Dot => {
                            self.advance();
                            let k = self.name()?;
                            full = format!("{full}.{k}");
                            target = Expr::Index(Box::new(target), Box::new(Expr::Str(lstr(&k))), line);
                        }
                        Tok::Colon => {
                            self.advance();
                            let k = self.name()?;
                            full = format!("{full}:{k}");
                            target = Expr::Index(Box::new(target), Box::new(Expr::Str(lstr(&k))), line);
                            method = true;
                            break;
                        }
                        _ => break,
                    }
                }
                let f = self.function_body(method, full, line)?;
                Ok(Stat::Assign(vec![to_target(target).expect("name is assignable")], vec![Expr::Func(f)], line))
            }
            Tok::Local => {
                self.advance();
                if self.peek() == &Tok::Function {
                    self.advance();
                    let name = self.name()?;
                    let local = self.declare(name.clone())?;
                    let f = self.function_body(false, name, line)?;
                    Ok(Stat::LocalFunction(local, f, line))
                } else {
                    let mut names = vec![self.name()?];
                    while self.peek() == &Tok::Comma {
                        self.advance();
                        names.push(self.name()?);
                    }
                    let exprs = if self.peek() == &Tok::Assign {
                        self.advance();
                        self.expr_list()?
                    } else {
                        Vec::new()
                    };
                    let locals = names.into_iter().map(|n| self.declare(n)).collect::<Result<Vec<_>, _>>()?;
                    Ok(Stat::Local(locals, exprs, line))
                }
            }
            Tok::Return => {
                self.advance();
                let exprs = if self.block_follow() || self.peek() == &Tok::Semi { Vec::new() } else { self.expr_list()? };
                Ok(Stat::Return(exprs, line))
            }
            Tok::Break => {
                self.advance();
                if self.fs().loops == 0 {
                    return Err(self.err_near("no loop to break"));
                }
                Ok(Stat::Break(line))
            }
            _ => self.expr_stat(line),
        }
    }

    fn if_stat(&mut self, line: u32) -> Result<Stat, LuaError> {
        self.advance();
        let mut conds = Vec::new();
        let cond = self.expr()?;
        self.check(Tok::Then)?;
        conds.push((cond, self.scoped_block()?));
        let mut otherwise = None;
        loop {
            match self.peek() {
                Tok::Elseif => {
                    self.advance();
                    let c = self.expr()?;
                    self.check(Tok::Then)?;
                    conds.push((c, self.scoped_block()?));
                }
                Tok::Else => {
                    self.advance();
                    otherwise = Some(self.scoped_block()?);
                    self.check_match(Tok::End, Tok::If, line)?;
                    break;
                }
                _ => {
                    self.check_match(Tok::End, Tok::If, line)?;
                    break;
                }
            }
        }
        Ok(Stat::If(conds, otherwise, line))
    }

    fn for_stat(&mut self, line: u32) -> Result<Stat, LuaError> {
        self.advance();
        let n1 = self.name()?;
        match self.peek() {
            Tok::Assign => {
                self.advance();
                let start = self.expr()?;
                self.check(Tok::Comma)?;
                let limit = self.expr()?;
                let step = if self.peek() == &Tok::Comma {
                    self.advance();
                    Some(self.expr()?)
                } else {
                    None
                };
                self.check(Tok::Do)?;
                self.open_block();
                let var = self.declare(n1)?;
                self.fs().loops += 1;
                let body = self.block();
                self.fs().loops -= 1;
                self.close_block();
                let body = body?;
                self.check_match(Tok::End, Tok::For, line)?;
                Ok(Stat::NumFor { var, start, limit, step, body, line })
            }
            Tok::Comma | Tok::In => {
                let mut names = vec![n1];
                while self.peek() == &Tok::Comma {
                    self.advance();
                    names.push(self.name()?);
                }
                self.check(Tok::In)?;
                let exprs = self.expr_list()?;
                self.check(Tok::Do)?;
                self.open_block();
                let vars = names.into_iter().map(|n| self.declare(n)).collect::<Result<Vec<_>, _>>();
                self.fs().loops += 1;
                let body = vars.and_then(|v| self.block().map(|b| (v, b)));
                self.fs().loops -= 1;
                self.close_block();
                let (vars, body) = body?;
                self.check_match(Tok::End, Tok::For, line)?;
                Ok(Stat::GenFor { vars, exprs, body, line })
            }
            _ => Err(self.err_near(&format!("'=' or 'in' expected near {}", self.peek().describe()))),
        }
    }

    fn expr_stat(&mut self, line: u32) -> Result<Stat, LuaError> {
        let e = self.suffixed_expr()?;
        if matches!(self.peek(), Tok::Assign | Tok::Comma) {
            let mut targets = vec![to_target(e).ok_or_else(|| self.err_near("syntax error: cannot assign to this expression"))?];
            while self.peek() == &Tok::Comma {
                self.advance();
                let t = self.suffixed_expr()?;
                targets.push(to_target(t).ok_or_else(|| self.err_near("syntax error: cannot assign to this expression"))?);
            }
            self.check(Tok::Assign)?;
            let exprs = self.expr_list()?;
            Ok(Stat::Assign(targets, exprs, line))
        } else if matches!(e, Expr::Call(..) | Expr::Method(..)) {
            Ok(Stat::Call(e, line))
        } else {
            Err(self.err_near(&format!("syntax error near {}", self.peek().describe())))
        }
    }

    // ---- Functions --------------------------------------------------------

    fn function_body(&mut self, method: bool, name: String, line: u32) -> Result<Arc<FuncProto>, LuaError> {
        self.enter()?;
        self.open_func(false);
        let mut nparams = 0;
        if method {
            self.declare("self".into())?;
            nparams += 1;
        }
        self.check(Tok::LParen)?;
        if self.peek() != &Tok::RParen {
            loop {
                match self.advance() {
                    Tok::Name(n) => {
                        self.declare(n)?;
                        nparams += 1;
                    }
                    Tok::Dots => {
                        self.fs().is_vararg = true;
                        break;
                    }
                    t => {
                        self.pos -= 1;
                        return Err(self.err_near(&format!("<name> expected near {}", t.describe())));
                    }
                }
                if self.peek() != &Tok::Comma {
                    break;
                }
                self.advance();
            }
        }
        self.check(Tok::RParen)?;
        let body = self.block()?;
        self.check_match(Tok::End, Tok::Function, line)?;
        let proto = self.close_func(body, name, line, nparams);
        self.leave();
        Ok(Arc::new(proto))
    }

    // ---- Expressions ------------------------------------------------------

    fn expr_list(&mut self) -> Result<Vec<Expr>, LuaError> {
        let mut out = vec![self.expr()?];
        while self.peek() == &Tok::Comma {
            self.advance();
            out.push(self.expr()?);
        }
        Ok(out)
    }

    fn expr(&mut self) -> Result<Expr, LuaError> {
        self.subexpr(0)
    }

    fn subexpr(&mut self, limit: u8) -> Result<Expr, LuaError> {
        self.enter()?;
        let line = self.line();
        let mut e = match self.peek() {
            Tok::Not | Tok::Minus | Tok::Hash => {
                let op = match self.advance() {
                    Tok::Not => UnOp::Not,
                    Tok::Minus => UnOp::Neg,
                    _ => UnOp::Len,
                };
                let operand = self.subexpr(UNARY_PRIORITY)?;
                match (op, operand) {
                    // Constant folding keeps "-1" a plain number.
                    (UnOp::Neg, Expr::Num(n)) => Expr::Num(-n),
                    (op, operand) => Expr::Un(op, Box::new(operand), line),
                }
            }
            _ => self.simple_expr()?,
        };
        loop {
            // `and` and `or` short-circuit, so they get their own nodes.
            let (op, left, right) = match self.peek() {
                Tok::And => (None, 2, 2),
                Tok::Or => (Some(None), 1, 1),
                t => match binop(t) {
                    Some((op, l, r)) => (Some(Some(op)), l, r),
                    None => break,
                },
            };
            if left <= limit {
                break;
            }
            let line = self.line();
            self.advance();
            let rhs = Box::new(self.subexpr(right)?);
            e = match op {
                None => Expr::And(Box::new(e), rhs),
                Some(None) => Expr::Or(Box::new(e), rhs),
                Some(Some(op)) => Expr::Bin(op, Box::new(e), rhs, line),
            };
        }
        self.leave();
        Ok(e)
    }

    fn simple_expr(&mut self) -> Result<Expr, LuaError> {
        let line = self.line();
        Ok(match self.peek().clone() {
            Tok::Num(n) => {
                self.advance();
                Expr::Num(n)
            }
            Tok::Str(s) => {
                self.advance();
                Expr::Str(s.into())
            }
            Tok::Nil => {
                self.advance();
                Expr::Nil
            }
            Tok::True => {
                self.advance();
                Expr::True
            }
            Tok::False => {
                self.advance();
                Expr::False
            }
            Tok::Dots => {
                self.advance();
                if !self.fs().is_vararg {
                    return Err(self.err_near("cannot use '...' outside a vararg function"));
                }
                Expr::Vararg
            }
            Tok::LBrace => self.table()?,
            Tok::Function => {
                self.advance();
                Expr::Func(self.function_body(false, "anonymous function".into(), line)?)
            }
            _ => self.suffixed_expr()?,
        })
    }

    fn primary_expr(&mut self) -> Result<Expr, LuaError> {
        let line = self.line();
        match self.peek().clone() {
            Tok::Name(n) => {
                self.advance();
                self.var_expr(n)
            }
            Tok::LParen => {
                self.advance();
                let e = self.expr()?;
                self.check_match(Tok::RParen, Tok::LParen, line)?;
                Ok(Expr::Paren(Box::new(e)))
            }
            _ => Err(self.unexpected()),
        }
    }

    fn suffixed_expr(&mut self) -> Result<Expr, LuaError> {
        self.enter()?;
        let mut e = self.primary_expr()?;
        loop {
            let line = self.line();
            match self.peek().clone() {
                Tok::Dot => {
                    self.advance();
                    let k = self.name()?;
                    e = Expr::Index(Box::new(e), Box::new(Expr::Str(lstr(&k))), line);
                }
                Tok::LBracket => {
                    self.advance();
                    let k = self.expr()?;
                    self.check(Tok::RBracket)?;
                    e = Expr::Index(Box::new(e), Box::new(k), line);
                }
                Tok::Colon => {
                    self.advance();
                    let k = self.name()?;
                    let args = self.call_args()?;
                    e = Expr::Method(Box::new(e), lstr(&k), args, line);
                }
                Tok::LParen | Tok::Str(_) | Tok::LBrace => {
                    // "f\n(...)" is ambiguous in Lua 5.1 and refused.
                    if self.peek() == &Tok::LParen && self.toks[self.pos - 1].1 != line {
                        return Err(self.err_near("ambiguous syntax (function call x new statement)"));
                    }
                    let args = self.call_args()?;
                    e = Expr::Call(Box::new(e), args, line);
                }
                _ => break,
            }
        }
        self.leave();
        Ok(e)
    }

    fn call_args(&mut self) -> Result<Vec<Expr>, LuaError> {
        let line = self.line();
        match self.peek().clone() {
            Tok::Str(s) => {
                self.advance();
                Ok(vec![Expr::Str(s.into())])
            }
            Tok::LBrace => Ok(vec![self.table()?]),
            Tok::LParen => {
                self.advance();
                if self.peek() == &Tok::RParen {
                    self.advance();
                    return Ok(Vec::new());
                }
                let args = self.expr_list()?;
                self.check_match(Tok::RParen, Tok::LParen, line)?;
                Ok(args)
            }
            _ => Err(self.err_near(&format!("function arguments expected near {}", self.peek().describe()))),
        }
    }

    fn table(&mut self) -> Result<Expr, LuaError> {
        let line = self.line();
        self.check(Tok::LBrace)?;
        let mut fields = Vec::new();
        while self.peek() != &Tok::RBrace {
            match (self.peek().clone(), self.peek2().clone()) {
                (Tok::Name(n), Tok::Assign) => {
                    self.advance();
                    self.advance();
                    let v = self.expr()?;
                    fields.push(Field::Pair(Expr::Str(lstr(&n)), v));
                }
                (Tok::LBracket, _) => {
                    self.advance();
                    let k = self.expr()?;
                    self.check(Tok::RBracket)?;
                    self.check(Tok::Assign)?;
                    let v = self.expr()?;
                    fields.push(Field::Pair(k, v));
                }
                _ => fields.push(Field::Item(self.expr()?)),
            }
            match self.peek() {
                Tok::Comma | Tok::Semi => {
                    self.advance();
                }
                _ => break,
            }
        }
        self.check_match(Tok::RBrace, Tok::LBrace, line)?;
        Ok(Expr::Table(fields, line))
    }
}

fn to_target(e: Expr) -> Option<Target> {
    Some(match e {
        Expr::Local(slot, id) => Target::Local(slot, id),
        Expr::Upval(i, _) => Target::Upval(i),
        Expr::Global(n) => Target::Global(n),
        Expr::Index(o, k, _) => Target::Index(*o, *k),
        _ => return None,
    })
}

// ---- Captured locals -------------------------------------------------------
// Once a function is parsed it is known which of its locals closures
// capture; their uses are rewritten to go through cells. Nested function
// bodies were rewritten when they closed.

fn fix_block(b: &mut Block, cap: &[bool]) {
    for s in b {
        fix_stat(s, cap);
    }
}

fn fix_local(l: &mut Local, cap: &[bool]) {
    l.cell = cap[l.id as usize];
}

fn fix_stat(s: &mut Stat, cap: &[bool]) {
    match s {
        Stat::Call(e, _) => fix_expr(e, cap),
        Stat::Local(locals, exprs, _) => {
            locals.iter_mut().for_each(|l| fix_local(l, cap));
            exprs.iter_mut().for_each(|e| fix_expr(e, cap));
        }
        Stat::Assign(targets, exprs, _) => {
            for t in targets.iter_mut() {
                fix_target(t, cap);
            }
            exprs.iter_mut().for_each(|e| fix_expr(e, cap));
        }
        Stat::Do(b) => fix_block(b, cap),
        Stat::While(c, b, _) | Stat::Repeat(b, c, _) => {
            fix_expr(c, cap);
            fix_block(b, cap);
        }
        Stat::If(conds, otherwise, _) => {
            for (c, b) in conds {
                fix_expr(c, cap);
                fix_block(b, cap);
            }
            if let Some(b) = otherwise {
                fix_block(b, cap);
            }
        }
        Stat::NumFor { var, start, limit, step, body, .. } => {
            fix_local(var, cap);
            fix_expr(start, cap);
            fix_expr(limit, cap);
            if let Some(s) = step {
                fix_expr(s, cap);
            }
            fix_block(body, cap);
        }
        Stat::GenFor { vars, exprs, body, .. } => {
            vars.iter_mut().for_each(|l| fix_local(l, cap));
            exprs.iter_mut().for_each(|e| fix_expr(e, cap));
            fix_block(body, cap);
        }
        Stat::LocalFunction(l, _, _) => fix_local(l, cap),
        Stat::Return(exprs, _) => exprs.iter_mut().for_each(|e| fix_expr(e, cap)),
        Stat::Break(_) => {}
    }
}

fn fix_target(t: &mut Target, cap: &[bool]) {
    match t {
        Target::Index(o, k) => {
            fix_expr(o, cap);
            fix_expr(k, cap);
        }
        Target::Local(slot, id) => {
            if cap[*id as usize] {
                *t = Target::Cell(*slot);
            }
        }
        Target::Cell(_) | Target::Upval(_) | Target::Global(_) => {}
    }
}

fn fix_expr(e: &mut Expr, cap: &[bool]) {
    match e {
        Expr::Local(slot, id) => {
            if cap[*id as usize] {
                *e = Expr::Cell(*slot, *id);
            }
        }
        Expr::Index(o, k, _) => {
            fix_expr(o, cap);
            fix_expr(k, cap);
        }
        Expr::Call(f, args, _) => {
            fix_expr(f, cap);
            args.iter_mut().for_each(|a| fix_expr(a, cap));
        }
        Expr::Method(o, _, args, _) => {
            fix_expr(o, cap);
            args.iter_mut().for_each(|a| fix_expr(a, cap));
        }
        Expr::Bin(_, a, b, _) | Expr::And(a, b) | Expr::Or(a, b) => {
            fix_expr(a, cap);
            fix_expr(b, cap);
        }
        Expr::Un(_, a, _) | Expr::Paren(a) => fix_expr(a, cap),
        Expr::Table(fields, _) => {
            for f in fields {
                match f {
                    Field::Item(v) => fix_expr(v, cap),
                    Field::Pair(k, v) => {
                        fix_expr(k, cap);
                        fix_expr(v, cap);
                    }
                }
            }
        }
        Expr::Nil
        | Expr::True
        | Expr::False
        | Expr::Num(_)
        | Expr::Str(_)
        | Expr::Vararg
        | Expr::Func(_)
        | Expr::Cell(..)
        | Expr::Upval(..)
        | Expr::Global(_) => {}
    }
}
