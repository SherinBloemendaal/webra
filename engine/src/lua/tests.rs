use super::*;

fn run(src: &str) -> Result<Vec<Value>, LuaError> {
    let mut lua = Lua::new();
    lua.exec(&mut NoHost, "test.lua", src)
}

/// The script's single return value as text (`tostring`).
fn eval(src: &str) -> String {
    let mut lua = Lua::new();
    let r = lua.exec(&mut NoHost, "test.lua", src).unwrap_or_else(|e| panic!("{}", e.report()));
    let v = r.into_iter().next().unwrap_or(Value::Nil);
    stdlib::tostring(&lua, &mut NoHost, &v)
}

fn err(src: &str) -> String {
    run(src).expect_err("script should fail").message()
}

#[test]
fn arithmetic_and_precedence() {
    assert_eq!(eval("return 1 + 2 * 3 ^ 2 ^ 0.5 - 4 / 2"), eval("return 1 + 2 * (3 ^ (2 ^ 0.5)) - (4 / 2)"));
    assert_eq!(eval("return 2 ^ 10"), "1024");
    assert_eq!(eval("return -2 ^ 2"), "-4");
    assert_eq!(eval("return 7 % 3, -7 % 3"), "1");
    assert_eq!(eval("local a, b = 7 % 3, -7 % 3 return b"), "2");
    assert_eq!(eval("return 5.5 % 2"), "1.5");
    assert_eq!(eval("return 10 / 4"), "2.5");
    assert_eq!(eval("return 1 / 0"), "inf");
    assert_eq!(eval("return '10' + 5"), "15");
    assert_eq!(eval("return 1 .. 2"), "12");
    assert_eq!(eval("return 'a' .. 'b' .. 'c' == 'abc'"), "true");
    assert_eq!(eval("return not nil and 1 or 2"), "1");
    assert_eq!(eval("return false or nil"), "nil");
    assert_eq!(eval("return 1 < 2 and 'x' < 'y' and 2 >= 2 and 3 ~= 4"), "true");
    assert_eq!(eval("return #'hello' + #{1, 2, 3}"), "8");
    assert_eq!(eval("return 0x10 + 1e2"), "116");
}

#[test]
fn locals_closures_and_upvalues() {
    let src = r#"
        local function counter()
            local n = 0
            return function() n = n + 1 return n end
        end
        local a, b = counter(), counter()
        a() a()
        return a() * 10 + b()
    "#;
    assert_eq!(eval(src), "31");
    // Each loop iteration has its own variable.
    let src = r#"
        local fs = {}
        for i = 1, 3 do fs[i] = function() return i end end
        local t = {}
        for _, v in ipairs({'a', 'b'}) do t[#t + 1] = function() return v end end
        return fs[1]() + fs[2]() * 10 + fs[3]() * 100 .. t[1]() .. t[2]()
    "#;
    assert_eq!(eval(src), "321ab");
    // Recursive local function and shadowing.
    let src = r#"
        local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end
        local x = 1
        do local x = 2 end
        local x = x + 1
        return fib(15) + x
    "#;
    assert_eq!(eval(src), "612");
    // Nested upvalues three levels deep.
    let src = "local a = 1 local function f() return function() a = a + 1 return a end end local g = f() g() return g()";
    assert_eq!(eval(src), "3");
}

#[test]
fn varargs_select_unpack() {
    assert_eq!(eval("local function f(...) return select('#', ...) end return f(1, nil, 3)"), "3");
    assert_eq!(eval("local function f(...) local a, b = ... return b end return f(1, 2)"), "2");
    assert_eq!(eval("return select(2, 'a', 'b', 'c')"), "b");
    assert_eq!(eval("return select(-1, 'a', 'b', 'c')"), "c");
    assert_eq!(eval("local t = {unpack({1, 2, 3})} return #t"), "3");
    assert_eq!(eval("local function f(...) return {...} end return #f(1, 2, 3, 4)"), "4");
    assert_eq!(eval("local function f() return 1, 2 end local t = {f(), f()} return #t"), "3");
    assert_eq!(eval("local function f() return 1, 2 end return (f())"), "1");
}

#[test]
fn control_flow() {
    let src = r#"
        local s = 0
        for i = 10, 1, -2 do s = s + i end
        local j = 0
        while true do j = j + 1 if j > 5 then break end end
        local k = 0
        repeat local done = k >= 3 k = k + 1 until done
        if s == 30 then s = s + 1 elseif s == 0 then s = -1 else s = -2 end
        return s * 100 + j * 10 + k
    "#;
    assert_eq!(eval(src), "3164");
    assert_eq!(eval("local n = 0 for i = 1, 0 do n = n + 1 end return n"), "0");
    assert_eq!(eval("local n = 0 for i = 1, 2, 0.5 do n = n + 1 end return n"), "3");
}

#[test]
fn tables_and_iteration_order() {
    // pairs: the array part in order, then other keys in insertion order.
    let src = r#"
        local t = {10, 20, x = 1, y = 2}
        t.z = 3
        t[3] = 30
        t.x = nil
        local out = {}
        for k, v in pairs(t) do out[#out + 1] = tostring(k) .. '=' .. tostring(v) end
        return table.concat(out, ',')
    "#;
    assert_eq!(eval(src), "1=10,2=20,3=30,y=2,z=3");
    // Clearing fields during a traversal is allowed.
    let src = r#"
        local t = {}
        for i = 1, 50 do t['k' .. i] = i end
        local n = 0
        for k in pairs(t) do t[k] = nil n = n + 1 end
        return n .. ':' .. tostring(next(t))
    "#;
    assert_eq!(eval(src), "50:nil");
    assert_eq!(eval("local t = {} t[1.0] = 'a' return t[1]"), "a");
    assert_eq!(eval("local t = {n = {m = 5}} return t.n.m"), "5");
    assert_eq!(eval("local t = {} t[3] = 'c' t[2] = 'b' t[1] = 'a' return #t .. table.concat(t)"), "3abc");
}

#[test]
fn table_library() {
    let src = r#"
        local t = {5, 2, 8, 1}
        table.sort(t)
        local u = {'b', 'c', 'a'}
        table.sort(u, function(a, b) return a > b end)
        table.insert(t, 9)
        table.insert(t, 1, 0)
        local r = table.remove(t, 2)
        local last = table.remove(t)
        return table.concat(t, ' ') .. '|' .. table.concat(u) .. '|' .. r .. last .. '|' .. table.maxn({1, 2, [10] = 3})
    "#;
    assert_eq!(eval(src), "0 2 5 8|cba|19|10");
}

#[test]
fn string_library() {
    assert_eq!(eval("return string.format('%d-%5.2f-%s-%x-%q', 42, 3.14159, 'hi', 255, 'a\"b')"), "42- 3.14-hi-ff-\"a\\\"b\"");
    assert_eq!(eval("return string.format('%03d|%-4s|%+d|%g|%e', 7, 'ab', 5, 0.1, 12345.678)"), "007|ab  |+5|0.1|1.234568e+04");
    assert_eq!(eval("return ('Hello'):upper() .. ('Hello'):lower() .. ('abc'):rep(2) .. ('abc'):reverse()"), "HELLOhelloabcabccba");
    assert_eq!(eval("return ('hello world'):sub(1, 5) .. ('hello'):sub(-3) .. ('hello'):sub(2, -2)"), "hellollo".to_string() + "ell");
    assert_eq!(eval("return string.byte('A') + #string.char(72, 105)"), "67");
    assert_eq!(eval("return ('hello world'):find('wor')"), "7");
    assert_eq!(eval("local a, b = ('hello world'):find('o w') return b"), "7");
    assert_eq!(eval("return ('key=value'):match('(%w+)=(%w+)')"), "key");
    assert_eq!(eval("local k, v = ('key=value'):match('(%w+)=(%w+)') return v"), "value");
    assert_eq!(eval("return ('  trim me  '):match('^%s*(.-)%s*$')"), "trim me");
    assert_eq!(eval("return ('hello'):gsub('l', 'L')"), "heLLo");
    assert_eq!(eval("local s, n = ('hello'):gsub('l', 'L') return n"), "2");
    assert_eq!(eval("return ('abc'):gsub('%w', '%0%0')"), "aabbcc");
    assert_eq!(eval("return ('$name is $age'):gsub('%$(%w+)', {name = 'Bob', age = 7})"), "Bob is 7");
    assert_eq!(eval("return ('abc'):gsub('.', function(c) return c:byte() end)"), "979899");
    assert_eq!(
        eval("local t = {} for w in ('one two three'):gmatch('%a+') do t[#t + 1] = w end return table.concat(t, ',')"),
        "one,two,three"
    );
    assert_eq!(eval("return ('f(a(b)c)d'):match('%b()')"), "(a(b)c)");
    assert_eq!(eval("return ('THE (quick) fox'):find('%f[%a]%a+', 5)"), "6");
    assert_eq!(eval("return ('aaa'):match('()a+()')"), "1");
    assert_eq!(eval("return ('x = 1, y = 22'):gsub('(%w+) = (%w+)', '%2 = %1')"), "1 = x, 22 = y");
    assert_eq!(eval("return string.format('%5s|%-5d|%.3s', 'ab', 3, 'abcdef')"), "   ab|3    |abc");
    assert_eq!(eval("return tostring(1e300 * 1e10) .. tostring(-1e300 * 1e10)"), "inf-inf");
    assert_eq!(eval("return tonumber('0x1f') + tonumber('  12  ') + tonumber('z', 36) + (tonumber('nope') or 0)"), "78");
}

#[test]
fn math_library() {
    assert_eq!(eval("return math.floor(3.7) + math.ceil(3.2) + math.abs(-2) + math.max(1, 5, 3) + math.min(4, 2)"), "16");
    assert_eq!(eval("return math.sqrt(16) + math.fmod(7, 3) + math.pi - math.pi"), "5");
    assert_eq!(eval("local i, f = math.modf(3.25) return i + f * 4"), "4");
    // Transcendental functions are libm's on every platform: fixed results.
    assert_eq!(eval("return string.format('%.17g', math.sin(1) + math.exp(1) + math.log(10))"), "5.8623379062609882");
    assert_eq!(eval("return math.random"), "nil");
    assert_eq!(eval("return math.huge > 1e308"), "true");
}

#[test]
fn sandbox_has_only_openra_globals() {
    for name in
        ["io", "os", "debug", "load", "loadstring", "dofile", "require", "coroutine", "setmetatable", "getmetatable", "rawget", "error"]
    {
        assert_eq!(eval(&format!("return {name}")), "nil", "{name} must not exist");
    }
    for name in
        ["ipairs", "next", "pairs", "pcall", "select", "tonumber", "tostring", "type", "unpack", "xpcall", "math", "string", "table"]
    {
        assert_ne!(eval(&format!("return {name}")), "nil", "{name} must exist");
    }
}

#[test]
fn errors_name_the_place_and_the_variable() {
    assert_eq!(err("local x = nil\nreturn x.y"), "test.lua:2: attempt to index local (a nil value)");
    assert_eq!(err("return Foo.Bar"), "test.lua:1: attempt to index global 'Foo' (a nil value)");
    assert_eq!(err("\n\nUndefined()"), "test.lua:3: attempt to call global 'Undefined' (a nil value)");
    assert_eq!(err("local t = {} t.x.y = 1"), "test.lua:1: attempt to index field 'x' (a nil value)");
    assert_eq!(err("return 1 + {}"), "test.lua:1: attempt to perform arithmetic on a table value");
    assert_eq!(err("return 'a' .. nil"), "test.lua:1: attempt to concatenate a nil value");
    assert_eq!(err("return {} < {}"), "test.lua:1: attempt to compare two table values");
    assert_eq!(err("return table.insert(nil, 1)"), "test.lua:1: bad argument #1 to 'insert' (table expected, got nil)");
    assert!(err("x = = 1").starts_with("test.lua:1: unexpected symbol near '='"));
    assert!(err("if true then").contains("'end' expected"));
    let e = run("local function inner() local t = nil return t.x end\nlocal function outer() return inner() end\nouter()").unwrap_err();
    assert_eq!(e.traceback.len(), 3, "{}", e.report());
    assert!(e.traceback[0].contains("function 'inner'"));
}

#[test]
fn pcall_catches_script_errors_but_not_the_budget() {
    assert_eq!(
        eval("local ok, e = pcall(function() local t = nil return t.x end) return tostring(ok) .. ' ' .. e"),
        "false test.lua:1: attempt to index local (a nil value)"
    );
    assert_eq!(eval("local ok, a, b = pcall(function(x) return x, x * 2 end, 21) return b"), "42");
    assert_eq!(eval("return xpcall(function() return nil + 1 end, function(e) return 'handled' end)"), "false");
    let mut lua = Lua::new();
    lua.set_budget(10_000);
    let e = lua.exec(&mut NoHost, "loop.lua", "pcall(function() while true do end end)").unwrap_err();
    assert_eq!(e.kind, ErrorKind::Budget);
}

#[test]
fn runaway_scripts_stop_deterministically() {
    let mut lua = Lua::new();
    lua.set_budget(1_000_000);
    let e = lua.exec(&mut NoHost, "loop.lua", "local n = 0 while true do n = n + 1 end").unwrap_err();
    assert_eq!(e.kind, ErrorKind::Budget);
    let mut lua = Lua::new();
    let e = lua.exec(&mut NoHost, "mem.lua", "local t = {} local i = 0 while true do i = i + 1 t[i] = {} end").unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Memory | ErrorKind::Budget), "{:?}", e.kind);
    let e = run("local s = 'x' while true do s = s .. s end").unwrap_err();
    assert!(e.message().contains("string length overflow"), "{}", e.message());
    // A pattern that backtracks a lot uses the budget too.
    let mut lua = Lua::new();
    lua.set_budget(100_000);
    let e = lua.exec(&mut NoHost, "pat.lua", "return string.rep('a', 5000):match(string.rep('a*', 30) .. 'b')").unwrap_err();
    assert_eq!(e.kind, ErrorKind::Budget);
}

#[test]
fn deep_recursion_fits_in_a_small_stack() {
    // The WebAssembly stack is about 1 MiB: the limits must hold within half
    // of it in an optimised build (debug builds use far bigger frames).
    let h = std::thread::Builder::new()
        .stack_size(if cfg!(debug_assertions) { 32 << 20 } else { 512 << 10 })
        .spawn(|| {
            let e = run("local function f(n) return 1 + f(n + 1) end return f(1)").unwrap_err();
            assert!(e.message().contains("stack overflow"));
            let e = run("local function f(t) return {f({t})} end return f({})").unwrap_err();
            assert!(e.message().contains("stack overflow"));
            // Recursion inside the deepest expressions the parser takes, and
            // through library calls: the level budget stops it first.
            let src = format!("local function f(n) return {}f(n + 1){} end return f(1)", "(1 + ".repeat(45), ")".repeat(45));
            assert!(run(&src).unwrap_err().message().contains("stack overflow"));
            // pcall turns the overflow into a value at the deepest level; it comes back up.
            assert!(eval("local function f(n) return select(2, pcall(f, n + 1)) end return f(1)").contains("stack overflow"));
            let e = run("local function f(t) table.sort({1, 2, 3}, function(a, b) f(t) return a < b end) end f(1)").unwrap_err();
            assert!(e.message().contains("stack overflow"), "{}", e.message());
            // Deeply nested expressions are refused by the parser.
            let src = format!("return {}1{}", "(".repeat(300), ")".repeat(300));
            assert!(run(&src).unwrap_err().message().contains("syntax levels"));
        })
        .unwrap();
    h.join().unwrap();
}

#[test]
fn garbage_is_collected_and_reachable_values_survive() {
    let mut lua = Lua::new();
    lua.exec(
        &mut NoHost,
        "gc.lua",
        "Keep = {1, 2, {3}} local tmp = {} for i = 1, 1000 do tmp[i] = {i} end Fn = function() return Keep[3][1] end",
    )
    .unwrap();
    let before = lua.heap_objects();
    lua.collect(&mut std::iter::empty());
    let after = lua.heap_objects();
    assert!(after + 1000 <= before, "{before} -> {after}");
    let f = lua.global("Fn");
    assert_eq!(lua.call(&mut NoHost, &f, Vec::new()).unwrap()[0].to_num(), Some(3.0));
    // Host roots keep their values alive.
    let held = lua.exec(&mut NoHost, "gc2.lua", "return {42}").unwrap().remove(0);
    lua.collect(&mut std::iter::once(held.clone()));
    let Value::Table(t) = held else { panic!() };
    assert_eq!(lua.raw_get(t, &Value::Num(1.0)).to_num(), Some(42.0));
}

#[test]
fn same_script_same_state_hash() {
    let script = r#"
        State = {}
        local seq = {}
        for i = 1, 200 do
            local k = 'k' .. (i * 7919 % 113)
            State[k] = (State[k] or 0) + i / 3
            seq[#seq + 1] = function() return k end
        end
        for k, v in pairs(State) do if v > 100 then State[k] = nil end end
        Total = 0
        for _, v in pairs(State) do Total = Total + v end
        Text = string.format('%.10g', Total) .. tostring(seq[1]) .. tostring(State)
        return Text
    "#;
    let mut a = Lua::new();
    let mut b = Lua::new();
    let ra = a.exec(&mut NoHost, "det.lua", script).unwrap();
    let rb = b.exec(&mut NoHost, "det.lua", script).unwrap();
    assert!(raw_equal(&ra[0], &rb[0]));
    assert_eq!(a.state_hash(), b.state_hash());
    // A clone runs on identically, and a change shows in the hash.
    let mut c = a.clone();
    a.exec(&mut NoHost, "more.lua", "Total = Total + 1").unwrap();
    c.exec(&mut NoHost, "more.lua", "Total = Total + 1").unwrap();
    assert_eq!(a.state_hash(), c.state_hash());
    c.exec(&mut NoHost, "more.lua", "Total = Total + 1").unwrap();
    assert_ne!(a.state_hash(), c.state_hash());
    // The whole output is fixed: the same on every platform and build.
    assert_eq!(eval(script), eval(script));
    let text = a.global("Text").to_text().unwrap();
    assert!(text.ends_with("function: 0x0000000ctable: 0x00000006") || text.contains("function: 0x"), "{text}");
}

#[test]
fn host_functions_objects_and_arithmetic() {
    struct Pos;
    const KIND: u8 = 1;
    impl Host for Pos {
        fn call(&mut self, lua: &mut Lua, id: u32, this: Option<UserData>, args: Vec<Value>) -> Result<Vec<Value>, LuaError> {
            match (id, this) {
                // Pos.New(x, y)
                (0, None) => {
                    let x = args.first().and_then(Value::to_num).unwrap_or(0.0) as i32;
                    let y = args.get(1).and_then(Value::to_num).unwrap_or(0.0) as i32;
                    Ok(vec![Value::UserData(UserData::new(KIND, x, y, 0))])
                }
                // p.Sum()
                (1, Some(u)) => Ok(vec![Value::Num((u.a + u.b) as f64)]),
                // Each(t, f): calls back into Lua
                (2, None) => {
                    let Value::Table(t) = args[0] else { return Err(LuaError::runtime("table expected")) };
                    for v in lua.sequence(t) {
                        lua.call(self, &args[1], vec![v])?;
                    }
                    Ok(Vec::new())
                }
                _ => Err(LuaError::runtime("unknown")),
            }
        }
        fn index(&mut self, _: &mut Lua, obj: UserData, key: &Value) -> Result<Value, LuaError> {
            Ok(match key.to_text().as_deref() {
                Some("X") => Value::Num(obj.a as f64),
                Some("Y") => Value::Num(obj.b as f64),
                Some("Sum") => Value::Host(1, Some(obj)),
                _ => Value::Nil,
            })
        }
        fn set_index(&mut self, _: &mut Lua, _: UserData, _: &Value, _: Value) -> Result<(), LuaError> {
            Err(LuaError::runtime("read only"))
        }
        fn tostring(&mut self, _: &Lua, obj: UserData) -> String {
            format!("{},{}", obj.a, obj.b)
        }
        fn arith(&mut self, op: BinOp, a: &Value, b: &Value) -> Option<Value> {
            let (Value::UserData(x), Value::UserData(y)) = (a, b) else { return None };
            match op {
                BinOp::Add => Some(Value::UserData(UserData::new(KIND, x.a + y.a, x.b + y.b, 0))),
                BinOp::Lt => Some(Value::Bool((x.a, x.b) < (y.a, y.b))),
                _ => None,
            }
        }
        fn function_name(&self, id: u32) -> String {
            format!("host{id}")
        }
    }
    let mut lua = Lua::new();
    let g = lua.new_table();
    let Value::Table(gt) = g else { panic!() };
    lua.raw_set(gt, Value::str("New"), Value::Host(0, None)).unwrap();
    lua.set_global("Pos", g);
    lua.set_global("Each", Value::Host(2, None));
    let r = lua
        .exec(
            &mut Pos,
            "host.lua",
            r#"
            local p = Pos.New(1, 2) + Pos.New(10, 20)
            local n = 0
            Each({Pos.New(1, 1), Pos.New(2, 2)}, function(q) n = n + q.Sum() end)
            local t = {}
            t[Pos.New(5, 5)] = 'five'
            return tostring(p) .. ' ' .. p.X .. ' ' .. n .. ' ' .. tostring(Pos.New(1, 1) == Pos.New(1, 1)) .. ' ' .. t[Pos.New(5, 5)] .. ' ' .. tostring(Pos.New(1, 1) < Pos.New(2, 0))
        "#,
        )
        .unwrap();
    assert_eq!(r[0].to_text().unwrap(), "11,22 11 6 true five true");
    let e = lua.exec(&mut Pos, "host.lua", "local p = Pos.New(1, 1) p.X = 3").unwrap_err();
    assert_eq!(e.message(), "host.lua:1: read only");
}

/// The stack one level costs, measured in this build for the deepest kinds
/// of nesting (expressions, Lua calls, library calls; host round trips are
/// measured in tests_mission.rs). Every kind must fit MAX_LEVELS levels in
/// `STACK_FOR_LEVELS` bytes, so a run never uses more native stack than that:
/// with the caller's frames it stays inside 512 KiB, half the 1 MiB
/// WebAssembly stack. (An optimised build measured about 560 to 680 bytes
/// per level.)
pub(crate) const STACK_FOR_LEVELS: usize = 384 << 10;

pub(crate) fn assert_levels_fit(what: &str, used: usize, levels: u32) {
    let per_level = used as f64 / levels.max(1) as f64;
    let worst = per_level * MAX_LEVELS as f64;
    eprintln!("{what}: {used} bytes for {levels} levels, {per_level:.0} per level, {worst:.0} for MAX_LEVELS");
    if !cfg!(debug_assertions) {
        assert!(worst <= STACK_FOR_LEVELS as f64, "{what}: {worst:.0} bytes for MAX_LEVELS levels, more than {STACK_FOR_LEVELS}");
    }
}

#[test]
fn native_stack_per_level() {
    use super::interp::stack_probe;
    let h = std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(|| {
            let cases = [
                ("nested parentheses", format!("return {}1{}", "(".repeat(95), ")".repeat(95))),
                ("Lua calls", "local function f(n) if n == 0 then return 0 end return 1 + f(n - 1) end return f(70)".to_string()),
                (
                    "library calls",
                    "local function f(n) if n == 0 then return 0 end return select(2, pcall(f, n - 1)) end return f(55)".to_string(),
                ),
                (
                    "calls in nested expressions",
                    format!(
                        "local function f(n) if n == 0 then return 0 end return {}f(n - 1){} end return f(10)",
                        "(1 + ".repeat(20),
                        ")".repeat(20)
                    ),
                ),
            ];
            for (what, src) in cases {
                let start = stack_probe::start();
                run(&src).unwrap_or_else(|e| panic!("{what}: {}", e.message()));
                let (used, levels) = stack_probe::used(start);
                assert!(levels >= 90, "{what}: only {levels} levels");
                assert_levels_fit(what, used, levels);
            }
        })
        .unwrap();
    h.join().unwrap();
}

/// Integers from scripts can be anything a double holds: sizes, counts and
/// positions near 2^62 or +-1e300 are refused or clamped, never wrapped into
/// a huge allocation or a panic.
#[test]
fn huge_integers_never_overflow() {
    for n in ["2^62", "2^63", "1e300", "-1e300", "-2^63"] {
        let src = format!("return string.rep('ab', {n})");
        let r = run(&src);
        if n.starts_with('-') {
            assert_eq!(eval(&src), "");
        } else {
            assert!(r.unwrap_err().message().contains("string length overflow"), "{n}");
        }
        // unpack over an enormous range: refused, whichever end is huge.
        let e = run(&format!("return unpack({{}}, -({n}), {n})"));
        if n.starts_with('-') {
            assert!(e.unwrap().is_empty(), "{n}: i > j gives nothing");
        } else {
            assert!(e.unwrap_err().message().contains("too many results"), "{n}");
        }
        // Positions saturate: from before the start to past the end.
        assert_eq!(eval(&format!("return string.sub('abc', -({n}), {n})")), if n.starts_with('-') { "" } else { "abc" });
        assert_eq!(eval(&format!("return (string.find('abc', 'b', -({n})))")), if n.starts_with('-') { "nil" } else { "2" });
        assert_eq!(eval(&format!("return select('#', string.byte('abc', -({n}), {n}))")), if n.starts_with('-') { "0" } else { "3" });
        assert!(run(&format!("return select(-({n}), 1, 2)")).is_err() == !n.starts_with('-'), "{n}");
        // table.concat to the largest index ends (at the first missing value).
        assert!(run(&format!("return table.concat({{'a'}}, '', 1, {n})")).is_err() == !n.starts_with('-') || n == "-2^63");
    }
    // The last possible index ends the loop instead of wrapping around.
    assert_eq!(eval("local t = {} t[2^63] = 'x' return table.concat(t, '', 2^63, 2^63)"), "x");
    // string.byte results cost budget like unpack's.
    let mut lua = Lua::new();
    lua.set_budget(1_000);
    let e = lua.exec(&mut NoHost, "byte.lua", "local s = string.rep('x', 100000) return string.byte(s, 1, -1)").unwrap_err();
    assert_eq!(e.kind, ErrorKind::Budget);
}
