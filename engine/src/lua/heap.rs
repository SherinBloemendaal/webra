//! Tables, closures and upvalue cells in index arenas. Indices instead of
//! pointers keep the interpreter `Clone` and `Send` (it lives in the World)
//! and make the heap layout, `tostring` addresses, iteration order and the
//! state hash the same on every machine.

use super::ast::FuncProto;
use super::{Builtin, LStr, UserData, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Table key: a value with numbers normalised (-0 is 0) and hashable.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Bool(bool),
    Num(u64),
    Str(LStr),
    Table(u32),
    Func(u32),
    Builtin(Builtin, u32),
    Host(u32, Option<UserData>),
    UserData(UserData),
}

impl Key {
    pub fn from_value(v: &Value) -> Result<Key, &'static str> {
        Ok(match v {
            Value::Nil => return Err("table index is nil"),
            Value::Bool(b) => Key::Bool(*b),
            Value::Num(n) => {
                if n.is_nan() {
                    return Err("table index is NaN");
                }
                Key::Num(if *n == 0.0 { 0 } else { n.to_bits() })
            }
            Value::Str(s) => Key::Str(s.clone()),
            Value::Table(t) => Key::Table(*t),
            Value::Func(f) => Key::Func(*f),
            Value::Builtin(b, t) => Key::Builtin(*b, *t),
            Value::Host(id, ud) => Key::Host(*id, *ud),
            Value::UserData(u) => Key::UserData(*u),
            Value::Cell(_) => unreachable!("cells are never script values"),
        })
    }

    pub fn to_value(&self) -> Value {
        match self {
            Key::Bool(b) => Value::Bool(*b),
            Key::Num(bits) => Value::Num(f64::from_bits(*bits)),
            Key::Str(s) => Value::Str(s.clone()),
            Key::Table(t) => Value::Table(*t),
            Key::Func(f) => Value::Func(*f),
            Key::Builtin(b, t) => Value::Builtin(*b, *t),
            Key::Host(id, ud) => Value::Host(*id, *ud),
            Key::UserData(u) => Value::UserData(*u),
        }
    }
}

/// Integer value of a number that indexes the array part (1-based), if any.
fn array_index(v: &Value) -> Option<usize> {
    match v {
        Value::Num(n) if *n >= 1.0 && *n <= u32::MAX as f64 && n.fract() == 0.0 => Some(*n as usize),
        _ => None,
    }
}

/// A Lua table: an array part for keys 1..n and an insertion-ordered hash
/// part. Removed hash entries stay as holes until the next rehash, so
/// `next` keeps working when a traversal clears fields (as Lua allows).
#[derive(Clone, Default, Debug)]
pub struct Table {
    pub arr: Vec<Value>,
    keys: Vec<Key>,
    vals: Vec<Value>,
    index: HashMap<Key, u32>,
    live: usize,
}

impl Table {
    pub fn get(&self, k: &Value) -> Value {
        if let Some(i) = array_index(k) {
            if i <= self.arr.len() {
                return self.arr[i - 1].clone();
            }
        }
        match Key::from_value(k) {
            Ok(key) => self.get_key(&key),
            Err(_) => Value::Nil,
        }
    }

    pub fn get_str(&self, k: &str) -> Value {
        self.get_key(&Key::Str(Arc::from(k.as_bytes())))
    }

    pub fn get_int(&self, i: usize) -> Value {
        if i >= 1 && i <= self.arr.len() {
            return self.arr[i - 1].clone();
        }
        self.get_key(&Key::Num((i as f64).to_bits()))
    }

    fn get_key(&self, key: &Key) -> Value {
        self.index.get(key).map_or(Value::Nil, |&i| self.vals[i as usize].clone())
    }

    /// Set a field. Returns the number of slots it added (for the memory
    /// accounting), or the error for a nil or NaN key.
    pub fn set(&mut self, k: Value, v: Value) -> Result<usize, &'static str> {
        if let Some(i) = array_index(&k) {
            if i <= self.arr.len() {
                self.arr[i - 1] = v;
                return Ok(0);
            }
            if i == self.arr.len() + 1 && !matches!(v, Value::Nil) {
                // Remove a copy in the hash part, then grow the array and pull
                // following keys out of the hash part.
                self.remove_key(&Key::Num((i as f64).to_bits()));
                self.arr.push(v);
                let added = 1 + self.absorb();
                return Ok(added);
            }
        }
        let key = Key::from_value(&k)?;
        Ok(self.set_key(key, v))
    }

    /// Move keys that continue the array part out of the hash part.
    fn absorb(&mut self) -> usize {
        let mut added = 0;
        loop {
            let next = Key::Num(((self.arr.len() + 1) as f64).to_bits());
            match self.index.get(&next) {
                Some(&j) if !matches!(self.vals[j as usize], Value::Nil) => {
                    let val = std::mem::replace(&mut self.vals[j as usize], Value::Nil);
                    self.live -= 1;
                    self.arr.push(val);
                    added += 1;
                }
                _ => return added,
            }
        }
    }

    fn remove_key(&mut self, key: &Key) {
        if let Some(&j) = self.index.get(key) {
            if !matches!(self.vals[j as usize], Value::Nil) {
                self.vals[j as usize] = Value::Nil;
                self.live -= 1;
            }
        }
    }

    fn set_key(&mut self, key: Key, v: Value) -> usize {
        if let Some(&j) = self.index.get(&key) {
            let was_nil = matches!(self.vals[j as usize], Value::Nil);
            let is_nil = matches!(v, Value::Nil);
            self.vals[j as usize] = v;
            match (was_nil, is_nil) {
                (true, false) => self.live += 1,
                (false, true) => self.live -= 1,
                _ => {}
            }
            return 0;
        }
        if matches!(v, Value::Nil) {
            return 0;
        }
        // A new key: the moment Lua rehashes. Drop holes when they dominate.
        let holes = self.keys.len() - self.live;
        if holes > 8 && holes > self.live {
            self.compact();
        }
        self.index.insert(key.clone(), self.keys.len() as u32);
        self.keys.push(key);
        self.vals.push(v);
        self.live += 1;
        1
    }

    fn compact(&mut self) {
        let keys = std::mem::take(&mut self.keys);
        let vals = std::mem::take(&mut self.vals);
        self.index.clear();
        for (k, v) in keys.into_iter().zip(vals) {
            if !matches!(v, Value::Nil) {
                self.index.insert(k.clone(), self.keys.len() as u32);
                self.keys.push(k);
                self.vals.push(v);
            }
        }
        while matches!(self.arr.last(), Some(Value::Nil)) {
            self.arr.pop();
        }
    }

    /// The length operator: a border, like Lua 5.1's luaH_getn.
    pub fn border(&self) -> usize {
        let n = self.arr.len();
        if n > 0 && matches!(self.arr[n - 1], Value::Nil) {
            let (mut i, mut j) = (0, n);
            while j - i > 1 {
                let m = (i + j) / 2;
                if matches!(self.arr[m - 1], Value::Nil) {
                    j = m;
                } else {
                    i = m;
                }
            }
            return i;
        }
        let mut j = n;
        while !matches!(self.get_key(&Key::Num(((j + 1) as f64).to_bits())), Value::Nil) {
            j += 1;
        }
        j
    }

    /// Entry after `k` (nil: the first), skipping empty slots. Err for a key
    /// that is not in the table.
    pub fn next(&self, k: &Value) -> Result<Option<(Value, Value)>, &'static str> {
        let mut pos = match k {
            Value::Nil => 0,
            _ => match array_index(k) {
                Some(i) if i <= self.arr.len() => i,
                _ => {
                    let key = Key::from_value(k).map_err(|_| "invalid key to 'next'")?;
                    let &j = self.index.get(&key).ok_or("invalid key to 'next'")?;
                    self.arr.len() + j as usize + 1
                }
            },
        };
        while pos < self.arr.len() {
            if !matches!(self.arr[pos], Value::Nil) {
                return Ok(Some((Value::Num((pos + 1) as f64), self.arr[pos].clone())));
            }
            pos += 1;
        }
        let mut j = pos - self.arr.len();
        while j < self.keys.len() {
            if !matches!(self.vals[j], Value::Nil) {
                return Ok(Some((self.keys[j].to_value(), self.vals[j].clone())));
            }
            j += 1;
        }
        Ok(None)
    }

    /// Slots this table takes (memory accounting).
    pub fn size(&self) -> usize {
        1 + self.arr.len() + self.keys.len()
    }

    /// Every key and value (for the collector and the state hash), in order.
    pub fn for_each(&self, mut f: impl FnMut(&Value, &Value)) {
        for (i, v) in self.arr.iter().enumerate() {
            if !matches!(v, Value::Nil) {
                f(&Value::Num((i + 1) as f64), v);
            }
        }
        for (k, v) in self.keys.iter().zip(&self.vals) {
            if !matches!(v, Value::Nil) {
                f(&k.to_value(), v);
            }
        }
    }

    /// Insert at array position `pos` (1-based), shifting later items up (table.insert).
    pub fn insert_at(&mut self, pos: usize, v: Value) -> usize {
        let n = self.border();
        if pos > n || n != self.arr.len() {
            // Not a plain sequence in the array part: shift field by field.
            let mut i = n;
            while i >= pos {
                let prev = self.get_int(i);
                let _ = self.set(Value::Num((i + 1) as f64), prev);
                i -= 1;
            }
            return self.set(Value::Num(pos as f64), v).unwrap_or(0);
        }
        self.arr.insert(pos - 1, v);
        // Keys after the old end may continue the sequence now.
        1 + self.absorb()
    }

    /// Remove array position `pos` (1-based) of a sequence of length `n`, shifting later items down (table.remove).
    pub fn remove_at(&mut self, pos: usize, n: usize) -> Value {
        let v = self.get_int(pos);
        for i in pos..n {
            let next = self.get_int(i + 1);
            let _ = self.set(Value::Num(i as f64), next);
        }
        let _ = self.set(Value::Num(n as f64), Value::Nil);
        v
    }
}

#[derive(Clone, Debug)]
pub struct Closure {
    pub proto: Arc<FuncProto>,
    /// Cells of the captured variables.
    pub upvals: Vec<u32>,
}

/// Objects the collector frees: index slots are reused lowest-first after a
/// collection, so allocation order is the same on every machine.
#[derive(Clone, Debug)]
pub struct Arena<T> {
    pub items: Vec<Option<T>>,
    free: Vec<u32>,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Arena { items: Vec::new(), free: Vec::new() }
    }
}

impl<T> Arena<T> {
    pub fn alloc(&mut self, v: T) -> u32 {
        if let Some(i) = self.free.pop() {
            self.items[i as usize] = Some(v);
            i
        } else {
            self.items.push(Some(v));
            self.items.len() as u32 - 1
        }
    }

    pub fn get(&self, i: u32) -> &T {
        self.items[i as usize].as_ref().expect("live heap object")
    }

    pub fn get_mut(&mut self, i: u32) -> &mut T {
        self.items[i as usize].as_mut().expect("live heap object")
    }

    pub fn live(&self) -> usize {
        self.items.len() - self.free.len()
    }

    /// Free every object `marked` does not keep. Returns how many were freed.
    fn sweep(&mut self, marked: &[bool]) -> usize {
        let mut freed = 0;
        for (i, item) in self.items.iter_mut().enumerate() {
            if item.is_some() && !marked[i] {
                *item = None;
                freed += 1;
            }
        }
        // Trailing free slots are dropped altogether; the free list is
        // rebuilt so the lowest index is reused first.
        while matches!(self.items.last(), Some(None)) {
            self.items.pop();
        }
        self.free = (0..self.items.len() as u32).rev().filter(|&i| self.items[i as usize].is_none()).collect();
        freed
    }
}

#[derive(Clone, Default, Debug)]
pub struct Heap {
    pub tables: Arena<Table>,
    pub closures: Arena<Closure>,
    pub cells: Arena<Value>,
    /// Slots allocated (tables count their entries), for the memory limit.
    pub slots: usize,
    /// Slots allocated since the last collection.
    pub allocated: usize,
}

impl Heap {
    pub fn new_table(&mut self) -> u32 {
        self.slots += 1;
        self.allocated += 1;
        self.tables.alloc(Table::default())
    }

    pub fn new_closure(&mut self, c: Closure) -> u32 {
        self.slots += 1 + c.upvals.len();
        self.allocated += 1;
        self.closures.alloc(c)
    }

    pub fn new_cell(&mut self, v: Value) -> u32 {
        self.slots += 1;
        self.allocated += 1;
        self.cells.alloc(v)
    }

    /// Mark and sweep from `roots`. Only called when no script runs, so the
    /// roots are complete: globals, the libraries and what the host keeps.
    pub fn collect(&mut self, roots: &mut dyn Iterator<Item = Value>) {
        let mut tmark = vec![false; self.tables.items.len()];
        let mut fmark = vec![false; self.closures.items.len()];
        let mut cmark = vec![false; self.cells.items.len()];
        let mut stack: Vec<Value> = roots.collect();
        while let Some(v) = stack.pop() {
            match v {
                Value::Table(t) | Value::Builtin(_, t) if t != super::NO_TABLE => {
                    if !std::mem::replace(&mut tmark[t as usize], true) {
                        self.tables.get(t).for_each(|k, v| {
                            stack.push(k.clone());
                            stack.push(v.clone());
                        });
                    }
                }
                Value::Func(f) => {
                    if !std::mem::replace(&mut fmark[f as usize], true) {
                        for &c in &self.closures.get(f).upvals {
                            stack.push(Value::Cell(c));
                        }
                    }
                }
                Value::Cell(c) => {
                    if !std::mem::replace(&mut cmark[c as usize], true) {
                        stack.push(self.cells.get(c).clone());
                    }
                }
                _ => {}
            }
        }
        self.tables.sweep(&tmark);
        self.closures.sweep(&fmark);
        self.cells.sweep(&cmark);
        self.slots = self.tables.items.iter().flatten().map(Table::size).sum::<usize>()
            + self.closures.items.iter().flatten().map(|c| 1 + c.upvals.len()).sum::<usize>()
            + self.cells.live();
        self.allocated = 0;
    }
}
