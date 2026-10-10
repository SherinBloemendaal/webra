//! Script activities: what `actor.Move(cell)`, `actor.Wait(25)`,
//! `actor.CallFunc(f)` and the like queue on an actor (OpenRA
//! `Actor.QueueActivity`). The queue runs in order, one activity at a time;
//! activities that move or fight hand the engine an order and finish when
//! the actor is idle again (runtime.rs). A player's order to the actor drops
//! the queue, like OpenRA's CancelActivity.

use crate::infantry::EnterKind;
use crate::lua::Value;
use std::collections::VecDeque;

#[derive(Clone, Debug)]
pub enum Act {
    /// Move (attack-move with `attack`) to an engine cell; done within `close` cells.
    Move {
        cell: (i32, i32),
        close: i32,
        attack: bool,
    },
    Wait(i32),
    /// Call a script function with these arguments.
    CallFunc(Value, Vec<Value>),
    /// RemoveSelf: leaves the game without dying.
    Destroy,
    /// Attack-move toward the nearest enemy until none are left (OpenRA Hunt).
    Hunt,
    Attack {
        target: u32,
        allow_move: bool,
        force: bool,
    },
    Teleport((i32, i32)),
    Scatter,
    EnterTransport(u32),
    Unload {
        cell: Option<(i32, i32)>,
        range: i32,
    },
    Deploy,
    Enter {
        kind: EnterKind,
        target: u32,
    },
    DeliverCash(u32),
    Guard(u32),
    ReturnToBase(Option<u32>),
    Land(u32),
    /// An aircraft transport lands near an engine cell (ReinforceWithTransport).
    LandNear((i32, i32)),
    Resupply,
    FindResources,
    /// Fly over the cell, drop the passengers by parachute, leave the map.
    Paradrop((i32, i32)),
    /// Fly off the map edge (then a Destroy usually follows).
    FlyOffMap,
    /// Build a unit at this factory, waiting while the exit is blocked.
    Produce {
        ty: u16,
    },
    /// The repeating part of a looping Patrol.
    PatrolLoop {
        cells: Vec<(i32, i32)>,
        wait: i32,
    },
    /// PatrolUntil: patrol again while the function returns true.
    PatrolUntil {
        cells: Vec<(i32, i32)>,
        func: Value,
        wait: i32,
    },
    /// Move from outside the map onto it (ReinforceWithTransport exits use plain moves).
    MoveIntoWorld((i32, i32)),
}

#[derive(Clone, Debug, Default)]
pub struct Queue {
    pub items: VecDeque<Act>,
    /// The first item has been started.
    pub started: bool,
    /// Ticks the first item has run (Wait counts down with it).
    pub ticks: i32,
}

impl Queue {
    pub fn push(&mut self, a: Act) {
        self.items.push_back(a);
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Drop the first item: the next one starts.
    pub fn advance(&mut self) {
        self.items.pop_front();
        self.started = false;
        self.ticks = 0;
    }

    pub fn roots(&self, out: &mut Vec<Value>) {
        for a in &self.items {
            match a {
                Act::CallFunc(f, args) => {
                    out.push(f.clone());
                    out.extend(args.iter().cloned());
                }
                Act::PatrolUntil { func: f, .. } => out.push(f.clone()),
                _ => {}
            }
        }
    }
}
