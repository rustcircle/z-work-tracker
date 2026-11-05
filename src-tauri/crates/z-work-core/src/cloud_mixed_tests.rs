//! 1.4 and 1.3.3 sharing one folder (plan C1). The fixtures under `tests/fixtures/cloud-1.4.0-mixed/` hold Studio's
//! file as 1.4 wrote it after giving three subtasks tags of their own, and Office PC's as 1.3.3 itself (fd51d79) wrote
//! it after reading Studio's: renamed task, a tag taken off it, half an hour on a subtask, and no `subtaskTags`, which
//! 1.3.3 drops. Office PC's edit of the task's tags is later than every clock in Studio's file, so a merge that let the
//! task's clocks decide the subtasks' tags would lose them here.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::cloud_roundtrip_tests::{MappedIo, copy_tree, device_path, fixture, lock, read_device};
use crate::merge::merge;
use crate::model::{DeviceFile, SyncProvider, SyncTarget, Task};
use crate::persist::MAIN_FILE;
use crate::service::Service;
use crate::subtasks::EffectiveTags;
use crate::sync::run_cycle_within;
use crate::time::ManualClock;

const VIRTUAL_ROOT: &str = "/cloud/OneDrive";
const FOLDER: &str = "cloud-1.4.0-mixed";
/// Studio, on 1.4.
const STUDIO: &str = "494df668-3488-4f75-9100-8e12ce3c6f80";
/// Office PC, on 1.3.3.
const OFFICE: &str = "ddf1d96b-c78e-4b66-91f5-bbd6e1fa5d4a";
/// After Office PC's last write.
const NOW: &str = "2026-03-03T12:00:00Z";
const LIMIT: Duration = Duration::from_secs(20);
const RENAMED: &str = "Design review (renamed on 1.3.3)";

fn the_task(file: &DeviceFile) -> &Task {
    file.data
        .tasks
        .values()
        .find(|t| t.name.starts_with("Design review"))
        .expect("the task")
}

/// Subtask ids by their text.
fn subtask(task: &Task, text: &str) -> String {
    crate::subtasks::items(&task.description)
        .into_iter()
        .find(|i| i.text == text)
        .expect("the subtask")
        .id
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

/// A 1.4 device on a copy of the folder, read and written once.
struct Run {
    svc: Mutex<Service>,
    cloud: tempfile::TempDir,
    _dir: tempfile::TempDir,
}

impl Run {
    /// Studio's next start, from its identity: its data comes from the folder, its own file and Office PC's.
    fn studio() -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::copy(
            fixture("cloud-1.4.0-mixed.identity.json"),
            dir.path().join(MAIN_FILE),
        )
        .unwrap();
        let svc =
            Service::open(dir.path(), Arc::new(ManualClock::at(NOW)), "Studio (1.4)").unwrap();
        assert!(svc.awaiting_cloud());
        assert_eq!(svc.file().device_id, STUDIO);
        Self::sync(svc, dir)
    }

    /// A computer new to the folder, on 1.4.
    fn newcomer() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut svc =
            Service::open(dir.path(), Arc::new(ManualClock::at(NOW)), "Laptop (1.4)").unwrap();
        svc.add_sync_target(SyncTarget {
            provider: SyncProvider::Custom,
            root: VIRTUAL_ROOT.to_owned(),
        })
        .unwrap();
        Self::sync(svc, dir)
    }

    fn sync(svc: Service, dir: tempfile::TempDir) -> Self {
        let cloud = tempfile::tempdir().unwrap();
        copy_tree(&fixture(FOLDER), cloud.path());
        let svc = Mutex::new(svc);
        let io = MappedIo {
            virtual_root: PathBuf::from(VIRTUAL_ROOT),
            real: cloud.path().to_path_buf(),
        };
        assert!(
            run_cycle_within(&svc, &io, LIMIT),
            "the folder's data arrived"
        );
        assert_eq!(lock(&svc).target_status_mut(VIRTUAL_ROOT).last_error, None);
        Self {
            svc,
            cloud,
            _dir: dir,
        }
    }

    fn task(&self) -> Task {
        let s = lock(&self.svc);
        s.file()
            .data
            .tasks
            .values()
            .find(|t| t.name.starts_with("Design review"))
            .unwrap()
            .clone()
    }

    fn written(&self, id: &str) -> (DeviceFile, Vec<u8>) {
        read_device(self.cloud.path(), id)
    }
}

/// What the rest rests on: each file is what its README says, and reads and writes back byte for byte on 1.4.
#[test]
fn c1_the_fixtures_hold_what_each_version_wrote() {
    let folder = fixture(FOLDER);
    let (studio, studio_bytes) = read_device(&folder, STUDIO);
    let (office, office_bytes) = read_device(&folder, OFFICE);
    assert_eq!(serde_json::to_vec(&studio).unwrap(), studio_bytes);
    assert_eq!(serde_json::to_vec(&office).unwrap(), office_bytes);
    let (s, o) = (the_task(&studio), the_task(&office));
    assert_eq!(s.id, o.id);
    assert_eq!(s.subtask_tags.len(), 3, "Studio's subtasks");
    assert!(o.subtask_tags.is_empty() && o.extra.is_empty());
    let raw: Value = serde_json::from_slice(&office_bytes).unwrap();
    assert!(raw["data"]["tasks"][&o.id].get("subtaskTags").is_none());
    assert_eq!(o.name, RENAMED);
    assert_eq!(o.tags, strings(&["tag-concept", "tag-revision"]));
    let newest_of_studio = studio.data.newest_stamp().unwrap();
    assert!(
        o.tags_stamp.at > newest_of_studio.at,
        "1.3.3's tag edit is later than everything Studio wrote"
    );
    let on_wireframes = |f: &DeviceFile| {
        f.data
            .segments
            .values()
            .filter(|g| g.subtask_id.as_deref() == Some(subtask(s, "Wireframes").as_str()))
            .count()
    };
    assert_eq!((on_wireframes(&studio), on_wireframes(&office)), (1, 2));
}

/// The named test of the plan: Studio set the subtasks' tags on 1.4, Office PC rewrote the task on 1.3.3 without
/// them, and after Studio reads Office PC's file every entry is there with its clock, next to Office PC's edits, in
/// Studio's data and in the file it writes back.
#[test]
fn c1_an_override_written_by_1_4_survives_a_sync_round_trip_through_1_3_3() {
    let (studio, _) = read_device(&fixture(FOLDER), STUDIO);
    let (office, office_bytes) = read_device(&fixture(FOLDER), OFFICE);
    let run = Run::studio();
    let task = run.task();
    assert_eq!(task.subtask_tags, the_task(&studio).subtask_tags);
    assert_eq!(task.name, RENAMED, "Office PC's rename arrived");
    assert_eq!(task.tags, the_task(&office).tags, "and its tags");
    assert_eq!(
        lock(&run.svc)
            .file()
            .data
            .segments
            .values()
            .filter(|g| g.task_id == task.id)
            .count(),
        4,
        "and its half hour"
    );
    let (written, _) = run.written(STUDIO);
    assert_eq!(the_task(&written).subtask_tags, task.subtask_tags);
    assert_eq!(the_task(&written).name, RENAMED);
    assert_eq!(
        fs::read(device_path(run.cloud.path(), OFFICE)).unwrap(),
        office_bytes,
        "nobody writes Office PC's file but Office PC"
    );
}

/// A 1.4 computer that joins later sees both files, and gets the subtasks' tags and Office PC's edits alike, in
/// whichever order the merge takes them.
#[test]
fn c1_a_1_4_device_new_to_the_folder_gets_the_overrides_and_the_1_3_3_edits() {
    let (studio, _) = read_device(&fixture(FOLDER), STUDIO);
    let (office, _) = read_device(&fixture(FOLDER), OFFICE);
    let run = Run::newcomer();
    let task = run.task();
    assert_eq!(task.subtask_tags, the_task(&studio).subtask_tags);
    assert_eq!(task.name, RENAMED);
    for merged in [
        merge(&studio.data, &office.data),
        merge(&office.data, &studio.data),
    ] {
        let t = &merged.tasks[&task.id];
        assert_eq!(t.subtask_tags, task.subtask_tags);
        assert_eq!((t.name.as_str(), &t.tags), (RENAMED, &task.tags));
    }
}

/// 1.3.3 took tag-admin off the task and couldn't touch Copy's list, which held only that tag: Copy counts as No tag,
/// not as back on "Same as task". Wireframes keeps its own tag, for Office PC's half hour too, and Sign-off follows the
/// task. A change to the task's tags on 1.4 rewrites no list either: Copy keeps tag-admin, unseen, and counts under it
/// again once the task has it back.
#[test]
fn c1_a_tag_taken_off_the_task_on_1_3_3_drops_out_of_the_subtasks_that_held_it() {
    let run = Run::studio();
    let task = run.task();
    let (wire, copy, sign) = (
        subtask(&task, "Wireframes"),
        subtask(&task, "Copy"),
        subtask(&task, "Sign-off"),
    );
    assert_eq!(
        task.subtask_override(&copy),
        Some(&strings(&["tag-admin"])[..])
    );
    let tags = EffectiveTags::of(&task);
    assert_eq!(tags.of_subtask(Some(&wire)), ["tag-concept"]);
    assert_eq!(tags.of_subtask(Some(&copy)), [] as [&str; 0]);
    assert_eq!(
        tags.of_subtask(Some(&sign)),
        ["tag-concept", "tag-revision"]
    );
    assert_eq!(tags.of_subtask(None), ["tag-concept", "tag-revision"]);
    let mut s = lock(&run.svc);
    let shown: Vec<(String, Option<Vec<String>>)> = s
        .snapshot()
        .tasks
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap()
        .subtasks
        .into_iter()
        .map(|v| (v.text, v.tags))
        .collect();
    assert_eq!(
        shown,
        [
            ("Wireframes".to_owned(), Some(strings(&["tag-concept"]))),
            ("Copy".to_owned(), Some(Vec::new())),
            ("Sign-off".to_owned(), None),
        ]
    );
    let mut retag = |tags: &[&str]| {
        let patch = crate::machine::TaskPatch {
            tags: Some(strings(tags)),
            ..Default::default()
        };
        s.patch_task(&task.id, &patch, &crate::machine::TaskExpected::default())
            .unwrap();
        s.file().data.tasks[&task.id].clone()
    };
    let after = retag(&["tag-concept", "tag-revision", "tag-client-call"]);
    assert_eq!(
        after.subtask_tags, task.subtask_tags,
        "every list and clock as it was"
    );
    assert_eq!(
        EffectiveTags::of(&after).of_subtask(Some(&copy)),
        [] as [&str; 0]
    );
    let back = retag(&["tag-concept", "tag-revision", "tag-admin"]);
    assert_eq!(back.subtask_tags, task.subtask_tags);
    let tags = EffectiveTags::of(&back);
    assert_eq!(tags.of_subtask(Some(&copy)), ["tag-admin"]);
    assert_eq!(tags.of_subtask(Some(&wire)), ["tag-concept"]);
}
