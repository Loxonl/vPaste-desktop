//! Restore an external editing control, which can share its HWND with the browser.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation2, IUIAutomationElement, UIA_ComboBoxControlTypeId,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_CONTROLTYPE_ID,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const CAPTURE_BUDGET: Duration = Duration::from_millis(200);
const RESTORE_BUDGET: Duration = Duration::from_millis(350);
static WORKER: OnceLock<Option<Worker>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    window: usize,
    process: u32,
}

impl Target {
    fn from_window(window: usize) -> Option<Self> {
        let mut process = 0;
        unsafe { GetWindowThreadProcessId(HWND(window as isize), Some(&mut process)) };
        (window != 0 && process != 0).then_some(Self { window, process })
    }

    fn foreground() -> Option<Self> {
        Self::from_window(unsafe { GetForegroundWindow() }.0 as usize)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RequestId {
    target: Target,
    generation: u64,
}

struct SavedFocus<E> {
    request: RequestId,
    element: E,
}

fn take_saved_element<E>(
    saved: &mut Option<SavedFocus<E>>,
    request: RequestId,
    foreground: Option<Target>,
) -> Option<E> {
    saved.take().and_then(|saved| {
        (saved.request == request && foreground == Some(request.target)).then_some(saved.element)
    })
}

#[derive(Clone, Copy)]
enum Operation {
    Capture,
    Restore,
}

struct Request {
    id: RequestId,
    operation: Operation,
    deadline: Instant,
    reply: mpsc::SyncSender<Result<bool, String>>,
}

impl Request {
    fn active(&self, generation: u64) -> bool {
        self.id.generation == generation && Instant::now() < self.deadline
    }
}

struct Worker {
    sender: mpsc::Sender<Request>,
    generation: Arc<AtomicU64>,
    captured_generation: AtomicU64,
}

impl Worker {
    fn call(&self, id: RequestId, operation: Operation, budget: Duration) -> Result<bool, String> {
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .send(Request {
                id,
                operation,
                deadline: Instant::now() + budget,
                reply,
            })
            .map_err(|err| format!("Editing focus worker unavailable: {err}"))?;
        result.recv_timeout(budget).unwrap_or_else(|err| {
            // Retire expired work so a queued request cannot focus an old input later.
            let _ = self.generation.compare_exchange(
                id.generation,
                id.generation + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            Err(format!("Editing focus request timed out or stopped: {err}"))
        })
    }
}

pub fn initialize() {
    let _ = worker();
}

fn worker() -> Option<&'static Worker> {
    WORKER
        .get_or_init(|| {
            let (sender, requests) = mpsc::channel();
            let generation = Arc::new(AtomicU64::new(0));
            let worker_generation = generation.clone();
            match std::thread::Builder::new()
                .name("paste-editing-focus".into())
                .spawn(move || {
                    if let Err(err) = run_worker(requests, worker_generation) {
                        log::warn!("Editing focus worker stopped: {err}");
                    }
                }) {
                Ok(_) => Some(Worker {
                    sender,
                    generation,
                    captured_generation: AtomicU64::new(0),
                }),
                Err(err) => {
                    log::warn!("Cannot start editing focus worker: {err}");
                    None
                }
            }
        })
        .as_ref()
}

pub fn capture_foreground() {
    let target = Target::foreground();
    // Returning from vPaste's own editor/preview must retain the external snapshot.
    if target.is_some_and(|target| target.process == std::process::id()) {
        return;
    }
    let Some(worker) = worker() else { return };
    let generation = worker.generation.fetch_add(1, Ordering::SeqCst) + 1;
    worker.captured_generation.store(0, Ordering::SeqCst);
    let Some(target) = target else { return };
    let started = Instant::now();
    match worker.call(
        RequestId { target, generation },
        Operation::Capture,
        CAPTURE_BUDGET,
    ) {
        Ok(true) if worker.generation.load(Ordering::SeqCst) == generation => {
            worker
                .captured_generation
                .store(generation, Ordering::SeqCst);
            log::info!(
                "Captured editing focus: window={:#x}, elapsed_ms={}",
                target.window,
                started.elapsed().as_millis()
            );
        }
        Ok(_) => log::info!(
            "No external editable focus captured: window={:#x}",
            target.window
        ),
        Err(err) => log::warn!("Editing focus capture skipped: {err}"),
    }
}

pub fn restore_before_paste(window: usize) -> Result<(), String> {
    let Some(worker) = worker() else {
        return Ok(());
    };
    let generation = worker.generation.load(Ordering::SeqCst);
    if generation == 0 || worker.captured_generation.swap(0, Ordering::SeqCst) != generation {
        return Ok(());
    }
    let target =
        Target::from_window(window).ok_or("Original paste window is no longer available")?;
    let result = worker.call(
        RequestId { target, generation },
        Operation::Restore,
        RESTORE_BUDGET,
    );
    match result {
        Ok(true) => {
            log::info!(
                "Restored editing focus before paste: window={:#x}",
                target.window
            );
            Ok(())
        }
        Ok(false) => {
            let err = "Original editing control is no longer available for paste".to_string();
            log::warn!("Editing focus restore failed: {err}");
            Err(err)
        }
        Err(err) => {
            log::warn!("Editing focus restore failed: {err}");
            Err(err)
        }
    }
}

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn automation_client() -> windows::core::Result<IUIAutomation2> {
    let client: IUIAutomation2 =
        unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)? };
    unsafe {
        client.SetConnectionTimeout(100)?;
        client.SetTransactionTimeout(100)?;
    }
    Ok(client)
}

fn run_worker(requests: mpsc::Receiver<Request>, generation: Arc<AtomicU64>) -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }.map_err(|err| err.to_string())?;
    let _apartment = ComApartment;
    let client = automation_client().map_err(|err| err.to_string())?;
    log::info!("Windows editing focus worker ready");
    let mut saved = None;
    for request in requests {
        let result = match request.operation {
            Operation::Capture => {
                saved = None;
                capture_element(&client, &request, &generation).map(|element| {
                    saved = element.map(|element| SavedFocus {
                        request: request.id,
                        element,
                    });
                    saved.is_some()
                })
            }
            Operation::Restore => {
                let element = take_saved_element(&mut saved, request.id, Target::foreground());
                match element {
                    Some(element) => restore_element(&element, &request, &generation),
                    None => Ok(false),
                }
            }
        };
        let _ = request.reply.send(result);
    }
    Ok(())
}

fn editable_control(control_type: UIA_CONTROLTYPE_ID) -> bool {
    [
        UIA_EditControlTypeId,
        UIA_ComboBoxControlTypeId,
        UIA_DocumentControlTypeId,
    ]
    .contains(&control_type)
}

fn capture_element(
    client: &IUIAutomation2,
    request: &Request,
    generation: &AtomicU64,
) -> Result<Option<IUIAutomationElement>, String> {
    if !request.active(generation.load(Ordering::SeqCst))
        || Target::foreground() != Some(request.id.target)
    {
        return Ok(None);
    }
    // Only accessibility identity/focus metadata is read; never values, names or text.
    let element = unsafe { client.GetFocusedElement() }.map_err(|err| err.to_string())?;
    let eligible = unsafe {
        element.CurrentProcessId().map_err(|err| err.to_string())? as u32
            == request.id.target.process
            && editable_control(
                element
                    .CurrentControlType()
                    .map_err(|err| err.to_string())?,
            )
            && element
                .CurrentIsKeyboardFocusable()
                .map_err(|err| err.to_string())?
                .as_bool()
            && element
                .CurrentHasKeyboardFocus()
                .map_err(|err| err.to_string())?
                .as_bool()
    };
    Ok((eligible
        && request.active(generation.load(Ordering::SeqCst))
        && Target::foreground() == Some(request.id.target))
    .then_some(element))
}

fn restore_element(
    element: &IUIAutomationElement,
    request: &Request,
    generation: &AtomicU64,
) -> Result<bool, String> {
    restore_editing_control(
        || {
            unsafe { element.CurrentHasKeyboardFocus() }
                .map(|focused| focused.as_bool())
                .map_err(|err| err.to_string())
        },
        || {
            log::info!("Requesting saved editing control focus before paste");
            unsafe { element.SetFocus() }.map_err(|err| err.to_string())
        },
        || {
            if request.active(generation.load(Ordering::SeqCst))
                && Target::foreground() == Some(request.id.target)
            {
                Ok(())
            } else {
                Err("Paste target changed or editing focus request expired".to_string())
            }
        },
    )
}

fn restore_editing_control(
    mut is_focused: impl FnMut() -> Result<bool, String>,
    set_focus: impl FnOnce() -> Result<(), String>,
    mut check_target: impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    check_target()?;
    if is_focused()? {
        return Ok(true);
    }
    check_target()?;
    set_focus()?;
    loop {
        check_target()?;
        if is_focused()? {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(window: usize, generation: u64) -> RequestId {
        RequestId {
            target: Target {
                window,
                process: 42,
            },
            generation,
        }
    }

    #[test]
    fn foreground_window_restoration_still_requires_the_saved_editing_control() {
        let captured = request(100, 1);
        let mut saved = Some(SavedFocus {
            request: captured,
            element: "original browser input",
        });
        // Chrome is foreground again, but its DOM activeElement is BODY.
        assert_eq!(
            take_saved_element(&mut saved, captured, Some(captured.target)),
            Some("original browser input"),
        );
        assert!(saved.is_none(), "a restored snapshot is consumed once");
        assert_eq!(
            take_saved_element(&mut saved, captured, Some(captured.target)),
            None
        );
    }

    #[test]
    fn a_later_capture_cannot_restore_an_older_input() {
        let captured = request(100, 1);
        let mut saved = Some(SavedFocus {
            request: captured,
            element: "old input",
        });
        assert_eq!(
            take_saved_element(&mut saved, request(100, 2), Some(captured.target)),
            None
        );
    }

    #[test]
    fn another_window_of_the_same_browser_must_not_receive_restored_focus() {
        let captured = request(100, 1);
        let mut saved = Some(SavedFocus {
            request: captured,
            element: "input",
        });
        assert_eq!(
            take_saved_element(&mut saved, captured, Some(request(200, 1).target)),
            None
        );
    }

    #[test]
    fn a_reused_window_handle_from_another_process_is_rejected() {
        let captured = request(100, 1);
        let mut saved = Some(SavedFocus {
            request: captured,
            element: "input",
        });
        assert_eq!(
            take_saved_element(
                &mut saved,
                captured,
                Some(Target {
                    window: 100,
                    process: 99
                })
            ),
            None
        );
    }

    #[test]
    fn restoring_the_browser_control_changes_body_focus_back_to_the_input() {
        use std::cell::Cell;

        let active_element = Cell::new("BODY");
        assert!(restore_editing_control(
            || Ok(active_element.get() == "original input"),
            || {
                active_element.set("original input");
                Ok(())
            },
            || Ok(()),
        )
        .unwrap());
        assert_eq!(active_element.get(), "original input");
    }

    #[test]
    fn an_input_that_kept_focus_is_not_refocused_or_reselected() {
        assert!(restore_editing_control(
            || Ok(true),
            || panic!("do not disturb an existing text selection"),
            || Ok(()),
        )
        .unwrap());
    }

    #[test]
    fn a_focus_provider_failure_is_returned_to_the_paste_command() {
        assert_eq!(
            restore_editing_control(
                || Ok(false),
                || Err("element disconnected".into()),
                || Ok(()),
            ),
            Err("element disconnected".into())
        );
    }

    #[test]
    fn changing_target_or_expiring_a_request_prevents_a_late_focus_change() {
        assert_eq!(
            restore_editing_control(
                || Ok(false),
                || panic!("must not steal focus from another window"),
                || Err("target changed".into()),
            ),
            Err("target changed".into())
        );
    }

    #[test]
    fn requests_expire_by_deadline_and_capture_generation() {
        let (reply, _) = mpsc::sync_channel(1);
        let request = Request {
            id: request(100, 2),
            operation: Operation::Restore,
            deadline: Instant::now() + Duration::from_secs(1),
            reply,
        };
        assert!(request.active(2));
        assert!(!request.active(1));
        let request = Request {
            deadline: Instant::now() - Duration::from_secs(1),
            ..request
        };
        assert!(!request.active(2));
    }

    #[test]
    fn only_editable_accessibility_controls_are_captured() {
        use windows::Win32::UI::Accessibility::UIA_ButtonControlTypeId;
        for control_type in [
            UIA_EditControlTypeId,
            UIA_ComboBoxControlTypeId,
            UIA_DocumentControlTypeId,
        ] {
            assert!(editable_control(control_type));
        }
        assert!(!editable_control(UIA_ButtonControlTypeId));
    }

    #[test]
    fn the_native_focus_client_initializes_on_an_mta_thread_without_touching_ui() {
        std::thread::spawn(|| {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }.unwrap();
            let _apartment = ComApartment;
            let _client =
                automation_client().expect("Windows UI Automation client must initialize");
        })
        .join()
        .unwrap();
    }
}
