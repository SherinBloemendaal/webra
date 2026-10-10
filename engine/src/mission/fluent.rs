//! `UserInterface.GetFluentMessage`: the mission's messages (Fluent, already
//! parsed by tools/gen_missions.py) with `{ $name }` placeables filled in.

use std::collections::BTreeMap;

/// The message `key` with its placeables replaced by `args`; the key itself
/// when there is no such message (OpenRA's FluentProvider does the same).
/// A placeable without an argument shows its name in braces, as Fluent does.
pub fn format(messages: &BTreeMap<String, String>, key: &str, args: &[(String, String)]) -> String {
    let Some(pattern) = messages.get(key) else { return key.to_string() };
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern.as_str();
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let Some(len) = rest[start..].find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = rest[start + 1..start + len].trim();
        match inner.strip_prefix('$') {
            Some(name) => match args.iter().find(|(k, _)| k == name.trim()) {
                Some((_, v)) => out.push_str(v),
                None => {
                    out.push('{');
                    out.push_str(name.trim());
                    out.push('}');
                }
            },
            // A string literal placeable: { "text" }.
            None if inner.len() >= 2 && inner.starts_with('"') && inner.ends_with('"') => out.push_str(&inner[1..inner.len() - 1]),
            None => out.push_str(&rest[start..start + len + 1]),
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out
}

/// C# `string.Format` with `{0}`, `{1}`: OpenRA's TimeLimitManager texts.
pub fn format_indexed(pattern: &str, args: &[String]) -> String {
    let mut out = pattern.to_string();
    for (i, a) in args.iter().enumerate() {
        out = out.replace(&format!("{{{i}}}"), a);
    }
    out
}

/// OpenRA WidgetUtils.FormatTime: "H:MM:SS", or "MM:SS" under an hour
/// ("M:SS" without the leading minute zero). Ticks at 40 ms.
pub fn format_time(ticks: i64, leading_minute_zero: bool) -> String {
    let seconds = (ticks.max(0) * 40 + 999) / 1000;
    let (h, m, s) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else if leading_minute_zero {
        format!("{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeables_are_filled_in() {
        let mut m = BTreeMap::new();
        m.insert("arrive".to_string(), "Reinforcements arrive in { $time }".to_string());
        m.insert("pct".to_string(), "{ $percentage }% destroyed, { $missing }.".to_string());
        assert_eq!(format(&m, "arrive", &[("time".into(), "01:30".into())]), "Reinforcements arrive in 01:30");
        assert_eq!(format(&m, "pct", &[("percentage".into(), "40".into())]), "40% destroyed, {missing}.");
        assert_eq!(format(&m, "unknown-key", &[]), "unknown-key");
        assert_eq!(format_indexed("{0} minute{1} remaining", &["5".into(), "s".into()]), "5 minutes remaining");
    }

    #[test]
    fn times_format_like_openra() {
        assert_eq!(format_time(25 * 90, true), "01:30");
        assert_eq!(format_time(25 * 90, false), "1:30");
        assert_eq!(format_time(25 * 3725, true), "1:02:05");
        assert_eq!(format_time(1, true), "00:01");
    }
}
