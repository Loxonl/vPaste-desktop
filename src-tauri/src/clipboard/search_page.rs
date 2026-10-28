use super::item::Page;

pub(super) fn collect<T>(
    mut cursor: (u64, u64),
    limit: usize,
    is_current: &impl Fn() -> bool,
    mut fetch: impl FnMut(u64, u64, usize) -> Result<Option<Page<T>>, String>,
) -> Result<Option<Page<T>>, String> {
    let mut result = Page {
        list: Vec::new(),
        consumed: 0_u128,
        has_more: false,
        next_id: cursor.0,
        next_time: cursor.1,
    };
    while result.list.len() < limit {
        if !is_current() {
            return Ok(None);
        }
        let Some(page) = fetch(cursor.0, cursor.1, limit - result.list.len())? else {
            return Ok(None);
        };
        if !is_current() {
            return Ok(None);
        }
        let next = (page.next_id, page.next_time);
        result.list.extend(page.list);
        result.consumed = result.consumed.saturating_add(page.consumed);
        result.has_more = page.has_more && next != (0, 0) && next != cursor;
        result.next_id = next.0;
        result.next_time = next.1;
        if !result.has_more {
            break;
        }
        cursor = next;
    }
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn page(list: Vec<i32>, has_more: bool, cursor: (u64, u64)) -> Page<i32> {
        Page {
            list,
            consumed: 1,
            has_more,
            next_id: cursor.0,
            next_time: cursor.1,
        }
    }

    #[test]
    fn filtered_batches_fill_one_logical_page_and_preserve_the_scan_cursor() {
        let mut requests = Vec::new();
        let result = collect((0, 0), 2, &|| true, |id, time, remaining| {
            requests.push((id, time, remaining));
            Ok(Some(match id {
                0 => page(vec![10], true, (7, 70)),
                7 => page(vec![], true, (4, 40)),
                4 => page(vec![3], true, (2, 20)),
                _ => panic!("unexpected cursor"),
            }))
        })
        .unwrap()
        .unwrap();
        assert_eq!(requests, [(0, 0, 2), (7, 70, 1), (4, 40, 1)]);
        assert_eq!(result.list, [10, 3]);
        assert_eq!((result.next_id, result.next_time), (2, 20));
        assert!(result.has_more);
    }

    #[test]
    fn stalled_and_terminal_cursors_do_not_loop() {
        for cursor in [(9, 90), (0, 0)] {
            let mut requests = 0;
            let result = collect((9, 90), 36, &|| true, |_, _, _| {
                requests += 1;
                Ok(Some(page(vec![], true, cursor)))
            })
            .unwrap()
            .unwrap();
            assert_eq!(requests, 1);
            assert!(!result.has_more);
        }
    }

    #[test]
    fn cancellation_drops_a_batch_instead_of_returning_a_partial_stale_page() {
        let current = Cell::new(true);
        let result = collect((0, 0), 36, &|| current.get(), |_, _, _| {
            current.set(false);
            Ok(Some(page(vec![1], true, (1, 10))))
        })
        .unwrap();
        assert!(result.is_none());
    }
}
