use std::ffi::c_void;

use cocoa::base::{id, nil};
use objc::{msg_send, sel, sel_impl};

use super::{
    empty_window,
    model::{Counters, ProcessLink},
    Discovery,
};

// This entire module is excluded by the parent's debug_assertions gate.
fn unavailable(result: &mut Discovery, message: &str) {
    result.window.error = Some(match result.window.error.take() {
        Some(previous) => format!("{previous}; {message}"),
        None => message.into(),
    });
}

pub fn inspect(view: tauri::webview::PlatformWebview, label: String, visible: bool) -> Discovery {
    unsafe { inspect_object(view.inner() as id, label, visible) }
}

unsafe fn inspect_object(webview: id, label: String, visible: bool) -> Discovery {
    let mut result = empty_window(
        label.clone(),
        visible,
        "WebKit renderer PID is unavailable".into(),
    );
    unsafe {
        // Call the integer-returning selectors directly after checking support.
        let supported: bool = msg_send![webview, respondsToSelector:sel!(_webProcessIdentifier)];
        if supported {
            let pid: i32 = msg_send![webview, _webProcessIdentifier];
            if pid > 0 {
                result.window.renderer_pids.push(pid as u32);
                result.window.error = None;
                result.processes.push(ProcessLink {
                    pid: pid as u32,
                    kind: "renderer".into(),
                    window_labels: vec![label],
                });
            }
        }
        let supported: bool = msg_send![webview, respondsToSelector:sel!(_gpuProcessIdentifier)];
        if supported {
            let pid: i32 = msg_send![webview, _gpuProcessIdentifier];
            if pid > 0 {
                result.processes.push(ProcessLink {
                    pid: pid as u32,
                    kind: "gpu".into(),
                    window_labels: vec![],
                });
            }
        } else {
            unavailable(&mut result, "WebKit GPU process lookup is unavailable");
        }
        let configuration: id = msg_send![webview, configuration];
        let store: id = if configuration == nil {
            nil
        } else {
            msg_send![configuration, websiteDataStore]
        };
        if store != nil {
            let supported: bool =
                msg_send![store, respondsToSelector:sel!(_networkProcessIdentifier)];
            if supported {
                let pid: i32 = msg_send![store, _networkProcessIdentifier];
                if pid > 0 {
                    result.processes.push(ProcessLink {
                        pid: pid as u32,
                        kind: "network".into(),
                        window_labels: vec![],
                    });
                }
            } else {
                unavailable(&mut result, "WebKit network process lookup is unavailable");
            }
        } else {
            unavailable(&mut result, "WebKit network data store is unavailable");
        }
    }
    result
}

#[repr(C)]
#[derive(Default)]
struct RusageInfoV0 {
    uuid: [u8; 16],
    user_time: u64,
    system_time: u64,
    idle_wakeups: u64,
    interrupt_wakeups: u64,
    pageins: u64,
    wired_size: u64,
    resident_size: u64,
    phys_footprint: u64,
    start_time: u64,
    exit_time: u64,
}

extern "C" {
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut c_void) -> i32;
}

pub fn read_memory(pid: u32) -> Result<Option<Counters>, String> {
    let mut usage = RusageInfoV0::default();
    let result =
        unsafe { proc_pid_rusage(pid as i32, 0, (&mut usage as *mut RusageInfoV0).cast()) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return if matches!(error.raw_os_error(), Some(2 | 3)) {
            Ok(None)
        } else {
            Err(error.to_string())
        };
    }
    Ok(Some(Counters {
        resident_bytes: usage.resident_size,
        accounted_bytes: usage.phys_footprint,
        started_at: usage.start_time,
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_service_selectors_preserve_renderer_but_report_incomplete_discovery() {
        use cocoa::base::{id, nil};
        use objc::{
            class,
            declare::ClassDecl,
            msg_send,
            runtime::{Object, Sel},
            sel, sel_impl,
        };
        extern "C" fn renderer(_: &Object, _: Sel) -> i32 {
            std::process::id() as i32
        }
        extern "C" fn configuration(object: &Object, _: Sel) -> id {
            object as *const Object as id
        }
        extern "C" fn store(_: &Object, _: Sel) -> id {
            nil
        }
        let mut declaration =
            ClassDecl::new("VPasteMemoryProbeWithoutServices", class!(NSObject)).unwrap();
        unsafe {
            declaration.add_method(
                sel!(_webProcessIdentifier),
                renderer as extern "C" fn(&Object, Sel) -> i32,
            );
            declaration.add_method(
                sel!(configuration),
                configuration as extern "C" fn(&Object, Sel) -> id,
            );
            declaration.add_method(
                sel!(websiteDataStore),
                store as extern "C" fn(&Object, Sel) -> id,
            );
            let class = declaration.register();
            let object: id = msg_send![class, new];
            let report = super::inspect_object(object, "probe".into(), false);
            let _: () = msg_send![object, release];
            assert_eq!(report.window.renderer_pids, vec![std::process::id()]);
            assert!(report.window.error.as_deref().unwrap_or("").contains("GPU"));
            assert!(report
                .window
                .error
                .as_deref()
                .unwrap_or("")
                .contains("network"));
        }
    }

    #[test]
    fn reads_real_current_process_memory_and_identity() {
        let first = super::read_memory(std::process::id()).unwrap().unwrap();
        let second = super::read_memory(std::process::id()).unwrap().unwrap();
        assert!(first.resident_bytes > 0);
        assert!(first.accounted_bytes > 0);
        assert_eq!(first.started_at, second.started_at);
        assert!(first.started_at > 0);
    }
}
