use std::{cell::RefCell, rc::Rc};

use tokio::sync::oneshot;
use webview2_com::{GetProcessExtendedInfosCompletedHandler, Microsoft::Web::WebView2::Win32::*};
use windows_dev::core::Interface;

use super::{
    empty_window,
    model::{Counters, ProcessLink, WindowSample},
    Discovery,
};

unsafe fn belongs_to(frame: ICoreWebView2FrameInfo, root: u32) -> bool {
    let mut frame = frame;
    for _ in 0..64 {
        let Ok(info) = frame.cast::<ICoreWebView2FrameInfo2>() else {
            return false;
        };
        let mut id = 0;
        if info.FrameId(&mut id).is_err() {
            return false;
        }
        if id == root {
            return true;
        }
        let Ok(parent) = info.ParentFrameInfo() else {
            return false;
        };
        frame = parent;
    }
    false
}

unsafe fn collect(
    collection: ICoreWebView2ProcessExtendedInfoCollection,
    root: u32,
    label: String,
    visible: bool,
) -> windows_dev::core::Result<Discovery> {
    let mut result = Discovery {
        window: WindowSample {
            label: label.clone(),
            visible,
            renderer_pids: vec![],
            error: None,
        },
        processes: vec![],
    };
    let mut count = 0;
    collection.Count(&mut count)?;
    for index in 0..count {
        let extended = collection.GetValueAtIndex(index)?;
        let process = extended.ProcessInfo()?;
        let mut pid = 0;
        let mut kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
        process.ProcessId(&mut pid)?;
        process.Kind(&mut kind)?;
        let mut labels = vec![];
        if kind == COREWEBVIEW2_PROCESS_KIND_RENDERER {
            let frames = extended.AssociatedFrameInfos()?;
            let iterator = frames.GetIterator()?;
            let mut current = windows_dev::core::BOOL::default();
            iterator.HasCurrent(&mut current)?;
            while current.as_bool() {
                if belongs_to(iterator.GetCurrent()?, root) {
                    labels.push(label.clone());
                    result.window.renderer_pids.push(pid as u32);
                    break;
                }
                iterator.MoveNext(&mut current)?;
            }
        }
        let kind = if kind == COREWEBVIEW2_PROCESS_KIND_RENDERER {
            "renderer"
        } else if kind == COREWEBVIEW2_PROCESS_KIND_GPU {
            "gpu"
        } else if kind == COREWEBVIEW2_PROCESS_KIND_BROWSER {
            "browser"
        } else {
            "utility"
        };
        if pid > 0 {
            result.processes.push(ProcessLink {
                pid: pid as u32,
                kind: kind.into(),
                window_labels: labels,
            });
        }
    }
    result.window.renderer_pids.sort_unstable();
    result.window.renderer_pids.dedup();
    if result.window.renderer_pids.is_empty() {
        result.window.error = Some("renderer frame mapping is unavailable".into());
    }
    Ok(result)
}

pub fn inspect(
    view: tauri::webview::PlatformWebview,
    label: String,
    visible: bool,
    sender: oneshot::Sender<Discovery>,
) {
    let sender = Rc::new(RefCell::new(Some(sender)));
    let result = (|| -> windows_dev::core::Result<()> {
        unsafe {
            let core = view
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_20>()?;
            let mut root = 0;
            core.FrameId(&mut root)?;
            if root == 0 {
                return Err(windows_dev::core::Error::from_hresult(
                    windows_dev::core::HRESULT(0x8000000A_u32 as i32),
                ));
            }
            let environment = view.environment().cast::<ICoreWebView2Environment13>()?;
            let callback_sender = sender.clone();
            let callback_label = label.clone();
            let callback = GetProcessExtendedInfosCompletedHandler::create(Box::new(
                move |status, collection| {
                    let result = status.and_then(|()| match collection {
                        Some(collection) => {
                            collect(collection, root, callback_label.clone(), visible)
                        }
                        None => Err(windows_dev::core::Error::from_hresult(
                            windows_dev::core::HRESULT(0x80004005_u32 as i32),
                        )),
                    });
                    let result = result.unwrap_or_else(|error| {
                        empty_window(callback_label, visible, error.to_string())
                    });
                    if let Some(sender) = callback_sender.borrow_mut().take() {
                        let _ = sender.send(result);
                    }
                    Ok(())
                },
            ));
            environment.GetProcessExtendedInfos(&callback)
        }
    })();
    if let Err(error) = result {
        if let Some(sender) = sender.borrow_mut().take() {
            let _ = sender.send(empty_window(label, visible, error.to_string()));
        }
    }
}

pub fn read_memory(pid: u32) -> Result<Option<Counters>, String> {
    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::{
            ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
            },
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(error) if error.code().0 as u32 == 0x80070057 => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let result = (|| {
            let mut memory = PROCESS_MEMORY_COUNTERS_EX::default();
            GetProcessMemoryInfo(
                handle,
                (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
                std::mem::size_of_val(&memory) as u32,
            )
            .map_err(|error| error.to_string())?;
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
                .map_err(|error| error.to_string())?;
            Ok(Some(Counters {
                resident_bytes: memory.WorkingSetSize as u64,
                accounted_bytes: memory.PrivateUsage as u64,
                started_at: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
            }))
        })();
        let _ = CloseHandle(handle);
        result
    }
}
