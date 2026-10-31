//! Deterministic state merge between devices. Each replicated record is merged by taking the
//! maximum under a total order, which makes `merge` idempotent, commutative and associative.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::Serialize;

use crate::model::{
    Project, RateVersion, RoundingVersion, Segment, SettingEntry, Shared, ShiftVersion, Stamp, Task,
};

fn canonical<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

fn stamp_cmp(a: &Stamp, b: &Stamp) -> Ordering {
    a.at.cmp(&b.at).then_with(|| a.by.cmp(&b.by))
}

/// Last writer wins by stamp, with the content as a final tie-break so the order stays total.
fn lww<'a, T: Serialize>(a: &'a T, sa: &Stamp, b: &'a T, sb: &Stamp) -> &'a T {
    match stamp_cmp(sa, sb).then_with(|| canonical(a).cmp(&canonical(b))) {
        Ordering::Less => b,
        _ => a,
    }
}

fn merge_project(a: &Project, b: &Project) -> Project {
    lww(a, &a.stamp, b, &b.stamp).clone()
}

fn merge_shift(a: &ShiftVersion, b: &ShiftVersion) -> ShiftVersion {
    lww(a, &a.stamp, b, &b.stamp).clone()
}

fn merge_rate(a: &RateVersion, b: &RateVersion) -> RateVersion {
    lww(a, &a.stamp, b, &b.stamp).clone()
}

fn merge_rounding(a: &RoundingVersion, b: &RoundingVersion) -> RoundingVersion {
    lww(a, &a.stamp, b, &b.stamp).clone()
}

fn merge_setting(a: &SettingEntry, b: &SettingEntry) -> SettingEntry {
    lww(a, &a.stamp, b, &b.stamp).clone()
}

/// The fields that travel with `meta_stamp`.
#[derive(Serialize)]
struct MetaKey<'a>(&'a str, &'a str, &'a serde_json::Value, bool);
/// The fields that travel with `state_stamp`.
#[derive(Serialize)]
struct StateKey<'a>(
    &'a crate::model::TaskState,
    &'a Option<crate::model::PauseReason>,
);

fn merge_task(a: &Task, b: &Task) -> Task {
    let meta_key =
        |t: &'_ Task| canonical(&MetaKey(&t.name, &t.project_id, &t.description, t.deleted));
    let meta_from_a = stamp_cmp(&a.meta_stamp, &b.meta_stamp)
        .then_with(|| meta_key(a).cmp(&meta_key(b)))
        != Ordering::Less;
    let meta = if meta_from_a { a } else { b };
    // Stopped is final: it outranks any other state whatever the clocks say.
    let state_key = |t: &'_ Task| canonical(&StateKey(&t.state, &t.pause_reason));
    let state_from_a = a
        .state
        .rank()
        .cmp(&b.state.rank())
        .then_with(|| stamp_cmp(&a.state_stamp, &b.state_stamp))
        .then_with(|| state_key(a).cmp(&state_key(b)))
        != Ordering::Less;
    let state = if state_from_a { a } else { b };
    Task {
        id: a.id.clone(),
        name: meta.name.clone(),
        project_id: meta.project_id.clone(),
        description: meta.description.clone(),
        deleted: meta.deleted,
        created_at: a.created_at.min(b.created_at),
        meta_stamp: meta.meta_stamp.clone(),
        state: state.state,
        pause_reason: state.pause_reason.clone(),
        state_stamp: state.state_stamp.clone(),
        stopped_at: a.stopped_at.max(b.stopped_at),
    }
}

/// A closed copy beats an open copy. Between closed copies the later end wins.
fn merge_segment(a: &Segment, b: &Segment) -> Segment {
    let rank = |s: &Segment| (s.end.is_some(), s.end);
    match rank(a)
        .cmp(&rank(b))
        .then_with(|| canonical(a).cmp(&canonical(b)))
    {
        Ordering::Less => b.clone(),
        _ => a.clone(),
    }
}

fn merge_map<T: Clone>(
    a: &BTreeMap<String, T>,
    b: &BTreeMap<String, T>,
    f: impl Fn(&T, &T) -> T,
) -> BTreeMap<String, T> {
    let mut out = a.clone();
    for (k, vb) in b {
        match out.get_mut(k) {
            Some(va) => *va = f(va, vb),
            None => {
                out.insert(k.clone(), vb.clone());
            }
        }
    }
    out
}

#[must_use]
pub fn merge(a: &Shared, b: &Shared) -> Shared {
    Shared {
        projects: merge_map(&a.projects, &b.projects, merge_project),
        tasks: merge_map(&a.tasks, &b.tasks, merge_task),
        segments: merge_map(&a.segments, &b.segments, merge_segment),
        settings: merge_map(&a.settings, &b.settings, merge_setting),
        shifts: merge_map(&a.shifts, &b.shifts, merge_shift),
        rates: merge_map(&a.rates, &b.rates, merge_rate),
        rounding: merge_map(&a.rounding, &b.rounding, merge_rounding),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PauseReason, TaskState};
    use crate::time::Ts;
    use proptest::prelude::*;
    use serde_json::{Value, json};

    fn stamp() -> impl Strategy<Value = Stamp> {
        (0i64..4, prop::sample::select(vec!["a", "b", "c"])).prop_map(|(t, d)| Stamp {
            at: Ts(t),
            by: d.to_owned(),
        })
    }

    fn project() -> impl Strategy<Value = Project> {
        (0u8..3, any::<bool>(), any::<bool>(), 0u8..3, stamp()).prop_map(
            |(id, archived, deleted, n, stamp)| Project {
                id: format!("p{id}"),
                name: format!("name{n}"),
                color: "#112233".into(),
                archived,
                deleted,
                billable: n == 1,
                budget_hours: None,
                client_zone: None,
                created_at: Ts(0),
                stamp,
            },
        )
    }

    fn task() -> impl Strategy<Value = Task> {
        (
            0u8..3,
            0u8..3,
            any::<bool>(),
            stamp(),
            0u8..4,
            stamp(),
            prop::option::of(0i64..4),
        )
            .prop_map(
                |(id, n, deleted, meta_stamp, st, state_stamp, stopped)| Task {
                    id: format!("t{id}"),
                    name: format!("name{n}"),
                    project_id: "p0".into(),
                    description: if n == 1 {
                        json!({"type":"doc"})
                    } else {
                        Value::Null
                    },
                    deleted,
                    created_at: Ts(i64::from(n)),
                    meta_stamp,
                    state: [
                        TaskState::Draft,
                        TaskState::Running,
                        TaskState::Paused,
                        TaskState::Stopped,
                    ][st as usize],
                    pause_reason: (st == 2).then_some(PauseReason::User),
                    state_stamp,
                    stopped_at: stopped.map(Ts),
                },
            )
    }

    fn segment() -> impl Strategy<Value = Segment> {
        (0u8..4, prop::option::of(1i64..5)).prop_map(|(id, end)| Segment {
            id: format!("s{id}"),
            task_id: "t0".into(),
            device_id: "a".into(),
            start: Ts(0),
            end: end.map(Ts),
        })
    }

    fn setting() -> impl Strategy<Value = (String, SettingEntry)> {
        (0u8..2, 0u8..3, stamp()).prop_map(|(k, v, stamp)| {
            (
                format!("k{k}"),
                SettingEntry {
                    value: json!(v),
                    stamp,
                },
            )
        })
    }

    fn shift() -> impl Strategy<Value = ShiftVersion> {
        (0u8..2, 0u8..3, any::<bool>(), stamp()).prop_map(|(id, n, deleted, stamp)| ShiftVersion {
            id: format!("v{id}"),
            shift_id: "x".into(),
            effective_from: "2026-01-01".into(),
            name: format!("n{n}"),
            color: "#000000".into(),
            start: "09:00".into(),
            end: "17:00".into(),
            weekdays: vec![1],
            zone: "UTC".into(),
            break_minutes: 0,
            retired: false,
            deleted,
            stamp,
        })
    }

    fn rate() -> impl Strategy<Value = RateVersion> {
        (0u8..2, prop::option::of(0i64..3), any::<bool>(), stamp()).prop_map(
            |(id, rate_cents, deleted, stamp)| RateVersion {
                id: format!("r{id}"),
                project_id: "p0".into(),
                effective_from: Ts(0),
                rate_cents,
                currency: if deleted { "EUR".into() } else { "USD".into() },
                deleted,
                stamp,
            },
        )
    }

    fn rounding() -> impl Strategy<Value = RoundingVersion> {
        (0u8..2, 0u32..3, any::<bool>(), stamp()).prop_map(|(id, m, deleted, stamp)| {
            RoundingVersion {
                id: format!("o{id}"),
                project_id: None,
                effective_from: "2026-01-01".into(),
                increment_minutes: m * 15,
                method: if m == 1 {
                    crate::model::RoundMethod::Up
                } else {
                    crate::model::RoundMethod::Nearest
                },
                deleted,
                stamp,
            }
        })
    }

    fn shared() -> impl Strategy<Value = Shared> {
        (
            prop::collection::vec(project(), 0..4),
            prop::collection::vec(task(), 0..4),
            prop::collection::vec(segment(), 0..5),
            prop::collection::vec(setting(), 0..3),
            prop::collection::vec(shift(), 0..3),
            prop::collection::vec(rate(), 0..3),
            prop::collection::vec(rounding(), 0..3),
        )
            .prop_map(|(ps, ts, ss, st, sh, ra, ro)| Shared {
                projects: ps.into_iter().map(|p| (p.id.clone(), p)).collect(),
                tasks: ts.into_iter().map(|t| (t.id.clone(), t)).collect(),
                segments: ss.into_iter().map(|s| (s.id.clone(), s)).collect(),
                settings: st.into_iter().collect(),
                shifts: sh.into_iter().map(|s| (s.id.clone(), s)).collect(),
                rates: ra.into_iter().map(|r| (r.id.clone(), r)).collect(),
                rounding: ro.into_iter().map(|r| (r.id.clone(), r)).collect(),
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(600))]

        #[test]
        fn idempotent(a in shared()) {
            prop_assert_eq!(merge(&a, &a), a);
        }

        #[test]
        fn commutative(a in shared(), b in shared()) {
            prop_assert_eq!(merge(&a, &b), merge(&b, &a));
        }

        #[test]
        fn associative(a in shared(), b in shared(), c in shared()) {
            prop_assert_eq!(merge(&merge(&a, &b), &c), merge(&a, &merge(&b, &c)));
        }

        #[test]
        fn absorbs_what_it_has_seen(a in shared(), b in shared()) {
            let m = merge(&a, &b);
            prop_assert_eq!(merge(&m, &a), m.clone());
            prop_assert_eq!(merge(&m, &b), m);
        }
    }

    #[test]
    fn closed_segment_beats_open_copy() {
        let open = Segment {
            id: "s".into(),
            task_id: "t".into(),
            device_id: "a".into(),
            start: Ts(5),
            end: None,
        };
        let closed = Segment {
            end: Some(Ts(9)),
            ..open.clone()
        };
        assert_eq!(merge_segment(&open, &closed).end, Some(Ts(9)));
        assert_eq!(merge_segment(&closed, &open).end, Some(Ts(9)));
    }

    #[test]
    fn stopped_outranks_a_later_state_and_metadata_merges_separately() {
        let base = Task {
            id: "t".into(),
            name: "old".into(),
            project_id: "p".into(),
            description: Value::Null,
            deleted: false,
            created_at: Ts(0),
            meta_stamp: Stamp {
                at: Ts(1),
                by: "a".into(),
            },
            state: TaskState::Stopped,
            pause_reason: None,
            state_stamp: Stamp {
                at: Ts(1),
                by: "a".into(),
            },
            stopped_at: Some(Ts(1)),
        };
        let later = Task {
            name: "new".into(),
            meta_stamp: Stamp {
                at: Ts(5),
                by: "b".into(),
            },
            state: TaskState::Running,
            state_stamp: Stamp {
                at: Ts(5),
                by: "b".into(),
            },
            stopped_at: None,
            ..base.clone()
        };
        let m = merge_task(&base, &later);
        assert_eq!(m.state, TaskState::Stopped);
        assert_eq!(m.name, "new");
        assert_eq!(m.stopped_at, Some(Ts(1)));
    }

    #[test]
    fn tombstone_does_not_resurrect() {
        let a = Project {
            id: "p".into(),
            name: "n".into(),
            color: "#000000".into(),
            archived: false,
            deleted: false,
            billable: false,
            budget_hours: None,
            client_zone: None,
            created_at: Ts(0),
            stamp: Stamp {
                at: Ts(1),
                by: "a".into(),
            },
        };
        let gone = Project {
            deleted: true,
            stamp: Stamp {
                at: Ts(2),
                by: "b".into(),
            },
            ..a.clone()
        };
        assert!(merge_project(&a, &gone).deleted);
        assert!(merge_project(&gone, &a).deleted);
    }
}
