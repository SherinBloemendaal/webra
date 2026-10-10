//! Syntax tree with resolved variables: every local has a frame slot, every
//! captured local lives in a heap cell, and upvalues are numbered per function.

use super::LStr;
use std::sync::Arc;

#[derive(Debug)]
pub struct FuncProto {
    /// Name for error messages ("function 'Foo'", "main chunk").
    pub name: String,
    pub chunk: Arc<str>,
    pub line: u32,
    pub nparams: usize,
    pub is_vararg: bool,
    /// Frame size: the most locals alive at once.
    pub nslots: usize,
    /// Parameters that closures capture (they get a cell at entry).
    pub param_cells: Vec<bool>,
    /// Where each upvalue of a new closure comes from in the creating function.
    pub upvals: Vec<UpvalSource>,
    pub body: Block,
}

#[derive(Clone, Copy, Debug)]
pub enum UpvalSource {
    /// A captured local of the creating function (its slot holds the cell).
    Local(u16),
    /// An upvalue of the creating function.
    Upval(u16),
}

pub type Block = Vec<Stat>;

/// A local declared by a statement: its slot, and whether a closure captures it.
#[derive(Clone, Copy, Debug)]
pub struct Local {
    pub slot: u16,
    pub cell: bool,
    /// Declaration id inside the function (resolver bookkeeping).
    pub id: u32,
}

#[derive(Debug)]
pub enum Stat {
    Call(Expr, u32),
    Local(Vec<Local>, Vec<Expr>, u32),
    Assign(Vec<Target>, Vec<Expr>, u32),
    Do(Block),
    While(Expr, Block, u32),
    Repeat(Block, Expr, u32),
    If(Vec<(Expr, Block)>, Option<Block>, u32),
    NumFor { var: Local, start: Expr, limit: Expr, step: Option<Expr>, body: Block, line: u32 },
    GenFor { vars: Vec<Local>, exprs: Vec<Expr>, body: Block, line: u32 },
    LocalFunction(Local, Arc<FuncProto>, u32),
    Return(Vec<Expr>, u32),
    Break,
}

#[derive(Debug)]
pub enum Target {
    /// Slot and declaration id; rewritten to `Cell` when a closure captures it.
    Local(u16, u32),
    Cell(u16),
    Upval(u16),
    Global(LStr),
    Index(Expr, Expr),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Concat,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Not,
    Len,
}

#[derive(Debug)]
pub enum Expr {
    Nil,
    True,
    False,
    Num(f64),
    Str(LStr),
    Vararg,
    Func(Arc<FuncProto>),
    /// A plain local in its frame slot.
    Local(u16, u32),
    /// A captured local: the frame slot holds its cell.
    Cell(u16),
    Upval(u16, LStr),
    Global(LStr),
    Index(Box<Expr>, Box<Expr>, u32),
    Call(Box<Expr>, Vec<Expr>, u32),
    Method(Box<Expr>, LStr, Vec<Expr>, u32),
    Bin(BinOp, Box<Expr>, Box<Expr>, u32),
    Un(UnOp, Box<Expr>, u32),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Table(Vec<Field>, u32),
    /// Parentheses: truncate a multi-value expression to one value.
    Paren(Box<Expr>),
}

#[derive(Debug)]
pub enum Field {
    /// Positional item (`{a, b}`).
    Item(Expr),
    /// `[k] = v` or `name = v`.
    Pair(Expr, Expr),
}

impl Expr {
    /// Calls and `...` produce any number of values at the end of a list.
    pub fn is_multi(&self) -> bool {
        matches!(self, Expr::Call(..) | Expr::Method(..) | Expr::Vararg)
    }
}
