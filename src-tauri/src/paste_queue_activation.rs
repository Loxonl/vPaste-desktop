#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    generation: u64,
    pub active: bool,
}

pub struct Requests {
    generation: u64,
    pending: Option<Request>,
}

impl Requests {
    pub const fn new() -> Self {
        Self {
            generation: 0,
            pending: None,
        }
    }

    pub fn request(&mut self, active: bool) -> Request {
        self.generation += 1;
        let request = Request {
            generation: self.generation,
            active,
        };
        self.pending = Some(request);
        request
    }

    pub fn toggle(&mut self, actual_active: bool) -> Request {
        let requested_active = self.pending.map_or(actual_active, |request| request.active);
        self.request(!requested_active)
    }

    pub fn current(&self, request: Request) -> bool {
        self.pending == Some(request)
    }

    pub fn finish(&mut self, request: Request) {
        if self.current(request) {
            self.pending = None;
        }
    }

    pub fn discard_window(&self, request: Request, actual_active: bool) -> bool {
        !self.current(request)
            && !self.pending.is_some_and(|request| request.active)
            && !actual_active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_toggle_cancels_an_open_while_the_page_is_still_loading() {
        let mut requests = Requests::new();
        let opening = requests.toggle(false);
        let closing = requests.toggle(false);
        assert!(opening.active);
        assert!(!closing.active);
        assert!(!requests.current(opening));
        assert!(requests.discard_window(opening, false));
    }

    #[test]
    fn explicit_close_invalidates_pending_open_and_stale_finish_cannot_clear_it() {
        let mut requests = Requests::new();
        let opening = requests.request(true);
        let closing = requests.request(false);
        requests.finish(opening);
        assert!(requests.current(closing));
        requests.finish(closing);
        assert!(requests.discard_window(opening, false));
    }

    #[test]
    fn stale_open_cannot_destroy_a_newer_pending_or_active_window() {
        let mut requests = Requests::new();
        let old = requests.request(true);
        requests.request(false);
        let new = requests.request(true);
        assert!(!requests.discard_window(old, false));
        requests.finish(new);
        assert!(!requests.discard_window(old, true));
    }
}
