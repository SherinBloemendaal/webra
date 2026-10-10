//! Number parsing and formatting with C semantics, computed the same on
//! every platform: Rust's float parsing and formatting are exact (correctly
//! rounded), so no platform libc is involved.

/// Parse a Lua numeral (decimal with optional fraction and exponent, or hex
/// integer), with optional surrounding whitespace and sign, as `tonumber` and
/// string coercion accept it. None when it is not a whole number literal.
pub fn parse_number(s: &str) -> Option<f64> {
    let t = s.trim_matches(|c: char| c == ' ' || ('\t'..='\r').contains(&c));
    if t.is_empty() {
        return None;
    }
    let (neg, body) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let v = if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        // Like strtoul: wraps nothing, keeps every digit's value as a double.
        hex.bytes().fold(0.0f64, |acc, b| acc * 16.0 + (b as char).to_digit(16).unwrap() as f64)
    } else {
        let b = body.as_bytes();
        let mut i = 0;
        let mut digits = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
        if i < b.len() && b[i] == b'.' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return None;
        }
        if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
            i += 1;
            if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
                i += 1;
            }
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                return None;
            }
        }
        if i != b.len() {
            return None;
        }
        // Rust's parser does not take "5." or ".5"-less forms differently: normalise.
        let mut text = body.to_string();
        if text.starts_with('.') {
            text.insert(0, '0');
        }
        text = text.replace(".e", ".0e").replace(".E", ".0E");
        if text.ends_with('.') {
            text.push('0');
        }
        text.parse::<f64>().ok()?
    };
    Some(if neg { -v } else { v })
}

/// `tostring` of a number: C's "%.14g", as the reference Lua 5.1 prints it.
pub fn fmt_number(x: f64) -> String {
    fmt_g(x, 14, false, false)
}

/// Exponent (base 10) of `x` once rounded to `digits` significant digits, and the digits.
fn sci_parts(x: f64, digits: usize) -> (String, i32) {
    let s = format!("{:.*e}", digits.saturating_sub(1), x.abs());
    let (m, e) = s.split_once('e').expect("exponent");
    (m.to_string(), e.parse().expect("integer exponent"))
}

fn nonfinite(x: f64, upper: bool) -> Option<String> {
    let s = if x.is_nan() {
        // The sign of a NaN differs between platforms; it is never shown.
        "nan"
    } else if x.is_infinite() {
        if x > 0.0 {
            "inf"
        } else {
            "-inf"
        }
    } else {
        return None;
    };
    Some(if upper { s.to_uppercase() } else { s.to_string() })
}

fn exp_suffix(e: i32, upper: bool) -> String {
    format!("{}{}{:02}", if upper { 'E' } else { 'e' }, if e < 0 { '-' } else { '+' }, e.abs())
}

fn strip_zeros(s: &mut String) {
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
}

/// C "%.{p}g" (`alt`: the '#' flag keeps trailing zeros).
pub fn fmt_g(x: f64, precision: usize, upper: bool, alt: bool) -> String {
    if let Some(s) = nonfinite(x, upper) {
        return s;
    }
    let p = precision.max(1);
    let sign = if x.is_sign_negative() { "-" } else { "" };
    if x == 0.0 {
        let mut s = format!("{:.*}", p - 1, 0.0);
        if !alt {
            strip_zeros(&mut s);
        }
        return format!("{sign}{s}");
    }
    let (_, e) = sci_parts(x, p);
    if (e as i64) < p as i64 && e >= -4 {
        let decimals = (p as i32 - 1 - e).max(0) as usize;
        let mut s = format!("{:.*}", decimals, x.abs());
        if !alt {
            strip_zeros(&mut s);
        }
        format!("{sign}{s}")
    } else {
        let (mut m, e) = sci_parts(x, p);
        if !alt {
            strip_zeros(&mut m);
        }
        format!("{sign}{m}{}", exp_suffix(e, upper))
    }
}

/// C "%.{p}e".
pub fn fmt_e(x: f64, precision: usize, upper: bool) -> String {
    if let Some(s) = nonfinite(x, upper) {
        return s;
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    let (m, e) = sci_parts(x, precision + 1);
    format!("{sign}{m}{}", exp_suffix(e, upper))
}

/// C "%.{p}f".
pub fn fmt_f(x: f64, precision: usize) -> String {
    if let Some(s) = nonfinite(x, false) {
        return s;
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    format!("{sign}{:.*}", precision, x.abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_c() {
        assert_eq!(fmt_number(1.0), "1");
        assert_eq!(fmt_number(-3.0), "-3");
        assert_eq!(fmt_number(0.5), "0.5");
        assert_eq!(fmt_number(1.0 / 3.0), "0.33333333333333");
        assert_eq!(fmt_number(1e14), "1e+14");
        assert_eq!(fmt_number(123456789012345.0), "1.2345678901234e+14");
        assert_eq!(fmt_number(99999999999999.0), "99999999999999");
        assert_eq!(fmt_number(1e-5), "1e-05");
        assert_eq!(fmt_number(0.0001), "0.0001");
        assert_eq!(fmt_number(f64::INFINITY), "inf");
        assert_eq!(fmt_number(-0.0), "-0");
        assert_eq!(fmt_g(100.0, 1, false, false), "1e+02");
        assert_eq!(fmt_e(1234.5, 2, false), "1.23e+03");
        assert_eq!(fmt_f(2.5, 0), "2");
        assert_eq!(fmt_f(-1.25, 1), "-1.2");
    }

    #[test]
    fn parses_numerals() {
        assert_eq!(parse_number("10"), Some(10.0));
        assert_eq!(parse_number(" 0x1F "), Some(31.0));
        assert_eq!(parse_number("-2.5e2"), Some(-250.0));
        assert_eq!(parse_number(".5"), Some(0.5));
        assert_eq!(parse_number("5."), Some(5.0));
        assert_eq!(parse_number("5.e1"), Some(50.0));
        assert_eq!(parse_number("1e"), None);
        assert_eq!(parse_number("abc"), None);
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("1 2"), None);
    }
}
