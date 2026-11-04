mod model;
mod window;
pub(crate) use window::{build_window, keep_on_top};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::Mutex;
use std::time::Duration;

use model::{History, ProcessLink, Tracker, WindowSample};
use serde::Serialize;
use tauri::Manager;
use tokio::sync::oneshot;

pub struct Discovery {
    pub window: WindowSample,
    pub processes: Vec<ProcessLink>,
}

#[derive(Default)]
struct State {
    running: bool,
    generation: u64,
    tracker: Tracker,
    history: History,
}

impl State {
    fn transition(&mut self, enabled: bool) -> Option<u64> {
        if self.running == enabled {
            return None;
        }
        self.running = enabled;
        self.generation += 1;
        enabled.then_some(self.generation)
    }

    fn active(&self, generation: u64) -> bool {
        self.running && self.generation == generation
    }
}

#[derive(Default)]
pub struct Monitor {
    state: Mutex<State>,
    sampling: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    running: bool,
    platform: &'static str,
    accounted_metric: &'static str,
    samples: Vec<model::Sample>,
}

fn empty_window(label: String, visible: bool, error: String) -> Discovery {
    Discovery {
        window: WindowSample {
            label,
            visible,
            renderer_pids: Vec::new(),
            error: Some(error),
        },
        processes: Vec::new(),
    }
}

async fn sample(app: &tauri::AppHandle, generation: Option<u64>) {
    let monitor = app.state::<Monitor>();
    let _sampling = monitor.sampling.lock().await;
    if generation.is_some_and(|generation| !monitor.state.lock().unwrap().active(generation)) {
        return;
    }
    let mut windows = Vec::new();
    let mut processes = vec![ProcessLink {
        pid: std::process::id(),
        kind: "core".into(),
        window_labels: vec![],
    }];
    let mut native_windows: Vec<_> = app.webview_windows().into_iter().collect();
    native_windows.sort_by(|a, b| a.0.cmp(&b.0));
    for (label, window) in native_windows {
        let visible = window.is_visible().unwrap_or(false);
        let (sender, receiver) = oneshot::channel();
        let native_label = label.clone();
        let dispatched = window.with_webview(move |view| {
            #[cfg(target_os = "macos")]
            let _ = sender.send(macos::inspect(view, native_label, visible));
            #[cfg(target_os = "windows")]
            windows::inspect(view, native_label, visible, sender);
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = (
                    view,
                    sender.send(empty_window(
                        native_label,
                        visible,
                        "native memory mapping is unavailable on this platform".into(),
                    )),
                );
            }
        });
        let discovery = match dispatched {
            Err(error) => empty_window(label, visible, error.to_string()),
            Ok(()) => match tokio::time::timeout(Duration::from_secs(2), receiver).await {
                Ok(Ok(discovery)) => discovery,
                _ => empty_window(
                    label,
                    visible,
                    "native process lookup timed out or window closed".into(),
                ),
            },
        };
        windows.push(discovery.window);
        processes.extend(discovery.processes);
    }
    // Drop native window handles before retaining history; the monitor must not
    // keep a destroyed webview alive through its own bookkeeping.
    let mut state = monitor.state.lock().unwrap();
    if generation.is_some_and(|generation| !state.active(generation)) {
        return;
    }
    let snapshot = state
        .tracker
        .record(crate::now_millis(), windows, processes, read_memory);
    state.history.push(snapshot);
}

fn read_memory(pid: u32) -> Result<Option<model::Counters>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::read_memory(pid)
    }
    #[cfg(target_os = "windows")]
    {
        windows::read_memory(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = pid;
        Err("native process memory is unavailable on this platform".into())
    }
}

pub async fn report(app: &tauri::AppHandle, refresh: bool) -> Report {
    if refresh {
        sample(app, None).await;
    }
    let state = app.state::<Monitor>();
    let state = state.state.lock().unwrap();
    Report {
        running: state.running,
        platform: std::env::consts::OS,
        accounted_metric: if cfg!(target_os = "macos") {
            "physicalFootprint"
        } else {
            "privateBytes"
        },
        samples: state.history.samples.iter().cloned().collect(),
    }
}

pub async fn set_monitoring(app: tauri::AppHandle, enabled: bool) -> Report {
    let start = {
        let monitor = app.state::<Monitor>();
        let mut state = monitor.state.lock().unwrap();
        state.transition(enabled)
    };
    if let Some(generation) = start {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                {
                    let monitor = handle.state::<Monitor>();
                    let state = monitor.state.lock().unwrap();
                    if !state.active(generation) {
                        break;
                    }
                }
                sample(&handle, Some(generation)).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }
    report(&app, false).await
}

#[cfg(test)]
mod tests {
    use super::State;

    #[test]
    fn repeated_start_does_not_spawn_another_loop_and_restart_invalidates_old_work() {
        let mut state = State::default();
        let first = state.transition(true).unwrap();
        assert!(state.active(first));
        assert!(state.transition(true).is_none());
        assert!(state.active(first));
        state.transition(false);
        assert!(!state.active(first));
        let second = state.transition(true).unwrap();
        assert!(!state.active(first));
        assert!(state.active(second));
    }
}
