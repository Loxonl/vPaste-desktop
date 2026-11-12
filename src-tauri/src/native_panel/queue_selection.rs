//! Pending native selections contain hashes only and outlive a panel controller.
use crate::paste_queue::{self, ToolbarStatus};
use serde_json::{json, Value};
use std::sync::Mutex;

static PENDING: Mutex<Selection> = Mutex::new(Selection {
    core: ToolbarStatus {
        active: false,
        revision: 0,
        activation_epoch: 0,
    },
    hashes: Vec::new(),
    revision: 0,
    submission: None,
});

#[derive(Default)]
struct Selection {
    core: ToolbarStatus,
    hashes: Vec<String>,
    revision: u64,
    submission: Option<u64>,
}
pub(super) struct Submission {
    epoch: u64,
    id: u64,
    pub(super) hashes: Vec<String>,
}
impl Selection {
    fn sync(&mut self, status: ToolbarStatus) {
        if status.revision < self.core.revision
            || status.activation_epoch < self.core.activation_epoch
        {
            return;
        }
        if status.activation_epoch != self.core.activation_epoch
            || (!status.active && (!self.hashes.is_empty() || self.submission.is_some()))
        {
            self.hashes = Vec::new();
            self.submission = None;
            self.revision += 1;
        }
        self.core = status;
    }
    fn editable(&self, epoch: u64) -> Result<(), String> {
        if !self.core.active || epoch != self.core.activation_epoch {
            return Err("Paste queue selection expired".into());
        }
        if self.submission.is_some() {
            return Err("Queue items are being added".into());
        }
        Ok(())
    }
    fn toggle(&mut self, hash: &str, epoch: u64) -> Result<(), String> {
        self.editable(epoch)?;
        if hash.is_empty() || hash.len() > 256 {
            return Err("Invalid clipboard item hash".into());
        }
        if let Some(index) = self.hashes.iter().position(|selected| selected == hash) {
            self.hashes.remove(index);
        } else {
            self.hashes.push(hash.to_string());
        }
        self.revision += 1;
        Ok(())
    }
    fn begin(&mut self, epoch: u64) -> Result<Submission, String> {
        self.editable(epoch)?;
        if self.hashes.is_empty() {
            return Err("Select items to add to the queue".into());
        }
        self.revision += 1;
        self.submission = Some(self.revision);
        Ok(Submission {
            epoch,
            id: self.revision,
            hashes: self.hashes.clone(),
        })
    }
    fn complete(&mut self, submission: &Submission, success: bool) {
        if self.core.activation_epoch != submission.epoch || self.submission != Some(submission.id)
        {
            return;
        }
        self.submission = None;
        if success {
            self.hashes = Vec::new();
        }
        self.revision += 1;
    }
    fn payload(&self) -> Value {
        json!({"active": self.core.active, "revision": self.core.revision,
            "activationEpoch": self.core.activation_epoch, "selectedHashes": self.hashes,
            "selectionRevision": self.revision, "selectionBusy": self.submission.is_some()})
    }
}

pub(super) fn intercepts_paste(operation: &str, plain: bool, active: bool) -> bool {
    operation == "paste" && !plain && active
}

pub(super) fn snapshot() -> Value {
    let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    pending.sync(paste_queue::toolbar_status());
    pending.payload()
}
pub(super) fn toggle(hash: &str, epoch: u64) -> Result<Value, String> {
    let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    pending.sync(paste_queue::toolbar_status());
    pending.toggle(hash, epoch)?;
    Ok(pending.payload())
}
pub(super) fn begin(epoch: u64) -> Result<Submission, String> {
    let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    pending.sync(paste_queue::toolbar_status());
    pending.begin(epoch)
}
pub(super) fn complete(submission: &Submission, success: bool) -> Value {
    let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    pending.sync(paste_queue::toolbar_status());
    pending.complete(submission, success);
    pending.payload()
}
pub(crate) fn deactivate() {
    let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    pending.sync(paste_queue::toolbar_status());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core(active: bool, epoch: u64, revision: u64) -> crate::paste_queue::ToolbarStatus {
        crate::paste_queue::ToolbarStatus {
            active,
            revision,
            activation_epoch: epoch,
        }
    }

    #[test]
    fn an_active_queue_intercepts_normal_paste_before_clipboard_side_effects() {
        assert!(intercepts_paste("paste", false, true));
        assert!(!intercepts_paste("paste", false, false));
        assert!(!intercepts_paste("copy", false, true));
        assert!(!intercepts_paste("paste", true, true));
    }

    #[test]
    fn pending_selection_is_ordered_by_hash_and_not_a_viewport_index() {
        let mut state = Selection::default();
        state.sync(core(true, 1, 2));
        state.toggle("b", 1).unwrap();
        state.toggle("a", 1).unwrap();
        state.toggle("c", 1).unwrap();
        state.toggle("a", 1).unwrap();
        state.toggle("a", 1).unwrap();
        assert_eq!(state.hashes, ["b", "c", "a"]);
        state.sync(core(true, 1, 3));
        assert_eq!(state.hashes, ["b", "c", "a"]);
    }

    #[test]
    fn submission_retains_selection_on_failure_and_clears_it_on_success() {
        let mut state = Selection::default();
        state.sync(core(true, 2, 3));
        state.toggle("image", 2).unwrap();
        state.toggle("file", 2).unwrap();
        let first = state.begin(2).unwrap();
        assert_eq!(first.hashes, ["image", "file"]);
        assert!(state.begin(2).is_err());
        assert!(state.toggle("text", 2).is_err());
        state.complete(&first, false);
        assert_eq!(state.hashes, ["image", "file"]);
        let second = state.begin(2).unwrap();
        state.complete(&second, true);
        assert!(state.hashes.is_empty());
        assert!(state.submission.is_none());
        assert!(state.core.active);
    }

    #[test]
    fn closing_or_restarting_the_queue_discards_only_the_previous_session() {
        let mut state = Selection::default();
        state.sync(core(true, 1, 2));
        state.toggle("old", 1).unwrap();
        let old = state.begin(1).unwrap();
        state.sync(core(false, 2, 3));
        assert!(state.hashes.is_empty());
        assert!(state.submission.is_none());
        assert!(state.toggle("late", 1).is_err());
        state.sync(core(true, 3, 4));
        state.toggle("new", 3).unwrap();
        state.complete(&old, true);
        assert_eq!(state.hashes, ["new"]);
        state.sync(core(false, 2, 3));
        assert!(
            state.core.active,
            "An old queue event cannot roll the session back"
        );
        assert_eq!(state.hashes, ["new"]);
    }

    #[test]
    fn selection_payload_contains_only_hashes_and_queue_metadata() {
        let mut state = Selection::default();
        state.sync(core(true, 1, 2));
        state.toggle("hash", 1).unwrap();
        let payload = state.payload();
        assert_eq!(payload["selectedHashes"], json!(["hash"]));
        assert_eq!(payload["selectionBusy"], false);
        assert!(payload.get("items").is_none());
        assert!(payload.get("cards").is_none());
        assert!(state.toggle("", 1).is_err());
        assert!(state.toggle("stale", 0).is_err());
    }
}
