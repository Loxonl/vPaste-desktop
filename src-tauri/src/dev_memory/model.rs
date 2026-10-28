use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSample {
    pub label: String,
    pub visible: bool,
    pub renderer_pids: Vec<u32>,
    pub error: Option<String>,
}

pub struct ProcessLink {
    pub pid: u32,
    pub kind: String,
    pub window_labels: Vec<String>,
}

pub struct Counters {
    pub resident_bytes: u64,
    pub accounted_bytes: u64,
    pub started_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    pub kind: String,
    pub window_labels: Vec<String>,
    pub retained: bool,
    pub resident_bytes: Option<u64>,
    pub accounted_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub timestamp: u64,
    pub windows: Vec<WindowSample>,
    pub processes: Vec<ProcessSample>,
    pub total_resident_bytes: u64,
    pub total_accounted_bytes: u64,
    pub partial: bool,
}

#[derive(Default)]
struct Tracked {
    started_at: Option<u64>,
    kind: String,
    labels: BTreeSet<String>,
}

#[derive(Default)]
pub struct Tracker {
    processes: BTreeMap<u32, Tracked>,
}

impl Tracker {
    pub fn record(
        &mut self,
        timestamp: u64,
        windows: Vec<WindowSample>,
        links: Vec<ProcessLink>,
        mut read: impl FnMut(u32) -> Result<Option<Counters>, String>,
    ) -> Sample {
        let mut current: BTreeMap<u32, Tracked> = BTreeMap::new();
        for link in links.into_iter().filter(|link| link.pid != 0) {
            let entry = current.entry(link.pid).or_default();
            entry.kind = link.kind;
            entry.labels.extend(link.window_labels);
        }
        for (&pid, link) in &current {
            self.processes.entry(pid).or_insert_with(|| Tracked {
                kind: link.kind.clone(),
                labels: link.labels.clone(),
                ..Tracked::default()
            });
        }
        let mut sample = Sample {
            timestamp,
            partial: windows.iter().any(|window| window.error.is_some()),
            windows,
            processes: Vec::new(),
            total_resident_bytes: 0,
            total_accounted_bytes: 0,
        };
        self.processes.retain(|&pid, tracked| {
            let linked = current.get(&pid);
            let result = read(pid);
            let counters = match &result {
                Ok(Some(counters)) => counters,
                Ok(None) => {
                    sample.partial |= linked.is_some();
                    return false;
                }
                Err(_) if linked.is_none() && tracked.started_at.is_none() => return false,
                Err(_) => {
                    sample.partial = true;
                    sample.processes.push(ProcessSample {
                        pid,
                        kind: tracked.kind.clone(),
                        window_labels: tracked.labels.iter().cloned().collect(),
                        retained: linked.is_none()
                            || linked.is_some_and(|link| {
                                link.kind == "renderer"
                                    && link.labels.is_empty()
                                    && !tracked.labels.is_empty()
                            }),
                        resident_bytes: None,
                        accounted_bytes: None,
                        error: result.err(),
                    });
                    return true;
                }
            };
            if tracked
                .started_at
                .is_some_and(|started| started != counters.started_at)
            {
                // A recycled PID must never inherit a closed window's attribution.
                let Some(link) = linked else {
                    return false;
                };
                tracked.labels = link.labels.clone();
            }
            tracked.started_at = Some(counters.started_at);
            if let Some(link) = linked {
                tracked.kind = link.kind.clone();
                // Environment membership alone does not establish a live
                // renderer/window association (WebView2 can cache renderers).
                if link.kind != "renderer" || !link.labels.is_empty() {
                    tracked.labels = link.labels.clone();
                }
            }
            sample.total_resident_bytes = sample
                .total_resident_bytes
                .saturating_add(counters.resident_bytes);
            sample.total_accounted_bytes = sample
                .total_accounted_bytes
                .saturating_add(counters.accounted_bytes);
            sample.processes.push(ProcessSample {
                pid,
                kind: tracked.kind.clone(),
                window_labels: tracked.labels.iter().cloned().collect(),
                retained: linked.is_none()
                    || linked.is_some_and(|link| {
                        link.kind == "renderer"
                            && link.labels.is_empty()
                            && !tracked.labels.is_empty()
                    }),
                resident_bytes: Some(counters.resident_bytes),
                accounted_bytes: Some(counters.accounted_bytes),
                error: None,
            });
            true
        });
        sample
    }
}

#[derive(Default)]
pub struct History {
    pub samples: VecDeque<Sample>,
}

impl History {
    pub fn push(&mut self, sample: Sample) {
        let cutoff = sample.timestamp.saturating_sub(60_000);
        self.samples.retain(|old| old.timestamp >= cutoff);
        self.samples.push_back(sample);
        while self.samples.len() > 61 {
            self.samples.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(pid: u32, labels: &[&str]) -> ProcessLink {
        ProcessLink {
            pid,
            kind: "renderer".into(),
            window_labels: labels.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn counters(started_at: u64) -> Counters {
        Counters {
            resident_bytes: 100,
            accounted_bytes: 80,
            started_at,
        }
    }

    #[test]
    fn shared_process_counts_once_and_names_every_window() {
        let mut tracker = Tracker::default();
        let sample = tracker.record(
            1,
            vec![],
            vec![link(7, &["clipboard"]), link(7, &["config"])],
            |_| Ok(Some(counters(10))),
        );
        assert_eq!(sample.processes.len(), 1);
        assert_eq!(sample.total_resident_bytes, 100);
        assert_eq!(
            sample.processes[0].window_labels,
            vec!["clipboard", "config"]
        );
    }

    #[test]
    fn closed_window_process_remains_until_exit_and_pid_reuse_loses_attribution() {
        let mut tracker = Tracker::default();
        tracker.record(1, vec![], vec![link(7, &["config"])], |_| {
            Ok(Some(counters(10)))
        });
        let retained = tracker.record(2, vec![], vec![], |_| Ok(Some(counters(10))));
        assert!(retained.processes[0].retained);
        assert_eq!(retained.total_accounted_bytes, 80);
        let reused = tracker.record(3, vec![], vec![], |_| Ok(Some(counters(20))));
        assert!(reused.processes.is_empty());
        tracker.record(4, vec![], vec![link(8, &["config"])], |_| {
            Ok(Some(counters(30)))
        });
        assert!(tracker
            .record(5, vec![], vec![], |_| Ok(None))
            .processes
            .is_empty());
    }

    #[test]
    fn unavailable_memory_is_partial_instead_of_zero() {
        let sample = Tracker::default().record(1, vec![], vec![link(7, &["config"])], |_| {
            Err("denied".into())
        });
        assert!(sample.partial);
        assert_eq!(sample.processes[0].resident_bytes, None);
        assert_eq!(sample.processes[0].error.as_deref(), Some("denied"));
    }

    #[test]
    fn environment_membership_preserves_closed_renderer_attribution_until_pid_reuse() {
        let mut tracker = Tracker::default();
        tracker.record(1, vec![], vec![link(7, &["config"])], |_| {
            Ok(Some(counters(10)))
        });
        let cached = tracker.record(2, vec![], vec![link(7, &[])], |_| Ok(Some(counters(10))));
        assert!(cached.processes[0].retained);
        assert_eq!(cached.processes[0].window_labels, vec!["config"]);
        let reused = tracker.record(3, vec![], vec![link(7, &[])], |_| Ok(Some(counters(20))));
        assert!(!reused.processes[0].retained);
        assert!(reused.processes[0].window_labels.is_empty());
    }

    #[test]
    fn history_is_bounded_by_time_and_count() {
        let mut history = History::default();
        for timestamp in 0..100 {
            history.push(Tracker::default().record(timestamp, vec![], vec![], |_| Ok(None)));
        }
        assert_eq!(history.samples.len(), 61);
        history.push(Tracker::default().record(100_000, vec![], vec![], |_| Ok(None)));
        assert_eq!(history.samples.len(), 1);
    }
}
