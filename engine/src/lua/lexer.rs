//! Lua 5.1 tokenizer.

use super::number::parse_number;
use super::LuaError;

#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    Name(String),
    Str(Vec<u8>),
    Num(f64),
    // Keywords
    And,
    Break,
    Do,
    Else,
    Elseif,
    End,
    False,
    For,
    Function,
    If,
    In,
    Local,
    Nil,
    Not,
    Or,
    Repeat,
    Return,
    Then,
    True,
    Until,
    While,
    // Symbols
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    Hash,
    Eq,
    Ne,
    Le,
    Ge,
    Lt,
    Gt,
    Assign,
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Semi,
    Colon,
    Comma,
    Dot,
    Concat,
    Dots,
    Eof,
}

impl Tok {
    pub fn describe(&self) -> String {
        match self {
            Tok::Name(n) => format!("'{n}'"),
            Tok::Str(_) => "string".into(),
            Tok::Num(_) => "number".into(),
            Tok::Eof => "<eof>".into(),
            t => format!("'{}'", symbol(t)),
        }
    }
}

fn symbol(t: &Tok) -> &'static str {
    match t {
        Tok::And => "and",
        Tok::Break => "break",
        Tok::Do => "do",
        Tok::Else => "else",
        Tok::Elseif => "elseif",
        Tok::End => "end",
        Tok::False => "false",
        Tok::For => "for",
        Tok::Function => "function",
        Tok::If => "if",
        Tok::In => "in",
        Tok::Local => "local",
        Tok::Nil => "nil",
        Tok::Not => "not",
        Tok::Or => "or",
        Tok::Repeat => "repeat",
        Tok::Return => "return",
        Tok::Then => "then",
        Tok::True => "true",
        Tok::Until => "until",
        Tok::While => "while",
        Tok::Plus => "+",
        Tok::Minus => "-",
        Tok::Star => "*",
        Tok::Slash => "/",
        Tok::Percent => "%",
        Tok::Caret => "^",
        Tok::Hash => "#",
        Tok::Eq => "==",
        Tok::Ne => "~=",
        Tok::Le => "<=",
        Tok::Ge => ">=",
        Tok::Lt => "<",
        Tok::Gt => ">",
        Tok::Assign => "=",
        Tok::LParen => "(",
        Tok::RParen => ")",
        Tok::LBrace => "{",
        Tok::RBrace => "}",
        Tok::LBracket => "[",
        Tok::RBracket => "]",
        Tok::Semi => ";",
        Tok::Colon => ":",
        Tok::Comma => ",",
        Tok::Dot => ".",
        Tok::Concat => "..",
        Tok::Dots => "...",
        _ => "?",
    }
}

fn keyword(s: &str) -> Option<Tok> {
    Some(match s {
        "and" => Tok::And,
        "break" => Tok::Break,
        "do" => Tok::Do,
        "else" => Tok::Else,
        "elseif" => Tok::Elseif,
        "end" => Tok::End,
        "false" => Tok::False,
        "for" => Tok::For,
        "function" => Tok::Function,
        "if" => Tok::If,
        "in" => Tok::In,
        "local" => Tok::Local,
        "nil" => Tok::Nil,
        "not" => Tok::Not,
        "or" => Tok::Or,
        "repeat" => Tok::Repeat,
        "return" => Tok::Return,
        "then" => Tok::Then,
        "true" => Tok::True,
        "until" => Tok::Until,
        "while" => Tok::While,
        _ => return None,
    })
}

/// Tokens with their line numbers.
pub fn tokenize(chunk: &str, src: &[u8]) -> Result<Vec<(Tok, u32)>, LuaError> {
    let mut lx = Lexer { src, pos: 0, line: 1, chunk };
    let mut out = Vec::new();
    // A leading "#!" line is skipped, as by the reference interpreter.
    if src.starts_with(b"#") {
        while lx.pos < src.len() && src[lx.pos] != b'\n' {
            lx.pos += 1;
        }
    }
    loop {
        let (t, line) = lx.next()?;
        let eof = t == Tok::Eof;
        out.push((t, line));
        if eof {
            return Ok(out);
        }
    }
}

struct Lexer<'a> {
    src: &'a [u8],
    pos: usize,
    line: u32,
    chunk: &'a str,
}

impl Lexer<'_> {
    fn err(&self, msg: &str) -> LuaError {
        LuaError::syntax(format!("{}:{}: {msg}", self.chunk, self.line))
    }

    fn peek(&self, k: usize) -> u8 {
        self.src.get(self.pos + k).copied().unwrap_or(0)
    }

    /// Length of the long bracket opening at `pos` (`[[`, `[==[`), as its level, or None.
    fn long_bracket(&self) -> Option<usize> {
        if self.peek(0) != b'[' {
            return None;
        }
        let mut k = 1;
        while self.peek(k) == b'=' {
            k += 1;
        }
        (self.peek(k) == b'[').then_some(k - 1)
    }

    fn read_long(&mut self, level: usize) -> Result<Vec<u8>, LuaError> {
        self.pos += level + 2;
        // A newline right after the opening bracket is skipped.
        if self.peek(0) == b'\r' || self.peek(0) == b'\n' {
            self.newline();
        }
        let mut out = Vec::new();
        loop {
            match self.peek(0) {
                0 if self.pos >= self.src.len() => return Err(self.err("unfinished long string or comment")),
                b']' => {
                    let mut k = 1;
                    while self.peek(k) == b'=' {
                        k += 1;
                    }
                    if k - 1 == level && self.peek(k) == b']' {
                        self.pos += k + 1;
                        return Ok(out);
                    }
                    out.push(b']');
                    self.pos += 1;
                }
                b'\r' | b'\n' => {
                    self.newline();
                    out.push(b'\n');
                }
                c => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
    }

    /// Consume one line break (\n, \r, \r\n or \n\r).
    fn newline(&mut self) {
        let c = self.peek(0);
        self.pos += 1;
        let d = self.peek(0);
        if (d == b'\r' || d == b'\n') && d != c {
            self.pos += 1;
        }
        self.line += 1;
    }

    fn next(&mut self) -> Result<(Tok, u32), LuaError> {
        loop {
            let c = self.peek(0);
            if self.pos >= self.src.len() {
                return Ok((Tok::Eof, self.line));
            }
            match c {
                b'\n' | b'\r' => self.newline(),
                b' ' | b'\t' | 0x0b | 0x0c => self.pos += 1,
                b'-' if self.peek(1) == b'-' => {
                    self.pos += 2;
                    if let Some(level) = self.long_bracket() {
                        self.read_long(level)?;
                    } else {
                        while self.pos < self.src.len() && self.peek(0) != b'\n' && self.peek(0) != b'\r' {
                            self.pos += 1;
                        }
                    }
                }
                _ => break,
            }
        }
        let line = self.line;
        let c = self.peek(0);
        let two = |a: u8, t2: Tok, t1: Tok, me: &mut Self| {
            if me.peek(1) == a {
                me.pos += 2;
                t2
            } else {
                me.pos += 1;
                t1
            }
        };
        let tok = match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let start = self.pos;
                while matches!(self.peek(0), b'a'..=b'z' | b'A'..=b'Z' | b'_' | b'0'..=b'9') {
                    self.pos += 1;
                }
                let s = std::str::from_utf8(&self.src[start..self.pos]).expect("ascii name");
                keyword(s).unwrap_or_else(|| Tok::Name(s.to_string()))
            }
            b'0'..=b'9' => self.number()?,
            b'.' if self.peek(1).is_ascii_digit() => self.number()?,
            b'"' | b'\'' => Tok::Str(self.string(c)?),
            b'[' => match self.long_bracket() {
                Some(level) => Tok::Str(self.read_long(level)?),
                None => {
                    self.pos += 1;
                    Tok::LBracket
                }
            },
            b'+' => self.single(Tok::Plus),
            b'-' => self.single(Tok::Minus),
            b'*' => self.single(Tok::Star),
            b'/' => self.single(Tok::Slash),
            b'%' => self.single(Tok::Percent),
            b'^' => self.single(Tok::Caret),
            b'#' => self.single(Tok::Hash),
            b'(' => self.single(Tok::LParen),
            b')' => self.single(Tok::RParen),
            b'{' => self.single(Tok::LBrace),
            b'}' => self.single(Tok::RBrace),
            b']' => self.single(Tok::RBracket),
            b';' => self.single(Tok::Semi),
            b':' => self.single(Tok::Colon),
            b',' => self.single(Tok::Comma),
            b'=' => two(b'=', Tok::Eq, Tok::Assign, self),
            b'<' => two(b'=', Tok::Le, Tok::Lt, self),
            b'>' => two(b'=', Tok::Ge, Tok::Gt, self),
            b'~' => {
                if self.peek(1) == b'=' {
                    self.pos += 2;
                    Tok::Ne
                } else {
                    return Err(self.err("unexpected symbol near '~'"));
                }
            }
            b'.' => {
                if self.peek(1) == b'.' {
                    if self.peek(2) == b'.' {
                        self.pos += 3;
                        Tok::Dots
                    } else {
                        self.pos += 2;
                        Tok::Concat
                    }
                } else {
                    self.pos += 1;
                    Tok::Dot
                }
            }
            _ => return Err(self.err(&format!("unexpected symbol near '{}'", c as char))),
        };
        Ok((tok, line))
    }

    fn single(&mut self, t: Tok) -> Tok {
        self.pos += 1;
        t
    }

    fn number(&mut self) -> Result<Tok, LuaError> {
        let start = self.pos;
        // Like the reference lexer: digits, dots, exponents with signs, hex digits.
        loop {
            let c = self.peek(0);
            if c.is_ascii_alphanumeric() || c == b'.' || c == b'_' {
                let e = c == b'e' || c == b'E';
                self.pos += 1;
                if e && (self.peek(0) == b'+' || self.peek(0) == b'-') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
        let text = std::str::from_utf8(&self.src[start..self.pos]).unwrap_or("");
        match parse_number(text) {
            Some(n) => Ok(Tok::Num(n)),
            None => Err(self.err(&format!("malformed number near '{text}'"))),
        }
    }

    fn string(&mut self, quote: u8) -> Result<Vec<u8>, LuaError> {
        self.pos += 1;
        let mut out = Vec::new();
        loop {
            let c = self.peek(0);
            if self.pos >= self.src.len() {
                return Err(self.err("unfinished string"));
            }
            match c {
                b'\n' | b'\r' => return Err(self.err("unfinished string")),
                b'\\' => {
                    self.pos += 1;
                    let e = self.peek(0);
                    match e {
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        b'a' => out.push(7),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'v' => out.push(11),
                        b'\\' => out.push(b'\\'),
                        b'"' => out.push(b'"'),
                        b'\'' => out.push(b'\''),
                        b'\n' | b'\r' => {
                            self.newline();
                            out.push(b'\n');
                            continue;
                        }
                        b'0'..=b'9' => {
                            let mut v: u32 = 0;
                            let mut k = 0;
                            while k < 3 && self.peek(0).is_ascii_digit() {
                                v = v * 10 + (self.peek(0) - b'0') as u32;
                                self.pos += 1;
                                k += 1;
                            }
                            if v > 255 {
                                return Err(self.err("escape sequence too large"));
                            }
                            out.push(v as u8);
                            continue;
                        }
                        _ if self.pos >= self.src.len() => return Err(self.err("unfinished string")),
                        // Lua 5.1 keeps unknown escapes as the character itself.
                        other => out.push(other),
                    }
                    self.pos += 1;
                }
                c if c == quote => {
                    self.pos += 1;
                    return Ok(out);
                }
                c => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
    }
}
